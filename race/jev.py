"""System One: Jev (TypeSafe AI) answers typed questions about one race event in 70-500 ms.

Jev decides, it never writes. We ask it, per event, whether the event moves Williams' money, how severe
the damage is, who was at fault, which parts are likely hit, whether a sponsor bonus is at risk and whether
a person would want a full plan. Every answer comes back with a probability and is logged on the effect
row (race_effects.jev_json), so a reviewer sees what the fast path believed and how sure it was.

    answers = decide(event, context)        # JevAnswers; answers.offline is True without TYPESAFE_API_KEY
    answers.severity, answers.p("severity")["heavy"], answers.parts["floor"], answers.latency_ms

Offline (RACE_OFFLINE=1 or no key) a rule table produces the same shape, so the pipeline, tests and demo
run without the network. The rule table is deliberately simple: Jev is the point.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field

from race import prices as P
from race.events import RaceEvent

# Two ways in: TypeSafe's own API (key from console.typesafe.ai) or Vercel's AI Gateway, whose keys start with
# "vck_" and which serves Jev at <gateway>/typesafe/v1/systemone under the model id typesafe-ai/jev.
VERCEL_GATEWAY = "https://ai-gateway.vercel.sh/typesafe"


def _route() -> tuple[str | None, str]:
    key = os.environ.get("TYPESAFE_API_KEY", "")
    base = os.environ.get("TYPESAFE_BASE_URL") or (VERCEL_GATEWAY if key.startswith("vck_") else None)
    model = os.environ.get("JEV_MODEL") or ("typesafe-ai/jev" if base and "vercel" in base else "jev-latest")
    return base, model


MODEL = _route()[1]
SEVERITIES = {
    "none": "No damage: a notice, penalty, flag or position change with nothing broken on the car",
    "light": "Light damage: front wing, bodywork or a brake duct; the car carried on or pitted once",
    "moderate": "Moderate damage: floor, suspension corner or rear wing; the car lost a lot of pace or retired without a heavy impact",
    "heavy": "Heavy damage: a heavy impact or barrier contact; chassis, gearbox, floor and suspension likely; the car retired on the spot",
}
FAULTS = {
    "team_car_at_fault": "The team's own car caused the incident",
    "other_car_at_fault": "Another car caused it (a penalty for the other car would confirm this)",
    "racing_incident": "No one at fault, or a mechanical failure",
    "unknown": "Not enough information yet",
}
BONUS_RISK = [
    "No sponsor bonus was in play for this car",
    "A bonus was possible but is still on",
    "A bonus this car was on course for is now unlikely",
    "A bonus this car was on course for is lost",
]
PARTS_ASKED = ("front_wing", "floor", "rear_wing", "front_suspension", "rear_suspension", "gearbox", "chassis", "bodywork",
               "power_unit", "brakes", "electronics")


@dataclass
class JevAnswers:
    relevant: float = 0.0  # P(this event changes the team's money)
    severity: str = "none"
    fault: str = "unknown"
    bonus_risk: float = 0.0  # weighted score 0..3
    needs_forecast: float = 0.0
    parts: dict[str, float] = field(default_factory=dict)  # part -> P(damaged)
    probabilities: dict[str, dict] = field(default_factory=dict)  # question -> distribution
    confidence: dict[str, float] = field(default_factory=dict)
    latency_ms: int = 0
    model: str = "offline"
    offline: bool = True
    error: str = ""

    def p(self, question: str) -> dict:
        return self.probabilities.get(question, {})

    def log(self) -> dict:
        """What goes on the effect row: compact, every probability kept."""
        return {
            "model": self.model, "ms": self.latency_ms, "relevant": round(self.relevant, 3), "severity": self.severity,
            "fault": self.fault, "bonus_risk": round(self.bonus_risk, 2), "needs_forecast": round(self.needs_forecast, 3),
            "p": {k: {kk: round(vv, 3) for kk, vv in v.items()} for k, v in self.probabilities.items()},
            "parts": {k: round(v, 3) for k, v in self.parts.items()},
            **({"error": self.error} if self.error else {}),
        }


def _state_text(event: RaceEvent, context: dict) -> str:
    """The state Jev reads. Facts only, in a fence, so nothing in a race-control message reads as an instruction."""
    lines = [
        f"team: {context.get('team', 'Williams')}; team cars: {context.get('team_cars', [])}",
        f"event: kind={event.kind} lap={event.lap} car={event.driver_number or 'field'} at={event.at}",
        f"payload: {json.dumps(event.payload, separators=(',', ':'))}",
    ]
    if event.state:
        s = event.state
        lines.append(f"car_state: position={s.position} lap={s.lap} compound={s.compound} tyre_age={s.tyre_age} gap={s.gap_to_leader} status={s.status}")
    for k in ("track_status", "field_lap", "last_lap_delta_s", "retired_within_laps", "pit_within_laps", "bonus_positions"):
        if k in context:
            lines.append(f"{k}: {context[k]}")
    recent = context.get("recent_events") or []
    if recent:
        lines.append("recent events for this car (oldest first):")
        lines.extend(f"  - {r}" for r in recent[-6:])
    return "\n".join(lines)


def _questions(team: str) -> dict:
    from typesafe_sdk import Choice, Noul, Score  # imported lazily so offline runs need no SDK

    q = {
        "relevant": Noul(instructions=f"This event changes {team}'s costs or its expected revenue this season"),
        "severity": Choice(instructions=f"How badly damaged is the {team} car after this event", criteria=SEVERITIES),
        "fault": Choice(instructions="Who caused the incident", criteria=FAULTS),
        "bonus_risk": Score(instructions=f"Whether a sponsor performance bonus {team} was on course for is affected", criteria=BONUS_RISK),
        "needs_forecast": Noul(instructions=f"{team}'s head of finance would want a repair and money plan for this event"),
    }
    for part in PARTS_ASKED:
        q[f"part:{part}"] = Noul(instructions=f"The {P.PART_LABELS[part]} on the {team} car is damaged and must be replaced or repaired")
    return q


def available() -> bool:
    return bool(os.environ.get("TYPESAFE_API_KEY")) and os.environ.get("RACE_OFFLINE", "") not in ("1", "true", "yes")


def decide(event: RaceEvent, context: dict) -> JevAnswers:
    """One batched System One call for one event. Falls back to the rule table on any failure."""
    if not available():
        return offline_decide(event, context)
    team = context.get("team", "Williams")
    t0 = time.perf_counter()
    try:
        from typesafe_sdk import TypeSafeClient

        base, model = _route()
        with TypeSafeClient(model=model, base_url=base) as client:
            resp = client.system_one(state=_state_text(event, context), questions=_questions(team))
        ms = int((time.perf_counter() - t0) * 1000)
        a = JevAnswers(latency_ms=ms, model=getattr(resp, "model", model) or model, offline=False)
        a.relevant = float(resp.nouls["relevant"].noul)
        a.needs_forecast = float(resp.nouls["needs_forecast"].noul)
        sev = resp.choices["severity"]
        a.severity = str(sev.choice)
        a.probabilities["severity"] = {k: float(v) for k, v in dict(sev.probabilities).items()}
        a.confidence["severity"] = float(sev.confidence)
        fault = resp.choices["fault"]
        a.fault = str(fault.choice)
        a.probabilities["fault"] = {k: float(v) for k, v in dict(fault.probabilities).items()}
        a.confidence["fault"] = float(fault.confidence)
        br = resp.scores["bonus_risk"]
        a.bonus_risk = float(br.score)
        a.probabilities["bonus_risk"] = {str(i): float(p) for i, p in enumerate(br.probabilities)}
        for part in PARTS_ASKED:
            a.parts[part] = float(resp.nouls[f"part:{part}"].noul)
        return a
    except Exception as exc:  # the fast path must never stop the tape
        a = offline_decide(event, context)
        a.error = f"jev failed, offline table used: {type(exc).__name__}: {str(exc)[:160]}"
        if not getattr(decide, "_warned", False):
            print(f"  jev: {a.error}")
            decide._warned = True  # type: ignore[attr-defined]
        return a


# ---------------------------------------------------------------- offline rule table

def offline_decide(event: RaceEvent, context: dict) -> JevAnswers:
    a = JevAnswers(model="offline-rules", offline=True)
    team_cars = set(context.get("team_cars") or [])
    ours = event.driver_number in team_cars or bool(event.payload.get("team_involved"))
    retired_within = context.get("retired_within_laps")
    pit_within = context.get("pit_within_laps")
    reason = (event.payload.get("reason") or "").upper()

    if event.kind == "car_stopped" and ours:
        # The tripwire: how fast the car was going before it stopped is the best early read of the damage.
        kph = int(event.payload.get("peak_kph") or 0)
        if kph >= 250:
            sev = {"heavy": 0.7, "moderate": 0.2, "light": 0.08, "none": 0.02}
        elif kph >= 150:
            sev = {"heavy": 0.4, "moderate": 0.4, "light": 0.15, "none": 0.05}
        else:
            sev = {"heavy": 0.1, "moderate": 0.35, "light": 0.45, "none": 0.1}
        a.relevant = 1 - sev["none"]
        a.needs_forecast = sev["heavy"] + 0.5 * sev["moderate"]
    elif event.kind in ("incident", "retirement_suspected", "retirement_confirmed") and ours:
        if event.kind.startswith("retirement") or (retired_within is not None and retired_within <= 2):
            sev = {"heavy": 0.6, "moderate": 0.3, "light": 0.08, "none": 0.02}
        elif pit_within is not None and pit_within <= 2:
            sev = {"heavy": 0.05, "moderate": 0.45, "light": 0.4, "none": 0.1}
        elif "COLLISION" in reason or "FORCING" in reason or reason == "":
            sev = {"heavy": 0.1, "moderate": 0.3, "light": 0.45, "none": 0.15}
        else:  # infringements: track limits, SC delta, unsafe release
            sev = {"heavy": 0.01, "moderate": 0.04, "light": 0.15, "none": 0.8}
        a.relevant = 1 - sev["none"]
        a.needs_forecast = sev["heavy"] + 0.5 * sev["moderate"]
    elif event.kind == "penalty" and ours:
        sev = {"heavy": 0.0, "moderate": 0.0, "light": 0.05, "none": 0.95}
        a.relevant = 0.3
    elif event.kind in ("position", "standings") and (ours or event.kind == "standings"):
        sev = {"heavy": 0.0, "moderate": 0.0, "light": 0.0, "none": 1.0}
        a.relevant = 0.6
    elif event.kind == "pit_stop" and ours:
        sev = {"heavy": 0.0, "moderate": 0.0, "light": 0.0, "none": 1.0}
        a.relevant = 0.2
    else:
        sev = {"heavy": 0.0, "moderate": 0.0, "light": 0.0, "none": 1.0}
        a.relevant = 0.02
    a.probabilities["severity"] = sev
    a.severity = max(sev, key=sev.get)
    a.confidence["severity"] = max(sev.values())

    cars = event.payload.get("car_numbers") or []
    if event.kind == "incident" and len(cars) >= 2 and ours:
        f = {"team_car_at_fault": 0.3, "other_car_at_fault": 0.3, "racing_incident": 0.25, "unknown": 0.15}
    elif event.kind == "incident" and ours:
        f = {"team_car_at_fault": 0.5, "other_car_at_fault": 0.05, "racing_incident": 0.3, "unknown": 0.15}
    else:
        f = {"team_car_at_fault": 0.05, "other_car_at_fault": 0.05, "racing_incident": 0.2, "unknown": 0.7}
    a.probabilities["fault"] = f
    a.fault = max(f, key=f.get)
    a.confidence["fault"] = max(f.values())

    pos = event.state.position if event.state else 0
    bonus_positions = context.get("bonus_positions") or 10
    if ours and event.kind.startswith("retirement") and pos and pos <= bonus_positions:
        br = {"0": 0.05, "1": 0.05, "2": 0.2, "3": 0.7}
    elif ours and event.kind == "position" and pos and pos <= bonus_positions:
        br = {"0": 0.3, "1": 0.5, "2": 0.15, "3": 0.05}
    else:
        br = {"0": 0.85, "1": 0.1, "2": 0.03, "3": 0.02}
    a.probabilities["bonus_risk"] = br
    a.bonus_risk = sum(int(k) * v for k, v in br.items())

    # Parts: the severity template's probabilities, blended by the severity distribution.
    for part in PARTS_ASKED:
        p = 0.0
        for s, w in sev.items():
            if s == "none":
                continue
            tpl = dict(P.SEVERITY_TEMPLATES.get(s, []))
            p += w * tpl.get(part, 0.0)
        a.parts[part] = round(min(p, 0.99), 4)
    return a
