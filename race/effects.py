"""Deterministic money consequences of a race event, as bands, with the tier that decided them.

    ctx = EffectsContext(team="Williams", world=World(), standings_start={...}, team_of={23: "Williams", ...})
    effects = effects_for(event, jev_answers, policy, ctx)

Order of authority (the cost cap desk's rule, applied to the race): an approved policy decides without a
model; otherwise Jev's typed answers weight the price book; the forecast agent (Claude) only ever adds a
plan on top. Every effect carries `decided_by`, `why` and the Jev probabilities it used.

Buckets: 6050 crash damage parts, 5200 repair labour, 6300 expedited freight (Meridian's chart of accounts,
world/company.py), prize_money (projected constructors' ladder), sponsor_bonus:<id>, cap_headroom.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from finance.world import World
from race import prices as P
from race.events import Effect, RaceEvent
from race.jev import JevAnswers
from race.points import points_for, position_of, projected_standings
from race.policies import Policy
from race.precedents import PrecedentMatch

CAP_USD_CENTS = int(os.environ.get("CAP_USD_CENTS", str(215_000_000 * 100)))  # 2026 cost cap, agents/config.py
RELEVANCE_FLOOR = 0.15
REVISION_FLOOR = 0.15  # a later estimate for the same crash is only posted when it moves the mid by 15%
LIKELY = 0.5  # a part counts in the low band when P(damaged) >= LIKELY ...
POSSIBLE = 0.2  # ... and in the high band when P(damaged) >= POSSIBLE


def ask_floor() -> float:
    """Below this severity confidence a Jev-decided crash line waits for a person. A setting a person controls."""
    return float(os.environ.get("RACE_ASK_FLOOR", "0.5"))


def jev_unsure(jev: JevAnswers, sev_p: dict[str, float]) -> tuple[bool, str, float]:
    """(ask?, the severity Jev picked, its confidence). Jev's own confidence when it gave one, else the top probability."""
    sev = max(sev_p, key=sev_p.get) if sev_p else "light"
    conf = jev.confidence.get("severity")
    if conf is None:
        conf = max(sev_p.values()) if sev_p else 0.0
    return conf < ask_floor(), sev, float(conf)


def _band(lo: float, mid: float, hi: float) -> tuple[int, int, int]:
    a, b, c = sorted((int(round(lo)), int(round(mid)), int(round(hi))))
    return a, b, c


class _Row:
    """What finance/bonuses._qualifies needs from a result row."""

    def __init__(self, pos: int | None):
        self.pos = pos
        self.points = points_for(pos)


@dataclass
class EffectsContext:
    team: str
    world: World = field(default_factory=World)
    standings_start: dict[str, float] = field(default_factory=dict)  # team -> points before this race
    team_of: dict[int, str] = field(default_factory=dict)  # car -> team
    positions: dict[int, int | None] = field(default_factory=dict)  # car -> current position (None = out)
    sprint: bool = False
    next_race_days: int | None = None
    next_race_flyaway: bool = False
    fx_date: str = "2026-06-01"
    cap_relevant_cents: int = 0  # relevant costs booked so far this cap year (from cost-cap-desk when available)
    # memory across events
    booked: dict[int, dict] = field(default_factory=dict)  # car -> {"lap": int, "mid": int, "low": int, "high": int}
    prize_position: int | None = None
    prize_position_before: int | None = None  # the projection before the first change this race (for the forecast)
    bonus_state: dict[str, str] = field(default_factory=dict)  # f"{sponsor}|{clause}|{car}" -> expected | lost
    race_cost_mid: int = 0

    # ------------------------------------------------------------------ setup
    def set_standings(self, rows: list[dict]) -> None:
        for r in rows:
            if r.get("team_name") is not None and r.get("points_start") is not None:
                self.standings_start[r["team_name"]] = float(r["points_start"])

    def team_cars(self) -> list[int]:
        return sorted(c for c, t in self.team_of.items() if t == self.team)

    def gbp_cents(self, gbp: float) -> int:
        try:
            rate = float(self.world.fx("GBP", self.fx_date))
        except (KeyError, FileNotFoundError):
            rate = P.USD_PER_GBP
        return int(round(gbp * rate * 100))

    def cap_headroom_cents(self) -> int:
        return CAP_USD_CENTS - self.cap_relevant_cents - self.race_cost_mid

    def clauses(self) -> list[tuple[dict, dict]]:
        """(sponsor, clause) for every performance clause in the team's current contracts."""
        out = []
        try:
            sponsors = self.world.sponsors
        except FileNotFoundError:
            return out
        for s in sponsors:
            contracts = s.get("contracts", [])
            if not contracts:
                continue
            latest = max(contracts, key=lambda c: int(c.get("version") or 0))  # amendments supersede earlier versions
            for cl in latest.get("clauses", []):
                if cl.get("type") in ("win", "podium", "points_finish", "top6"):
                    out.append((s, cl))
        return out

    def best_bonus_position(self) -> int:
        """The worst finishing position that still pays some bonus (10 when a points-finish clause exists)."""
        best = 0
        for _, cl in self.clauses():
            best = max(best, {"win": 1, "podium": 3, "top6": 6, "points_finish": 10}.get(cl["type"], 0))
        return best or 10


# ---------------------------------------------------------------------- pieces

def damage_band(parts_p: dict[str, float], severity_p: dict[str, float], ctx: EffectsContext) -> tuple[tuple[int, int, int], list[dict]]:
    """Expected-value mid from part probabilities; low counts likely parts, high counts possible parts."""
    lo = mid = hi = 0.0
    detail = []
    parts_p = dict(parts_p)
    if "chassis" in parts_p and "chassis_repair" in parts_p:
        parts_p.pop("chassis" if parts_p["chassis"] < parts_p["chassis_repair"] else "chassis_repair")
    for part, p in sorted(parts_p.items(), key=lambda kv: -kv[1]):
        price = P.PARTS.get(part)
        if not price or p <= 0.02:
            continue
        l, m, h = (ctx.gbp_cents(price.low), ctx.gbp_cents(price.mid), ctx.gbp_cents(price.high))
        mid += p * m
        if p >= LIKELY:
            lo += l
        if p >= POSSIBLE:
            hi += h
        detail.append({"part": part, "label": P.PART_LABELS.get(part, part), "p": round(p, 3), "low": l, "mid": m, "high": h, "basis": price.basis})
    sev = max(severity_p, key=severity_p.get) if severity_p else "light"
    labour = P.REPAIR_LABOUR.get(sev, P.REPAIR_LABOUR["light"])
    return _band(lo, mid, hi), detail


def crash_effects(event: RaceEvent, jev: JevAnswers, policy: Policy | None, ctx: EffectsContext,
                  precedent: PrecedentMatch | None = None) -> list[Effect]:
    car = event.driver_number
    sev_p = dict(jev.p("severity")) or {"none": 1.0}
    parts_p = dict(jev.parts)
    decided_by, status, basis_note = "jev", "proposed", ""
    shadow = policy if (policy and policy.autonomy != "GRANTED") else None
    if shadow:
        # A shadow policy only watches: the row says which draft would have matched.
        basis_note = f" (shadow policy {shadow.policy_id} would have matched)"
        policy = None
    tpl: dict = {}
    if policy:
        decided_by = f"policy:{policy.policy_id}"
        status = "autonomous"
        tpl = policy.effect_template
    elif precedent:
        # The team has done this before and it scored the same: the precedent's protocol runs on its own.
        decided_by = "precedent:" + ",".join(precedent.case_ids[:4])
        status = "autonomous"
        tpl = precedent.effect_template()
        basis_note = " " + precedent.why()
    if policy or precedent:
        if "severity" in tpl:
            sev = tpl["severity"]
            sev_p = {k: (1.0 if k == sev else 0.0) for k in ("none", "light", "moderate", "heavy")}
            parts_p = dict(P.SEVERITY_TEMPLATES.get(sev, []))
            if policy:
                basis_note = f" (policy {policy.policy_id}: severity {sev})"
        if tpl.get("cost") == 0 or tpl.get("cost_cents") == [0, 0, 0]:
            return []
    elif jev.relevant < RELEVANCE_FLOOR or (1 - sev_p.get("none", 0.0)) < 0.3:
        return []

    # Jev is the last resort after granted policies and precedents, so what reaches it is the least familiar case.
    # When it is unsure, the crash lines wait for a person; the question leads `why` so the 512-char cut keeps it.
    ask = ""
    if decided_by == "jev":
        unsure, jev_sev, conf = jev_unsure(jev, sev_p)
        if unsure:
            status = "needs_person"
            ask = (f"Asks the Head of Racing Finance: Jev is unsure (severity {jev_sev}, P={conf:.2f} < {ask_floor():.2f}). "
                   "Confirm or correct. ")

    out: list[Effect] = []
    if "cost_cents" in tpl:
        lo, mid, hi = _band(*tpl["cost_cents"])
        detail = []
    else:
        (lo, mid, hi), detail = damage_band(parts_p, sev_p, ctx)
    sev = max(sev_p, key=sev_p.get)
    where = f"L{event.lap} {event.payload.get('turn') or ''}".strip()
    reason = event.payload.get("reason") or event.payload.get("summary") or event.kind.replace("_", " ")
    why = (f"{event.kind.replace('_', ' ')} for car {car} at {where}: {reason}. Severity {sev} "
           f"(P={sev_p.get(sev, 0):.2f}); parts weighted by P(damaged){basis_note}.")

    prev = ctx.booked.get(car)
    retired = ctx.positions.get(car, 0) is None or (event.state is not None and event.state.status.startswith("retired"))
    if prev and (retired or abs(event.lap - prev["lap"]) <= 10):
        # Same crash, later evidence (the stewards' message after our own retirement call). Post only a revision,
        # and never a smaller one for a car that is out: a late "noted" message carries no news about the damage.
        if retired:
            lo, mid, hi = max(lo, prev["low"]), max(mid, prev["mid"]), max(hi, prev["high"])
        if prev["mid"] == 0 or abs(mid - prev["mid"]) / max(prev["mid"], 1) < REVISION_FLOOR:
            return []
        d_lo, d_mid, d_hi = _band(lo - prev["low"], mid - prev["mid"], hi - prev["high"])
        ctx.booked[car] = {"lap": prev["lap"], "mid": mid, "low": lo, "high": hi}
        ctx.race_cost_mid += d_mid
        out.append(Effect("cost", "6050", d_lo, d_mid, d_hi, f"Crash damage revision - car {car} - {reason.lower()}",
                          "assumption", decided_by, ask + "Revised estimate after new evidence: " + why, jev.log(), status))
        out.append(Effect("cap_headroom", "cap_headroom", ctx.cap_headroom_cents(), ctx.cap_headroom_cents(), ctx.cap_headroom_cents(),
                          "Cap headroom after revision", "policy", "code", "2026 cap less relevant costs to date less this race's crash damage (mid).", {}, "autonomous"))
        return out

    if mid <= 0:
        return []
    ctx.booked[car] = {"lap": event.lap, "mid": mid, "low": lo, "high": hi}
    parts_txt = ", ".join(f"{d['label']} {int(d['p'] * 100)}%" for d in detail[:5]) or "fixed band"
    basis = "precedent" if precedent and not policy else "assumption"
    out.append(Effect("cost", "6050", lo, mid, hi, f"Crash damage - car {car} - {parts_txt}", basis, decided_by, ask + why, jev.log(), status))
    labour = P.REPAIR_LABOUR.get(sev)
    if labour and labour.mid > 0:
        l, m, h = (ctx.gbp_cents(labour.low), ctx.gbp_cents(labour.mid), ctx.gbp_cents(labour.high))
        out.append(Effect("cost", "5200", l, m, h, f"Crash repair labour ({sev}) - car {car}", labour.basis, decided_by,
                          ask + f"Overtime and contract labour for a {sev} repair.", {}, status))
        mid += m
        lo += l
        hi += h
    if ctx.next_race_flyaway and ctx.next_race_days is not None and ctx.next_race_days <= 7 and sev in ("moderate", "heavy"):
        f = P.EXPEDITED_FREIGHT
        l, m, h = (ctx.gbp_cents(f.low), ctx.gbp_cents(f.mid), ctx.gbp_cents(f.high))
        out.append(Effect("cost", "6300", l, m, h, f"Priority air freight of replacement parts - car {car}", f.basis, decided_by,
                          ask + f"Next race is a flyaway in {ctx.next_race_days} days; parts travel by priority air.", {}, status))
        mid += m
    ctx.race_cost_mid += mid
    hr = ctx.cap_headroom_cents()
    out.append(Effect("cap_headroom", "cap_headroom", hr, hr, hr, "Cap headroom after this incident", "policy", "code",
                      "2026 cap ($215m) less relevant costs to date less this race's crash damage (mid).", {}, "autonomous"))
    return out


def prize_effects(event: RaceEvent, jev: JevAnswers, ctx: EffectsContext) -> list[Effect]:
    if not ctx.standings_start or not ctx.team_of:
        return []
    standings = projected_standings(ctx.standings_start, ctx.positions, ctx.team_of, ctx.sprint)
    new_pos = position_of(ctx.team, standings)
    if new_pos is None:
        return []
    old_pos = ctx.prize_position
    ctx.prize_position = new_pos
    if ctx.prize_position_before is None:
        ctx.prize_position_before = old_pos if old_pos is not None else new_pos
    if old_pos is None or old_pos == new_pos:
        return []
    delta = ctx.world.prize(new_pos) - ctx.world.prize(old_pos)
    arrow = "up" if new_pos < old_pos else "down"
    pts = dict(standings)
    why = (f"Projected constructors' position moves from P{old_pos} to P{new_pos} ({arrow}) on the running order: "
           f"{ctx.team} {pts.get(ctx.team, 0):.0f} pts projected. Prize ladder is the synthetic world table; real payouts are confidential.")
    return [Effect("revenue_projection", "prize_money", delta, delta, delta,
                   f"Projected season prize money: P{old_pos} -> P{new_pos}", "ladder", "code", why, jev.log() if jev.relevant else {}, "autonomous")]


def bonus_effects(event: RaceEvent, jev: JevAnswers, ctx: EffectsContext) -> list[Effect]:
    from finance.bonuses import _qualifies

    out: list[Effect] = []
    for sponsor, clause in ctx.clauses():
        for car in ctx.team_cars():
            pos = ctx.positions.get(car)
            key = f"{sponsor['id']}|{clause['id']}|{car}"
            qualifies = _qualifies(clause, _Row(pos))
            prev = ctx.bonus_state.get(key)
            amount = int(clause.get("amount") or 0)
            if qualifies and prev != "expected":
                ctx.bonus_state[key] = "expected"
                out.append(Effect("bonus", f"sponsor_bonus:{sponsor['id']}", amount, amount, amount,
                                  f"{sponsor['name']} clause {clause['id']} ({clause['type']}) expected - car {car} P{pos}", "contract", "code",
                                  f"Car {car} runs P{pos}, inside the clause's window; booked as expected until the result is final.", {}, "autonomous"))
            elif not qualifies and prev == "expected":
                ctx.bonus_state[key] = "lost"
                out.append(Effect("bonus", f"sponsor_bonus:{sponsor['id']}", -amount, -amount, -amount,
                                  f"{sponsor['name']} clause {clause['id']} ({clause['type']}) lost - car {car} {'OUT' if pos is None else f'P{pos}'}",
                                  "contract", "code", f"Car {car} left the clause's window ({event.kind.replace('_', ' ')}).", jev.log() if jev.bonus_risk >= 1 else {}, "autonomous"))
    return out


# ---------------------------------------------------------------------- entry point

def pit_stop_effects(event: RaceEvent, policy: Policy | None, precedent: PrecedentMatch | None, ctx: EffectsContext) -> list[Effect]:
    """A tyre change is supplied kit: the protocol books it as a zero-cost line so the tape shows the desk saw it."""
    granted = policy if policy and policy.autonomy == "GRANTED" else None
    if not granted and not precedent:
        return []
    under = event.payload.get("under") or "green"
    if granted:
        decided_by, why = f"policy:{granted.policy_id}", f"Policy {granted.policy_id}: {granted.title or 'pit stop protocol'}."
    else:
        decided_by, why = "precedent:" + ",".join(precedent.case_ids[:4]), precedent.why()
    memo = f"Tyre set {event.state.compound if event.state and event.state.compound else ''} fitted at L{event.lap}".strip()
    memo += " under the safety car: free stop" if under in ("sc", "vsc") else ": supplied tyres, no cost line"
    return [Effect("cost", "tyres", 0, 0, 0, memo, "policy" if granted else "precedent", decided_by, why, {}, "autonomous")]


def effects_for(event: RaceEvent, jev: JevAnswers, policy: Policy | None, ctx: EffectsContext,
                precedent: PrecedentMatch | None = None) -> list[Effect]:
    team_car = ctx.team_of.get(event.driver_number) == ctx.team
    involved = team_car or bool(event.payload.get("team_involved"))

    # keep the running order current for every car, ours or not
    if event.kind == "position" and event.payload.get("to"):
        ctx.positions[event.driver_number] = int(event.payload["to"])
    elif event.kind in ("retirement_suspected", "retirement_confirmed"):
        ctx.positions[event.driver_number] = None
    elif event.kind == "standings" and event.payload.get("team") and event.payload.get("points_start") is not None:
        ctx.standings_start.setdefault(event.payload["team"], float(event.payload["points_start"]))

    out: list[Effect] = []
    if event.kind in ("car_stopped", "incident", "retirement_suspected", "retirement_confirmed") and involved:
        out += crash_effects(event, jev, policy, ctx, precedent)
    if event.kind == "pit_stop" and team_car:
        out += pit_stop_effects(event, policy, precedent, ctx)
    if event.kind in ("position", "retirement_suspected", "retirement_confirmed", "standings"):
        out += prize_effects(event, jev, ctx)
        out += bonus_effects(event, jev, ctx)
    return out
