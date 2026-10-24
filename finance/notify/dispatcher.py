"""Listens to the ledger and tells the right person, on their channels, exactly once.

Audiences:
- parked entries -> whoever holds the needed role (controller, CFO): approve or reject
- open questions -> the role asked: answer in a Slack thread or via a link
- at-risk alerts -> controller
- billing outcomes worth knowing (hold, rejected, corrected, credited) -> commercial team
- credit notes -> a draft email to the sponsor, sent only after the controller approves it

Modes (PITWALL_NOTIFY): dry (default: render into the outbox, send nothing), live, off.
"""

from __future__ import annotations

import json
import os

from ..ledger import new_id
from . import messages as M
from .channels import ALL, DeliveryError
from .people import Directory

OUTBOX = """
CREATE TABLE IF NOT EXISTS notify_outbox (
  msg_id TEXT PRIMARY KEY, channel TEXT, recipient TEXT, person TEXT, kind TEXT, dedupe_key TEXT, status TEXT,
  title TEXT, payload TEXT, context TEXT, provider_ref TEXT, error TEXT, created_at TEXT, sent_at TEXT, acted_by TEXT,
  UNIQUE (channel, recipient, dedupe_key));
"""


class Notifier:
    def __init__(self, ledger, run_id: str, directory: Directory | None = None, channels: dict | None = None, env=os.environ):
        self.ledger, self.run_id, self.env = ledger, run_id, env
        self.mode = env.get("PITWALL_NOTIFY", "dry")
        self.directory = directory or Directory(ledger.world.dir, env)
        self.channels = channels or {name: cls(env=env) for name, cls in ALL.items()}
        self.muted = False
        ledger.db.executescript(OUTBOX)

    # ------------------------------------------------------------------ listener

    def __call__(self, name: str, payload: dict) -> None:
        if self.muted or self.mode == "off":
            return
        led = self.ledger
        if name == "entry":
            if payload["status"] == "parked":
                for role in payload["needs"]:
                    for person in self.directory.by_role(role):
                        self.send(M.approval(self.run_id, payload, role), person)
            if payload["status"] == "posted" and payload["kind"] == "bonus_reversal" and any(
                    x["account"] == "1200" and x["credit_cents"] for x in payload["lines"]):
                self.draft_credit_note(payload)
        elif name == "question" and payload.get("status") == "open":
            q = dict(led.one("SELECT * FROM questions WHERE q_id=?", payload["q_id"]))
            for person in self.directory.by_role(q["to_role"]):
                self.send(M.question(self.run_id, q), person)
        elif name == "memo" and payload.get("kind") == "alert":
            for person in self.directory.by_role("controller"):
                self.send(M.alert(self.run_id, payload), person)
        elif name == "billing":
            b = led.billing(payload["request_id"])
            msg = M.billing(self.run_id, b) if b else None
            if msg:
                for person in self.directory.by_role("commercial"):
                    self.send(msg, person)

    # ------------------------------------------------------------------ sending

    def channels_for(self, msg: M.Message, person) -> list[str]:
        chosen = []
        for name in person.channels:
            if name == "sms" and msg.severity != "urgent":
                continue
            ch = self.channels.get(name)
            if ch is None:
                continue
            if self.mode == "live" and not ch.configured():
                continue
            chosen.append(name)
        if self.mode == "live" and self.channels.get("webhook") and self.channels["webhook"].configured():
            chosen.append("webhook")
        return chosen

    def send(self, msg: M.Message, person=None, channel_names: list[str] | None = None, to: str | None = None) -> list[dict]:
        out = []
        for name in channel_names or self.channels_for(msg, person):
            ch = self.channels[name]
            recipient = to or ch.recipient(person) or (person.pid if person else "")
            if self.ledger.one("SELECT 1 FROM notify_outbox WHERE channel=? AND recipient=? AND dedupe_key=?", name, recipient, msg.dedupe_key):
                continue  # already told this person this thing on this channel
            payload = ch.render(msg, person) if name != "email" or to is None else ch.render(msg, person, to=to)
            row = {"msg_id": new_id("msg"), "channel": name, "recipient": recipient, "person": person.pid if person else None,
                   "kind": msg.kind, "dedupe_key": msg.dedupe_key, "title": msg.title, "payload": payload, "context": msg.context}
            self._deliver(row, ch, person)
            out.append(row)
        return out

    def _deliver(self, row: dict, ch, person) -> None:
        status, ref, error, sent = "dry_run", None, None, None
        if self.mode == "live":
            try:
                ref, status, sent = ch.deliver(row["payload"], person), "sent", self.ledger.clock
            except (DeliveryError, OSError, KeyError, ValueError) as exc:
                status, error = "failed", str(exc)[:500]
            except Exception as exc:  # a broken channel must never break the books
                status, error = "failed", f"{type(exc).__name__}: {exc}"[:500]
        row.update(status=status, provider_ref=ref, error=error)
        self.ledger.db.execute(
            "INSERT OR IGNORE INTO notify_outbox VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (row["msg_id"], row["channel"], row["recipient"], row["person"], row["kind"], row["dedupe_key"], status, row["title"],
             json.dumps(row["payload"], default=str), json.dumps(row["context"]), ref, error, self.ledger.clock, sent, None))
        self.ledger.db.commit()

    # ------------------------------------------------------------------ external drafts (human approves before sending)

    def draft_credit_note(self, entry: dict) -> str | None:
        sponsor_id = entry.get("sponsor_id")
        if not sponsor_id or self.ledger.one("SELECT 1 FROM notify_outbox WHERE dedupe_key=?", f"external|{entry['je_id']}"):
            return None
        sponsor = self.directory.sponsors.get(sponsor_id, {"contact": sponsor_id, "email": ""})
        draft_id = new_id("draft")
        msg, email = M.credit_note_draft(self.run_id, entry, sponsor, draft_id)
        self.ledger.db.execute(
            "INSERT INTO notify_outbox VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (draft_id, "email", email["to"] or f"{sponsor_id}-ap", None, "external_draft", f"external|{entry['je_id']}",
             "awaiting_approval", email["subject"], json.dumps(email), json.dumps({"run_id": self.run_id, "je_id": entry["je_id"]}),
             None, None, self.ledger.clock, None, None))
        self.ledger.db.commit()
        for person in self.directory.by_role("controller"):
            self.send(msg, person)
        return draft_id

    def send_draft(self, draft_id: str, who: str) -> dict:
        row = self.ledger.one("SELECT * FROM notify_outbox WHERE msg_id=? AND kind='external_draft'", draft_id)
        if row is None or row["status"] != "awaiting_approval":
            return {"ok": False, "text": "That draft is not waiting for approval."}
        email = json.loads(row["payload"])
        status, error, ref = "dry_run", None, None
        if self.mode == "live":
            ch = self.channels["email"]
            try:
                ref, status = ch.deliver({**email, "html": None}, None), "sent"
            except Exception as exc:
                status, error = "failed", str(exc)[:500]
        self.ledger.db.execute("UPDATE notify_outbox SET status=?, error=?, provider_ref=?, sent_at=?, acted_by=? WHERE msg_id=?",
                               (status, error, ref, self.ledger.clock, who, draft_id))
        self.ledger.db.commit()
        return {"ok": status != "failed", "text": f"Credit note email {status.replace('_', ' ')} to {row['recipient']}" + (f": {error}" if error else ".")}

    def discard_draft(self, draft_id: str, who: str) -> dict:
        self.ledger.db.execute("UPDATE notify_outbox SET status='discarded', acted_by=? WHERE msg_id=? AND status='awaiting_approval'",
                               (who, draft_id))
        self.ledger.db.commit()
        return {"ok": True, "text": "Draft discarded. Nothing was sent to the sponsor."}

    # ------------------------------------------------------------------ reads

    def outbox(self, limit: int = 200) -> list[dict]:
        rows = self.ledger.q("SELECT * FROM notify_outbox ORDER BY created_at DESC, rowid DESC LIMIT ?", limit)
        return [{**dict(r), "payload": json.loads(r["payload"]), "context": json.loads(r["context"])} for r in rows]

    def thread_question(self, provider_ref: str) -> str | None:
        row = self.ledger.one("SELECT context FROM notify_outbox WHERE channel='slack' AND kind='question' AND provider_ref=?", provider_ref)
        return json.loads(row["context"]).get("q_id") if row else None


def maybe_attach(ledger, run_id: str, env=os.environ) -> Notifier | None:
    if env.get("PITWALL_NOTIFY", "off") == "off":
        return None
    n = Notifier(ledger, run_id, env=env)
    ledger.listeners.append(n)
    ledger.notifier = n
    return n
