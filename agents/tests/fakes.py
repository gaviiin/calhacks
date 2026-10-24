"""Test doubles: FakeStdb (a small in-memory cost_cap_desk module), FakeWorld (the cursor API over
httpx.MockTransport, so the real WorldClient is exercised), FakeAnthropic (a scripted tool runner)."""

from __future__ import annotations

import json
import re
from collections import defaultdict
from types import SimpleNamespace
from typing import Any

import httpx

from agents.identities import Actor
from agents.world_client import WorldClient

# Field orders from SCHEMA.md §6 (independent of agents/reducers.py on purpose).
GL_FIELDS = ["id", "raw_ref", "posted_date", "period_key", "account_id", "account_code", "department_id",
             "vendor_id", "bill_id", "amount_minor", "currency", "fx_rate_e6", "amount_usd_minor", "memo",
             "erp_category_code", "entity", "correction_of"]
BILL_LINE_FIELDS = ["id", "raw_ref", "bill_id", "gl_line_id", "line_no", "description", "amount_minor",
                    "bill_text", "vendor_id", "bank_iban_on_bill"]
VENDOR_FIELDS = ["id", "raw_ref", "name", "country", "related_party", "related_party_entity", "bank_iban",
                 "category_hint"]
FV_FIELDS = ["id", "raw_ref", "counterparty_vendor_id", "item", "contract_value_minor", "fair_value_minor",
             "currency", "effective_from", "basis"]
RULEBOOK_FIELDS = ["id", "category_code", "treatment", "rule_version", "article", "effective_from",
                   "effective_to", "title", "text", "cap_limit_usd_minor"]
POLICY_ARG_FIELDS = ["policy_key", "version", "category_code", "rulebook_entry_id", "pattern", "rationale",
                     "evidence_refs", "precedent_count", "effective_from", "effective_to", "parent_policy_id",
                     "cornerstones"]
ALLOCATION_FIELDS = ["basis", "basisRef", "categoryCode", "rulebookEntryId", "policyId", "amountUsdMinor",
                     "capEffectUsdMinor"]
APPORTIONABLE = {"NON_F1", "HERITAGE"}

HUMAN = ("human_controller", "human_head_of_cost_cap")


def unopt(v: Any) -> Any:
    if isinstance(v, dict) and len(v) == 1:
        if "some" in v:
            return v["some"]
        if "none" in v:
            return None
    return v


class FakeStdb:
    """Records every call; serves `SELECT * FROM t [WHERE a = x [AND b = y]]`; optionally simulates
    the module's reducers (roles matrix, SoD, materiality, period lock, audit rows on denial)."""

    def __init__(self, simulate: bool = True, materiality: int = 25_000_000):
        self.tables: dict[str, list[dict]] = defaultdict(list)
        self.calls: list[tuple[str, str, list]] = []
        self.tokens: dict[str, str] = {}
        self.simulate = simulate
        self._n = 0
        self._ids: dict[str, int] = defaultdict(int)
        self.tables["setting"].append({"key": "materiality_usd_minor", "value": str(materiality)})
        self.raise_on: set[str] = set()

    # -- identities
    def create_identity(self) -> tuple[str, str]:
        self._n += 1
        ident, tok = f"{self._n:064x}", f"tok-{self._n}"
        self.tokens[tok] = ident
        return ident, tok

    def actor(self, name: str, role: str | None) -> Actor:
        ident, tok = self.create_identity()
        if role:
            self.tables["role"].append({"identity": ident, "role": role, "label": name})
        return Actor(name, ident, tok, role or "")

    # -- sql
    def sql(self, token: str, query: str) -> list[dict]:
        m = re.match(r"\s*SELECT \* FROM (\w+)(?: WHERE (.+))?\s*$", query, re.IGNORECASE | re.DOTALL)
        assert m, f"unsupported SQL in fake: {query}"
        table, where = m.group(1), m.group(2)
        conds = []
        if where:
            for part in re.split(r"\s+AND\s+", where):
                cm = re.match(r"\s*(\w+)\s*=\s*('(?:[^']|'')*'|0x[0-9a-fA-F]+|-?\d+|true|false)\s*$", part,
                              re.IGNORECASE)
                assert cm, f"unsupported WHERE in fake: {part}"
                raw = cm.group(2)
                if raw.lower().startswith("0x"):
                    val = raw[2:].lower()  # identity literal; identities are stored without 0x
                elif raw.startswith("'"):
                    val: Any = raw[1:-1].replace("''", "'")
                elif raw.lower() in ("true", "false"):
                    val = raw.lower() == "true"
                else:
                    val = int(raw)
                conds.append((cm.group(1), val))
        return [dict(r) for r in self.tables.get(table, []) if all(r.get(c) == v for c, v in conds)]

    # -- helpers
    def next_id(self, table: str) -> int:
        self._ids[table] += 1
        return self._ids[table]

    def role_of(self, token: str) -> str | None:
        ident = self.tokens.get(token)
        for r in self.tables["role"]:
            if r["identity"] == ident:
                return r["role"]
        return None

    def item(self, wid: int) -> dict:
        for r in self.tables["work_item"]:
            if r["id"] == int(wid):
                return r
        raise KeyError(f"unknown work item {wid}")  # invalid args throw

    def add_item(self, **kw) -> dict:
        row = {"id": self.next_id("work_item"), "kind": "classification", "state": "NEW", "proposed_by": None,
               "proposed_category_code": None, "proposed_rulebook_entry_id": None, "proposed_policy_id": None,
               "reason": "", "evidence_refs": "[]", "question": None, "answer": None, "decided_by": None,
               "decided_reason": None, "erp_entry_id": None, "amount_usd_minor": 0,
               "cap_effect_usd_minor": None, "proposal_source": ""}
        row.update(kw)
        self.tables["work_item"].append(row)
        return row

    def audit(self, token: str, action: str, subject: Any, allowed: bool, frm: Any = None, to: Any = None,
              reason: str = "") -> None:
        self.tables["audit_log"].append({
            "id": self.next_id("audit_log"), "actor": self.tokens.get(token), "actor_role": self.role_of(token),
            "action": action, "resource_kind": "work_item", "subject_id": str(subject), "allowed": allowed,
            "from_state": frm, "to_state": to, "reason": reason})

    def _upsert(self, table: str, row: dict) -> bool:
        rows = self.tables[table]
        for i, r in enumerate(rows):
            if r["id"] == row["id"]:
                rows[i] = row
                return False
        rows.append(row)
        return True

    def reducer_calls(self, name: str | None = None) -> list[tuple[str, str, list]]:
        return [c for c in self.calls if name is None or c[1] == name]

    # -- reducers
    def call(self, token: str, reducer: str, args: list | None = None) -> None:
        args = list(args or [])
        json.dumps(args)  # must be JSON-serialisable, like the HTTP body
        self.calls.append((token, reducer, args))
        if reducer in self.raise_on:
            from agents.stdb import StdbError
            raise StdbError(f"{reducer} failed (fake)", 500, "")
        if not self.simulate:
            return
        getattr(self, f"_r_{reducer}", lambda t, a: None)(token, args)

    def _r_bootstrapAdmin(self, t, a):
        if not self.tables["role"]:
            self.tables["role"].append({"identity": self.tokens[t], "role": "admin", "label": "admin"})

    def _r_createRoleInvite(self, t, a):
        if self.role_of(t) != "admin":
            return self.audit(t, "create_role_invite", a[2], False)
        self.tables["role_invite"].append({"code": a[2], "role": a[0], "label": a[1], "used": False})

    def _r_claimRole(self, t, a):
        for inv in self.tables["role_invite"]:
            if inv["code"] == a[0] and not inv["used"]:
                inv["used"] = True
                self.tables["role"].append({"identity": self.tokens[t], "role": inv["role"], "label": inv["label"]})
                return
        self.audit(t, "claim_role", a[0], False)

    def _r_setSetting(self, t, a):
        if self.role_of(t) != "admin":
            return self.audit(t, "set_setting", a[0], False)
        self.tables["setting"] = [r for r in self.tables["setting"] if r["key"] != a[0]] + [{"key": a[0], "value": a[1]}]

    def _r_loadRulebookEntry(self, t, a):
        if self.role_of(t) != "admin":
            return self.audit(t, "load_rulebook_entry", a[0], False)
        self._upsert("rulebook_entry", {k: unopt(v) for k, v in zip(RULEBOOK_FIELDS, a)})

    def _r_upsertGlLine(self, t, a):
        row = {k: unopt(v) for k, v in zip(GL_FIELDS, a)}
        if self._upsert("gl_line", row):
            self.add_item(subject_ref=row["id"], period_key=row["period_key"], amount_usd_minor=row["amount_usd_minor"])

    def _r_upsertBillLine(self, t, a):
        self._upsert("bill_line", {k: unopt(v) for k, v in zip(BILL_LINE_FIELDS, a)})

    def _r_upsertVendor(self, t, a):
        self._upsert("vendor", {k: unopt(v) for k, v in zip(VENDOR_FIELDS, a)})

    def _r_upsertFairValue(self, t, a):
        self._upsert("fair_value", {k: unopt(v) for k, v in zip(FV_FIELDS, a)})

    def _locked(self, period_key: str) -> bool:
        return any(p["key"] == period_key and p["locked"] for p in self.tables["period"])

    def _covers(self, frm, to, period_key):
        y, m = (int(x) for x in period_key.split("-"))
        last = [31, 29 if (y % 4 == 0 and y % 100 != 0) or y % 400 == 0 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
        return frm <= f"{period_key}-01" and (to is None or to >= f"{period_key}-{last:02d}")

    def _rulebook_ok(self, entry_id, category, period_key):
        e = next((e for e in self.tables["rulebook_entry"] if e["id"] == entry_id), None)
        return bool(e) and e["category_code"] == category and self._covers(e["effective_from"], e.get("effective_to"), period_key)

    def _r_propose(self, t, a):
        """propose(workItemId, categoryCode, rulebookEntryId, policyId?, reason, evidenceRefs,
        capEffectUsdMinor?, proposalSource) (SCHEMA §10)."""
        wi = self.item(a[0])
        if len(a) != 8:
            raise ValueError(f"propose takes 8 args, got {len(a)}")  # 400 in the module
        if not a[1] or not a[2] or not a[4]:
            raise ValueError("empty required string")  # 530 in the module
        if a[7] not in ("deterministic", "llm", "human_text"):
            raise ValueError(f"bad proposalSource {a[7]!r}")
        cap_effect = unopt(a[6])
        entry = next((e for e in self.tables["rulebook_entry"] if e["id"] == a[2]), None)
        reasons = []
        if self.role_of(t) != "ai_cap_analyst":
            reasons.append("role")
        if wi["state"] not in ("NEW", "REJECTED"):
            reasons.append("invalid_transition")
        if self._locked(wi["period_key"]):
            reasons.append("period_locked")
        if not self._rulebook_ok(a[2], a[1], wi["period_key"]):
            reasons.append("rulebook_invalid")
        elif entry and entry.get("treatment") == "ADJUSTMENT" and cap_effect is None:
            reasons.append("cap_effect_invalid")
        elif entry and entry.get("treatment") != "ADJUSTMENT" and cap_effect is not None:
            reasons.append("cap_effect_invalid")
        if not reasons and unopt(a[3]) is not None:
            reasons += self._policy_problems(int(unopt(a[3])), a[1], wi)
        if reasons:
            return self.audit(t, "propose", wi["id"], False, wi["state"], wi["state"], ", ".join(reasons))
        frm = wi["state"]
        self.tables["allocation"] = [r for r in self.tables["allocation"] if r["work_item_id"] != wi["id"]]
        wi.update(state="PROPOSED", proposed_by=self.tokens[t], proposed_category_code=a[1],
                  proposed_rulebook_entry_id=a[2], proposed_policy_id=unopt(a[3]), reason=a[4], evidence_refs=a[5],
                  cap_effect_usd_minor=cap_effect, proposal_source=a[7], decided_by=None, decided_reason=None)
        self.audit(t, "propose", wi["id"], True, frm, "PROPOSED", a[4])

    # -- Tier 1 (SCHEMA §11): policy precedence, allocations, category limits
    def _line_of(self, wi: dict) -> tuple[dict | None, dict | None, list[dict]]:
        gl_id = wi["subject_ref"]
        if wi.get("kind") == "reversal":
            refs = json.loads(wi.get("evidence_refs") or "[]")
            gl_id = next((r for r in refs if str(r).startswith("gl-")), None)
        gl = next((g for g in self.tables["gl_line"] if g["id"] == gl_id), None)
        if gl is None:
            return None, None, []
        ven = next((v for v in self.tables["vendor"] if v["id"] == gl.get("vendor_id")), None)
        bls = sorted((b for b in self.tables["bill_line"] if b.get("gl_line_id") == gl["id"]),
                     key=lambda b: int(b.get("line_no", 0)))
        return gl, ven, bls

    def _policy_problems(self, policy_id: int, category: str, wi: dict, bill_line: dict | None = None) -> list[str]:
        """policy_invalid / exception_applies / policy_conflict, as the module computes them."""
        from agents import policy as pol

        p = next((p for p in self.tables["policy"] if p["id"] == int(policy_id)), None)
        if p is None:
            raise ValueError(f"unknown policy {policy_id}")  # 530
        gl, ven, bls = self._line_of(wi)
        period = wi["period_key"]
        eligible = pol.eligible_policies(self.tables["policy"], period)
        by_id = {str(x["id"]): x for x in eligible}
        if (p.get("state") != "APPROVED" or p.get("category_code") != category or str(p["id"]) not in by_id
                or gl is None or not pol.applies(p, by_id, gl, ven, bill_lines=bls, bill_line=bill_line)):
            return [f"policy_invalid: pol-{p['id']}"]
        kids = pol.applying_children(p, self.tables["policy"], gl, ven, period, bill_lines=bls, bill_line=bill_line)
        if kids:
            return [f"exception_applies: pol-{kids[0]['id']}"]
        res = pol.resolve(self.tables["policy"], gl, ven, period, bill_lines=bls, bill_line=bill_line)
        if res.result != "category" or str(res.policy["id"]) != str(p["id"]):
            return ["policy_conflict"]
        return []

    def _limit(self, category: str, period: str) -> int | None:
        from agents import policy as pol

        e = pol.rulebook_entry_in_force(self.tables["rulebook_entry"], category, period)
        if e and e.get("treatment") == "EXCLUDED" and e.get("cap_limit_usd_minor") is not None:
            return int(e["cap_limit_usd_minor"])
        return None

    def _ledger(self, category: str, period: str) -> dict:
        key = f"{period[:4]}|{category}"
        row = next((r for r in self.tables["limit_ledger"] if r["key"] == key), None)
        if row is None:
            row = {"key": key, "cap_year": int(period[:4]), "category_code": category, "excluded_usd_minor": 0}
            self.tables["limit_ledger"].append(row)
        return row

    def _allocation_problems(self, wi: dict, allocs: list[dict]) -> list[str]:
        reasons: list[str] = []
        period = wi["period_key"]
        gl, _, bls = self._line_of(wi)
        if len(allocs) < 2:
            reasons.append("allocation_invalid: at least two allocations")
        if sum(int(x["amountUsdMinor"]) for x in allocs) != int(wi["amount_usd_minor"]):
            reasons.append("allocation_sum_mismatch: allocations do not sum to the item")
        own = {b["id"] for b in bls}
        used: list[str] = []
        by_cat: dict[str, int] = defaultdict(int)
        for x in allocs:
            code, entry_id, basis, ref = x["categoryCode"], x["rulebookEntryId"], x["basis"], x["basisRef"]
            by_cat[code] += int(x["amountUsdMinor"])
            entry = next((e for e in self.tables["rulebook_entry"] if e["id"] == entry_id), None)
            if not self._rulebook_ok(entry_id, code, period):
                reasons.append(f"rulebook_invalid: {entry_id}")
            elif (entry["treatment"] == "ADJUSTMENT") != (unopt(x["capEffectUsdMinor"]) is not None):
                reasons.append("cap_effect_invalid")
            bill_line = None
            if basis == "bill_line":
                if ref not in own:
                    reasons.append(f"allocation_invalid: {ref} is not a bill line of this line")
                bill_line = next((b for b in bls if b["id"] == ref), None)
                used.append(ref)
            elif basis == "share":
                dept, _, share = ref.partition(":")
                try:
                    ok_share = 0 <= float(share) <= 1 and abs(int(x["amountUsdMinor"]) - int(wi["amount_usd_minor"])
                                                               * float(share)) <= 1
                except ValueError:
                    ok_share = False
                if not dept or not ok_share:
                    reasons.append("allocation_invalid: share")
                if code not in APPORTIONABLE and code != "RELEVANT":
                    reasons.append(f"apportionment_not_permitted: {code}")
            elif basis == "cap_limit_excess":
                if code != "RELEVANT" or self._limit(ref, period) is None:
                    reasons.append("allocation_invalid: cap_limit_excess")
            pid = unopt(x["policyId"])
            if pid is not None:
                reasons += self._policy_problems(int(pid), code, wi, bill_line)
        if len(used) != len(set(used)) or (used and set(used) != own):
            reasons.append("allocation_invalid: bill lines used once and all covered")
        for x in allocs:
            if x["basis"] == "cap_limit_excess" and self._limit(x["basisRef"], period) is not None:
                remaining = self._limit(x["basisRef"], period) - self._ledger(x["basisRef"], period)["excluded_usd_minor"]
                if by_cat.get(x["basisRef"], 0) > remaining:
                    reasons.append(f"cap_limit_exceeded: remaining {remaining}")
        return reasons

    def _stored_allocations(self, wi: dict) -> list[dict]:
        rows = sorted((r for r in self.tables["allocation"] if r["work_item_id"] == wi["id"]), key=lambda r: r["line_no"])
        return [{"basis": r["basis"], "basisRef": r["basis_ref"], "categoryCode": r["category_code"],
                 "rulebookEntryId": r["rulebook_entry_id"], "policyId": r["policy_id"],
                 "amountUsdMinor": r["amount_usd_minor"], "capEffectUsdMinor": r["cap_effect_usd_minor"]} for r in rows]

    def _r_proposeAllocations(self, t, a):
        """proposeAllocations(workItemId, allocations: Allocation[], reason, evidenceRefs, proposalSource)."""
        if len(a) != 5:
            raise ValueError(f"proposeAllocations takes 5 args, got {len(a)}")  # 400
        wi = self.item(a[0])
        raw = a[1]
        # REDUCERS.md: AllocationInput values arrive as positional arrays in field order
        if not isinstance(raw, list) or any(not isinstance(x, list) or len(x) != len(ALLOCATION_FIELDS) for x in raw):
            raise ValueError("allocations must be an array of positional AllocationInput arrays")  # 400
        allocs = [dict(zip(ALLOCATION_FIELDS, x)) for x in raw]
        for x in allocs:
            if x["basis"] not in ("bill_line", "share", "cap_limit_excess"):
                raise ValueError(f"unknown basis {x['basis']!r}")  # 530
            if not x["basisRef"] or not x["categoryCode"] or not x["rulebookEntryId"]:
                raise ValueError("empty basisRef / categoryCode / rulebookEntryId")  # 530
        json.loads(a[3])
        if a[4] not in ("deterministic", "llm", "human_text") or not a[2]:
            raise ValueError("bad proposalSource or empty reason")
        reasons = []
        if self.role_of(t) != "ai_cap_analyst":
            reasons.append("role")
        if wi["state"] not in ("NEW", "REJECTED"):
            reasons.append("invalid_transition")
        if self._locked(wi["period_key"]):
            reasons.append("period_locked")
        if not reasons:
            reasons += self._allocation_problems(wi, allocs)
        if reasons:
            return self.audit(t, "propose", wi["id"], False, wi["state"], wi["state"], "; ".join(reasons))
        frm = wi["state"]
        self.tables["allocation"] = [r for r in self.tables["allocation"] if r["work_item_id"] != wi["id"]]
        for n, x in enumerate(allocs, start=1):
            self.tables["allocation"].append({
                "id": self.next_id("allocation"), "work_item_id": wi["id"], "line_no": n, "basis": x["basis"],
                "basis_ref": x["basisRef"], "category_code": x["categoryCode"], "rulebook_entry_id": x["rulebookEntryId"],
                "policy_id": unopt(x["policyId"]), "amount_usd_minor": int(x["amountUsdMinor"]),
                "cap_effect_usd_minor": unopt(x["capEffectUsdMinor"]), "posted_treatment": None,
                "posted_cap_effect_usd_minor": None})
        wi.update(state="PROPOSED", proposed_by=self.tokens[t], proposed_category_code="ALLOCATED",
                  proposed_rulebook_entry_id="ALLOCATED", proposed_policy_id=None, reason=a[2], evidence_refs=a[3],
                  cap_effect_usd_minor=None, proposal_source=a[4], decided_by=None, decided_reason=None)
        self.audit(t, "propose", wi["id"], True, frm, "PROPOSED", a[2])

    def _r_ask(self, t, a):
        wi = self.item(a[0])
        if self.role_of(t) != "ai_cap_analyst" or wi["state"] not in ("NEW", "PROPOSED"):
            return self.audit(t, "ask", wi["id"], False, wi["state"], wi["state"])
        frm = wi["state"]
        wi.update(state="NEEDS_INFO", question=a[1])
        self.audit(t, "ask", wi["id"], True, frm, "NEEDS_INFO")

    def _decide(self, t, a, action, to):
        wi = self.item(a[0])
        role = self.role_of(t)
        ok = (role in HUMAN and wi["state"] == "PROPOSED" and wi.get("proposed_by") != self.tokens[t]
              and not (abs(int(wi["amount_usd_minor"])) >= self.materiality() and role != "human_head_of_cost_cap"))
        if action == "approve" and self._locked(wi["period_key"]):
            ok = False
        if ok and action == "approve" and wi.get("proposed_policy_id") is not None:
            ok = not self._policy_problems(int(wi["proposed_policy_id"]), wi["proposed_category_code"], wi)
        if ok and action == "approve" and wi.get("proposed_category_code") == "ALLOCATED":
            ok = not self._allocation_problems(wi, self._stored_allocations(wi))  # re-validation (REDUCERS.md)
        if not ok:
            return self.audit(t, action, wi["id"], False, wi["state"], wi["state"])
        wi.update(state=to, decided_by=self.tokens[t], decided_reason=a[1])
        self.precedent(t, wi, f"{action}: {a[1]}")
        self.audit(t, action, wi["id"], True, "PROPOSED", to, a[1])

    def precedent(self, t, wi, reason):
        gl = next((g for g in self.tables["gl_line"] if g["id"] == wi["subject_ref"]), {})
        ven = next((v for v in self.tables["vendor"] if v["id"] == gl.get("vendor_id")), None)
        summary = {"gl_line_id": gl.get("id"), "vendor_id": gl.get("vendor_id"), "account_code": gl.get("account_code"),
                   "department_id": gl.get("department_id"), "related_party": ven["related_party"] if ven else None,
                   "amount_usd_minor": gl.get("amount_usd_minor"), "memo": (gl.get("memo") or "")[:120]}
        self.tables["precedent"].append({"id": self.next_id("precedent"), "work_item_id": wi["id"],
                                         "pattern_summary": json.dumps(summary),
                                         "category_code": wi.get("proposed_category_code") or "",
                                         "decided_by": self.tokens[t], "reason": reason})

    def _r_answer(self, t, a):
        wi = self.item(a[0])
        role = self.role_of(t)
        ok = role in HUMAN and wi["state"] == "NEEDS_INFO" and not (
            abs(int(wi["amount_usd_minor"])) >= self.materiality() and role != "human_head_of_cost_cap")
        if not ok:
            return self.audit(t, "answer", wi["id"], False, wi["state"], "NEW")
        wi.update(state="NEW", answer=a[1])
        self.precedent(t, wi, f"answer: Q: {wi.get('question')} A: {a[1]}")
        self.audit(t, "answer", wi["id"], True, "NEEDS_INFO", "NEW", a[1])

    def materiality(self) -> int:
        return int(next(r["value"] for r in self.tables["setting"] if r["key"] == "materiality_usd_minor"))

    def _r_approve(self, t, a):
        self._decide(t, a, "approve", "APPROVED")

    def _r_reject(self, t, a):
        self._decide(t, a, "reject", "REJECTED")

    def _r_post(self, t, a):
        wi = self.item(a[0])
        if self.role_of(t) != "gateway" or wi["state"] != "APPROVED" or self._locked(wi["period_key"]):
            return self.audit(t, "post", wi["id"], False, wi["state"], wi["state"])
        period = wi["period_key"]
        allocs = [r for r in self.tables["allocation"] if r["work_item_id"] == wi["id"]]
        parts = ([(r["category_code"], r["rulebook_entry_id"], int(r["amount_usd_minor"])) for r in allocs]
                 if wi.get("proposed_category_code") == "ALLOCATED"
                 else [(wi["proposed_category_code"], wi["proposed_rulebook_entry_id"], int(wi["amount_usd_minor"]))])
        add: dict[str, int] = defaultdict(int)
        for code, _, amt in parts:
            if self._limit(code, period) is not None:
                add[code] += amt
        for code, amt in add.items():
            remaining = self._limit(code, period) - self._ledger(code, period)["excluded_usd_minor"]
            if amt > remaining:
                return self.audit(t, "post", wi["id"], False, wi["state"], wi["state"],
                                  f"cap_limit_exceeded: remaining {remaining}")
        for code, amt in add.items():
            self._ledger(code, period)["excluded_usd_minor"] += amt
        for r in allocs:
            e = next((e for e in self.tables["rulebook_entry"] if e["id"] == r["rulebook_entry_id"]), {})
            r.update(posted_treatment=e.get("treatment"),
                     posted_cap_effect_usd_minor=r["cap_effect_usd_minor"] if e.get("treatment") == "ADJUSTMENT"
                     else r["amount_usd_minor"])
        wi.update(state="POSTED", erp_entry_id=a[1])
        self.audit(t, "post", wi["id"], True, "APPROVED", "POSTED")

    def _r_lockPeriod(self, t, a):
        if self.role_of(t) != "human_head_of_cost_cap":
            return self.audit(t, "lock_period", a[0], False)
        self.tables["period"] = [p for p in self.tables["period"] if p["key"] != a[0]] + [{"key": a[0], "locked": True}]
        self.audit(t, "lock_period", a[0], True)

    def _r_proposePolicy(self, t, a):
        row = {k: unopt(v) for k, v in zip(POLICY_ARG_FIELDS, a)}
        json.loads(row["pattern"]) and json.loads(row["evidence_refs"])  # JSON strings containing JSON
        if self.role_of(t) != "ai_policy_learner":
            return self.audit(t, "propose_policy", row["policy_key"], False)
        e = next((e for e in self.tables["rulebook_entry"] if e["id"] == row["rulebook_entry_id"]), None)
        if not e or e["category_code"] != row["category_code"] or not (
                e["effective_from"] <= row["effective_from"] and (e.get("effective_to") is None or e["effective_to"] >= row["effective_from"])):
            return self.audit(t, "propose_policy", row["policy_key"], False)
        if len(a) != len(POLICY_ARG_FIELDS):
            raise ValueError(f"proposePolicy takes {len(POLICY_ARG_FIELDS)} args, got {len(a)}")  # 400
        stones = json.loads(row["cornerstones"])
        problems = self._cornerstone_problems(row, stones)
        if problems:
            return self.audit(t, "propose_policy", row["policy_key"], False, reason="; ".join(problems))
        existing = [p["version"] for p in self.tables["policy"] if p["policy_key"] == row["policy_key"]]
        if row["version"] == 0:
            row["version"] = max(existing, default=0) + 1
        elif row["version"] in existing:
            raise ValueError("version exists")  # 530
        row.update(id=self.next_id("policy"), state="PROPOSED", proposed_by=self.tokens[t], decided_by=None,
                   decided_reason=None, flip_report="{}", autonomy="NONE")
        self.tables["policy"].append(row)
        self.audit(t, "propose_policy", row["policy_key"], True, None, "PROPOSED")

    def _cornerstone_problems(self, row: dict, stones: list[dict]) -> list[str]:
        """SCHEMA §11.2 cornerstone check for refs that are gl lines in the module; other refs are
        stored unchecked (checked_by_proposer)."""
        from agents import policy as pol

        out = []
        everyone = {str(p["id"]): p for p in self.tables["policy"]}
        parent = everyone.get(str(row["parent_policy_id"])) if row.get("parent_policy_id") is not None else None
        if row.get("parent_policy_id") is not None and parent is None:
            raise ValueError(f"unknown parent policy {row['parent_policy_id']}")  # 530
        me = dict(row, id="__new__")
        by_id = dict(everyone, __new__=me)

        def line(ref):
            gl = next((g for g in self.tables["gl_line"] if g["id"] == ref), None)
            if gl is None:
                return None, None, []
            ven = next((v for v in self.tables["vendor"] if v["id"] == gl.get("vendor_id")), None)
            return gl, ven, [b for b in self.tables["bill_line"] if b.get("gl_line_id") == gl["id"]]

        missed = []
        for c in stones:
            gl, ven, bls = line(c["ref"])
            if gl is not None and not pol.applies(me, by_id, gl, ven, bill_lines=bls):
                missed.append(c["ref"])
        if missed:
            out.append(f"cornerstone_mismatch: the policy does not apply to its own cornerstones {', '.join(missed)}")
        if parent is not None:
            clash = []
            for c in json.loads(parent.get("cornerstones") or "[]"):
                if c.get("category_code") != parent.get("category_code"):
                    continue
                gl, ven, bls = line(c["ref"])
                if gl is not None and pol.matches(row["pattern"], gl, ven, bill_lines=bls):
                    clash.append(c["ref"])
            if clash:
                out.append(f"conflicting_cornerstone: {', '.join(clash)}")
        return out

    def _r_approvePolicy(self, t, a):
        p = next(p for p in self.tables["policy"] if p["id"] == int(a[0]))
        if self.role_of(t) != "human_head_of_cost_cap" or p["proposed_by"] == self.tokens[t]:
            return self.audit(t, "approve_policy", p["policy_key"], False)
        p.update(state="APPROVED", decided_by=self.tokens[t], decided_reason=a[1])
        self.audit(t, "approve_policy", p["policy_key"], True)


# ---- world ----------------------------------------------------------------------------------------


class FakeWorld:
    def __init__(self, gateway_key: str = "test-gateway-key"):
        self.streams: dict[str, list[dict]] = defaultdict(list)
        self.cursor = 0
        self.gateway_key = gateway_key
        self.journal: dict[str, dict] = {}
        self.post_count = 0
        self.requests: list[httpx.Request] = []

    def emit(self, source: str, record: dict) -> int:
        self.cursor += 1
        rec = dict(record)
        rec.setdefault("source", source)
        self.streams[source].append({"cursor": self.cursor, "op": "upsert", "record": rec})
        return self.cursor

    def latest(self, source: str, rid: str) -> dict | None:
        found = None
        for ch in self.streams[source]:
            if ch["record"]["id"] == rid:
                found = ch["record"]
        return found

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if request.method == "GET" and path.startswith("/changes/"):
            source = path.split("/")[2]
            after = int(request.url.params.get("after", 0))
            limit = int(request.url.params.get("limit", 500))
            recs = [c for c in self.streams[source] if c["cursor"] > after]
            page = recs[:limit]
            nxt = page[-1]["cursor"] if page else after
            return httpx.Response(200, json={"records": page, "next_cursor": nxt, "has_more": len(recs) > limit})
        if request.method == "GET" and path.startswith("/records/"):
            _, _, source, rid = path.split("/", 3)
            rec = self.latest(source, rid)
            return httpx.Response(200, json=rec) if rec else httpx.Response(404, json={"detail": "not found"})
        if request.method == "GET" and path == "/clock":
            return httpx.Response(200, json={"sim_date": "2026-02-01"})
        if request.method == "POST" and path == "/erp/journal_entries":
            if request.headers.get("X-Gateway-Key") != self.gateway_key:
                return httpx.Response(403, json={"detail": "bad key"})
            body = json.loads(request.content)
            wid = body["work_item_id"]
            if wid not in self.journal:
                self.post_count += 1
                self.journal[wid] = dict(body, erp_entry_id=f"JE-2026-{self.post_count:06d}")
            return httpx.Response(200, json={"erp_entry_id": self.journal[wid]["erp_entry_id"]})
        return httpx.Response(404, json={"detail": f"no route {request.method} {path}"})

    def client(self) -> WorldClient:
        return WorldClient(url="http://world.test", http=httpx.Client(transport=httpx.MockTransport(self.handler)))


# ---- anthropic ------------------------------------------------------------------------------------


class FakeRunner:
    """Plays a script of tool calls against the tools it was given, like BetaToolRunner would."""

    def __init__(self, owner: "FakeAnthropic", kwargs: dict):
        self.owner, self.kwargs = owner, kwargs

    def __iter__(self):
        tools = {t.name: t for t in self.kwargs["tools"]}
        for i, step in enumerate(self.owner.script):
            if step == "refusal":
                yield SimpleNamespace(stop_reason="refusal", content=[])
                return
            if step == "max_tokens":
                yield SimpleNamespace(stop_reason="max_tokens", content=[])
                return
            name, inp = step
            block = SimpleNamespace(type="tool_use", id=f"toolu_{i}", name=name, input=inp)
            yield SimpleNamespace(stop_reason="tool_use", content=[block])
            if name not in tools:
                self.owner.results.append((name, f"Error: tool {name} not found", True))
                self.owner.unavailable.append(name)
                continue
            try:
                self.owner.results.append((name, tools[name].call(inp), False))
            except Exception as e:  # ToolError / validation -> is_error result, as the real runner does
                self.owner.results.append((name, str(e), True))
        yield SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="text", text="done")])


class FakeMessages:
    def __init__(self, owner: "FakeAnthropic"):
        self.owner = owner

    def tool_runner(self, **kwargs):
        self.owner.runner_kwargs.append(kwargs)
        return FakeRunner(self.owner, kwargs)

    def parse(self, **kwargs):
        self.owner.parse_kwargs.append(kwargs)
        out = self.owner.parse_reply(kwargs) if self.owner.parse_reply else None
        return SimpleNamespace(stop_reason="end_turn", parsed_output=out, content=[])

    def create(self, **kwargs):  # not used by the agents; fail loudly if it is
        raise AssertionError("agents must use tool_runner / parse")


class FakeAnthropic:
    def __init__(self, script: list | None = None, parse_reply=None):
        self.script = list(script or [])
        self.parse_reply = parse_reply
        self.runner_kwargs: list[dict] = []
        self.parse_kwargs: list[dict] = []
        self.results: list[tuple[str, Any, bool]] = []
        self.unavailable: list[str] = []
        self.beta = SimpleNamespace(messages=FakeMessages(self))
