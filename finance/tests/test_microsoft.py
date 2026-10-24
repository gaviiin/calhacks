"""Independent auditor, tamper drill, Azure OpenAI reviewer, Business Central, Outlook (Graph), impact metrics."""

import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from finance.audit import drill
from finance.audit.auditor import Auditor
from finance.audit.reviewer import AzureOpenAIReviewer, Reviewer, make_reviewer
from finance.erp.business_central import BusinessCentral, lines_for
from finance.eval import generate
from finance.impact import impact
from finance.microsoft import auth
from finance.notify.channels import EmailChannel
from finance.sim import new_run


@pytest.fixture
def season_run(world, store, tmp_path):
    requests, _ = generate(world, 2024)
    run = new_run(2024, world=world, store=store, data_dir=tmp_path, requests=requests)
    run.run_all()
    run.ledger.sealer.anchor_now()
    return run


def audit(run, **kw):
    return Auditor(run.ledger.path, run.world, run.run_id, run.season, **kw).run(review=bool(kw.get("reviewer")))


def test_clean_season_gets_a_clean_opinion(season_run):
    rep = audit(season_run)
    assert rep["opinion"] == "unmodified", rep["findings"][:3]
    assert rep["summary"]["posted"] > 50 and rep["coverage"]["A2"]["tested"] > 5
    assert rep["coverage"]["A1"]["seals"] == rep["summary"]["posted"]
    assert rep["independence"]["can_change_books"] is False


def test_auditor_cannot_write_to_the_books(season_run):
    a = Auditor(season_run.ledger.path, season_run.world, season_run.run_id, 2024)
    with pytest.raises(sqlite3.OperationalError):
        a.db.execute("UPDATE journal_entries SET memo='x'")


def test_tamper_drill_catches_every_attack(season_run):
    out = drill.run(Path(season_run.ledger.path).parent, season_run.world, season_run.run_id, 2024)
    assert out["baseline_opinion"] == "unmodified"
    assert out["caught"] == out["of"] == 4, out
    by = {a["attack"]: a for a in out["attacks"]}
    assert all(a["books_still_tie"] for a in out["attacks"])  # a trial balance alone would have missed every one
    assert any("anchored" in c for c in by["cover_up"]["caught_by"])
    assert any(c.startswith("A4") for c in by["approval_swap"]["caught_by"])
    # the real books were not touched
    assert audit(season_run)["opinion"] == "unmodified"


def test_missing_bonus_is_a_completeness_finding(season_run):
    led = season_run.ledger
    je = led.entries(kind="bonus", status="posted")[0]
    led.db.execute("UPDATE journal_entries SET status='rejected' WHERE je_id=?", (je["je_id"],))
    led.db.commit()
    rep = audit(season_run)
    assert any(f["procedure"] == "A2" and f["title"] == "Earned bonus not booked" for f in rep["findings"])


class FakeAzure:
    def __init__(self, verdict="disagree", fail=False):
        self.verdict, self.fail, self.calls = verdict, fail, []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    def create(self, **kw):
        self.calls.append(kw)
        if self.fail:
            raise RuntimeError("content_filter")
        content = (json.dumps({"verdict": self.verdict, "concern": "Quote does not support the conclusion.", "policy_ids": ["REV-02"]})
                   if kw.get("response_format") else "Memo: opinion qualified.")
        usage = SimpleNamespace(prompt_tokens=100, completion_tokens=20)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))], usage=usage)


ENV = {"AZURE_OPENAI_ENDPOINT": "https://x.openai.azure.com", "AZURE_OPENAI_DEPLOYMENT": "gpt-test", "AZURE_OPENAI_API_KEY": "k"}


def test_azure_reviewer_only_raises_items_never_clears(season_run, store):
    fake = FakeAzure("disagree")
    rev = AzureOpenAIReviewer(ENV, client=fake, store=store, run_id=season_run.run_id)
    rep = audit(season_run, reviewer=rev)
    assert fake.calls and fake.calls[0]["model"] == "gpt-test"
    assert rep["second_opinions"] and all(o["backend"] == "azure_openai" for o in rep["second_opinions"])
    raised = [f for f in rep["findings"] if f["second_opinion"]]
    assert raised and all(f["severity"] == "low" for f in raised)
    assert rep["memo"].startswith("Memo")
    assert store.costs(season_run.run_id)["model_calls"] == len(fake.calls)


def test_azure_reviewer_falls_back_when_the_model_fails(season_run):
    rev = AzureOpenAIReviewer(ENV, client=FakeAzure(fail=True))
    rep = audit(season_run, reviewer=rev)
    assert rep["opinion"] == "unmodified" and all(o.get("note") for o in rep["second_opinions"])
    assert "Opinion: UNMODIFIED" in rep["memo"]


def test_reviewer_selection():
    assert type(make_reviewer({})) is Reviewer
    assert type(make_reviewer({**ENV, "PITWALL_AUDITOR": "rules"})) is Reviewer


# ---------------------------------------------------------------------------- Business Central

BC_ENV = {"MS_TENANT_ID": "t1", "MS_CLIENT_ID": "c1", "MS_CLIENT_SECRET": "s1", "BC_ENVIRONMENT": "Sandbox", "BC_COMPANY_ID": "co1",
          "BC_JOURNAL_ID": "jr1"}


def test_bc_lines_balance_and_map_accounts(season_run):
    led = season_run.ledger
    e = next(x for x in led.entries(kind="bonus", status="posted") if x["lines"][0]["orig_currency"] != "USD")
    body = lines_for(e, {"1300": "13300", "4010": "40110"})
    assert round(sum(b["amount"] for b in body), 2) == 0
    assert {b["accountNumber"] for b in body} == {"13300", "40110"} and all(b["accountType"] == "G/L Account" for b in body)
    assert all(b["documentNumber"] == e["je_id"] for b in body) and "@" in body[0]["description"]


def test_bc_dry_export_is_idempotent_and_skips_unsealed(season_run):
    led = season_run.ledger
    led.sealer.db.execute("DELETE FROM seals WHERE seq=1")
    led.sealer.db.commit()
    bc = BusinessCentral(led, env={})
    first = bc.export("dry")
    assert first["exported"] > 50 and len(first["skipped"]) == 1 and not first["failed"]
    assert bc.export("dry")["exported"] == first["exported"]  # a dry run never blocks the real export
    assert bc.status()["by_status"]["dry_run"] == first["exported"]


def test_bc_live_export_posts_lines_then_the_journal(season_run):
    auth.clear_cache()
    calls = []

    def api(req: httpx.Request):
        calls.append(req)
        if "login.microsoftonline.com" in str(req.url):
            assert b"api.businesscentral.dynamics.com" in req.content
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600})
        assert req.headers["Authorization"] == "Bearer tok"
        if str(req.url).endswith("Microsoft.NAV.post"):
            return httpx.Response(204)
        return httpx.Response(201, json={"id": f"line{len(calls)}"})

    bc = BusinessCentral(season_run.ledger, env=BC_ENV, http=httpx.Client(transport=httpx.MockTransport(api)))
    out = bc.export("live", limit=3, post=True)
    assert out["exported"] == 3 and out["journal_posted"]["ok"]
    urls = [str(c.url) for c in calls]
    assert any("/v2.0/t1/Sandbox/api/v2.0/companies(co1)/journals(jr1)/journalLines" in u for u in urls)
    assert sum("login.microsoftonline.com" in u for u in urls) == 1  # token cached
    assert bc.status()["by_status"] == {"posted_in_bc": 3}
    n = len(calls)
    assert bc.export("live", limit=3)["entries"][0]["je_id"] not in {e["je_id"] for e in out["entries"]}  # never sent twice
    assert len(calls) > n


def test_bc_live_refuses_without_config(season_run):
    from finance.erp.business_central import BCError

    with pytest.raises(BCError):
        BusinessCentral(season_run.ledger, env={}).export("live")


# ---------------------------------------------------------------------------- Outlook via Graph


def test_outlook_via_graph_sendmail():
    auth.clear_cache()
    calls = []

    def api(req):
        calls.append(req)
        if "login" in str(req.url):
            return httpx.Response(200, json={"access_token": "g", "expires_in": 3600})
        return httpx.Response(202, headers={"request-id": "r1"})

    env = {**BC_ENV, "EMAIL_TRANSPORT": "graph", "GRAPH_SENDER": "pitwall@meridian.example"}
    ch = EmailChannel(http=httpx.Client(transport=httpx.MockTransport(api)), env=env)
    assert ch.configured()
    ref = ch.deliver({"to": "dana@meridian.example", "subject": "s", "text": "t", "html": "<p>t</p>"}, None)
    assert ref == "r1"
    send = calls[-1]
    assert str(send.url) == "https://graph.microsoft.com/v1.0/users/pitwall@meridian.example/sendMail"
    msg = json.loads(send.content)["message"]
    assert msg["toRecipients"][0]["emailAddress"]["address"] == "dana@meridian.example" and msg["body"]["contentType"] == "HTML"


# ---------------------------------------------------------------------------- impact and HTTP


def test_impact_numbers(season_run):
    out = impact(season_run)
    h = out["headline"]
    assert h["books_tie"] and h["entries_posted"] > 50
    assert 0.5 < h["straight_through_rate"] <= 1
    assert h["bonus_minutes_after_final_median"] is not None and h["bonus_minutes_after_final_median"] < 60
    assert h["manual_close_days_after_race_median"] >= 5
    assert out["control"]["overturned_results_not_invoiced"] == 5


def test_microsoft_endpoints(world, store, tmp_path, monkeypatch):
    import finance.api as api

    requests, _ = generate(world, 2024)
    (world.dir / "requests").mkdir(exist_ok=True)
    (world.dir / "requests" / "2024.json").write_text(json.dumps({"requests": requests}))
    monkeypatch.setattr(api, "WORLD", world)
    monkeypatch.setattr(api, "STORE", store)
    monkeypatch.setattr("finance.sim.DATA_DIR", tmp_path)
    monkeypatch.setenv("PITWALL_NOTIFY", "dry")
    for k in ("AZURE_OPENAI_ENDPOINT", "TEAMS_WEBHOOK_URL"):
        monkeypatch.delenv(k, raising=False)
    c = TestClient(api.app)
    rid = c.post("/api/runs", json={"season": 2024}).json()["run_id"]

    rep = c.post(f"/api/runs/{rid}/audit", json={}).json()
    assert rep["opinion"] == "unmodified" and rep["reviewer"]["backend"] == "rules"
    assert c.get(f"/api/runs/{rid}/audit").json()["audit_id"] == rep["audit_id"]
    assert c.get(f"/api/runs/{rid}/audit/findings.csv").text.startswith("id,procedure")
    assert c.post(f"/api/runs/{rid}/audit/drill").json()["caught"] == 4
    shared = c.post(f"/api/runs/{rid}/audit/share", json={"channels": ["teams"]}).json()
    assert shared["sent"] and {s["channel"] for s in shared["sent"]} == {"teams"}
    outbox = c.get(f"/api/runs/{rid}/outbox").json()["messages"]
    card = next(m for m in outbox if m["kind"] == "audit_report")["payload"]
    assert card["attachments"][0]["contentType"] == "application/vnd.microsoft.card.adaptive"

    assert c.get(f"/api/runs/{rid}/impact").json()["headline"]["books_tie"]
    ex = c.post(f"/api/runs/{rid}/erp/business-central/export", json={"mode": "dry"}).json()
    assert ex["exported"] > 50
    assert c.post(f"/api/runs/{rid}/erp/business-central/export", json={"mode": "live"}).status_code == 409
    st = c.get("/api/microsoft/status").json()
    assert set(st) >= {"entra_id", "azure_openai_auditor", "business_central", "outlook_graph", "teams", "application_insights"}
