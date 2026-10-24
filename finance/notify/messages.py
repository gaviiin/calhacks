"""What Pit Wall says to people, independent of the channel it goes out on."""

from __future__ import annotations

from dataclasses import dataclass, field

from ..money import fmt


@dataclass
class Action:
    label: str
    action: str  # approve | reject | answer | send_draft | discard_draft | open
    style: str = "default"  # primary | danger | default


@dataclass
class Message:
    kind: str  # approval | question | alert | billing | draft_review | test
    dedupe_key: str
    title: str
    body: str
    facts: list[tuple[str, str]] = field(default_factory=list)
    actions: list[Action] = field(default_factory=list)
    context: dict = field(default_factory=dict)  # run_id, je_id, role, q_id, request_id, draft_id
    severity: str = "info"  # info | warning | urgent


def approval(run_id: str, entry: dict, role: str) -> Message:
    d = entry.get("decision") or {}
    evidence = "; ".join((e.get("ref") or e.get("url") or e.get("type")) for e in d.get("evidence", [])[:4])
    return Message(
        kind="approval", dedupe_key=f"approval|{entry['je_id']}|{role}",
        title=f"Approval needed ({role}): {entry['memo']}",
        body=f"{d.get('answer', '')}\n\nWhy it needs you: {entry.get('reason') or 'material entry'}.",
        facts=[("Amount", fmt(entry["total_cents"] or 0)), ("Kind", entry["kind"]), ("Policy", ", ".join(d.get("policy_ids", []))),
               ("Evidence", evidence or "none"), ("Prepared by", entry["preparer"]), ("Entry", entry["je_id"])],
        actions=[Action("Approve", "approve", "primary"), Action("Reject", "reject", "danger"), Action("Open in Pit Wall", "open")],
        context={"run_id": run_id, "je_id": entry["je_id"], "role": role},
        severity="urgent" if entry["total_cents"] >= 100_000_000 else "warning",
    )


def question(run_id: str, q: dict) -> Message:
    return Message(
        kind="question", dedupe_key=f"question|{q['q_id']}", title=f"Question for the {q['to_role']}",
        body=q["text"], facts=[("Asked by", q.get("asked_by", "agent:revenue")), ("About", q.get("subject", ""))],
        actions=[Action("Answer", "answer", "primary"), Action("Open in Pit Wall", "open")],
        context={"run_id": run_id, "q_id": q["q_id"], "role": q["to_role"]}, severity="warning",
    )


def alert(run_id: str, memo: dict) -> Message:
    return Message(
        kind="alert", dedupe_key=f"alert|{memo['key']}", title="Bonuses at risk", body=memo["text"],
        facts=[("FIA document", memo.get("fia_url") or "")],
        actions=[Action("Open in Pit Wall", "open")], context={"run_id": run_id, "memo_key": memo["key"]}, severity="warning",
    )


BILLING_WORDS = {
    "provisional": "is on hold: the result is still provisional. It goes out automatically once the FIA publishes the Final Classification (REV-02a).",
    "awaiting_controller": "is on hold while the controller rules on the contract.",
    "bonus_pending_approval": "is on hold until the controller approves the bonus.",
    "overturned": "was not sent: the final classification no longer earns it.",
    "not_earned": "was not sent: the final classification does not earn this bonus.",
    "duplicate": "was not sent: this bonus has already been invoiced.",
    "sprint_excluded": "was not sent: this clause excludes sprint races.",
    "excluded_by_ruling": "was not sent: the controller has ruled sprints do not count for this clause.",
    "amount_corrected": "was invoiced at the contract amount, not the amount requested.",
    "result_changed_after_billing": "was credited back: the result changed after it was invoiced.",
    "approved": "was invoiced.",
}


def billing(run_id: str, b: dict) -> Message | None:
    r = b["payload"]
    reason = b["reason_code"]
    if b["status"] == "billed" and reason == "approved":
        return None  # routine success: no ping
    text = BILLING_WORDS.get(reason, f"is {b['status']} ({reason}).")
    return Message(
        kind="billing", dedupe_key=f"billing|{b['request_id']}|{b['status']}|{reason}",
        title=f"Billing request {b['request_id']}: {b['status']}",
        body=f"Your request to invoice {r['sponsor_id']} clause {r['clause_id']} for car {r['car']} "
             f"({fmt(r['amount_orig'], r['currency'])}, {r['season']} R{r['round']} {r['session']}) {text}",
        facts=[("Request", b["request_id"]), ("Status", b["status"]), ("Reason", reason)],
        actions=[Action("Open in Pit Wall", "open")], context={"run_id": run_id, "request_id": b["request_id"]},
        severity="info" if b["status"] in ("billed", "hold") else "warning",
    )


def credit_note_draft(run_id: str, entry: dict, sponsor: dict, draft_id: str) -> tuple[Message, dict]:
    """Returns (message asking the controller to approve sending, the email draft itself)."""
    orig = next((x for x in entry["lines"] if x["account"] == "4010"), entry["lines"][0])
    amount = fmt(orig["orig_amount_cents"] or orig["debit_cents"], orig["orig_currency"] or "USD")
    subject = f"Credit note: Meridian Racing bonus adjustment ({amount})"
    email = {
        "to": sponsor.get("email", ""), "subject": subject,
        "text": (f"Dear {sponsor['contact']},\n\nFollowing an official change to the race classification, the bonus below no longer "
                 f"applies and we are issuing a credit of {amount} against your account.\n\n{entry['memo']}\n\n"
                 "Reference: " + entry["je_id"] + "\n\nKind regards,\nMeridian Racing Finance"),
    }
    msg = Message(
        kind="draft_review", dedupe_key=f"draft|{entry['je_id']}", title=f"Send credit note to {sponsor['contact']}?",
        body=f"Pit Wall drafted this email. Nothing goes to a sponsor without your approval.\n\nSubject: {subject}\n\n{email['text']}",
        facts=[("To", email["to"] or "(no address configured)"), ("Amount", amount), ("Entry", entry["je_id"])],
        actions=[Action("Send", "send_draft", "primary"), Action("Discard", "discard_draft", "danger")],
        context={"run_id": run_id, "draft_id": draft_id, "role": "controller", "je_id": entry["je_id"]}, severity="warning",
    )
    return msg, email
