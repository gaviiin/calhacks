"""Wiring shared by the CLI scripts and the API: the cached slice, the world, the sinks, Jev."""

from __future__ import annotations

import json
from pathlib import Path


from .advisor import Advisor
from .config import Config
from .jev_router import JevRouter
from .normalize import NormalizedEvent, read_jsonl
from .publisher import JsonlSink, MemorySink, Publisher, SpacetimeSink, WebhookSink
from .races import Race, race as get_race
from .replay import Replay, ReplayOptions
from .result_replay import ResultReplay, ResultReplayOptions
from .team import LiveWorld


def slice_dir(cfg: Config, race: Race) -> Path:
    return cfg.data_dir / race.cache_dir / "derived"


def load_slice(cfg: Config, race: Race) -> tuple[dict, list[NormalizedEvent]]:
    d = slice_dir(cfg, race)
    meta_path, events_path = d / "meta.json", d / "events.jsonl"
    if not meta_path.exists() or not events_path.exists():
        raise FileNotFoundError(f"no cached slice for {race.race_id} in {d}; run: uv run python scripts/fetch_openf1_brazil_2024.py --race {race.race_id}")
    return json.loads(meta_path.read_text()), read_jsonl(events_path)


def build_publisher(cfg: Config, replay_id: str, *, memory: MemorySink | None = None, spacetime: bool = True, jsonl: bool = True,
                    webhook: bool = True) -> Publisher:
    sinks: list = []
    if memory is not None:
        sinks.append(memory)
    if jsonl:
        sinks.append(JsonlSink(cfg.out_dir / f"{replay_id.replace(':', '_')}.jsonl"))
    if spacetime:
        sinks.append(SpacetimeSink(replay_id, cfg.spacetime_url, cfg.spacetime_db, cfg.spacetime_token))
    if webhook and cfg.finance_agent_url:
        sinks.append(WebhookSink(cfg.finance_agent_url))
    return Publisher(sinks)


def build_jev(cfg: Config, enabled: bool = True) -> JevRouter:
    return JevRouter(cfg, mode=cfg.jev_mode if enabled else "deterministic_fallback")


def make_replay(race_id: str, options: ReplayOptions | ResultReplayOptions | None = None, *, cfg: Config | None = None, memory: MemorySink | None = None,
                spacetime: bool = True, jsonl: bool = True, log=print, replay_id: str | None = None, pause_handler=None, step_handler=None,
                advisor: bool | None = None):
    """A Replay (OpenF1 slice) or a ResultReplay (FIA documents), depending on what the race has."""
    cfg = cfg or Config.from_env()
    race = get_race(race_id)
    import uuid

    rid = replay_id or f"{race.race_id}:{uuid.uuid4().hex[:8]}"
    publisher = build_publisher(cfg, rid, memory=memory, spacetime=spacetime, jsonl=jsonl)
    if slice_dir(cfg, race).joinpath("events.jsonl").exists():
        o = options if isinstance(options, ReplayOptions) else ReplayOptions(**(options.__dict__ if options else {}))
        world = LiveWorld(o.team)
        jev = build_jev(cfg, o.jev)
        meta, events = load_slice(cfg, race)
        return Replay(race, meta, events, world, publisher, jev, o, log=log, replay_id=rid, pause_handler=pause_handler, step_handler=step_handler,
                      advisor=Advisor(enabled=advisor), cases_jsonl=(cfg.out_dir / "cases.jsonl") if jsonl else None)
    world = LiveWorld("mercedes")
    o = options if isinstance(options, ResultReplayOptions) else ResultReplayOptions(**{k: v for k, v in (options.__dict__ if options else {}).items()
                                                                                        if k in ("speed", "jev", "max_sleep_s", "mode")})
    jev = build_jev(cfg, o.jev)
    return ResultReplay(race, world, publisher, jev, o, log=log, replay_id=rid)
