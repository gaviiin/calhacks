"""People's decisions replayed into a demo: what the team actually decided before the snapshot, at the race time it
happened, through the same reducers a person's click uses. Every one is labelled '(replayed)' in its `by`.

    script = load_script(1249)              # race/data/snapshot_<meeting>.json, or None
    apply_due(state, sink, script, now)     # the decisions whose time has come; returns what it applied
"""

from __future__ import annotations

import json
from pathlib import Path

DATA = Path(__file__).resolve().parent / "data"


def load_script(meeting_key: int) -> dict | None:
    p = DATA / f"snapshot_{meeting_key}.json"
    return json.loads(p.read_text()) if p.exists() else None


def apply_due(state, sink, script: dict | None, now: str) -> list[str]:
    if not script or not now:
        return []
    done = getattr(state, "replayed", None)
    if done is None:
        done = state.replayed = set()
    out = []
    for i, d in enumerate(script.get("decisions", [])):
        if i in done or d["at"] > now:
            continue
        if d["kind"] == "answer":
            ok = _answer(state, sink, d)
        elif d["kind"] == "choose":
            ok = _choose(state, sink, d)
        else:
            ok = True
        if ok:
            done.add(i)
            out.append(f"{d['by']}: {d['kind']} {d['pick']} on {d['incident']} ({d['why']})")
    return out


def _answer(state, sink, d: dict) -> bool:
    q = state.questions.get(f"{d['incident']}:damage")
    if q is None:
        return False  # not asked yet: try again on a later event
    if q.status != "open":
        return True
    opt = next((o for o in q.options if o.get("severity") == d["pick"]), None) or q.options[0]
    answer = {"option": opt["id"], "replayed": True, "why": d["why"]}
    if sink is not None and not getattr(sink, "disabled", True):
        return sink.call("answer_race_question", [q.question_key, json.dumps(answer), d["by"], d["at"]])
    q.status, q.answer, q.answered_by = "answered", answer, d["by"]
    return True


def _choose(state, sink, d: dict) -> bool:
    key = f"{d['incident']}:withdraw_car"
    a = state.actions.get(key)
    if a is None:
        inc = state.incidents.get(d["incident"])
        # Once the garage has assessed the car, no decision may be needed at all (a moderate repair is routine).
        return bool(inc and inc.status in ("assessed", "closed"))
    if a.status != "awaiting_approval":
        return True
    if sink is not None and not getattr(sink, "disabled", True):
        ok = sink.call("choose_race_action_option", [key, d["pick"], d["by"], d["at"]])
    else:
        ok = True
    if ok:
        a.status = "approved"
        a.detail = {**a.detail, "chosen": d["pick"], "chosen_by": d["by"], "chosen_at": d["at"]}
    return ok
