from __future__ import annotations

import json

import pytest

from agents import config
from agents.tools import AgentTools

from .fakes import FakeStdb, FakeWorld


@pytest.fixture(scope="session")
def rulebook() -> list[dict]:
    data = json.loads(config.RULEBOOK_PATH.read_text())
    return data["entries"] if isinstance(data, dict) else data


@pytest.fixture
def stdb(rulebook) -> FakeStdb:
    s = FakeStdb()
    s.tables["rulebook_entry"] = [dict(e) for e in rulebook]
    return s


@pytest.fixture
def actors(stdb):
    return {
        "admin": stdb.actor("admin", "admin"),
        "sync": stdb.actor("sync", "sync"),
        "cap_analyst": stdb.actor("cap_analyst", "ai_cap_analyst"),
        "policy_learner": stdb.actor("policy_learner", "ai_policy_learner"),
        "controller": stdb.actor("controller", "human_controller"),
        "head_of_cost_cap": stdb.actor("head_of_cost_cap", "human_head_of_cost_cap"),
        "gateway": stdb.actor("gateway", "gateway"),
        "red_team": stdb.actor("red_team", "red_team"),
    }


@pytest.fixture
def analyst_tools(stdb, actors) -> AgentTools:
    return AgentTools(actors["cap_analyst"], stdb)


@pytest.fixture
def world() -> FakeWorld:
    return FakeWorld()


def gl(id="gl-000001", vendor_id="ven-001", account_code="6410", amount_usd_minor=720_000, memo="Canteen January",
       period_key="2026-01", posted_date="2026-01-15", bill_id=None, department_id="dept-AERO", **kw) -> dict:
    row = {"id": id, "raw_ref": f"gl_line:{id}:1", "posted_date": posted_date, "period_key": period_key,
           "account_id": f"acct-{account_code}", "account_code": account_code, "department_id": department_id,
           "vendor_id": vendor_id, "bill_id": bill_id, "amount_minor": amount_usd_minor, "currency": "USD",
           "fx_rate_e6": 1_000_000, "amount_usd_minor": amount_usd_minor, "memo": memo,
           "erp_category_code": "MARKETING", "entity": "RACING", "correction_of": None}
    row.update(kw)
    return row


def vendor(id="ven-001", name="Grove Catering", related_party=False, **kw) -> dict:
    row = {"id": id, "raw_ref": f"vendor:{id}:1", "name": name, "country": "GB", "related_party": related_party,
           "related_party_entity": None, "bank_iban": "GB00TEST", "category_hint": None}
    row.update(kw)
    return row


def policy(id=1, version=1, category_code="CATERING", rulebook_entry_id="CATERING@SECD-ISS07", pattern=None,
           state="APPROVED", effective_from="2026-01-01", effective_to=None, policy_key=None, **kw) -> dict:
    row = {"id": id, "policy_key": policy_key or f"key-{id}", "version": version, "category_code": category_code,
           "rulebook_entry_id": rulebook_entry_id,
           "pattern": json.dumps(pattern or {"vendor_id": "ven-001", "account_code": "6410"}),
           "rationale": "Grove Catering is the factory canteen", "evidence_refs": json.dumps(["h25-gl-1", "h25-gl-2"]),
           "precedent_count": 214, "effective_from": effective_from, "effective_to": effective_to, "state": state,
           "proposed_by": "learner", "decided_by": "head", "decided_reason": "ok"}
    row.update(kw)
    return row


def seed_line(stdb: FakeStdb, line: dict, ven: dict | None = None, bill_lines: list[dict] | None = None) -> dict:
    stdb.tables["gl_line"].append(line)
    if ven:
        stdb.tables["vendor"].append(ven)
    for b in bill_lines or []:
        stdb.tables["bill_line"].append(b)
    return stdb.add_item(subject_ref=line["id"], period_key=line["period_key"],
                         amount_usd_minor=line["amount_usd_minor"])
