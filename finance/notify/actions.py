"""What a person can do from Slack, email or Teams. Every path ends in the same ledger calls as the UI."""

from __future__ import annotations

ROLE_ACTIONS = {"approve", "reject", "answer", "send_draft", "discard_draft"}


def perform(run, notifier, who: str, action: str, context: dict, text: str = "", via: str = "") -> dict:
    """Returns {"ok": bool, "text": str}. The ledger enforces K11 regardless of what the link or button claims."""
    if action not in ROLE_ACTIONS:
        return {"ok": False, "text": f"Unknown action {action!r}."}
    person = notifier.directory.people.get(who)
    if person is None:
        return {"ok": False, "text": "You're not in Meridian's finance directory, so you can't act on this."}
    led = run.ledger
    role = context.get("role", "")
    if role and role not in person.roles:
        return {"ok": False, "text": f"{person.name} doesn't hold the {role} role."}

    if action in ("approve", "reject"):
        je_id = context.get("je_id", "")
        try:
            res = led.approve(je_id, who, role, "approve" if action == "approve" else "reject",
                              text or f"{'Approved' if action == 'approve' else 'Rejected'} via {via or 'link'}")
        except KeyError:
            return {"ok": False, "text": f"No entry {je_id}."}
        run.router.engine.rereview(led)
        if res.status == "refused":
            return {"ok": False, "text": f"Not done: {res.reason}"}
        if res.status == "parked":
            return {"ok": True, "text": f"Recorded your {role} approval. Still waiting for {', '.join(res.needs)}."}
        return {"ok": True, "text": f"Done: {je_id} is {res.status}."}

    if action == "answer":
        q = led.one("SELECT * FROM questions WHERE q_id=?", context.get("q_id", ""))
        if q is None:
            return {"ok": False, "text": "No such question."}
        if q["status"] != "open":
            return {"ok": False, "text": f"This question was already {q['status']}."}
        if not text.strip():
            return {"ok": False, "text": "Type an answer first."}
        led.answer(q["q_id"], text.strip())
        out = run.router.agent.apply_answer(dict(led.one("SELECT * FROM questions WHERE q_id=?", q["q_id"])), led)
        run.router.engine.rereview(led)
        learned = [r for r in out if isinstance(r, dict) and r.get("type") == "rule_learned"]
        tail = f" I'll apply it to every later case of this clause (rule {learned[0]['rule_id']})." if learned else ""
        return {"ok": True, "text": f"Thanks, got it: \"{text.strip()}\".{tail}"}

    if action == "send_draft":
        return notifier.send_draft(context.get("draft_id", ""), who)
    return notifier.discard_draft(context.get("draft_id", ""), who)
