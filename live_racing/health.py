"""Feed health: measured cadence, sink write counts, the exposure tally. Shared by both replays."""

from __future__ import annotations

from datetime import datetime

from .schemas import FeedHealth, SinkHealth


def _age(now_utc: str, then: str | None) -> float | None:
    if not then:
        return None
    try:
        return round((datetime.fromisoformat(now_utc.replace("Z", "+00:00")) - datetime.fromisoformat(then.replace("Z", "+00:00"))).total_seconds(), 3)
    except ValueError:
        return None


def feed_health(replay_id, status, mode, now_utc, race_clock_utc, lap, publisher, jev, advisor_desc: str, state_updates: int, exposure_now, exposure_at_join,
                exposure_peak, incidents: int, plans: int) -> FeedHealth:
    cad = publisher.cadence()
    return FeedHealth(
        replay_id=replay_id, state=status.state if status else None, mode=mode, now_utc=now_utc, race_clock_utc=race_clock_utc, lap=lap,
        last_publish_utc=cad["last_publish_utc"], seconds_since_last_publish=_age(now_utc, cad["last_publish_utc"]), publishes_total=cad["publishes_total"],
        publishes_last_60s=cad["publishes_last_60s"], publishes_per_second_10s=cad["publishes_per_second_10s"], state_updates=state_updates,
        publish_p95_ms=publisher.percentile(0.95), sinks=[SinkHealth(**h) for h in publisher.sink_health()], jev={**jev.stats.summary(), "mode": jev.describe()},
        advisor=advisor_desc, exposure_now_cents=exposure_now, exposure_at_join_cents=exposure_at_join, exposure_peak_cents=exposure_peak,
        lost_from_peak_cents=(exposure_peak - exposure_now) if exposure_peak is not None and exposure_now is not None else None, incidents=incidents, incident_plans=plans)
