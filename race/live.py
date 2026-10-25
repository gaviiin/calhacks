"""Live: subscribe to OpenF1's MQTT feed and run the same pipeline as the replay.

    OPENF1_USERNAME=... OPENF1_PASSWORD=... uv run python -m race.live --team Williams

Needs OpenF1's paid tier. Token: POST https://api.openf1.org/token (form username/password, 1 hour). Broker:
mqtt.openf1.org:8883 over TLS (or wss://mqtt.openf1.org:8084/mqtt); topics mirror the REST paths (v1/laps,
v1/position, ...); each message is the REST row plus `_id` (ordering) and `_key` (updates to one object).
Data counts as live from 30 minutes before a session to 30 minutes after. /location, /car_data and /intervals
have been reported unavailable live at times; we do not subscribe to the first two anyway.
"""

from __future__ import annotations

import argparse
import json
import os
import ssl
import threading
import time

import httpx

from race import openf1
from race.events import now_iso
from race.normalize import Normalizer
from race.replay import Replay
from race.sink import RaceSink

TOPICS = ("v1/sessions", "v1/drivers", "v1/laps", "v1/position", "v1/intervals", "v1/pit", "v1/stints", "v1/overtakes",
          "v1/race_control", "v1/championship_teams", "v1/session_result")
TOKEN_URL = "https://api.openf1.org/token"
BROKER = os.environ.get("OPENF1_MQTT_HOST", "mqtt.openf1.org")
PORT = int(os.environ.get("OPENF1_MQTT_PORT", "8883"))


def fetch_token(username: str, password: str) -> str:
    r = httpx.post(TOKEN_URL, data={"username": username, "password": password}, timeout=30)
    r.raise_for_status()
    return r.json()["access_token"]


class Live(Replay):
    """A Replay whose rows arrive from the broker instead of a fixture. The tick runs on the wall clock."""

    def __init__(self, team: str, sink: RaceSink | None, offline: bool, forecast: bool):
        self.team = team
        self.pace = 0
        self.from_lap = 0
        self.sink = sink
        self.offline = offline
        self.want_forecast = forecast
        self.max_sleep = 0
        self.quiet = False
        self.rows = {"drivers": []}
        self.session = {"session_key": 0, "meeting_key": 0, "date_start": now_iso(), "date_end": ""}
        self.team_of = {}
        self.acronym = {}
        from race.effects import EffectsContext
        from race.policies import PolicyBook

        self.ctx = EffectsContext(team=team, team_of=self.team_of, fx_date=now_iso()[:10])
        self.book = PolicyBook.from_rows(sink.sql("SELECT * FROM race_policies") if sink else [])
        self.track_status = "green"
        self.recent, self.incident_lap, self.pit_lap, self.retired_lap = {}, {}, {}, {}
        self.forecasted, self.threads = set(), []
        self.stats = {"events": 0, "effects": 0, "jev_calls": 0, "jev_ms": [], "policy_hits": 0, "forecasts": 0}
        self.normalizer: Normalizer | None = None
        self._lock = threading.Lock()

    def on_row(self, topic: str, row: dict) -> None:
        endpoint = topic.split("/", 1)[-1]
        with self._lock:
            if endpoint == "sessions":
                if row.get("session_key") and row["session_key"] != self.session.get("session_key"):
                    self.session = row
                    self.normalizer = Normalizer(self.team, row, source="openf1_live")
                    self.ctx.sprint = "Sprint" in (row.get("session_name") or "")
                    print(f"session {row['session_key']} {row.get('country_name')} {row.get('session_name')}")
                return
            if self.normalizer is None:
                # No session row yet: adopt the one the row names so events are not lost.
                sk = row.get("session_key")
                if not sk:
                    return
                try:
                    self.session = openf1.session(int(sk))
                except Exception:
                    self.session = {"session_key": sk, "meeting_key": row.get("meeting_key", 0), "date_start": now_iso()}
                self.normalizer = Normalizer(self.team, self.session, source="openf1_live")
            if endpoint == "drivers":
                self.team_of[int(row["driver_number"])] = row.get("team_name", "")
                self.acronym[int(row["driver_number"])] = row.get("name_acronym", "")
            if endpoint == "championship_teams":
                self.ctx.set_standings([row])
            if endpoint == "stints":
                row = {**row, "_t": now_iso()}
            if endpoint in ("championship_teams", "session_result"):
                row = {**row, "_t": now_iso()}
            for ev in self.normalizer.feed(endpoint, row):
                effects = self.handle(ev)
                line = ev.one_line()
                if effects:
                    line += "  => " + "; ".join(f"{e.kind}:{e.bucket} ${e.mid_cents / 100:,.0f} [{e.decided_by}]" for e in effects)
                if ev.kind not in ("position", "overtake", "flag", "notice") or effects or self.team_of.get(ev.driver_number) == self.team:
                    print(line[:200])

    def tick(self) -> None:
        with self._lock:
            if self.normalizer is None:
                return
            for ev in self.normalizer.tick(now_iso()):
                effects = self.handle(ev)
                print(ev.one_line()[:200] + ("  => " + "; ".join(f"{e.kind}:{e.bucket} ${e.mid_cents / 100:,.0f}" for e in effects) if effects else ""))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--team", default=os.environ.get("RACE_TEAM", "Williams"))
    ap.add_argument("--no-sink", action="store_true")
    ap.add_argument("--offline", action="store_true", default=os.environ.get("RACE_OFFLINE", "") in ("1", "true"))
    ap.add_argument("--no-forecast", action="store_true")
    ap.add_argument("--topics", default=",".join(TOPICS))
    args = ap.parse_args()
    user, pw = os.environ.get("OPENF1_USERNAME"), os.environ.get("OPENF1_PASSWORD")
    if not (user and pw):
        raise SystemExit("set OPENF1_USERNAME and OPENF1_PASSWORD (OpenF1 paid tier) to use the live feed")
    import paho.mqtt.client as mqtt

    live = Live(args.team, None if args.no_sink else RaceSink(), args.offline, not args.no_forecast)
    topics = [t.strip() for t in args.topics.split(",") if t.strip()]

    def connect(client: "mqtt.Client") -> None:
        client.username_pw_set(user, fetch_token(user, pw))
        client.connect(BROKER, PORT, keepalive=60)

    def on_connect(client, userdata, flags, reason_code, properties=None):
        print(f"connected to {BROKER}:{PORT} ({reason_code}); subscribing {len(topics)} topics")
        for t in topics:
            client.subscribe(t)

    def on_message(client, userdata, msg):
        try:
            payload = json.loads(msg.payload)
        except json.JSONDecodeError:
            return
        rows = payload if isinstance(payload, list) else [payload]
        for row in rows:
            live.on_row(msg.topic, row)

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    client.tls_set(cert_reqs=ssl.CERT_REQUIRED)
    client.on_connect = on_connect
    client.on_message = on_message
    connect(client)
    client.loop_start()
    last_token = time.monotonic()
    try:
        while True:
            time.sleep(5)
            live.tick()
            if time.monotonic() - last_token > 50 * 60:  # tokens last an hour
                client.username_pw_set(user, fetch_token(user, pw))
                client.reconnect()
                last_token = time.monotonic()
    except KeyboardInterrupt:
        pass
    finally:
        client.loop_stop()
        print("stats:", live.stats)


if __name__ == "__main__":
    main()
