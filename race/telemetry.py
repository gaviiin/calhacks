"""The telemetry tripwire: a team car that stops hard, seen in car_data seconds before anyone says so.

    stops = detect_stops(rows, car=23)   # rows: OpenF1 car_data (about 3.7 Hz: speed, rpm, throttle, brake, gear)

Race control is slow and sometimes silent: in São Paulo 2024 the red flag came 9-27 s after each Williams crash
and never named Colapinto's race crash; in Canada 2026 the first message about Albon came 4m21s after the contact.
The car's own telemetry shows it at once: a stop from speed (Albon, Q3: 315 to 0 km/h at 11:57:19) or a stream that
freezes on OpenF1's sentinel values (throttle and brake read 104) the second the car is hit.

Two signatures, both only after the car was moving at racing speed, so a garage or pit-lane stop never fires:
- stop:   speed at or above FROM_KPH within WINDOW_S before a sample under TO_KPH, with the brake on;
- freeze: FREEZE_ROWS consecutive identical samples with throttle 104 while the last real sample was at speed.
"""

from __future__ import annotations

from datetime import datetime

FROM_KPH = 100  # above the 80 km/h pit limiter, below a safety-car pace (Sainz, Melbourne 2025: 119 to 0)
TO_KPH = 25
WINDOW_S = 3.0
FREEZE_ROWS = 8
COOLDOWN_S = 60.0  # one crash, one stop


def _t(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def detect_stops(rows: list[dict], car: int) -> list[dict]:
    """[{"at", "car", "signature", "peak_kph", "impact_kph", "decel_g", "seconds"}] in time order."""
    out: list[dict] = []
    last_at: datetime | None = None
    j = 0
    run = 0
    for i, r in enumerate(rows):
        t = _t(r["date"])
        while j < i and (t - _t(rows[j]["date"])).total_seconds() > WINDOW_S:
            j += 1
        hit = None
        if r["speed"] < TO_KPH and r.get("brake") in (100, 104) and r.get("throttle") != 104:
            window = rows[j:i + 1]
            peak = max(window, key=lambda x: x["speed"])
            if peak["speed"] >= FROM_KPH:
                secs = max((t - _t(peak["date"])).total_seconds(), 0.25)
                hit = {"signature": "stop", "peak_kph": peak["speed"], "impact_kph": peak["speed"], "seconds": round(secs, 2),
                       "decel_g": round((peak["speed"] - r["speed"]) / 3.6 / secs / 9.81, 1)}
        run = run + 1 if (r.get("throttle") == 104 and i and rows[i - 1].get("throttle") == 104 and rows[i - 1]["speed"] == r["speed"]) else 0
        if hit is None and run == FREEZE_ROWS:
            k = i - FREEZE_ROWS
            before = rows[max(k - 15, 0):k + 1]
            moving = [x for x in before if x.get("throttle") != 104]
            if moving and max(x["speed"] for x in moving) >= FROM_KPH:
                first = rows[k + 1]
                t = _t(first["date"])
                hit = {"signature": "freeze", "peak_kph": max(x["speed"] for x in moving), "impact_kph": first["speed"], "seconds": 0.0,
                       "decel_g": None}
                r = first
        if hit and (last_at is None or (t - last_at).total_seconds() > COOLDOWN_S):
            out.append({"at": r["date"], "car": car, **hit})
            last_at = t
    return out


def detect_all(car_data: dict[int, list[dict]], cars: list[int] | None = None) -> list[dict]:
    out = [s for car, rows in car_data.items() if cars is None or car in cars for s in detect_stops(rows, car)]
    return sorted(out, key=lambda s: s["at"])
