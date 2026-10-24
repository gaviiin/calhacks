"""Inbound side of the communication integrations.

    POST /integrations/slack/actions   Slack interactivity (button clicks), signature-verified
    POST /integrations/slack/events    Slack Events API: thread replies answer Pit Wall's questions
    GET  /integrations/act?token=...   confirmation page for an email or Teams link
    POST /integrations/act             performs the confirmed action
    GET  /api/runs/{id}/outbox         everything Pit Wall sent (or would have sent, in dry mode)
    POST /api/notify/test              send a test message on one channel
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from html import escape

import httpx
from fastapi import APIRouter, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel

from .notify import messages as M
from .notify.actions import perform
from .notify.tokens import verify


def verify_slack(body: bytes, timestamp: str, signature: str, secret: str | None = None, now: float | None = None) -> bool:
    secret = secret if secret is not None else os.environ.get("SLACK_SIGNING_SECRET", "")
    if not secret or not timestamp or not signature:
        return False
    try:
        if abs((now or time.time()) - int(timestamp)) > 300:
            return False  # replay protection
    except ValueError:
        return False
    base = f"v0:{timestamp}:{body.decode()}".encode()
    expected = "v0=" + hmac.new(secret.encode(), base, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


PAGE = """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pit Wall</title><style>body{{font-family:system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;color:#1b1b1b}}
button{{padding:10px 18px;border:0;border-radius:6px;color:#fff;background:#1f7a4d;font-size:15px;cursor:pointer}}
button.danger{{background:#b3261e}} textarea{{width:100%;min-height:90px;font:inherit;margin:8px 0}} .muted{{color:#666}}</style></head>
<body><p class="muted">Meridian Racing &middot; Pit Wall</p>{content}</body></html>"""


def build_router(get_run, runs: dict) -> APIRouter:
    r = APIRouter()

    def notifier_for(run):
        n = getattr(run.ledger, "notifier", None)
        if n is None:
            raise HTTPException(409, "notifications are not enabled for this run")
        return n

    # ------------------------------------------------------------------ Slack

    @r.post("/integrations/slack/actions")
    async def slack_actions(request: Request):
        raw = await request.body()
        if not verify_slack(raw, request.headers.get("X-Slack-Request-Timestamp", ""), request.headers.get("X-Slack-Signature", "")):
            raise HTTPException(401, "bad Slack signature")
        form = await request.form()
        payload = json.loads(form["payload"])
        act = (payload.get("actions") or [{}])[0]
        if act.get("action_id") == "open":
            return JSONResponse({})
        try:
            context = json.loads(act.get("value") or "{}")
        except json.JSONDecodeError:
            return JSONResponse({"response_type": "ephemeral", "text": "Malformed button."})
        run = runs.get(context.get("run_id", ""))
        if run is None:
            return JSONResponse({"response_type": "ephemeral", "text": "That run is no longer live."})
        n = notifier_for(run)
        person = n.directory.by_slack_user(payload.get("user", {}).get("id", ""))
        result = perform(run, n, person.pid if person else "", context.get("action", ""), context, via="Slack") if person else \
            {"ok": False, "text": "Your Slack account isn't mapped to anyone in Meridian's finance directory."}
        if payload.get("response_url") and result["ok"]:
            who = person.name if person else "someone"
            try:
                httpx.post(payload["response_url"], json={"replace_original": False, "text": f"{who}: {result['text']}"}, timeout=5)
            except httpx.HTTPError:
                pass
        return JSONResponse({"response_type": "ephemeral", "text": result["text"]})

    @r.post("/integrations/slack/events")
    async def slack_events(request: Request):
        raw = await request.body()
        data = json.loads(raw or b"{}")
        if data.get("type") == "url_verification":
            if not verify_slack(raw, request.headers.get("X-Slack-Request-Timestamp", ""), request.headers.get("X-Slack-Signature", "")):
                raise HTTPException(401, "bad Slack signature")
            return {"challenge": data.get("challenge")}
        if not verify_slack(raw, request.headers.get("X-Slack-Request-Timestamp", ""), request.headers.get("X-Slack-Signature", "")):
            raise HTTPException(401, "bad Slack signature")
        ev = data.get("event", {})
        if ev.get("type") != "message" or not ev.get("thread_ts") or ev.get("bot_id") or ev.get("subtype"):
            return {"ok": True}
        ref = f"{ev.get('channel')}:{ev['thread_ts']}"
        for run in runs.values():
            n = getattr(run.ledger, "notifier", None)
            q_id = n.thread_question(ref) if n else None
            if q_id:
                person = n.directory.by_slack_user(ev.get("user", ""))
                q = run.ledger.one("SELECT to_role FROM questions WHERE q_id=?", q_id)
                result = perform(run, n, person.pid if person else "", "answer", {"run_id": run.run_id, "q_id": q_id, "role": q["to_role"]},
                                 text=ev.get("text", ""), via="Slack thread")
                token = os.environ.get("SLACK_BOT_TOKEN")
                if token:
                    try:
                        httpx.post("https://slack.com/api/chat.postMessage", headers={"Authorization": f"Bearer {token}"},
                                   json={"channel": ev["channel"], "thread_ts": ev["thread_ts"], "text": result["text"]}, timeout=5)
                    except httpx.HTTPError:
                        pass
                return {"ok": result["ok"]}
        return {"ok": True}

    # ------------------------------------------------------------------ signed links (email, Teams)

    def _claims(token: str) -> dict:
        try:
            return verify(token)
        except ValueError as exc:
            raise HTTPException(400, f"This link can't be used: {exc}.")

    @r.get("/integrations/act", response_class=HTMLResponse)
    def act_page(token: str):
        c = _claims(token)
        run = runs.get(c.get("run_id", ""))
        if run is None:
            return HTMLResponse(PAGE.format(content="<h2>That run is no longer live.</h2>"), 410)
        led = run.ledger
        action = c["action"]
        if action in ("approve", "reject"):
            e = led.entry(c["je_id"])
            detail = (f"<h2>{'Approve' if action == 'approve' else 'Reject'} as {escape(c['role'])}?</h2><p><b>{escape(e['memo'])}</b></p>"
                      f"<p>{escape((e['decision'] or {}).get('answer', ''))}</p><p class='muted'>Status now: {e['status']}. {escape(e.get('reason') or '')}</p>")
            field = "<textarea name='text' placeholder='Reason (optional)'></textarea>"
        elif action == "answer":
            q = led.one("SELECT * FROM questions WHERE q_id=?", c["q_id"])
            detail = f"<h2>Question for you</h2><p>{escape(q['text'])}</p><p class='muted'>Status: {q['status']}</p>"
            field = "<textarea name='text' placeholder='Your answer' required></textarea>"
        else:
            row = led.one("SELECT * FROM notify_outbox WHERE msg_id=?", c.get("draft_id", ""))
            email = json.loads(row["payload"]) if row else {}
            detail = (f"<h2>{'Send' if action == 'send_draft' else 'Discard'} this email?</h2><p class='muted'>To {escape(email.get('to') or '(not configured)')}</p>"
                      f"<pre style='white-space:pre-wrap'>{escape(email.get('text', ''))}</pre>")
            field = ""
        cls = " class='danger'" if action in ("reject", "discard_draft") else ""
        label = {"approve": "Approve", "reject": "Reject", "answer": "Send answer", "send_draft": "Send email", "discard_draft": "Discard"}[action]
        return PAGE.format(content=f"{detail}<form method='post' action='/integrations/act'><input type='hidden' name='token' value='{escape(token)}'>"
                                   f"{field}<button{cls}>{label}</button></form>")

    @r.post("/integrations/act", response_class=HTMLResponse)
    def act(token: str = Form(...), text: str = Form("")):
        c = _claims(token)
        run = runs.get(c.get("run_id", ""))
        if run is None:
            return HTMLResponse(PAGE.format(content="<h2>That run is no longer live.</h2>"), 410)
        result = perform(run, notifier_for(run), c.get("who", ""), c["action"], c, text=text, via="email link")
        return PAGE.format(content=f"<h2>{'Done' if result['ok'] else 'Not done'}</h2><p>{escape(result['text'])}</p>")

    # ------------------------------------------------------------------ outbox and tests

    @r.get("/api/runs/{run_id}/outbox")
    def outbox(run_id: str, limit: int = 200):
        run = get_run(run_id)
        n = getattr(run.ledger, "notifier", None)
        return {"mode": n.mode if n else "off", "messages": n.outbox(limit) if n else []}

    class TestMessage(BaseModel):
        run_id: str
        channel: str
        person: str = "dana"

    @r.post("/api/notify/test")
    def test_message(body: TestMessage):
        run = get_run(body.run_id)
        n = notifier_for(run)
        person = n.directory.people.get(body.person)
        if body.channel not in n.channels or person is None:
            raise HTTPException(400, "unknown channel or person")
        msg = M.Message(kind="test", dedupe_key=f"test|{time.time()}", title="Pit Wall test message",
                        body=f"Hello {person.name}, this is a test from Pit Wall on {body.channel}.",
                        actions=[M.Action("Open in Pit Wall", "open")], context={"run_id": run.run_id})
        return n.send(msg, person, [body.channel])

    return r
