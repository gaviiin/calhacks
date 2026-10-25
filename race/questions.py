"""Stage 5, ask: a person is asked when a wrong answer would cost more than the question.

    questions_for(incident, effects, state) -> list[Question]   # at most one damage question per incident
    apply_answers(state, sink, book) -> list[Incident]           # incidents re-decided by answers since the last call

When to ask. Not on a model's say-so alone: self-reported LLM confidence is poorly calibrated. The desk asks when
either (a) the crash lines wait for a person already (Jev unsure, status needs_person: race/effects.py), or (b) the
expected loss of booking the most likely severity is above the price of a question: the sum over the other
severities of P(severity) x the dollar gap between their bands, or (c) the learned history disagrees with Jev:
the nearest precedent ended differently (the committee idea behind Varun Sanjeev's Jev gate on var930). The price
of a question is RACE_ASK_PRICE_USD (default $50,000): a setting a person controls, like RACE_ASK_FLOOR.

How to ask. A choice between two cases the team has lived through that ended differently ("more like Melbourne
2024, chassis broken, or like the Mexico lap-1 contact, a front wing?"), each with its band, so one answer names
the deciding difference instead of a number typed from memory. The default, taken if nobody answers before the
deadline, is the heavier option: reserving spares that turn out unneeded is cheap; running short is not.

What an answer does. The incident is assessed with the chosen severity; the crash lines are confirmed (same band)
or corrected (the option's band) through the module, which writes race_precedents rows; the case joins the live
precedent store so the next similar event matches it; and the weekend re-runs the stages for the incident.
"""

from __future__ import annotations

import json
import os
import time
from datetime import timedelta
from pathlib import Path

from race import prices as P
from race.events import Effect, Incident, Question
from race.precedents import Case, similarity

SEVERITIES = ("heavy", "moderate", "light")
CRASH_BUCKETS = ("6050", "5200", "6300")
BEFORE_NEXT_SESSION = timedelta(minutes=90)  # a qualifying crash must be settled well before the race starts
AFTER_SESSION = timedelta(minutes=60)  # a race crash, an hour after the flag (the garage has the car stripped)
POLL_SECONDS = 1.0


def ask_price_cents() -> int:
    return int(float(os.environ.get("RACE_ASK_PRICE_USD", "50000")) * 100)


def _gbp(x: float) -> int:
    return int(round(x * P.USD_PER_GBP * 100))


def severity_band(sev: str) -> tuple[int, int, int]:
    """Parts plus labour for a crash of this severity, from the price book's template (USD cents)."""
    lo = mid = hi = 0.0
    for part, p in P.SEVERITY_TEMPLATES.get(sev, []):
        price = P.PARTS.get(part)
        if not price:
            continue
        mid += p * price.mid
        if p >= 0.5:
            lo += price.low
        if p >= 0.2:
            hi += price.high
    lab = P.REPAIR_LABOUR.get(sev)
    if lab:
        lo, mid, hi = lo + lab.low, mid + lab.mid, hi + lab.high
    a, b, c = sorted((_gbp(lo), _gbp(mid), _gbp(hi)))
    return a, b, c


def expected_loss(sev_p: dict[str, float]) -> tuple[int, str]:
    """(cents, the severity we would book): what booking the most likely severity costs us in expectation if wrong."""
    p = {s: float(sev_p.get(s, 0.0)) for s in SEVERITIES}
    if not any(p.values()):
        return 0, "light"
    top = max(p, key=p.get)
    mid_top = severity_band(top)[1]
    return int(sum(w * abs(severity_band(s)[1] - mid_top) for s, w in p.items() if s != top)), top


def _view(inc: Incident) -> dict:
    b = inc.belief
    return {"kind": "car_stopped", "reason": "", "retired_within_laps": 0 if inc.status in ("confirmed",) or b.get("out_of_session") else None,
            "under": b.get("track_status") or "green", "damage_likely": True}


def contrastive_pair(inc: Incident, store, sev_p: dict[str, float]) -> list[dict]:
    """The two nearest cases the team has lived through, with different outcomes, as the answers on the buttons."""
    view = _view(inc)
    best: dict[str, tuple[float, Case]] = {}
    for c in getattr(store, "cases", []):
        if c.outcome not in SEVERITIES:
            continue
        s = similarity({**view, "kind": c.kind}, c) + (0.05 if c.source == "press" else 0.0)
        if c.outcome not in best or s > best[c.outcome][0]:
            best[c.outcome] = (s, c)
    ranked = sorted(SEVERITIES, key=lambda o: -(sev_p.get(o, 0.0) + 0.3 * (best[o][0] if o in best else 0.0)))
    out = []
    for i, o in enumerate(ranked[:2]):
        lo, mid, hi = severity_band(o)
        case = best.get(o)
        label = case_label(case[1]) if case else ""
        out.append({"id": "ab"[i], "severity": o, "band": [lo, mid, hi], "case_id": case[1].case_id if case else "",
                    "label": f"{label}: {o}" if label else f"{o.capitalize()} damage",
                    "detail": (case[1].summary if case else f"price-book template for {o} damage") + f" · ${mid / 1e8:.2f}m mid"})
    if len(out) != 2:
        return [], ""
    # The default if nobody answers: the likelier option, or the heavier when the two are close (reserving spares
    # that turn out unneeded is cheap; running short is not).
    a, b = out
    pa, pb = sev_p.get(a["severity"], 0.0), sev_p.get(b["severity"], 0.0)
    heavier = a if SEVERITIES.index(a["severity"]) < SEVERITIES.index(b["severity"]) else b
    default = heavier["id"] if abs(pa - pb) <= 0.1 else (a["id"] if pa > pb else b["id"])
    return out, default


SESSION_NAMES = Path(__file__).resolve().parent / "data" / "session_names.json"


def case_label(c: Case) -> str:
    """'Melbourne 2024 FP1, Albon' for a press case; 'Japan 2024 race, car 23, lap 1' for one from the tape."""
    if c.source == "press":
        return c.summary.split(":")[0]
    try:
        names = json.loads(SESSION_NAMES.read_text())
    except (OSError, ValueError):
        names = {}
    where = names.get(str(c.session_key), f"session {c.session_key}")
    return f"{where}, car {c.car}, lap {c.lap}" if c.car else where


def deadline_for(inc: Incident, state) -> str:
    """Race time by which a person should answer; past it the desk takes the default and says so."""
    from race.events import iso, parse_iso

    sessions = [int(k) for k in state.info.get("sessions", [])]
    later = [k for k in sessions if k > inc.session_key] if inc.session_key in sessions else []
    nxt = later[0] if later else None
    if nxt is not None:
        try:
            start = json.loads((Path(__file__).resolve().parent / "fixtures" / str(nxt) / "session.json").read_text())["date_start"]
            return iso(parse_iso(start) - BEFORE_NEXT_SESSION)
        except (OSError, ValueError, KeyError):
            pass
    end = (state.session or {}).get("date_end") or inc.updated_at
    return iso(parse_iso(end) + AFTER_SESSION)


def _event_of(effects: list[Effect], state):
    for ev, effs in reversed(state.effects):
        if effs is effects:
            return ev
    return None


def questions_for(inc: Incident, effects: list[Effect], state) -> list[Question]:
    if inc.status in ("assessed", "closed"):
        return []
    key = f"{inc.incident_key}:damage"
    if key in state.questions:
        return []
    crash = [e for e in effects if e.kind == "cost" and e.bucket in CRASH_BUCKETS]
    waiting = any(e.status == "needs_person" for e in crash)
    sev_p = inc.belief.get("severity") or {}
    loss, top = expected_loss(sev_p)
    store = getattr(getattr(state, "replay", None), "precedents", None)
    options, default = contrastive_pair(inc, store, sev_p) if store is not None else ([], "")
    disagree = bool(options) and options[0]["severity"] != top and sev_p.get(top, 0) < 0.75
    if not (waiting or loss >= ask_price_cents() or disagree) or not options:
        return []
    ev = _event_of(effects, state)
    effect_keys = [f"{ev.key}:{i}" for i, e in enumerate(effects) if e in crash] if ev is not None else []
    b = inc.belief
    what = f"stopped from {b['impact_kph']} km/h" if b.get("impact_kph") else "involved in an incident"
    why = ("Jev is unsure" if waiting else "the learned cases disagree with Jev" if disagree else "a wrong call would cost more than asking")
    prompt = f"Car {inc.driver_number} {what}. Is the damage more like {options[0]['label'].removeprefix('Like ')} or {options[1]['label'].removeprefix('Like ')}?"
    deadline = deadline_for(inc, state)
    return [Question(question_key=key, incident_key=inc.incident_key, kind="damage", prompt=prompt[:1024], options=options,
                     route_role="chief_mechanic", expected_loss_cents=loss, deadline_at=deadline, effect_keys=effect_keys,
                     default_option=default, created_at=inc.updated_at, answer={"why_asked": why})]


# ---------------------------------------------------------------------- answers

def _answered(state, sink) -> list[tuple[Question, dict, str]]:
    """(question, answer, by) for answers not yet applied: from pit-wall when connected, else from memory (tests)."""
    applied = state.applied_answers
    out = []
    if sink is not None and not getattr(sink, "disabled", True):
        now = time.monotonic()
        if now - getattr(state, "_last_poll", 0.0) < POLL_SECONDS:
            return []
        state._last_poll = now
        for r in sink.sql("SELECT * FROM race_questions"):
            k = r.get("question_key")
            if k in applied or r.get("status") not in ("answered", "defaulted") or k not in state.questions:
                continue
            try:
                ans = json.loads(r.get("answer_json") or "{}")
            except ValueError:
                ans = {}
            out.append((state.questions[k], ans, r.get("answered_by") or "a person"))
    else:
        for q in state.questions.values():
            if q.question_key not in applied and q.status in ("answered", "defaulted"):
                out.append((q, q.answer, q.answered_by or "a person"))
    return out


def _expire(state, sink) -> None:
    """Past the deadline in race time, nobody answered: the desk takes the stated default and says so."""
    for q in state.questions.values():
        if q.status == "open" and q.deadline_at and state.now and state.now >= q.deadline_at and q.question_key not in state.applied_answers:
            if sink is not None and not getattr(sink, "disabled", True):
                sink.default_question(q.question_key, state.now)
            else:
                q.status, q.answer, q.answered_by = "defaulted", {"option": q.default_option, "defaulted": True}, "deadline"


def apply_answers(state, sink, book) -> list[Incident]:
    _expire(state, sink)
    changed = []
    for q, ans, by in _answered(state, sink):
        state.applied_answers.add(q.question_key)
        opt = next((o for o in q.options if o["id"] == ans.get("option")), None)
        if opt is None and ans.get("band"):
            opt = {"id": "neither", "severity": ans.get("severity", "moderate"), "band": ans["band"], "label": ans.get("note", "a person's own band")}
        if opt is None:
            continue
        q.status = "defaulted" if ans.get("defaulted") else "answered"
        q.answer, q.answered_by = ans, by
        inc = state.incidents.get(q.incident_key)
        if inc is None:
            continue
        verb = "the deadline passed; the desk took" if ans.get("defaulted") else f"{by} answered"
        book.assess(inc, {"severity": {s: (1.0 if s == opt["severity"] else 0.0) for s in (*SEVERITIES, "none")}, "assessed_as": opt["severity"],
                          "assessed_band": opt["band"], "assessed_by": by, "precedent": opt.get("case_id", "")},
                    f"{verb} {opt['label']}", state.now or inc.updated_at)
        _apply_to_lines(q, opt, by, state, sink)
        if not ans.get("defaulted"):
            _learn(inc, opt, by, state)  # a default is the desk's own choice, not something a person taught it
        changed.append(inc)
    return changed


def _apply_to_lines(q: Question, opt: dict, by: str, state, sink) -> None:
    lo, mid, hi = (int(x) for x in opt["band"])
    reason = f"{by}: {opt['label']} ({q.question_key})"[:512]
    for ev, effs in state.effects:
        for i, e in enumerate(effs):
            k = f"{ev.key}:{i}"
            if k not in q.effect_keys:
                continue
            if e.bucket == "6050" and abs(e.mid_cents - mid) > 0.05 * max(mid, 1):
                parts_lo, parts_mid, parts_hi = _parts_share(opt["severity"], lo, mid, hi)
                e.status = "corrected"
                if sink is not None:
                    sink.correct(k, parts_lo, parts_mid, parts_hi, reason, by, state.now)
            elif e.status in ("needs_person", "proposed"):
                e.status = "confirmed"
                if sink is not None:
                    sink.confirm(k, reason, by, state.now)


def _parts_share(sev: str, lo: int, mid: int, hi: int) -> tuple[int, int, int]:
    """The option's band includes labour; the 6050 line is parts only."""
    lab = P.REPAIR_LABOUR.get(sev)
    if not lab:
        return lo, mid, hi
    a, b, c = (max(0, x - _gbp(y)) for x, y in ((lo, lab.low), (mid, lab.mid), (hi, lab.high)))
    a, b, c = sorted((a, b, c))
    return a, b, c


def _learn(inc: Incident, opt: dict, by: str, state) -> None:
    """The answer joins the live precedent store, so the next stop like it matches without asking."""
    store = getattr(getattr(state, "replay", None), "precedents", None)
    if store is None:
        return
    v = _view(inc)
    store.add(Case(case_id=f"answer-{inc.incident_key}", kind="car_stopped", outcome=opt["severity"], reason="", retired_within_laps=v["retired_within_laps"],
                   under=v["under"], damage_likely=True, source="correction", session_key=inc.session_key, car=inc.driver_number,
                   summary=f"{by} on {inc.incident_key}: {opt['label']}", cost_cents=list(opt["band"])))
