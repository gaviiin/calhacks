"""Positional argument arrays for every reducer the agents call.

This is the ONE place that knows reducer argument order. Reconciled with the authoritative
system_of_work/REDUCERS.md (verified live on SpacetimeDB 2.13): every builder below matches its
"positional args" column exactly. Encoding: u64/u32/i64 as JSON numbers, `Option<T>` as
{"some": v} / {"none": []}, and `evidenceRefs` / `pattern` as JSON strings containing JSON.
`proposePolicy.version` = 0 means "next version for this policy_key" (the module assigns it).

If REDUCERS.md changes, change this file and agents/tests/test_reducer_args.py, nothing else.
"""

from __future__ import annotations

import json
from typing import Any, Iterable

from .stdb import opt

# Reducer names (exported const names in the module, camelCase).
BOOTSTRAP_ADMIN = "bootstrapAdmin"
CREATE_ROLE_INVITE = "createRoleInvite"
CLAIM_ROLE = "claimRole"
SET_SETTING = "setSetting"
LOAD_RULEBOOK_ENTRY = "loadRulebookEntry"
LOCK_PERIOD = "lockPeriod"
UPSERT_GL_LINE = "upsertGlLine"
UPSERT_BILL_LINE = "upsertBillLine"
UPSERT_VENDOR = "upsertVendor"
UPSERT_FAIR_VALUE = "upsertFairValue"
PROPOSE = "propose"
ASK = "ask"
ANSWER = "answer"
APPROVE = "approve"
REJECT = "reject"
POST = "post"
PROPOSE_POLICY = "proposePolicy"
PROPOSE_ALLOCATIONS = "proposeAllocations"
APPROVE_POLICY = "approvePolicy"
REJECT_POLICY = "rejectPolicy"
TEACH_POLICY = "teachPolicy"
GRANT_AUTONOMY = "grantAutonomy"
REVOKE_AUTONOMY = "revokeAutonomy"
RECORD_STEP = "recordStep"


def _json_list(x: Iterable[str] | str | None) -> str:
    if x is None:
        return "[]"
    if isinstance(x, str):
        # already JSON? keep it; otherwise treat as a single ref
        try:
            parsed = json.loads(x)
            if isinstance(parsed, list):
                return json.dumps([str(i) for i in parsed])
        except ValueError:
            pass
        return json.dumps([x])
    return json.dumps([str(i) for i in x])


def _json_obj(x: dict | str) -> str:
    if isinstance(x, str):
        json.loads(x)  # validate
        return x
    return json.dumps(x, sort_keys=True)


def _int(x: Any) -> int:
    return int(x)


def _opt_int(x: Any) -> dict:
    return opt(None if x is None else int(x))


# ---- admin / roles -----------------------------------------------------------------------------


def bootstrap_admin() -> list:
    return []


def create_role_invite(role: str, label: str, code: str) -> list:
    return [role, label, code]


def claim_role(code: str) -> list:
    return [code]


def set_setting(key: str, value: Any) -> list:
    return [key, str(value)]


def load_rulebook_entry(e: dict) -> list:
    """rulebook_entry { id, category_code, treatment, rule_version, article, effective_from,
    effective_to?, title, text, cap_limit_usd_minor? }"""
    cap = e.get("cap_limit_usd_minor")
    return [
        e["id"],
        e["category_code"],
        e["treatment"],
        e["rule_version"],
        e["article"],
        e["effective_from"],
        opt(e.get("effective_to")),
        e["title"],
        e["text"],
        opt(None if cap is None else int(cap)),
    ]


def lock_period(period_key: str) -> list:
    return [period_key]


# ---- sync (golden rows) ------------------------------------------------------------------------


def upsert_gl_line(g: dict) -> list:
    """gl_line { id, raw_ref, posted_date, period_key, account_id, account_code, department_id,
    vendor_id?, bill_id?, amount_minor, currency, fx_rate_e6, amount_usd_minor, memo,
    erp_category_code, entity, correction_of? }  (synced_at is filled by the reducer)"""
    return [
        g["id"],
        g["raw_ref"],
        g["posted_date"],
        g["period_key"],
        g["account_id"],
        str(g["account_code"]),
        g["department_id"],
        opt(g.get("vendor_id")),
        opt(g.get("bill_id")),
        _int(g["amount_minor"]),
        g["currency"],
        _int(g["fx_rate_e6"]),
        _int(g["amount_usd_minor"]),
        g.get("memo") or "",
        g.get("erp_category_code") or "",
        g["entity"],
        opt(g.get("correction_of")),
    ]


def upsert_bill_line(b: dict) -> list:
    """bill_line { id, raw_ref, bill_id, gl_line_id?, line_no: u32, description, amount_minor,
    bill_text, vendor_id, bank_iban_on_bill }"""
    return [
        b["id"],
        b["raw_ref"],
        b["bill_id"],
        opt(b.get("gl_line_id")),
        _int(b["line_no"]),
        b.get("description") or "",
        _int(b["amount_minor"]),
        b.get("bill_text") or "",
        b.get("vendor_id") or "",
        b.get("bank_iban_on_bill") or "",
    ]


def upsert_vendor(v: dict) -> list:
    """vendor { id, raw_ref, name, country, related_party: bool, related_party_entity?, bank_iban,
    category_hint? }"""
    return [
        v["id"],
        v["raw_ref"],
        v["name"],
        v.get("country") or "",
        bool(v.get("related_party", False)),
        opt(v.get("related_party_entity")),
        v.get("bank_iban") or "",
        opt(v.get("category_hint")),
    ]


def upsert_fair_value(f: dict) -> list:
    """fair_value { id, raw_ref, counterparty_vendor_id, item, contract_value_minor,
    fair_value_minor, currency, effective_from, basis }"""
    return [
        f["id"],
        f["raw_ref"],
        f["counterparty_vendor_id"],
        f.get("item") or "",
        _int(f["contract_value_minor"]),
        _int(f["fair_value_minor"]),
        f["currency"],
        f["effective_from"],
        f.get("basis") or "",
    ]


# ---- work items --------------------------------------------------------------------------------


PROPOSAL_SOURCES = ("deterministic", "llm", "human_text")


def propose(work_item_id: int, category_code: str, rulebook_entry_id: str, policy_id: int | None,
            reason: str, evidence_refs: Iterable[str] | str, cap_effect_usd_minor: int | None = None,
            proposal_source: str = "deterministic") -> list:
    """{workItemId, categoryCode, rulebookEntryId, policyId?, reason, evidenceRefs,
    capEffectUsdMinor?: i64, proposalSource} (SCHEMA §10 "Cap effect on adjustments").

    capEffectUsdMinor is required for ADJUSTMENT treatments (the signed amount added to
    relevant_usd_minor at post) and must be absent for RELEVANT / EXCLUDED; the module checks it.
    proposalSource is one of PROPOSAL_SOURCES; the auto_approver only approves "deterministic".
    """
    if proposal_source not in PROPOSAL_SOURCES:
        raise ValueError(f"proposal_source must be one of {PROPOSAL_SOURCES}, not {proposal_source!r}")
    return [_int(work_item_id), category_code, rulebook_entry_id, _opt_int(policy_id), reason,
            _json_list(evidence_refs), _opt_int(cap_effect_usd_minor), proposal_source]


ALLOCATION_BASES = ("bill_line", "share", "cap_limit_excess")
ALLOCATED = "ALLOCATED"  # proposed_category_code / proposed_rulebook_entry_id of an allocated item
# REDUCERS.md "SATS-JSON for HTTP callers": each AllocationInput is a POSITIONAL array in this order
ALLOCATION_FIELDS = ("basis", "basisRef", "categoryCode", "rulebookEntryId", "policyId", "amountUsdMinor",
                     "capEffectUsdMinor")


def allocation(basis: str, basis_ref: str, category_code: str, rulebook_entry_id: str, policy_id: int | None,
               amount_usd_minor: int, cap_effect_usd_minor: int | None = None) -> list:
    """One `AllocationInput` (SCHEMA §11.1) as REDUCERS.md asks: a positional array
    [basis, basisRef, categoryCode, rulebookEntryId, policyId?, amountUsdMinor, capEffectUsdMinor?],
    options as {"some": v} / {"none": []}."""
    if basis not in ALLOCATION_BASES:
        raise ValueError(f"basis must be one of {ALLOCATION_BASES}, not {basis!r}")
    if not basis_ref or not category_code or not rulebook_entry_id:
        raise ValueError("basisRef, categoryCode and rulebookEntryId must be non-empty")
    return [basis, str(basis_ref), category_code, rulebook_entry_id, _opt_int(policy_id), _int(amount_usd_minor),
            _opt_int(cap_effect_usd_minor)]


def propose_allocations(work_item_id: int, allocations: Iterable[dict | list], reason: str,
                        evidence_refs: Iterable[str] | str, proposal_source: str = "deterministic") -> list:
    """{workItemId: u64, allocations: AllocationInput[], reason, evidenceRefs, proposalSource} (REDUCERS.md).

    `allocations` items are either already-built `allocation(...)` arrays or dicts with the
    snake_case keys basis, basis_ref, category_code, rulebook_entry_id, policy_id, amount_usd_minor,
    cap_effect_usd_minor."""
    if proposal_source not in PROPOSAL_SOURCES:
        raise ValueError(f"proposal_source must be one of {PROPOSAL_SOURCES}, not {proposal_source!r}")
    out = []
    for a in allocations:
        if isinstance(a, list):
            out.append(list(a))
        else:
            out.append(allocation(a["basis"], a["basis_ref"], a["category_code"], a["rulebook_entry_id"],
                                  a.get("policy_id"), a["amount_usd_minor"], a.get("cap_effect_usd_minor")))
    return [_int(work_item_id), out, reason, _json_list(evidence_refs), proposal_source]


def ask(work_item_id: int, question: str) -> list:
    return [_int(work_item_id), question]


def answer(work_item_id: int, answer_text: str) -> list:
    return [_int(work_item_id), answer_text]


def approve(work_item_id: int, reason: str) -> list:
    return [_int(work_item_id), reason]


def reject(work_item_id: int, reason: str) -> list:
    return [_int(work_item_id), reason]


def post(work_item_id: int, erp_entry_id: str) -> list:
    return [_int(work_item_id), erp_entry_id]


# ---- policies ----------------------------------------------------------------------------------


AUTO_VERSION = 0


def cornerstones_json(cornerstones: Iterable[dict] | str | None) -> str:
    """JSON array of {"ref", "category_code"} (SCHEMA §11.2), as a string."""
    if cornerstones is None:
        return "[]"
    if isinstance(cornerstones, str):
        v = json.loads(cornerstones)
        if not isinstance(v, list):
            raise ValueError("cornerstones must be a JSON array")
        return cornerstones
    return json.dumps([{"ref": str(c["ref"]), "category_code": c["category_code"]} for c in cornerstones])


def propose_policy(policy_key: str, version: int, category_code: str, rulebook_entry_id: str,
                   pattern: dict | str, rationale: str, evidence_refs: Iterable[str] | str,
                   precedent_count: int, effective_from: str, effective_to: str | None,
                   parent_policy_id: int | None = None,
                   cornerstones: Iterable[dict] | str | None = None) -> list:
    """REDUCERS.md: policyKey, version: u32, categoryCode, rulebookEntryId, pattern, rationale,
    evidenceRefs, precedentCount: u32, effectiveFrom, effectiveTo?, parentPolicyId?: u64,
    cornerstones (SCHEMA §11.2: the last two appended after effectiveTo).

    Pass version=AUTO_VERSION (0) to let the module assign the next version for the key; an
    explicit version that already exists is a 530.
    """
    return [
        policy_key,
        _int(version),
        category_code,
        rulebook_entry_id,
        _json_obj(pattern),
        rationale,
        _json_list(evidence_refs),
        _int(precedent_count),
        effective_from,
        opt(effective_to),
        _opt_int(parent_policy_id),
        cornerstones_json(cornerstones),
    ]


def approve_policy(policy_id: int, reason: str) -> list:
    return [_int(policy_id), reason]


def reject_policy(policy_id: int, reason: str) -> list:
    return [_int(policy_id), reason]


def teach_policy(work_item_id: int, category_code: str, rulebook_entry_id: str, pattern: dict | str, reason: str) -> list:
    """REDUCERS.md: workItemId, categoryCode, rulebookEntryId, pattern (JSON string), reason. A person
    turns their decision on a line into a narrow rule, approved by them in the same call."""
    return [_int(work_item_id), category_code, rulebook_entry_id, _json_obj(pattern), reason]


def grant_autonomy(policy_id: int, evidence: dict | str, reason: str) -> list:
    """{policyId, evidence, reason} (SCHEMA §6). evidence is the sandbox record, JSON in a string."""
    return [_int(policy_id), _json_obj(evidence), reason]


def revoke_autonomy(policy_id: int, reason: str) -> list:
    return [_int(policy_id), reason]


# ---- agent steps (SCHEMA §6b) ------------------------------------------------------------------


def record_step(run_id: str, step: int, kind: str, name: str, input_json: str, output_digest: str,
                output_excerpt: str, work_item_id: int | None, model: str | None) -> list:
    """{runId, step: u32, kind, name, input, outputDigest, outputExcerpt, workItemId?: u64, model?}"""
    return [run_id, _int(step), kind, name, input_json, output_digest, output_excerpt,
            _opt_int(work_item_id), opt(model)]
