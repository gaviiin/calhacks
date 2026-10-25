"""A person's edits to a response plan, in their own words, turned into operations the desk executes.

    changes, model = interpret(text, inc, state)          # Claude reads the words against the plan's own lines
    edits = record(state, inc, changes, by=..., edit_key=..., text=...)
    acts = overlay(inc, acts, state)                       # logistics.plan calls this: the edits stay in force

The chief of staff approves a plan with edits ("hand carry the floor instead of the air freight; add a power unit check;
the parc fermé list goes to the Technical Director"). pit-wall holds the plan ('revising') until the desk has applied
them. The desk reads the words into a short list of changes from a fixed set, each naming a line of the plan by its ref:

    cancel    ref                      the operation is not done
    reroute   ref, to, parts           parts move between the air freight and the hand carry
    source    ref, to                  a spare comes from the track, from Grove, or is made
    add       kind, part, title, owner a new operation: a spare, a work order, a power unit check, or a task for a person
    retime    ref, due                 a new deadline
    reassign  ref, owner               a different owner
    note      text                     words the desk could not turn into an operation: on the record, not applied

The changes are kept per incident and laid over every later re-plan (`overlay`), so a later event that rebuilds the
operations never undoes what a person asked for. Each changed operation says whose edit changed it. Then the plan is
rebuilt against the team's history: a new kind of operation, or a part the team has not handled that way, is novel and
waits for the Head of Cost Cap like any other novel line.

Entries are not edited here: the money follows the garage's assessment and the Books, so an edit that asks for one comes
back as a note saying where to make it.
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import timedelta

from race import prices as P
from race.events import Action, Incident, iso, parse_iso

log = logging.getLogger(__name__)

OPS = ("cancel", "reroute", "source", "add", "retime", "reassign", "note")
ADD_KINDS = ("spares_reserve", "work_order", "pu_check", "task")
SOURCES = ("at_track", "factory", "make")
OWNERS = ("chief_mechanic", "technical_director", "team_principal", "sporting_director", "logistics", "head_of_cost_cap",
          "head_of_strategy", "chief_of_staff", "cfo", "press_office")
DONE = ("done",)  # an operation already carried out is not undone by an edit

# words a person uses for a part, longest first so "front wing" wins over "wing"
PART_WORDS: list[tuple[str, str]] = sorted(
    [(v, k) for k, v in P.PART_LABELS.items() if k not in ("tyre", "chassis_repair")]
    + [("floor", "floor"), ("front wing", "front_wing"), ("rear wing", "rear_wing"), ("wing", "front_wing"), ("tub", "chassis"),
       ("monocoque", "chassis"), ("chassis", "chassis"), ("survival cell", "chassis"), ("gearbox", "gearbox"), ("power unit", "power_unit"),
       ("pu", "power_unit"), ("engine", "power_unit"), ("front suspension", "front_suspension"), ("rear suspension", "rear_suspension"),
       ("suspension", "front_suspension"), ("brakes", "brakes"), ("bodywork", "bodywork"), ("loom", "electronics"), ("electronics", "electronics"),
       ("steering", "steering_rack"), ("diffuser", "floor")],
    key=lambda x: -len(x[0]),
)
OWNER_WORDS = [("technical director", "technical_director"), ("chief mechanic", "chief_mechanic"), ("team principal", "team_principal"),
               ("sporting director", "sporting_director"), ("logistics", "logistics"), ("head of cost cap", "head_of_cost_cap"),
               ("strategy", "head_of_strategy"), ("chief of staff", "chief_of_staff"), ("cfo", "cfo"), ("press", "press_office"),
               ("garage", "chief_mechanic"), ("factory", "technical_director"), ("grove", "technical_director")]


def _label(part: str) -> str:
    return "monocoque" if part == "chassis" else P.PART_LABELS.get(part, part.replace("_", " "))


def lines_of(inc: Incident, state) -> list[dict]:
    """What the desk shows the reader: the incident's operations as plan lines, with their refs and parts."""
    out = []
    for a in sorted((x for x in (state.actions or {}).values() if x.incident_key == inc.incident_key), key=lambda x: x.action_key):
        if a.kind in ("garage_check", "withdraw_car"):
            continue
        d = a.detail or {}
        raw = d.get("parts") or ([d["part"]] if d.get("part") else [])
        parts = [str(x.get("part") if isinstance(x, dict) else x) for x in raw if x]
        out.append({"ref": a.action_key, "kind": a.kind, "title": a.title, "status": a.status, "owner": a.owner_role, "parts": parts,
                    "source": d.get("source", ""), "due": a.due_at})
    return out


# ---------------------------------------------------------------------- reading the words

def _parts_in(text: str) -> list[str]:
    t = f" {text.lower()} "
    found: list[str] = []
    for word, part in PART_WORDS:
        if re.search(rf"(?<![a-z]){re.escape(word)}(?![a-z])", t) and part not in found:
            found.append(part)
            t = t.replace(word, " ")
    return found


def _owner_in(text: str) -> str:
    t = text.lower()
    return next((o for w, o in OWNER_WORDS if w in t), "")


def _find(lines: list[dict], kind: str, part: str = "") -> dict | None:
    for ln in lines:
        if ln["kind"] == kind and (not part or part in ln["parts"] or ln["ref"].endswith(f":{part}")):
            return ln
    return None


_KIND_WORDS = [("air freight", "freight"), ("freight", "freight"), ("hand carry", "hand_carry"), ("hand-carry", "hand_carry"),
               ("work order", "work_order"), ("rebuild", "work_order"), ("parc ferm", "parc_ferme_list"), ("notice", "fia_notice"),
               ("power unit check", "pu_check"), ("pu check", "pu_check"), ("gearbox check", "pu_check"), ("reserv", "spares_reserve"),
               ("spare", "spares_reserve"), ("inventory", "td017_move"), ("evidence", "evidence_pack")]


def _kind_in(text: str) -> str:
    t = text.lower()
    return next((k for w, k in _KIND_WORDS if w in t), "")


def offline_interpret(text: str, lines: list[dict]) -> list[dict]:
    """The deterministic reader: one clause at a time, a few verbs a chief of staff uses. Anything else is a note."""
    clauses = [c.strip(" ,") for c in re.split(r"[.;\n]+|\band then\b|,\s*and\b|\band also\b", text) if c and c.strip(" ,")]
    out: list[dict] = []
    for c in clauses:
        low = c.lower()
        parts = _parts_in(c)
        kind = _kind_in(c)
        owner = _owner_in(c)
        if re.search(r"\b(entry|entries|accrual|accrue|journal|posting|invoice)\b|\$\d", low):
            out.append({"op": "note", "text": c, "why": "entries follow the garage's assessment: change them in Books"})
        elif re.search(r"\b(cancel|skip|drop|scrap|don'?t|do not|no need|not needed|no longer)\b", low):
            target = _find(lines, kind, parts[0] if parts and kind in ("work_order", "spares_reserve") else "") if kind else None
            if target is None and parts:
                target = _find(lines, "work_order", parts[0]) or _find(lines, "spares_reserve", parts[0])
            out.append({"op": "cancel", "ref": target["ref"], "why": c} if target else {"op": "note", "text": c, "why": "no line of the plan matches what to cancel"})
        elif re.search(r"\bhand[- ]?carr", low) and not re.search(r"\b(cancel|skip)\b", low):
            src = _find(lines, "freight")
            moved = parts or (src["parts"] if src else [])
            if src and moved:
                out.append({"op": "reroute", "ref": src["ref"], "to": "hand_carry", "parts": moved, "why": c})
            else:
                out.append({"op": "note", "text": c, "why": "nothing on the air freight to hand carry"})
        elif re.search(r"\b(air freight|fly|ship)\b", low) and re.search(r"\b(instead|rather|move|put)\b", low):
            src = _find(lines, "hand_carry")
            moved = parts or (src["parts"] if src else [])
            out.append({"op": "reroute", "ref": src["ref"], "to": "freight", "parts": moved, "why": c} if src and moved else {"op": "note", "text": c, "why": "nothing on the hand carry to move"})
        elif re.search(r"\bfrom (grove|the factory)\b|\bfrom the track\b|\bat the track\b|\bmake a new\b|\bbuild a new\b", low) and parts:
            to = "factory" if re.search(r"grove|factory", low) else "at_track" if "track" in low else "make"
            target = _find(lines, "spares_reserve", parts[0])
            out.append({"op": "source", "ref": target["ref"], "to": to, "why": c} if target else {"op": "note", "text": c, "why": f"no spare reserved for the {_label(parts[0])}"})
        elif re.search(r"\b(assign|give|hand over|owned by|goes to|is for)\b", low) and owner and kind:
            target = _find(lines, kind, parts[0] if parts else "")
            out.append({"op": "reassign", "ref": target["ref"], "owner": owner, "why": c} if target else {"op": "note", "text": c, "why": "no line of the plan matches"})
        elif re.search(r"\b(add|also|order|raise|book|reserve|run|do|tell|ask|brief|call|email|notify|get)\b", low):
            if kind == "pu_check" or ("check" in low and ("power unit" in low or "gearbox" in low or re.search(r"\bpu\b", low))):
                out.append({"op": "add", "kind": "pu_check", "part": "", "title": c[:120], "owner": owner or "technical_director", "why": c})
            elif kind == "work_order" and parts:
                out.append({"op": "add", "kind": "work_order", "part": parts[0], "title": c[:120], "owner": owner or "technical_director", "why": c})
            elif not kind and parts and re.search(r"\b(order|build|make)\b", low):
                out.append({"op": "add", "kind": "work_order", "part": parts[0], "title": c[:120], "owner": owner or "technical_director", "why": c})
            elif kind == "spares_reserve" and parts:
                out.append({"op": "add", "kind": "spares_reserve", "part": parts[0], "title": c[:120], "owner": owner or "chief_mechanic", "why": c})
            else:
                out.append({"op": "add", "kind": "task", "part": parts[0] if parts else "", "title": c[:120], "owner": owner or "chief_of_staff", "why": c})
        else:
            out.append({"op": "note", "text": c, "why": "not an operation the desk can carry out"})
    return out


SYSTEM_PROMPT = """You read a chief of staff's edits to a Formula 1 team's response plan after a crash and turn them into changes
from a fixed list. The plan's lines are given as data: each has a ref, a kind, a title, its parts and its owner.

Rules:
- Use only these ops: cancel(ref), reroute(ref of the freight or hand_carry line, to: freight|hand_carry, parts), source(ref of a
  spares_reserve line, to: at_track|factory|make), add(kind: spares_reserve|work_order|pu_check|task, part, title, owner), retime(ref,
  due as ISO 8601 UTC), reassign(ref, owner), note(text) for anything you cannot express with the others.
- A ref must be one of the lines given. Never invent a ref. Parts are ids like floor, front_wing, chassis, gearbox, power_unit.
- Owners: chief_mechanic, technical_director, team_principal, sporting_director, logistics, head_of_cost_cap, head_of_strategy,
  chief_of_staff, cfo, press_office.
- A request about money (an entry, an accrual, a posting) is a note: entries follow the garage's assessment and are changed in Books.
- One change per thing the person asked for. Quote the words each change comes from in why.
- Call submit_changes once."""


def claude_interpret(text: str, inc: Incident, lines: list[dict]) -> list[dict] | None:
    from anthropic import beta_tool
    from anthropic.lib.tools import ToolError

    from agents import llm

    client = llm.make_client()
    out: list[dict] = []

    @beta_tool(strict=True)
    def submit_changes(changes_json: str) -> str:
        """Finish: changes_json is a JSON array of change objects, each {"op": ..., and the fields that op takes, "why": the person's words}."""
        try:
            ch = json.loads(changes_json)
        except json.JSONDecodeError as exc:
            raise ToolError(f"changes_json must be a JSON array: {exc}") from exc
        if not isinstance(ch, list):
            raise ToolError("changes_json must be a JSON array")
        bad = [c for c in ch if not isinstance(c, dict) or c.get("op") not in OPS]
        if bad:
            raise ToolError(f"unknown op in {bad[:2]}; use only {OPS}")
        refs = {ln["ref"] for ln in lines}
        wrong = [c for c in ch if c.get("op") in ("cancel", "reroute", "source", "retime", "reassign") and c.get("ref") not in refs]
        if wrong:
            raise ToolError(f"refs not in the plan: {[c.get('ref') for c in wrong]}")
        out.extend(ch)
        return "recorded"

    data = {"car": inc.driver_number, "incident": inc.incident_key, "lines": lines}
    user = (f"The plan's lines:\n```data\n{json.dumps(data, indent=1)}\n```\n\nThe chief of staff's edits, in their words:\n"
            f"```edits\n{text}\n```\nTurn the edits into changes and call submit_changes once.")
    runner = client.beta.messages.tool_runner(**llm.common_kwargs(max_tokens=3000), system=SYSTEM_PROMPT, tools=[submit_changes],
                                              messages=[{"role": "user", "content": user}], max_iterations=4)
    for message in runner:
        if llm.check_stop(message, "plan edits") == "refusal":
            break
    return out or None


def interpret(text: str, inc: Incident, state, offline: bool = False) -> tuple[list[dict], str]:
    """The changes the words ask for, and who read them: Claude, else the deterministic reader."""
    lines = lines_of(inc, state)
    if not (offline or os.environ.get("RACE_OFFLINE", "") in ("1", "true")):
        try:
            ch = claude_interpret(text, inc, lines)
            if ch:
                return [c for c in ch if isinstance(c, dict)], _model_name()
        except Exception as exc:  # the edits must still be read
            log.warning("plan edits: Claude unavailable (%s); reading them with the rules", exc)
    return offline_interpret(text, lines), "offline-rules"


def _model_name() -> str:
    try:
        from agents import config

        return str(config.model())
    except Exception:
        return "claude"


# ---------------------------------------------------------------------- keeping them, and laying them over the plan

def record(state, inc: Incident, changes: list[dict], *, by: str, edit_key: str, text: str) -> list[dict]:
    """Validate the changes against the plan as it stands and keep the ones that apply; every change comes back with
    `applied` and a plain `label` for the record."""
    lines = {ln["ref"]: ln for ln in lines_of(inc, state)}
    kept = getattr(state, "plan_edits", None)
    if kept is None:
        kept = {}
        state.plan_edits = kept
    mine = kept.setdefault(inc.incident_key, [])
    out = []
    for i, c in enumerate(changes):
        c = {k: v for k, v in c.items() if v not in (None, "")}
        op = c.get("op")
        ln = lines.get(str(c.get("ref") or ""))
        why_not = ""
        if op not in OPS or op == "note":
            why_not = c.get("why") or "not an operation the desk can carry out"
        elif op in ("cancel", "reroute", "source", "retime", "reassign") and ln is None:
            why_not = f"no line {c.get('ref')!r} in the plan"
        elif op in ("cancel", "reroute", "source", "retime", "reassign") and ln["status"] in DONE:
            why_not = f"{ln['title']} is already done"
        elif op == "reroute" and (c.get("to") not in ("freight", "hand_carry") or ln["kind"] not in ("freight", "hand_carry") or ln["kind"] == c.get("to")):
            why_not = "a reroute moves parts between the air freight and the hand carry"
        elif op == "source" and (c.get("to") not in SOURCES or ln["kind"] != "spares_reserve"):
            why_not = "a source change applies to a reserved spare: at the track, from Grove, or made"
        elif op == "add" and c.get("kind") not in ADD_KINDS:
            why_not = f"the desk can add {', '.join(ADD_KINDS)}"
        elif op == "add" and c.get("kind") in ("spares_reserve", "work_order") and not c.get("part"):
            why_not = "which part?"
        elif op == "retime":
            try:
                c["due"] = iso(parse_iso(str(c.get("due"))))
            except (ValueError, TypeError):
                why_not = "the new deadline is not a time"
        elif op == "reassign" and c.get("owner") not in OWNERS:
            why_not = f"unknown owner {c.get('owner')!r}"
        applied = not why_not
        change = {**c, "seq": len(mine) + 1, "edit_key": edit_key, "by": by, "edit_text": text[:400], "applied": applied,
                  "label": _describe(c, ln), "why": (c.get("why") or "")[:240] if applied else why_not[:240]}
        if applied:
            mine.append(change)
        out.append(change)
    return out


def _describe(c: dict, ln: dict | None) -> str:
    op = c.get("op")
    title = ln["title"] if ln else ""
    if op == "cancel":
        return f"Cancel: {title}"
    if op == "reroute":
        return f"{', '.join(_label(p) for p in c.get('parts') or [])} by {'hand carry' if c.get('to') == 'hand_carry' else 'air freight'} instead"
    if op == "source":
        return f"{title}: {dict(at_track='from the spares at the track', factory='from Grove', make='made new').get(str(c.get('to')), c.get('to'))}"
    if op == "add":
        return f"Add: {c.get('title') or c.get('kind')}"
    if op == "retime":
        return f"{title}: due {str(c.get('due'))[:16].replace('T', ' ')}"
    if op == "reassign":
        return f"{title}: now {str(c.get('owner')).replace('_', ' ')}"
    if op == "note":
        return f"Not an operation: {c.get('text') or c.get('why') or ''}"[:200]
    return f"Not applied: {c.get('text') or c.get('why') or op}"[:200]


def overlay(inc: Incident, acts: list[Action], state) -> list[Action]:
    """The playbook's operations with every applied edit laid over them, in the order they were made."""
    edits = (getattr(state, "plan_edits", None) or {}).get(inc.incident_key) or []
    if not edits:
        return acts
    by_key = {a.action_key: a for a in acts}
    order = [a.action_key for a in acts]
    prior = getattr(state, "actions", {}) or {}

    def stamp(a: Action, c: dict, why: str) -> Action:
        d = dict(a.detail or {})
        d["edited"] = [*(d.get("edited") or []), {"edit": c["edit_key"], "by": c["by"], "said": c.get("why") or c.get("edit_text", "")}][-4:]
        d["why"] = f"{why} ({c['by']}'s edit {c['edit_key']}). " + str((a.detail or {}).get("why") or "")
        return Action(action_key=a.action_key, incident_key=a.incident_key, kind=a.kind, title=a.title, detail=d, due_at=a.due_at, status=a.status,
                      owner_role=a.owner_role, reversible=a.reversible, outward=a.outward, decided_by=f"person:{c['by']}", updated_at=a.updated_at)

    def put(a: Action) -> None:
        if a.action_key not in by_key:
            order.append(a.action_key)
        by_key[a.action_key] = a

    for c in edits:
        op = c["op"]
        a = by_key.get(str(c.get("ref") or ""))
        if op == "cancel" and a is not None and a.status not in DONE:
            a = stamp(a, c, "Cancelled")
            a.status = "cancelled"
            put(a)
        elif op == "reroute" and a is not None:
            moved = [p for p in c.get("parts") or [] if p in (a.detail or {}).get("parts", [])] or list((a.detail or {}).get("parts") or [])
            left = [p for p in (a.detail or {}).get("parts", []) if p not in moved]
            src = stamp(a, c, f"{', '.join(_label(p) for p in moved)} moved to the {'hand carry' if c['to'] == 'hand_carry' else 'air freight'}")
            src.detail["parts"] = left
            if not left:
                src.status = "cancelled"
            put(src)
            key = f"{inc.incident_key}:{c['to']}"
            tgt = by_key.get(key)
            if tgt is None or tgt.status == "cancelled":
                old = prior.get(key)
                tgt = Action(action_key=key, incident_key=inc.incident_key, kind=c["to"], title="", detail={"parts": [], "cost_cents": (a.detail or {}).get("cost_cents"),
                             "cutoff": (a.detail or {}).get("cutoff")}, due_at=a.due_at, status="awaiting_approval", owner_role="logistics", outward=True,
                             updated_at=a.updated_at)
                if old is not None and old.status in ("approved", "done") and old.detail.get("edited"):
                    tgt = old
            parts = list(dict.fromkeys([*(tgt.detail or {}).get("parts", []), *moved]))
            tgt = stamp(tgt, c, f"{', '.join(_label(p) for p in moved)} by {'hand carry' if c['to'] == 'hand_carry' else 'air freight'}")
            tgt.detail["parts"] = parts
            tgt.title = f"{'Hand carry' if c['to'] == 'hand_carry' else 'Book air freight'} for car {inc.driver_number}: {', '.join(_label(p) for p in parts)}"
            put(tgt)
        elif op == "source" and a is not None:
            n = stamp(a, c, {"at_track": "From the spares at the track", "factory": "From Grove", "make": "Made new"}[c["to"]])
            n.detail["source"] = c["to"]
            part = n.detail.get("part") or ""
            n.title = f"Reserve {_label(part)} for car {inc.driver_number}" + {"at_track": "", "factory": " (from Grove)", "make": " (to be made)"}[c["to"]]
            put(n)
        elif op == "retime" and a is not None:
            n = stamp(a, c, "New deadline")
            n.due_at = c["due"]
            put(n)
        elif op == "reassign" and a is not None:
            n = stamp(a, c, f"Now owned by {c['owner'].replace('_', ' ')}")
            n.owner_role = c["owner"]
            put(n)
        elif op == "add":
            kind = c["kind"]
            key = f"{inc.incident_key}:{kind}:edit{c['seq']}" + (f":{c['part']}" if c.get("part") else "")
            old = prior.get(key)
            if old is not None and old.status in ("approved", "rejected", "done"):
                put(old)
                continue
            detail: dict = {"part": c.get("part") or "", "qty": 1}
            if kind == "spares_reserve":
                detail |= {"label": _label(c["part"]), "source": "at_track", "p": 1.0}
            if kind == "work_order":
                lead = P.LEAD_DAYS.get(c["part"], (3, 5, 8))
                detail |= {"lead_days": list(lead), "ready_at": iso(parse_iso(inc.first_seen_at) + timedelta(days=lead[1]))}
            n = Action(action_key=key, incident_key=inc.incident_key, kind=kind, title=str(c.get("title") or kind)[:120], detail=detail, status="auto",
                       owner_role=c.get("owner") or "chief_of_staff", updated_at=inc.updated_at)
            put(stamp(n, c, "Added"))
    return [by_key[k] for k in order]


def summary(changes: list[dict]) -> str:
    done = [c for c in changes if c["applied"]]
    not_done = [c for c in changes if not c["applied"]]
    s = f"{len(done)} change{'s' if len(done) != 1 else ''} applied"
    if done:
        s += ": " + "; ".join(c["label"] for c in done[:4])
    if not_done:
        s += f". Not applied ({len(not_done)}): " + "; ".join(c["label"] for c in not_done[:3])
    return s[:1000]


__all__ = ["interpret", "offline_interpret", "record", "overlay", "summary", "lines_of", "OPS"]
