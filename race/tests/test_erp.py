"""The books: race entries posted to the ERP through the gateway key, or held for a person's review."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

import httpx
import pytest

from race import erp
from race.events import Effect, Entry, EntryLine, Plan, RaceEvent
from world.company import ACCOUNT

SUBLEDGER = re.compile(r"^cap(cat|adj)-[A-Z0-9_]+$")  # world/api.py SUBLEDGER_ACCOUNT


class FakeErp:
    """The world API's POST /erp/journal_entries rules (world/api.py), in memory."""

    def __init__(self):
        self.journal: list[dict] = []
        self.by_work_item: dict[str, dict] = {}
        self.down = False
        self.calls = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        if self.down:
            raise httpx.ConnectError("connection refused", request=request)
        if request.headers.get("X-Gateway-Key") != "dev-gateway-key":
            return httpx.Response(403, json={"detail": "invalid X-Gateway-Key"})
        body = json.loads(request.content)
        for ln in body["lines"]:
            if (ln["debit_minor"] > 0) == (ln["credit_minor"] > 0):
                return httpx.Response(422, json={"detail": "one-sided lines"})
            acct = ln["account_id"]
            if not ((acct.startswith("acct-") and acct[5:] in ACCOUNT) or SUBLEDGER.match(acct)):
                return httpx.Response(422, json={"detail": f"unknown account {acct!r}"})
        if sum(x["debit_minor"] for x in body["lines"]) != sum(x["credit_minor"] for x in body["lines"]):
            return httpx.Response(422, json={"detail": "unbalanced"})
        prior = self.by_work_item.get(body["work_item_id"])
        if prior:
            if prior["lines"] != body["lines"]:
                return httpx.Response(409, json={"detail": "different lines"})
            return httpx.Response(200, json={"erp_entry_id": prior["erp_entry_id"]})
        rec = {"erp_entry_id": f"JE-{body['period_key'][:4]}-{len(self.journal) + 1:06d}", **body}
        self.journal.append(rec)
        self.by_work_item[body["work_item_id"]] = rec
        return httpx.Response(200, json={"erp_entry_id": rec["erp_entry_id"]})


class FakeSink:
    """race_postings as the module keeps it: our rows, then a person's decision."""

    def __init__(self):
        self.disabled = False
        self.rows: dict[str, dict] = {}
        self.reads = 0

    def record(self, postings):
        for p in postings:
            w = p.wire()
            cur = self.rows.get(p.entry_key)
            if cur and cur["status"] == "held" and p.status == "posted":
                raise AssertionError("the module refuses held -> posted without a person")
            self.rows[p.entry_key] = w

    def decide(self, key, status, by):
        assert self.rows[key]["status"] == "held"
        self.rows[key] = {**self.rows[key], "status": status, "by": by}

    def sql(self, query):
        self.reads += 1
        assert "race_postings" in query
        return list(self.rows.values())


@dataclass
class State:
    year: int = 2024
    effects: list = field(default_factory=list)
    entries: dict = field(default_factory=dict)
    postings: dict = field(default_factory=dict)
    plans: dict = field(default_factory=dict)


def planned(st: State, *entries: Entry, novel: tuple[Entry, ...] = (), status: str = "approved", by: str = "Sam Reyes") -> Plan:
    """The incident's response plan as the desk would record it: every entry a line, on precedent unless listed as novel."""
    lines = []
    for e in [*entries, *novel]:
        is_novel = e in novel
        lines.append({"ref": e.entry_key, "kind": "entry", "label": e.memo[:40], "amount_cents": e.amount_cents,
                      "status": "novel" if is_novel else "precedent", "why": "nothing like it on the record" if is_novel else "",
                      "precedent": None if is_novel else {"case_id": "press-mel24-fp1-23:fit:front_wing", "similarity": 0.93}, "components": []})
    p = Plan(plan_key="inc-1", incident_key="inc-1", version=1, lines=lines, summary="the plan", status=status,
             approved_by=by if status == "approved" else "", approved_at="2024-11-03T13:40:00Z" if status == "approved" else "")
    st.plans["inc-1"] = p
    return p


@pytest.fixture
def fake_erp(monkeypatch):
    f = FakeErp()
    monkeypatch.setattr(erp, "_http", httpx.Client(transport=httpx.MockTransport(f.handler)))
    monkeypatch.setattr(erp, "READ_EVERY_S", 0.0)
    monkeypatch.setattr(erp, "RETRY_EVERY_S", 0.0)
    monkeypatch.delenv("GATEWAY_KEY", raising=False)
    monkeypatch.delenv("RACE_ERP", raising=False)
    return f


def ev(car=43, at="2024-11-03T15:44:02Z") -> RaceEvent:
    return RaceEvent(kind="car_stopped", at=at, session_key=9636, meeting_key=1249, lap=31, driver_number=car, team_name="Williams")


def entry(st: State, bucket="6050", amount=3_000_000, status="autonomous", recognition="first_use", credit="1400", reverse=False, car=43) -> Entry:
    e = ev(car=car, at=f"2024-11-03T15:{len(st.effects):02d}:00Z")
    st.effects.append((e, [Effect("cost", bucket, amount, amount, amount, "Crash damage", "assumption", "jev", "why", {}, status)]))
    dr, cr = (credit, bucket) if reverse else (bucket, credit)
    x = Entry(entry_key=f"{e.key}:0:{recognition}", incident_key="inc-1" if bucket != "6910" else "", memo=f"Spares fitted to car {car}",
              effective_date="2024-11-03", recognition=recognition, cap_relevant=recognition != "excluded", effect_key=f"{e.key}:0",
              lines=[EntryLine(dr, debit_cents=amount), EntryLine(cr, credit_cents=amount)], evidence=[e.key], at=e.at)
    st.entries[x.entry_key] = x
    return x


def book(st: State, sink, entries) -> list:
    out = erp.post(st, entries, sink)
    for p in out:
        st.postings[p.entry_key] = p
    if sink:
        sink.record(out)
    return out


def review(st: State, sink) -> list:
    out = erp.apply_reviews(st, sink)
    for p in out:
        st.postings[p.entry_key] = p
    if sink:
        sink.record(out)
    return out


def lines_of(rec: dict) -> list[tuple[str, int, int]]:
    return [(x["account_id"], x["debit_minor"], x["credit_minor"]) for x in rec["lines"]]


def test_no_amount_threshold_anywhere():
    assert not hasattr(erp, "MATERIALITY_CENTS") and not hasattr(erp, "CFO_CENTS")
    assert erp.PRECEDENT_MIN == 0.8


def test_an_entry_posts_on_precedent_under_an_approved_plan(fake_erp):
    st, sink = State(), FakeSink()
    x = entry(st, amount=3_000_000)
    planned(st, x)
    [p] = book(st, sink, [x])
    assert p.status == "posted" and p.erp_entry_id == "JE-2024-000001" and p.by == "race_desk"
    assert "on precedent press-mel24-fp1-23:fit:front_wing (similarity 0.93) under the plan Sam Reyes approved" in p.reason
    [rec] = fake_erp.journal
    assert rec["work_item_id"].split("#")[0] == x.entry_key and rec["period_key"] == "2024-11"  # key plus a hash of its lines
    assert lines_of(rec) == [("acct-6050", 3_000_000, 0), ("capadj-RACE_SPARES_INVENTORY_1400", 0, 3_000_000),
                             ("capcat-RELEVANT", 3_000_000, 0), ("acct-6050", 0, 3_000_000)]
    assert sum(l[1] for l in lines_of(rec)) == sum(l[2] for l in lines_of(rec))
    assert f"race_entry:{x.entry_key}" in rec["evidence_refs"]


def test_without_a_plan_or_with_a_draft_the_chief_of_staff_is_asked(fake_erp):
    st, sink = State(), FakeSink()
    x = entry(st, amount=3_000_000)
    [p] = book(st, sink, [x])
    assert p.status == "held" and p.review_role == "chief_of_staff" and "no response plan" in p.reason
    planned(st, x, status="draft")
    assert erp.review_for(x, st) == ("chief_of_staff", ["the response plan for this incident waits for the chief of staff"])
    # the approval releases it: the rule is re-run for the incident's held entries and the clear ones post
    st.plans["inc-1"].status, st.plans["inc-1"].approved_by = "approved", "Sam Reyes"
    [posted] = erp.reconsider(st, "inc-1", sink)
    assert posted.status == "posted" and "under the plan Sam Reyes approved" in posted.reason
    assert fake_erp.calls == 1


def test_a_reversal_swaps_both_pairs(fake_erp):
    st, sink = State(), FakeSink()
    x = entry(st, bucket="5200", credit="2100", amount=600_550, recognition="incurred", reverse=True)
    planned(st, x)
    [p] = book(st, sink, [x])
    assert p.status == "posted"
    assert lines_of(fake_erp.journal[0]) == [("capadj-RACE_ACCRUED_COSTS_2100", 600_550, 0), ("acct-5200", 0, 600_550),
                                             ("acct-5200", 600_550, 0), ("capcat-RELEVANT", 0, 600_550)]


def test_a_million_dollar_entry_posts_when_the_team_has_done_it_before(fake_erp):
    st, sink = State(), FakeSink()
    big = entry(st, amount=120_000_000)
    planned(st, big)
    [p] = book(st, sink, [big])
    assert p.status == "posted" and "$1,200,000 on precedent" in p.reason
    assert fake_erp.calls == 1


def test_a_novel_entry_and_an_excluded_one_go_to_the_head_of_cost_cap(fake_erp):
    st, sink = State(), FakeSink()
    big, fine = entry(st, amount=3_000_000), entry(st, bucket="6910", credit="2100", amount=5_000_000, recognition="excluded")
    planned(st, novel=(big,))
    p_big, p_fine = book(st, sink, [big, fine])
    assert (p_big.status, p_big.review_role) == ("held", "head_of_cost_cap") and "no entry like it in the team's history: nothing like it on the record" in p_big.reason
    assert (p_fine.status, p_fine.review_role) == ("held", "head_of_cost_cap") and "outside the cap" in p_fine.reason
    sink.decide(fine.entry_key, "approved", "Head of Cost Cap")
    [posted] = review(st, sink)
    assert posted.status == "posted" and posted.by == "race_desk after Head of Cost Cap"
    assert lines_of(fake_erp.journal[0]) == [("acct-6910", 5_000_000, 0), ("capadj-RACE_ACCRUED_COSTS_2100", 0, 5_000_000),
                                             ("capcat-FINES", 5_000_000, 0), ("acct-6910", 0, 5_000_000)]


def test_an_entry_from_a_line_that_waits_for_a_person_is_held(fake_erp):
    st, sink = State(), FakeSink()
    a = entry(st, amount=600_550, status="needs_person")
    b = entry(st, amount=150_000_000, status="needs_person")
    planned(st, a, b)
    [p] = book(st, sink, [a])
    assert p.status == "held" and p.review_role == "controller" and "waits for a person" in p.reason
    [p2] = book(st, sink, [b])
    assert p2.review_role == "controller" and "waits for a person" in p2.reason  # the amount changes nothing


def test_an_adjustment_to_an_entry_not_in_the_erp_is_held_with_it(fake_erp):
    st, sink = State(), FakeSink()
    orig = entry(st, amount=50_000_000)
    planned(st, novel=(orig,))
    [p] = book(st, sink, [orig])
    assert p.status == "held" and p.review_role == "head_of_cost_cap"
    down = Entry(entry_key=f"{orig.entry_key}:adj", incident_key="inc-1", memo="Adjustment after the garage's assessment (-$200,000)",
                 effective_date="2024-11-03", recognition="first_use", cap_relevant=True, effect_key=orig.effect_key,
                 lines=[EntryLine("1400", debit_cents=20_000_000), EntryLine("6050", credit_cents=20_000_000)], evidence=[], at=orig.at)
    st.entries[down.entry_key] = down
    [a] = book(st, sink, [down])
    assert a.status == "held" and a.review_role == "head_of_cost_cap" and "reviewed together" in a.reason, "under $250k, but its entry is not posted"
    assert fake_erp.calls == 0

    st2, sink2 = State(), FakeSink()
    small = entry(st2, amount=3_000_000)
    planned(st2, small)
    [q] = book(st2, sink2, [small])
    assert q.status == "posted"
    adj = Entry(entry_key=f"{small.entry_key}:adj", incident_key="inc-1", memo="Adjustment (+$10,000)", effective_date="2024-11-03",
                recognition="first_use", cap_relevant=True, effect_key=small.effect_key,
                lines=[EntryLine("6050", debit_cents=1_000_000), EntryLine("1400", credit_cents=1_000_000)], evidence=[], at=small.at)
    st2.entries[adj.entry_key] = adj
    st2.plans["inc-1"].lines.append({**st2.plans["inc-1"].line(small.entry_key), "ref": adj.entry_key})
    [b] = book(st2, sink2, [adj])
    assert b.status == "posted", "its entry is in the ERP: the adjustment follows on the desk's authority"


def test_approving_posts_it_and_rejecting_keeps_it_out(fake_erp):
    st, sink = State(), FakeSink()
    a, b = entry(st, amount=120_000_000), entry(st, amount=600_550, status="needs_person")
    planned(st, b, novel=(a,))
    book(st, sink, [a, b])
    assert review(st, sink) == [] and fake_erp.calls == 0  # nobody has decided yet
    sink.decide(a.entry_key, "approved", "Dana Okafor (CFO)")
    sink.decide(b.entry_key, "rejected", "Sam Reid (Controller)")
    out = {p.entry_key: p for p in review(st, sink)}
    assert out[a.entry_key].status == "posted" and out[a.entry_key].erp_entry_id == "JE-2024-000001"
    assert out[a.entry_key].by == "race_desk after Dana Okafor (CFO)" and out[a.entry_key].review_role == "head_of_cost_cap"
    assert out[b.entry_key].status == "rejected" and not out[b.entry_key].erp_entry_id
    assert [r["work_item_id"].split("#")[0] for r in fake_erp.journal] == [a.entry_key]
    assert review(st, sink) == []  # nothing changes on the next call


def test_posting_the_same_entry_twice_books_one_erp_entry(fake_erp):
    st1, st2, sink = State(), State(), FakeSink()
    x = entry(st1, amount=3_000_000)
    planned(st1, x)
    planned(st2, x)
    st2.effects, st2.entries = st1.effects, dict(st1.entries)
    [p1] = book(st1, sink, [x])
    [p2] = erp.post(st2, [x], sink)  # a second process: the ERP's work_item_id makes it idempotent
    [p3] = erp.post(st1, [x], sink)  # the same process: answered from what it already posted
    assert p1.erp_entry_id == p2.erp_entry_id == p3.erp_entry_id
    assert len(fake_erp.journal) == 1 and fake_erp.calls == 2


def test_erp_down_fails_then_posts_on_retry(fake_erp):
    st, sink = State(), FakeSink()
    fake_erp.down = True
    x = entry(st, amount=3_000_000)
    planned(st, x)
    [p] = book(st, sink, [x])
    assert p.status == "failed" and "ERP unreachable" in p.reason and "will retry" in p.reason
    assert review(st, sink) == []  # still down: nothing changed, nothing to record
    fake_erp.down = False
    [p2] = review(st, sink)
    assert p2.status == "posted" and p2.erp_entry_id == "JE-2024-000001" and "on retry" in p2.reason
    assert review(st, sink) == []


def test_an_approved_entry_the_erp_refuses_is_retried_as_the_approver(fake_erp):
    st, sink = State(), FakeSink()
    x = entry(st, amount=120_000_000)
    planned(st, novel=(x,))
    book(st, sink, [x])
    sink.decide(x.entry_key, "approved", "Dana Okafor (CFO)")
    fake_erp.down = True
    [p] = review(st, sink)
    assert p.status == "failed" and p.by == "race_desk after Dana Okafor (CFO)"
    fake_erp.down = False
    [p2] = review(st, sink)
    assert p2.status == "posted" and p2.by == "race_desk after Dana Okafor (CFO)"


def test_offline_without_a_sink_nothing_reaches_the_erp(fake_erp):
    st = State()
    small, big = entry(st, amount=3_000_000), entry(st, amount=120_000_000)
    planned(st, small, novel=(big,))
    p_small, p_big = book(st, None, [small, big])
    assert p_small.status == "failed" and "dry run" in p_small.reason
    assert p_big.status == "held"
    assert review(st, None) == [] and fake_erp.calls == 0


def test_rate_limit_reads_postings_at_most_once_a_second(fake_erp, monkeypatch):
    monkeypatch.setattr(erp, "READ_EVERY_S", 60.0)
    st, sink = State(), FakeSink()
    book(st, sink, [entry(st, amount=120_000_000)])
    review(st, sink)
    review(st, sink)
    assert sink.reads == 1


def test_the_weekend_books_its_entries(fake_erp):
    """São Paulo 2024, offline: every entry gets a posting; small ones reach the ERP, material ones wait."""
    from race.weekend import Weekend

    from race import people

    class Sink:  # every reducer accepted; the plans the replayed chief of staff approves are read back, as the module would hand them back
        disabled, errors, calls, url = False, 0, 0, "http://fake/v1/database/pit-wall"

        def __init__(self):
            self.plans = {}

        def call(self, reducer, args):
            if reducer == "approve_race_plan":
                self.plans[args[0]] = {"plan_key": args[0], "status": args[1], "approved_by": args[2], "approved_at": args[3]}
            return True

        def sql(self, q):
            return list(self.plans.values()) if "race_plans" in q else []

        def __getattr__(self, name):
            return lambda *a, **k: True

    sink = Sink()
    w = Weekend(1249, pace=0, sink=sink, offline=True, forecast=False, quiet=True, script=people.load_script(1249), until="2024-11-03T16:44:00Z")
    w.run()
    st = w.state
    assert set(st.postings) == set(st.entries)
    assert len(st.plans) == len(st.incidents) and all(p.lines for p in st.plans.values())
    assert {k for k, p in st.plans.items() if p.status == "approved"} == {"1249-9627-43-1", "1249-9627-23-1"}, "the morning's plans, replayed"
    by = {}
    for p in st.postings.values():
        by.setdefault(p.status, []).append(p)
    assert by.get("posted") and by.get("held")
    assert all(p.erp_entry_id for p in by["posted"]) and all("on precedent" in p.reason and "under the plan Chief of Staff (replayed) approved" in p.reason for p in by["posted"])
    assert {p.review_role for p in by["held"]} <= {"controller", "head_of_cost_cap", "cfo", "chief_of_staff"}
    assert any(p.review_role == "chief_of_staff" for p in by["held"]), "the race crash's plan is still a draft at the snapshot"
    assert len(fake_erp.journal) == len(by["posted"])
    for rec in fake_erp.journal:
        assert sum(l[1] for l in lines_of(rec)) == sum(l[2] for l in lines_of(rec))


# ---------------------------------------------------------------- pit-wall decides

class PitWallSink(FakeSink):
    """A sink whose database decides: request_posting returns the module's row, never the desk's opinion."""

    def __init__(self, decisions: dict[str, tuple[str, str, str]]):
        super().__init__()
        self.decisions = decisions
        self.requests: list[str] = []

    def request_posting(self, entry_key, at):
        self.requests.append(entry_key)
        status, role, reason = self.decisions[entry_key]
        self.rows[entry_key] = {"entry_key": entry_key, "status": status, "review_role": role, "reason": reason, "by": "pit-wall"}
        return dict(self.rows[entry_key])

    def record(self, postings):
        for p in postings:
            cur = self.rows.get(p.entry_key)
            if p.status == "posted" and not (cur and cur["status"] in ("authorized", "approved", "posted")):
                raise AssertionError("pit-wall refuses a posting it did not authorize")
            if p.status in ("posted", "failed") or cur is None:
                self.rows[p.entry_key] = {**(cur or {}), **p.wire(), "status": p.status if p.status == "posted" else (cur or {}).get("status", p.status)}


def test_the_desk_sends_only_what_pit_wall_authorized(fake_erp):
    st = State()
    small = entry(st, amount=3_000_000)  # small enough to post on the desk's rules, but only Jev's estimate
    other = entry(st, amount=2_000_000)
    sink = PitWallSink({small.entry_key: ("held", "controller", "held for review: the estimate is Jev's alone"),
                        other.entry_key: ("authorized", "", "authorized by pit-wall: $20,000 on precedent press-x (similarity 0.90), under the plan Sam Reyes approved")})
    out = {p.entry_key: p for p in book(st, sink, [small, other])}
    assert sink.requests == [small.entry_key, other.entry_key]
    assert out[small.entry_key].status == "held" and out[small.entry_key].review_role == "controller"
    assert "Jev's alone" in out[small.entry_key].reason
    assert out[other.entry_key].status == "posted" and len(fake_erp.journal) == 1
    # a person signs off the estimate: pit-wall flips the row to authorized and the desk posts it on its next look
    sink.rows[small.entry_key]["status"] = "authorized"
    [p] = review(st, sink)
    assert p.status == "posted" and len(fake_erp.journal) == 2


def test_the_erp_gateway_refuses_a_race_entry_pit_wall_did_not_authorize(monkeypatch):
    from fastapi.testclient import TestClient

    from world import api

    body = {"work_item_id": "race-e1", "period_key": "2024-11", "memo": "Race desk incurred: crash parts",
            "evidence_refs": ["race_entry:e1"], "lines": [{"account_id": "capcat-X", "debit_minor": 100, "credit_minor": 0},
                                                          {"account_id": "capadj-Y", "debit_minor": 0, "credit_minor": 100}]}
    h = {"X-Gateway-Key": "dev-gateway-key"}
    monkeypatch.delenv("GATEWAY_KEY", raising=False)
    monkeypatch.delenv("ERP_REQUIRE_PITWALL", raising=False)
    with TestClient(api.create_app() if hasattr(api, "create_app") else api.app) as client:
        monkeypatch.setattr(api, "pitwall_posting_status", lambda key: "held")
        r = client.post("/erp/journal_entries", json=body, headers=h)
        assert r.status_code == 403 and "has not authorized race entry e1 (held)" in r.json()["detail"]
        monkeypatch.setattr(api, "pitwall_posting_status", lambda key: None)
        assert client.post("/erp/journal_entries", json=body, headers=h).status_code == 503  # fail closed
        monkeypatch.setattr(api, "pitwall_posting_status", lambda key: "authorized")
        assert client.post("/erp/journal_entries", json=body, headers=h).status_code == 200
        # entries that are not race entries are the cost cap gateway's and are not asked about
        monkeypatch.setattr(api, "pitwall_posting_status", lambda key: (_ for _ in ()).throw(AssertionError("asked")))
        assert client.post("/erp/journal_entries", json={**body, "work_item_id": "w2", "evidence_refs": ["gl:1"]}, headers=h).status_code == 200
