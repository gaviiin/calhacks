import hashlib
import hmac
import json
import re
import time
import urllib.parse

import httpx
import pytest
from fastapi.testclient import TestClient

import finance.api as api
from finance.eval import generate
from finance.integrations_api import verify_slack
from finance.notify import tokens
from finance.notify.channels import EmailChannel, SmsChannel, TeamsChannel
from finance.notify.dispatcher import Notifier
from finance.notify.messages import Action, Message
from finance.notify.people import Directory
from finance.sim import new_run

SECRET = "test-signing-secret"


@pytest.fixture
def env(monkeypatch):
    values = {"PITWALL_NOTIFY": "dry", "PITWALL_SECRET": "s3cret", "SLACK_SIGNING_SECRET": SECRET,
              "SLACK_USER_DANA": "U_DANA", "SLACK_USER_PRIYA": "U_PRIYA", "SLACK_USER_LUIS": "U_LUIS",
              "EMAIL_DANA": "dana@example.com", "EMAIL_PRIYA": "priya@example.com", "EMAIL_LUIS": "luis@example.com",
              "PHONE_PRIYA": "+15550100", "EMAIL_SPONSOR_HALCYON": "ap@halcyon.example"}
    for k, v in values.items():
        monkeypatch.setenv(k, v)
    return values


@pytest.fixture
def client(world, store, tmp_path, monkeypatch, env):
    requests, _ = generate(world, 2024)
    (world.dir / "requests").mkdir(exist_ok=True)
    (world.dir / "requests" / "2024.json").write_text(json.dumps({"requests": requests}))
    monkeypatch.setattr(api, "WORLD", world)
    monkeypatch.setattr(api, "STORE", store)
    monkeypatch.setattr("finance.sim.DATA_DIR", tmp_path)
    return TestClient(api.app)


def slack_post(c, path, body: bytes, content_type="application/x-www-form-urlencoded"):
    ts = str(int(time.time()))
    sig = "v0=" + hmac.new(SECRET.encode(), f"v0:{ts}:{body.decode()}".encode(), hashlib.sha256).hexdigest()
    return c.post(path, content=body, headers={"X-Slack-Request-Timestamp": ts, "X-Slack-Signature": sig, "Content-Type": content_type})


def test_spa_weekend_tells_the_right_people_once(client):
    c = client
    rid = c.post("/api/runs", json={"season": 2024, "stop_before_round": 14, "auto_people": False}).json()["run_id"]
    assert c.get(f"/api/runs/{rid}/outbox").json()["messages"] == []  # fast-forwarded history is muted
    c.post(f"/api/runs/{rid}/advance", json={"round": 14})
    box = c.get(f"/api/runs/{rid}/outbox").json()
    assert box["mode"] == "dry"
    msgs = box["messages"]
    alerts = [m for m in msgs if m["kind"] == "alert"]
    assert {m["channel"] for m in alerts} == {"slack", "email", "teams"} and all(m["person"] == "dana" for m in alerts)
    luis = [m for m in msgs if m["person"] == "luis"]
    assert any("overturned" in m["dedupe_key"] for m in luis) and any("provisional" in m["dedupe_key"] for m in luis)
    keys = [(m["channel"], m["recipient"], m["dedupe_key"]) for m in msgs]
    assert len(keys) == len(set(keys))
    slack = next(m for m in alerts if m["channel"] == "slack")["payload"]
    assert slack["blocks"][0]["type"] == "header" and "<@U_DANA>" in slack["blocks"][1]["text"]["text"]


def test_approve_by_email_link_then_credit_note_needs_a_human(client):
    c = client
    rid = c.post("/api/runs", json={"season": 2024, "auto_people": False}).json()["run_id"]
    c.post(f"/api/runs/{rid}/scenario", json={"round": 12, "car": 44})
    msgs = c.get(f"/api/runs/{rid}/outbox").json()["messages"]
    halcyon = [m for m in msgs if m["kind"] == "approval" and "Halcyon" in m["title"]]
    assert {(m["person"], m["channel"]) for m in halcyon} >= {("dana", "email"), ("priya", "email"), ("priya", "sms")}  # $1M is urgent
    links = {}
    for m in halcyon:
        if m["channel"] == "email":
            links[m["person"]] = re.search(r"Approve: (\S+)", m["payload"]["text"]).group(1)
    token = urllib.parse.parse_qs(urllib.parse.urlparse(links["dana"]).query)["token"][0]
    page = c.get("/integrations/act", params={"token": token})
    assert page.status_code == 200 and "Approve as controller" in page.text  # GET only shows a confirmation
    assert "Still waiting for cfo" in c.post("/integrations/act", data={"token": token}).text
    assert "Not done" in c.post("/integrations/act", data={"token": token}).text  # same person can't approve twice
    priya = urllib.parse.parse_qs(urllib.parse.urlparse(links["priya"]).query)["token"][0]
    assert "is posted" in c.post("/integrations/act", data={"token": priya}).text

    msgs = c.get(f"/api/runs/{rid}/outbox").json()["messages"]
    draft = next(m for m in msgs if m["kind"] == "external_draft" and m["recipient"] == "ap@halcyon.example")
    assert draft["status"] == "awaiting_approval"  # nothing went to the sponsor on its own
    review = next(m for m in msgs if m["kind"] == "draft_review" and m["channel"] == "email" and m["person"] == "dana")
    send = urllib.parse.parse_qs(urllib.parse.urlparse(re.search(r"Send: (\S+)", review["payload"]["text"]).group(1)).query)["token"][0]
    assert "dry run" in c.post("/integrations/act", data={"token": send}).text
    msgs = c.get(f"/api/runs/{rid}/outbox").json()["messages"]
    assert next(m for m in msgs if m["msg_id"] == draft["msg_id"])["acted_by"] == "dana"


def test_slack_buttons_are_signed_mapped_and_still_checked(client, monkeypatch):
    c = client
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")  # buttons only render with a bot token
    rid = c.post("/api/runs", json={"season": 2024, "auto_people": False}).json()["run_id"]
    out = c.post(f"/api/runs/{rid}/scenario", json={"round": 12, "car": 44}).json()
    arcadia = next(e for e in out["entries"] if "Arcadia" in e["memo"])
    value = json.dumps({"run_id": rid, "je_id": arcadia["je_id"], "role": "controller", "action": "approve"})

    def click(user):
        payload = {"type": "block_actions", "user": {"id": user}, "actions": [{"action_id": "approve", "value": value}]}
        return slack_post(c, "/integrations/slack/actions", urllib.parse.urlencode({"payload": json.dumps(payload)}).encode())

    assert c.post("/integrations/slack/actions", data={"payload": "{}"}).status_code == 401  # unsigned
    assert "isn't mapped" in click("U_STRANGER").json()["text"]
    assert "doesn't hold the controller role" in click("U_LUIS").json()["text"]
    assert "is posted" in click("U_DANA").json()["text"]


def test_slack_thread_reply_answers_the_question(world, store, tmp_path, env, monkeypatch):
    monkeypatch.setenv("PITWALL_NOTIFY", "live")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")
    posted = []

    def slack_api(request: httpx.Request):
        posted.append(json.loads(request.content))
        return httpx.Response(200, json={"ok": True, "channel": "C1", "ts": f"171.{len(posted)}"})

    run = new_run(2024, world=world, store=store, data_dir=tmp_path, requests=[], cash=False, auto_people=False)
    n = run.ledger.notifier  # attached automatically because PITWALL_NOTIFY is set
    assert isinstance(n, Notifier)
    n.channels["slack"].http = httpx.Client(transport=httpx.MockTransport(slack_api))
    run.run_until(lambda e: e["payload"].get("round") == 6)
    q = next(m for m in n.outbox() if m["kind"] == "question")
    assert q["status"] == "sent" and q["provider_ref"].startswith("C1:"), q["error"]
    monkeypatch.setitem(api.RUNS, run.run_id, run)
    c = TestClient(api.app)
    body = json.dumps({"type": "event_callback", "event": {"type": "message", "channel": "C1", "user": "U_DANA",
                                                           "thread_ts": q["provider_ref"].split(":")[1],
                                                           "text": "No, sprints don't count for Volta."}}).encode()
    assert slack_post(c, "/integrations/slack/events", body, "application/json").json()["ok"]
    assert run.ledger.one("SELECT status FROM questions WHERE q_id=?", q["context"]["q_id"])["status"] == "applied"


def test_tokens_reject_tampering_and_expiry(env):
    t = tokens.sign({"run_id": "r", "action": "approve"})
    assert tokens.verify(t)["action"] == "approve"
    body, mac = t.split(".")
    with pytest.raises(ValueError):
        tokens.verify(body + "x." + mac)
    with pytest.raises(ValueError):
        tokens.verify(tokens.sign({"a": 1}, ttl_seconds=-1))


def test_slack_signature_window():
    body = b"x=1"
    ts = str(int(time.time()))
    sig = "v0=" + hmac.new(b"k", f"v0:{ts}:x=1".encode(), hashlib.sha256).hexdigest()
    assert verify_slack(body, ts, sig, secret="k")
    assert not verify_slack(body, ts, sig, secret="other")
    assert not verify_slack(body, str(int(ts) - 600), sig, secret="k")


def test_live_email_teams_and_sms_delivery(env, monkeypatch, world):
    sent = []

    class FakeSMTP:
        def __init__(self, host, port, timeout=None):
            self.host = host

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def starttls(self):
            pass

        def login(self, user, password):
            sent.append(("login", user))

        def send_message(self, m):
            sent.append(m)

    e = {**env, "SMTP_HOST": "smtp.gmail.com", "SMTP_FROM": "pitwall@example.com", "SMTP_USER": "pitwall@example.com",
         "SMTP_PASSWORD": "app-password", "TEAMS_WEBHOOK_URL": "https://teams.example/hook", "TWILIO_ACCOUNT_SID": "AC1",
         "TWILIO_AUTH_TOKEN": "t", "TWILIO_FROM": "+15550199"}
    people = Directory(world.dir, e)
    msg = Message(kind="approval", dedupe_key="k", title="Approve reversal", body="Body", facts=[("Amount", "$1")],
                  actions=[Action("Approve", "approve", "primary"), Action("Open in Pit Wall", "open")],
                  context={"run_id": "r", "je_id": "je_1", "role": "controller"}, severity="urgent")
    email = EmailChannel(env=e, smtp_factory=FakeSMTP)
    email.deliver(email.render(msg, people.people["dana"]), people.people["dana"])
    m = sent[-1]
    assert m["To"] == "dana@example.com" and "/integrations/act?token=" in m.get_body(("html",)).get_content()
    calls = []
    transport = httpx.MockTransport(lambda r: calls.append(r) or httpx.Response(201 if "twilio" in str(r.url) else 202, json={"sid": "SM1"}))
    teams = TeamsChannel(http=httpx.Client(transport=transport), env=e)
    card = teams.render(msg, people.people["dana"])
    assert card["attachments"][0]["content"]["type"] == "AdaptiveCard"
    assert card["attachments"][0]["content"]["actions"][0]["type"] == "Action.OpenUrl"
    teams.deliver(card, None)
    sms = SmsChannel(http=httpx.Client(transport=transport), env=e)
    assert sms.deliver(sms.render(msg, people.people["priya"]), people.people["priya"]) == "SM1"
    assert b"To=%2B15550100" in calls[-1].content
