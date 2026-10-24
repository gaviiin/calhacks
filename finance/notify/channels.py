"""Delivery channels: Slack, email (SMTP, works with Gmail), Microsoft Teams, SMS (Twilio), generic webhook.

Each channel renders a Message into that channel's native format, then
delivers it. With PITWALL_NOTIFY=dry (the default) nothing leaves the machine:
the rendered payload goes to the outbox, where the UI can show it.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import smtplib
from email.message import EmailMessage
from html import escape

import httpx

from .messages import Message
from .people import Person
from .tokens import link

SEVERITY_EMOJI = {"info": ":large_blue_circle:", "warning": ":large_yellow_circle:", "urgent": ":red_circle:"}


class DeliveryError(RuntimeError):
    pass


def ui_link(msg: Message) -> str:
    base = os.environ.get("PITWALL_UI_URL", "http://localhost:5173").rstrip("/")
    c = msg.context
    if c.get("je_id"):
        return f"{base}/?run={c['run_id']}&entry={c['je_id']}"
    if c.get("q_id"):
        return f"{base}/?run={c['run_id']}&question={c['q_id']}"
    return f"{base}/?run={c.get('run_id', '')}"


def action_links(msg: Message, person: Person | None) -> dict[str, str]:
    """Signed links for every non-'open' action, bound to this person."""
    out = {}
    for a in msg.actions:
        if a.action == "open":
            out["open"] = ui_link(msg)
        elif person is not None:
            out[a.action] = link("/integrations/act", {**msg.context, "action": a.action, "who": person.pid})
    return out


class Channel:
    name = "base"

    def __init__(self, http: httpx.Client | None = None, env=os.environ):
        self.env = env
        self.http = http or httpx.Client(timeout=10)

    def configured(self) -> bool:
        return False

    def recipient(self, person: Person | None) -> str:
        return ""

    def render(self, msg: Message, person: Person | None) -> dict:
        raise NotImplementedError

    def deliver(self, payload: dict, person: Person | None) -> str:
        raise NotImplementedError


class SlackChannel(Channel):
    """Bot token (chat.postMessage, buttons, threads) or, failing that, an incoming webhook (text + links)."""

    name = "slack"

    def configured(self) -> bool:
        return bool(self.env.get("SLACK_BOT_TOKEN") or self.env.get("SLACK_WEBHOOK_URL"))

    def recipient(self, person: Person | None) -> str:
        return self.env.get("SLACK_CHANNEL_FINANCE", "#pit-wall")

    def render(self, msg: Message, person: Person | None) -> dict:
        mention = f"<@{person.slack_user}> " if person and person.slack_user else ""
        blocks = [
            {"type": "header", "text": {"type": "plain_text", "text": msg.title[:150]}},
            {"type": "section", "text": {"type": "mrkdwn", "text": f"{SEVERITY_EMOJI.get(msg.severity, '')} {mention}{msg.body}"[:2900]}},
        ]
        if msg.facts:
            blocks.append({"type": "section", "fields": [{"type": "mrkdwn", "text": f"*{k}*\n{v or '-'}"[:1900]} for k, v in msg.facts[:10]]})
        buttons = []
        links = action_links(msg, person)
        for a in msg.actions:
            if a.action == "open":
                buttons.append({"type": "button", "text": {"type": "plain_text", "text": a.label}, "url": links["open"], "action_id": "open"})
            elif a.action == "answer":
                blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": "_Reply in this thread to answer._"}]})
            elif self.env.get("SLACK_BOT_TOKEN"):
                btn = {"type": "button", "text": {"type": "plain_text", "text": a.label}, "action_id": a.action,
                       "value": json.dumps({**msg.context, "action": a.action})[:2000]}
                if a.style in ("primary", "danger"):
                    btn["style"] = a.style
                if a.action in ("approve", "send_draft"):
                    btn["confirm"] = {"title": {"type": "plain_text", "text": "Confirm"},
                                      "text": {"type": "mrkdwn", "text": f"{a.label}: {msg.title[:200]}"},
                                      "confirm": {"type": "plain_text", "text": a.label}, "deny": {"type": "plain_text", "text": "Cancel"}}
                buttons.append(btn)
            elif a.action in links:
                buttons.append({"type": "button", "text": {"type": "plain_text", "text": a.label}, "url": links[a.action], "action_id": a.action})
        if buttons:
            blocks.append({"type": "actions", "elements": buttons[:5]})
        return {"channel": self.recipient(person), "text": f"{msg.title}: {msg.body}"[:3000], "blocks": blocks}

    def deliver(self, payload: dict, person: Person | None) -> str:
        token = self.env.get("SLACK_BOT_TOKEN")
        if token:
            r = self.http.post("https://slack.com/api/chat.postMessage", json=payload,
                               headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=utf-8"})
            data = r.json()
            if not data.get("ok"):
                raise DeliveryError(f"slack: {data.get('error')}")
            return f"{data['channel']}:{data['ts']}"
        r = self.http.post(self.env["SLACK_WEBHOOK_URL"], json={k: v for k, v in payload.items() if k != "channel"})
        if r.status_code != 200:
            raise DeliveryError(f"slack webhook {r.status_code}: {r.text[:200]}")
        return "webhook"


class EmailChannel(Channel):
    """Plain SMTP with STARTTLS. Gmail: SMTP_HOST=smtp.gmail.com, SMTP_PORT=587, an app password as SMTP_PASSWORD."""

    name = "email"

    def __init__(self, http=None, env=os.environ, smtp_factory=smtplib.SMTP):
        super().__init__(http, env)
        self.smtp_factory = smtp_factory

    def configured(self) -> bool:
        return bool(self.env.get("SMTP_HOST") and self.env.get("SMTP_FROM"))

    def recipient(self, person: Person | None) -> str:
        return person.email if person else ""

    def render(self, msg: Message, person: Person | None, to: str | None = None) -> dict:
        links = action_links(msg, person)
        facts_text = "\n".join(f"{k}: {v}" for k, v in msg.facts)
        actions_text = "\n".join(f"{a.label}: {links[a.action]}" for a in msg.actions if a.action in links)
        text = f"{msg.body}\n\n{facts_text}\n\n{actions_text}\n\nPit Wall, Meridian Racing finance"
        rows = "".join(f"<tr><td style='color:#666;padding:2px 12px 2px 0'>{escape(k)}</td><td>{escape(str(v))}</td></tr>" for k, v in msg.facts)
        buttons = "".join(
            f"<a href='{escape(links[a.action])}' style='display:inline-block;margin:4px 8px 4px 0;padding:8px 14px;border-radius:6px;"
            f"text-decoration:none;color:#fff;background:{'#1f7a4d' if a.style == 'primary' else '#b3261e' if a.style == 'danger' else '#444'}'>"
            f"{escape(a.label)}</a>" for a in msg.actions if a.action in links)
        body_html = escape(msg.body).replace("\n", "<br>")
        html = (f"<div style='font-family:system-ui,sans-serif;max-width:640px'><h2 style='font-size:18px'>{escape(msg.title)}</h2>"
                f"<p>{body_html}</p><table>{rows}</table><p>{buttons}</p>"
                f"<p style='color:#888;font-size:12px'>Links ask you to confirm before anything happens. Pit Wall, Meridian Racing finance.</p></div>")
        return {"to": to or self.recipient(person), "subject": f"[Pit Wall] {msg.title}"[:200], "text": text, "html": html}

    def deliver(self, payload: dict, person: Person | None) -> str:
        if not payload.get("to"):
            raise DeliveryError("email: no recipient address configured")
        m = EmailMessage()
        m["From"], m["To"], m["Subject"] = self.env["SMTP_FROM"], payload["to"], payload["subject"]
        m.set_content(payload["text"])
        if payload.get("html"):
            m.add_alternative(payload["html"], subtype="html")
        with self.smtp_factory(self.env["SMTP_HOST"], int(self.env.get("SMTP_PORT", "587")), timeout=15) as s:
            s.starttls()
            if self.env.get("SMTP_USER"):
                s.login(self.env["SMTP_USER"], self.env.get("SMTP_PASSWORD", ""))
            s.send_message(m)
        return m["Message-ID"] or "smtp"


class TeamsChannel(Channel):
    """Microsoft Teams via a Workflows webhook ('Post to a channel when a webhook request is received'), as an Adaptive Card."""

    name = "teams"

    def configured(self) -> bool:
        return bool(self.env.get("TEAMS_WEBHOOK_URL"))

    def recipient(self, person: Person | None) -> str:
        return "teams-channel"

    def render(self, msg: Message, person: Person | None) -> dict:
        links = action_links(msg, person)
        card = {
            "$schema": "http://adaptivecards.io/schemas/adaptive-card.json", "type": "AdaptiveCard", "version": "1.4",
            "body": [
                {"type": "TextBlock", "text": msg.title, "weight": "Bolder", "size": "Medium", "wrap": True,
                 "color": {"urgent": "Attention", "warning": "Warning"}.get(msg.severity, "Default")},
                {"type": "TextBlock", "text": msg.body, "wrap": True},
                {"type": "FactSet", "facts": [{"title": k, "value": str(v)} for k, v in msg.facts]},
            ],
            "actions": [{"type": "Action.OpenUrl", "title": a.label, "url": links[a.action],
                         **({"style": "positive" if a.style == "primary" else "destructive"} if a.style in ("primary", "danger") else {})}
                        for a in msg.actions if a.action in links],
        }
        if person and person.email:
            card["body"].insert(1, {"type": "TextBlock", "text": f"For {person.name} ({person.title})", "isSubtle": True, "wrap": True})
        return {"type": "message", "attachments": [{"contentType": "application/vnd.microsoft.card.adaptive", "content": card}]}

    def deliver(self, payload: dict, person: Person | None) -> str:
        r = self.http.post(self.env["TEAMS_WEBHOOK_URL"], json=payload)
        if r.status_code not in (200, 202):
            raise DeliveryError(f"teams {r.status_code}: {r.text[:200]}")
        return "teams"


class SmsChannel(Channel):
    """Twilio SMS for urgent items: short text plus a link."""

    name = "sms"

    def configured(self) -> bool:
        return all(self.env.get(k) for k in ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM"))

    def recipient(self, person: Person | None) -> str:
        return person.phone if person else ""

    def render(self, msg: Message, person: Person | None) -> dict:
        target = action_links(msg, person).get("open") or ui_link(msg)
        return {"To": self.recipient(person), "From": self.env.get("TWILIO_FROM", ""), "Body": f"Pit Wall: {msg.title}. {target}"[:320]}

    def deliver(self, payload: dict, person: Person | None) -> str:
        if not payload.get("To"):
            raise DeliveryError("sms: no phone number configured")
        sid = self.env["TWILIO_ACCOUNT_SID"]
        r = self.http.post(f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json", data=payload,
                           auth=(sid, self.env["TWILIO_AUTH_TOKEN"]))
        if r.status_code not in (200, 201):
            raise DeliveryError(f"twilio {r.status_code}: {r.text[:200]}")
        return r.json().get("sid", "twilio")


class WebhookChannel(Channel):
    """Generic signed JSON webhook (Zapier, n8n, an ops bot, a red-team harness...). Header X-PitWall-Signature = HMAC-SHA256."""

    name = "webhook"

    def configured(self) -> bool:
        return bool(self.env.get("PITWALL_WEBHOOK_URL"))

    def recipient(self, person: Person | None) -> str:
        return self.env.get("PITWALL_WEBHOOK_URL", "")

    def render(self, msg: Message, person: Person | None) -> dict:
        return {"kind": msg.kind, "title": msg.title, "body": msg.body, "facts": dict(msg.facts), "severity": msg.severity,
                "context": msg.context, "person": person.pid if person else None, "links": action_links(msg, person)}

    def deliver(self, payload: dict, person: Person | None) -> str:
        raw = json.dumps(payload, separators=(",", ":")).encode()
        sig = hmac.new(self.env.get("PITWALL_SECRET", "dev-only-not-secret").encode(), raw, hashlib.sha256).hexdigest()
        r = self.http.post(self.env["PITWALL_WEBHOOK_URL"], content=raw,
                           headers={"Content-Type": "application/json", "X-PitWall-Signature": f"sha256={sig}"})
        if r.status_code >= 300:
            raise DeliveryError(f"webhook {r.status_code}")
        return "webhook"


ALL = {c.name: c for c in (SlackChannel, EmailChannel, TeamsChannel, SmsChannel, WebhookChannel)}
