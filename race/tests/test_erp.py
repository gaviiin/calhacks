"""The books: race entries posted to the ERP through the gateway key, or held for a person's review."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

import httpx
import pytest

from race import erp
from race.events import Effect, Entry, EntryLine, RaceEvent
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


def test_thresholds_are_the_desks_own():
    from agents.config import MATERIALITY_USD_MINOR
    from finance.config import CFO_CENTS

    assert MATERIALITY_USD_MINOR == 25_000_000 and CFO_CENTS == 100_000_000
    assert erp.MATERIALITY_CENTS == MATERIALITY_USD_MINOR and erp.CFO_CENTS == CFO_CENTS


def test_a_small_entry_posts_with_an_erp_id_and_balanced_lines(fake_erp):
    st, sink = State(), FakeSink()
    x = entry(st, amount=3_000_000)
    [p] = book(st, sink, [x])
    assert p.status == "posted" and p.erp_entry_id == "JE-2024-000001" and p.by == "race_desk"
    assert "under the $250,000 review threshold" in p.reason
    [rec] = fake_erp.journal
    assert rec["work_item_id"] == x.entry_key and rec["period_key"] == "2024-11"
    assert lines_of(rec) == [("acct-6050", 3_000_000, 0), ("capadj-RACE_SPARES_INVENTORY_1400", 0, 3_000_000),
                             ("capcat-RELEVANT", 3_000_000, 0), ("acct-6050", 0, 3_000_000)]
    assert sum(l[1] for l in lines_of(rec)) == sum(l[2] for l in lines_of(rec))
    assert f"race_entry:{x.entry_key}" in rec["evidence_refs"]


def test_a_reversal_swaps_both_pairs(fake_erp):
    st, sink = State(), FakeSink()
    x = entry(st, bucket="5200", credit="2100", amount=600_550, recognition="incurred", reverse=True)
    [p] = book(st, sink, [x])
    assert p.status == "posted"
    assert lines_of(fake_erp.journal[0]) == [("capadj-RACE_ACCRUED_COSTS_2100", 600_550, 0), ("acct-5200", 0, 600_550),
                                             ("acct-5200", 600_550, 0), ("capcat-RELEVANT", 0, 600_550)]


def test_a_million_dollar_entry_is_held_for_the_cfo(fake_erp):
    st, sink = State(), FakeSink()
    [p] = book(st, sink, [entry(st, amount=120_000_000)])
    assert p.status == "held" and p.review_role == "cfo" and not p.erp_entry_id
    assert "$1,200,000" in p.reason and "K10" in p.reason
    assert fake_erp.calls == 0


def test_material_and_excluded_entries_go_to_the_head_of_cost_cap(fake_erp):
    st, sink = State(), FakeSink()
    big, fine = entry(st, amount=30_000_000), entry(st, bucket="6910", credit="2100", amount=5_000_000, recognition="excluded")
    p_big, p_fine = book(st, sink, [big, fine])
    assert (p_big.status, p_big.review_role) == ("held", "head_of_cost_cap") and "$250,000 materiality" in p_big.reason
    assert (p_fine.status, p_fine.review_role) == ("held", "head_of_cost_cap") and "outside the cap" in p_fine.reason
    sink.decide(fine.entry_key, "approved", "Head of Cost Cap")
    [posted] = review(st, sink)
    assert posted.status == "posted" and posted.by == "race_desk after Head of Cost Cap"
    assert lines_of(fake_erp.journal[0]) == [("acct-6910", 5_000_000, 0), ("capadj-RACE_ACCRUED_COSTS_2100", 0, 5_000_000),
                                             ("capcat-FINES", 5_000_000, 0), ("acct-6910", 0, 5_000_000)]


def test_an_entry_from_a_line_that_waits_for_a_person_is_held(fake_erp):
    st, sink = State(), FakeSink()
    [p] = book(st, sink, [entry(st, amount=600_550, status="needs_person")])
    assert p.status == "held" and p.review_role == "controller" and "waits for a person" in p.reason
    [p2] = book(st, sink, [entry(st, amount=150_000_000, status="needs_person")])
    assert p2.review_role == "cfo" and "waits for a person" in p2.reason and "CFO" in p2.reason


def test_approving_posts_it_and_rejecting_keeps_it_out(fake_erp):
    st, sink = State(), FakeSink()
    a, b = entry(st, amount=120_000_000), entry(st, amount=600_550, status="needs_person")
    book(st, sink, [a, b])
    assert review(st, sink) == [] and fake_erp.calls == 0  # nobody has decided yet
    sink.decide(a.entry_key, "approved", "Dana Okafor (CFO)")
    sink.decide(b.entry_key, "rejected", "Sam Reid (Controller)")
    out = {p.entry_key: p for p in review(st, sink)}
    assert out[a.entry_key].status == "posted" and out[a.entry_key].erp_entry_id == "JE-2024-000001"
    assert out[a.entry_key].by == "race_desk after Dana Okafor (CFO)" and out[a.entry_key].review_role == "cfo"
    assert out[b.entry_key].status == "rejected" and not out[b.entry_key].erp_entry_id
    assert [r["work_item_id"] for r in fake_erp.journal] == [a.entry_key]
    assert review(st, sink) == []  # nothing changes on the next call


def test_posting_the_same_entry_twice_books_one_erp_entry(fake_erp):
    st1, st2, sink = State(), State(), FakeSink()
    x = entry(st1, amount=3_000_000)
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

    class Sink:  # every reducer accepted, nobody decides
        disabled, errors, calls, url = False, 0, 0, "http://fake/v1/database/pit-wall"

        def sql(self, q):
            return []

        def __getattr__(self, name):
            return lambda *a, **k: True

    w = Weekend(1249, pace=0, sink=Sink(), offline=True, forecast=False, quiet=True)
    w.run()
    st = w.state
    assert set(st.postings) == set(st.entries)
    by = {}
    for p in st.postings.values():
        by.setdefault(p.status, []).append(p)
    assert by.get("posted") and by.get("held")
    assert all(p.erp_entry_id for p in by["posted"])
    assert {p.review_role for p in by["held"]} <= {"controller", "head_of_cost_cap", "cfo"}
    assert len(fake_erp.journal) == len(by["posted"])
    for rec in fake_erp.journal:
        assert sum(l[1] for l in lines_of(rec)) == sum(l[2] for l in lines_of(rec))
