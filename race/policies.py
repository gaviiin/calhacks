"""Race policies: Ripple-Down Rules that decide an event's money effect without a model call.

A policy is {policy_id, parent_policy_id, pattern, effect_template, autonomy}. The pattern is a JSON object
matched against a flat view of the event (kind, team_involved, reason, stage, severity hints...). A child
policy refines its parent: when both match, the child wins. GRANTED policies produce autonomous effects;
SHADOW policies produce proposed effects, shown dashed in the dashboard until a person grants autonomy.

Pattern grammar (same spirit as system_of_work/spacetimedb/src/rules.ts):
    {"kind": "pit_stop", "under": "sc"}                       exact match on a field
    {"kind": "incident", "reason": {"contains": "COLLISION"}} substring (case-insensitive)
    {"retired_within_laps": {"lte": 2}}                       numeric range: lte / gte / lt / gt
    {"kind": {"in": ["incident", "retirement_suspected"]}}    one of

Effect template:
    {"severity": "heavy"}                              -> effects.py prices the parts for that severity
    {"cost_cents": [low, mid, high], "bucket": "6050"} -> a fixed band
    {"cost": 0}                                        -> no cost (e.g. a pit stop under the safety car)
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from race.events import RaceEvent


@dataclass
class Policy:
    policy_id: str
    pattern: dict
    effect_template: dict
    autonomy: str = "SHADOW"
    parent_policy_id: str = ""
    title: str = ""
    hits: int = 0
    contradictions: int = 0
    precedent_count: int = 0

    @classmethod
    def from_row(cls, row: dict) -> "Policy":
        return cls(
            policy_id=row["policy_id"], pattern=json.loads(row.get("pattern") or "{}"),
            effect_template=json.loads(row.get("effect_template") or "{}"), autonomy=row.get("autonomy", "SHADOW"),
            parent_policy_id=row.get("parent_policy_id") or "", title=row.get("title") or "", hits=int(row.get("hits") or 0),
            contradictions=int(row.get("contradictions") or 0), precedent_count=int(row.get("precedent_count") or 0),
        )

    @property
    def active(self) -> bool:
        return self.autonomy in ("GRANTED", "SHADOW")

    def depth(self, by_id: dict[str, "Policy"]) -> int:
        d, p = 0, self
        while p.parent_policy_id and p.parent_policy_id in by_id:
            p = by_id[p.parent_policy_id]
            d += 1
        return d


def flat_view(event: RaceEvent, context: dict) -> dict:
    """The fields a pattern may name."""
    p = event.payload
    team = context.get("team")
    v = {
        "kind": event.kind, "driver_number": event.driver_number, "lap": event.lap,
        "team_involved": bool(p.get("team_involved")) or (bool(team) and event.team_name == team),
        "reason": p.get("reason") or "", "stage": p.get("stage") or "", "under": p.get("under") or context.get("track_status") or "",
        "track_status": context.get("track_status") or "", "position": event.state.position if event.state else 0,
        "car_count": len(p.get("car_numbers") or []), "damage_likely": bool(p.get("damage_likely")),
        "compound": p.get("compound") or "", "flag": p.get("flag") or "",
    }
    for k in ("retired_within_laps", "pit_within_laps", "last_lap_delta_s", "jev_severity"):
        if context.get(k) is not None:
            v[k] = context[k]
    return v


def _match_value(spec, value) -> bool:
    if isinstance(spec, dict):
        for op, arg in spec.items():
            if op == "contains":
                if str(arg).lower() not in str(value).lower():
                    return False
            elif op == "in":
                if value not in arg:
                    return False
            elif op == "lte":
                if value is None or not value <= arg:
                    return False
            elif op == "gte":
                if value is None or not value >= arg:
                    return False
            elif op == "lt":
                if value is None or not value < arg:
                    return False
            elif op == "gt":
                if value is None or not value > arg:
                    return False
            else:
                return False
        return True
    return value == spec


def matches(pattern: dict, view: dict) -> bool:
    return all(_match_value(spec, view.get(k)) for k, spec in pattern.items())


class PolicyBook:
    def __init__(self, policies: list[Policy] | None = None):
        self.by_id: dict[str, Policy] = {p.policy_id: p for p in (policies or [])}

    @classmethod
    def from_rows(cls, rows: list[dict]) -> "PolicyBook":
        return cls([Policy.from_row(r) for r in rows])

    def __len__(self) -> int:
        return len(self.by_id)

    def resolve(self, event: RaceEvent, context: dict) -> Policy | None:
        """The most specific matching active policy: deepest child first, then most pattern fields."""
        view = flat_view(event, context)
        hits = [p for p in self.by_id.values() if p.active and p.pattern and matches(p.pattern, view)]
        if not hits:
            return None
        hits.sort(key=lambda p: (p.depth(self.by_id), len(p.pattern), p.autonomy == "GRANTED"), reverse=True)
        return hits[0]
