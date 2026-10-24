"""Policy Learner. Identity: policy_learner (role ai_policy_learner).

May: read the system of work and the 2025 history in the world API, and `proposePolicy`.
May not: approve anything (the Head of Cost Cap approves policies), touch work items or records.

--onboard          mine history_2025_gl_line + history_2025_cap_classification deterministically:
                   groups by (vendor_id, account_code), by account_code, by (account_code,
                   department_id) (how 2025 classified payroll), and by memo keywords (Grand Prix /
                   circuit names). A group becomes a candidate at >= 10 precedents and >= 95%
                   consistency. Each candidate's 2025 category is mapped to the 2026 rulebook
                   (agents/rule_versions.py: CHANGES.md overrides, new exclusions, same code, or ask),
                   proposed with effective_from 2026-01-01, and written up in
                   agents/out/onboarding_report.md with coverage of January 2026 lines.
--from-corrections scan precedents where a human rejected (or answered) with a category, group
                   alike (>= 3), propose a general policy citing the precedent ids.
--offline          template rationales. Online, Claude writes the rationale and judges whether the
                   pattern generalises (structured output); the category and rule version stay code.

Usage:
  uv run python -m agents.policy_learner --onboard [--offline] [--dry-run]
  uv run python -m agents.policy_learner --from-corrections [--offline] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from pydantic import BaseModel

from . import config, identities, llm
from . import policy as pol
from .cap_analyst import category_from_text, fmt_usd, sim_date_or_unknown
from .recorder import NullRecorder, Recorder, digest, model_call_output
from .rule_versions import NEW_DATE, Nature, Rulebook, VersionMapping, map_to_2026
from .stdb import StdbClient
from .tools import AgentTools
from .world_client import WorldClient

log = logging.getLogger("agents.policy_learner")

MIN_PRECEDENTS = 10
MIN_CONSISTENCY = 0.95
MIN_ALIKE_CORRECTIONS = 3

# Race and circuit names (not nationalities: "British" would catch British Airways). Matching is
# always case-insensitive and ASCII-only on both sides (SCHEMA §10), no inline flags, <= 200 chars.
GP_REGEX = (
    r"\b(grand prix|gp|sakhir|bahrain|jeddah|melbourne|suzuka|shanghai|miami|imola|monaco|barcelona|montreal|"
    r"spielberg|silverstone|hungaroring|zandvoort|monza|baku|singapore|austin|interlagos|lusail)\b"
)
assert len(GP_REGEX) <= pol.MEMO_REGEX_MAX_CHARS, len(GP_REGEX)
_GP = re.compile(GP_REGEX, pol.MEMO_REGEX_FLAGS)


# ---- history -------------------------------------------------------------------------------------


@dataclass
class History:
    gl_lines: list[dict]
    classifications: dict[str, list[dict]]  # gl_line_id -> classification rows (several = a split)
    approvals: dict[str, dict]  # gl_line_id -> approval
    accounts: dict[str, dict]  # account code -> account
    vendors: dict[str, dict]  # vendor id -> vendor

    def joined(self) -> list[tuple[dict, dict]]:
        """Lines with exactly one classification. Split lines (e.g. payroll split by department
        F1 share) cannot be expressed as a single-category policy; see split_lines()."""
        return [(g, self.classifications[g["id"]][0]) for g in self.gl_lines
                if len(self.classifications.get(g["id"], [])) == 1]

    def split_lines(self) -> list[tuple[dict, list[dict]]]:
        return [(g, self.classifications[g["id"]]) for g in self.gl_lines
                if len(self.classifications.get(g["id"], [])) > 1]


def load_history(world: WorldClient) -> History:
    gl = world.all_records("history_2025_gl_line")
    cls: dict[str, list[dict]] = defaultdict(list)
    for c in sorted(world.all_records("history_2025_cap_classification"), key=lambda c: c["id"]):
        cls[c["gl_line_id"]].append(c)
    try:
        appr = {a["gl_line_id"]: a for a in world.all_records("history_2025_approval")}
    except Exception:  # optional source
        appr = {}
    accounts = {}
    for a in world.all_records("account"):
        accounts[str(a.get("code") or pol.line_account_code({"account_id": a["id"]}))] = a
    vendors = {v["id"]: v for v in world.all_records("vendor")}
    return History(gl, cls, appr, accounts, vendors)


# ---- candidates ----------------------------------------------------------------------------------


@dataclass
class Candidate:
    policy_key: str
    kind: str  # vendor_account | account | memo | correction
    pattern: dict
    description: str
    category_2025: str
    entry_2025_id: str | None
    precedent_count: int
    consistency: float
    exceptions: list[str]
    evidence_refs: list[str]
    nature: Nature
    mapping: VersionMapping | None = None
    rationale: str = ""
    escalated: int = 0
    llm_concerns: str | None = None
    result: dict | None = None
    effective_from: str = NEW_DATE

    @property
    def proposable(self) -> bool:
        return self.mapping is not None and self.mapping.status in ("same", "changed") and not self.llm_concerns

    def policy_like(self) -> dict:
        """As a policy row, for coverage estimation."""
        m = self.mapping
        return {"id": self.policy_key, "policy_key": self.policy_key, "version": 1, "state": "APPROVED",
                "category_code": m.category_2026 if m else None, "rulebook_entry_id": m.entry_2026_id if m else None,
                "pattern": json.dumps(self.pattern), "effective_from": self.effective_from, "effective_to": None}


def _group_stats(rows: list[tuple[dict, dict]]) -> tuple[str, str | None, float, list[str], list[str]]:
    counts = Counter(c["category_code"] for _, c in rows)
    modal, n = counts.most_common(1)[0]
    entries = Counter(c.get("rulebook_entry_id") for _, c in rows if c["category_code"] == modal)
    entry = entries.most_common(1)[0][0] if entries else None
    exceptions = [g["id"] for g, c in rows if c["category_code"] != modal]
    sample = [g["id"] for g, c in rows if c["category_code"] == modal][:10]
    return modal, entry, n / len(rows), exceptions, sample


def mine_history(h: History, rb: Rulebook, min_precedents: int = MIN_PRECEDENTS,
                 min_consistency: float = MIN_CONSISTENCY) -> tuple[list[Candidate], list[Candidate]]:
    """Return (candidates above thresholds, near misses with enough volume but too many exceptions)."""
    joined = h.joined()
    groups: dict[tuple, list[tuple[dict, dict]]] = defaultdict(list)
    for g, c in joined:
        acct = pol.line_account_code(g)
        if g.get("vendor_id"):
            groups[("vendor_account", g["vendor_id"], acct)].append((g, c))
        groups[("account", None, acct)].append((g, c))
        if g.get("department_id"):
            groups[("account_department", g["department_id"], acct)].append((g, c))
        if _GP.search(g.get("memo") or ""):
            groups[("memo", "grand_prix", acct)].append((g, c))

    candidates: list[Candidate] = []
    near: list[Candidate] = []
    for (kind, k2, acct), rows in sorted(groups.items(), key=lambda kv: (kv[0][0], str(kv[0][1]), str(kv[0][2]))):
        if len(rows) < min_precedents:
            continue
        modal, entry, consistency, exceptions, sample = _group_stats(rows)
        account = h.accounts.get(str(acct), {})
        vendor = h.vendors.get(k2, {}) if kind == "vendor_account" else {}
        if kind == "vendor_account":
            key, pattern = f"vendor:{k2}|acct:{acct}", {"vendor_id": k2, "account_code": str(acct)}
            desc = f"vendor {vendor.get('name', k2)} ({k2}) on account {acct} {account.get('name', '')}".strip()
        elif kind == "account":
            key, pattern = f"acct:{acct}", {"account_code": str(acct)}
            desc = f"account {acct} {account.get('name', '')}".strip()
        elif kind == "account_department":
            key, pattern = f"acct:{acct}|dept:{k2}", {"account_code": str(acct), "department_id": k2}
            desc = f"account {acct} {account.get('name', '')} in department {k2}".strip()
        else:
            key, pattern = f"memo:grand_prix|acct:{acct}", {"account_code": str(acct), "memo_regex": GP_REGEX}
            desc = f"account {acct} {account.get('name', '')} lines whose memo names a Grand Prix or circuit".strip()
        nature = Nature(
            account_code=str(acct), account_name=account.get("name"),
            account_default_category=account.get("default_category_code"),
            vendor_name=vendor.get("name"), vendor_category_hint=vendor.get("category_hint"),
            memos=[g.get("memo") or "" for g, _ in rows[:50]],
        )
        escalated = sum(1 for g, _ in rows if (h.approvals.get(g["id"]) or {}).get("escalated_to"))
        cand = Candidate(key, kind, pattern, desc, modal, entry, len(rows), consistency, exceptions[:20],
                         sample + exceptions[:5], nature, escalated=escalated)
        cand.mapping = map_to_2026(modal, nature, rb, entry)
        if kind != "memo" and cand.mapping.source.endswith("Competition travel"):
            # that change only reaches race-weekend road transport: the memo group carries it, and the
            # rest of the account keeps its 2025 answer
            nature.memos = [g.get("memo") or "" for g, _ in rows if not _GP.search(g.get("memo") or "")][:50]
            cand.mapping = map_to_2026(modal, nature, rb, entry)
        (candidates if consistency >= min_consistency else near).append(cand)

    acct_near = {(c.pattern["account_code"], c.precedent_count) for c in near if c.kind == "account"}
    near = [c for c in near if not (c.kind == "vendor_account" and
                                    (c.pattern["account_code"], c.precedent_count) in acct_near)]
    # drop narrower candidates whose 2026 answer equals the account-level one (they add nothing)
    acct_answers = {c.pattern["account_code"]: (c.mapping.category_2026, c.mapping.entry_2026_id)
                    for c in candidates if c.kind == "account" and c.mapping}
    out = []
    for c in candidates:
        if c.kind != "account" and c.mapping and \
                acct_answers.get(c.pattern["account_code"]) == (c.mapping.category_2026, c.mapping.entry_2026_id):
            continue
        out.append(c)
    near = [c for c in near if c.kind != "account_department" or c.pattern["account_code"] not in acct_answers]
    return out, near


def template_rationale(c: Candidate) -> str:
    m = c.mapping
    exc = f", {len(c.exceptions)} exceptions" if c.exceptions else ""
    head = (f"{c.precedent_count} precedents in 2025 ({c.consistency:.0%} consistent{exc}): {c.description} -> "
            f"{c.category_2025} under {c.entry_2025_id}.")
    if m is None:
        return head
    if m.status == "changed":
        return f"{head} {m.explanation} Source: {m.source}."
    return f"{head} 2026: {m.category_2026} under {m.entry_2026_id}, same as 2025 practice."


class PolicyReview(BaseModel):
    generalises: bool
    rationale: str
    concerns: str


REVIEW_SYSTEM = """\
You review draft cost cap policies that a deterministic miner drafted from a Formula 1 team's 2025 \
ledger and cost cap submission. The category and the 2026 rule version were chosen by code; do not \
change them. Write a two-sentence rationale a Head of Cost Cap can approve: what the lines are, how \
many precedents, and (if the 2026 rule differs from 2025 practice) that it differs and why. Do not \
write article numbers. Set generalises=false if the pattern is too broad for the evidence (for \
example mixed activities under one account, or exceptions that look like a different kind of cost), \
and say why in concerns; otherwise concerns is an empty string."""


def llm_review(client: Any, c: Candidate, rec: Any = None) -> PolicyReview | None:
    """Model review of one candidate; recorded as a model_call step (SCHEMA §6b) when `rec` is given."""
    rec = rec or NullRecorder()
    m = c.mapping
    payload = {
        "policy_key": c.policy_key, "pattern": c.pattern, "description": c.description,
        "precedent_count": c.precedent_count, "consistency": round(c.consistency, 4),
        "exceptions": c.exceptions[:10], "sample_memos": c.nature.memos[:15],
        "category_2025": c.category_2025, "entry_2025": c.entry_2025_id,
        "category_2026": m.category_2026 if m else None, "entry_2026": m.entry_2026_id if m else None,
        "rule_change": m.explanation if m and m.status == "changed" else None,
    }
    user = json.dumps(payload)
    prompt = {"purpose": "review policy candidate", "policy_key": c.policy_key,
              "prompt_digest": digest(REVIEW_SYSTEM + "\n" + user), "user": user}
    try:
        msg = client.beta.messages.parse(
            **llm.common_kwargs(4000),
            system=REVIEW_SYSTEM,
            messages=[{"role": "user", "content": user}],
            output_format=PolicyReview,
        )
    except Exception as e:
        log.warning("LLM review failed for %s: %s", c.policy_key, e)
        rec.record("error", "policy_learner.review", prompt, f"{type(e).__name__}: {e}", model=config.model())
        return None
    parsed = getattr(msg, "parsed_output", None)
    out = model_call_output(msg)
    out["parsed_output"] = parsed.model_dump() if hasattr(parsed, "model_dump") else parsed
    rec.record("model_call", "policy_learner.review", prompt, out, model=config.model())
    if llm.check_stop(msg, f"review {c.policy_key}"):
        return None
    return parsed


def _record_policy_decision(rec: Any, c: Candidate, action: str, why: str) -> None:
    """Every proposal (or deliberate non-proposal) is preceded by a decision step naming the
    candidate, what was weighed and why (SCHEMA §6b)."""
    m = c.mapping
    (rec or NullRecorder()).record("decision", f"{action}:policy_candidate", {
        "action": action, "policy_key": c.policy_key, "kind": c.kind, "pattern": c.pattern,
        "category_2025": c.category_2025, "entry_2025": c.entry_2025_id,
        "category_2026": m.category_2026 if m else None, "entry_2026": m.entry_2026_id if m else None,
        "mapping_status": m.status if m else None, "precedent_count": c.precedent_count,
        "consistency": round(c.consistency, 4), "exceptions": c.exceptions[:20],
        "llm_concerns": c.llm_concerns, "effective_from": c.effective_from, "why": why,
    })


def existing_policy(policies: Iterable[dict], key: str, category: str | None) -> dict | None:
    for p in policies:
        if p.get("policy_key") == key and p.get("category_code") == category and p.get("state") in ("PROPOSED", "APPROVED"):
            return p
    return None


def propose_candidates(tools: AgentTools | None, cands: list[Candidate], dry_run: bool, rec: Any = None) -> None:
    rec = rec or (tools.rec if tools is not None else NullRecorder())
    current = tools.all_policies() if tools is not None and not dry_run else []
    for c in cands:
        m = c.mapping
        if not c.proposable:
            why = c.llm_concerns or (m.explanation if m else "no 2026 mapping")
            _record_policy_decision(rec, c, "ask", f"not proposable: {why}")
            continue
        dup = existing_policy(current, c.policy_key, m.category_2026)
        if dup:
            c.result = {"ok": True, "skipped": f"already {dup['state']} as pol-{dup.get('id')} v{dup.get('version')}"}
            _record_policy_decision(rec, c, "skip", c.result["skipped"])
            continue
        _record_policy_decision(rec, c, "propose",
                                f"{c.precedent_count} precedents, {c.consistency:.0%} consistent; mapping {m.status}")
        if dry_run or tools is None:
            c.result = {"ok": True, "dry_run": True}
            continue
        c.result = tools.propose_policy(c.policy_key, m.category_2026, m.entry_2026_id, c.pattern, c.rationale,
                                        c.evidence_refs, c.precedent_count, c.effective_from, None)


# ---- coverage ------------------------------------------------------------------------------------


def coverage(cands: list[Candidate], lines: list[dict], vendors: dict[str, dict], period: str = "2026-01") -> dict:
    policies = [c.policy_like() for c in cands if c.proposable]
    jan = [g for g in lines if g.get("period_key") == period]
    covered, conflict, usd_cov, usd_all = 0, 0, 0, 0
    uncovered_accounts: Counter = Counter()
    for g in jan:
        amt = abs(int(g.get("amount_usd_minor") or 0))
        usd_all += amt
        matched = pol.matching_policies(policies, g, vendors.get(g.get("vendor_id")), period)
        chosen, why = pol.resolve_matches(matched)
        if chosen is not None:
            covered += 1
            usd_cov += amt
        else:
            if why == "conflict":
                conflict += 1
            uncovered_accounts[pol.line_account_code(g)] += 1
    n = len(jan)
    return {"period": period, "lines": n, "covered": covered, "conflicts": conflict,
            "share": covered / n if n else 0.0, "usd_share": usd_cov / usd_all if usd_all else 0.0,
            "top_uncovered_accounts": uncovered_accounts.most_common(8)}


def january_lines(world: WorldClient) -> tuple[list[dict], str]:
    lines = [g for g in world.all_records("gl_line") if g.get("period_key") == "2026-01"]
    if lines:
        return lines, "world API /changes/gl_line"
    path = config.WORLD_OUT_DIR / "gl_line.jsonl"
    if path.exists():
        recs: dict[str, dict] = {}
        for raw in path.read_text().splitlines():
            if raw.strip():
                r = json.loads(raw)
                r = r.get("record", r)
                recs[r["id"]] = r
        return [g for g in recs.values() if g.get("period_key") == "2026-01"], \
            f"{path} (generator output; not yet visible at the sim date)"
    return [], "none available"


# ---- report --------------------------------------------------------------------------------------


def escalation_envelope(h: History) -> dict:
    escalated = [abs(int(a.get("amount_usd_minor") or 0)) for a in h.approvals.values() if a.get("escalated_to")]
    not_esc = [abs(int(a.get("amount_usd_minor") or 0)) for a in h.approvals.values() if not a.get("escalated_to")]
    return {"approvals": len(h.approvals), "escalated": len(escalated),
            "min_escalated_usd_minor": min(escalated) if escalated else None,
            "max_unescalated_usd_minor": max(not_esc) if not_esc else None}


def write_report(path: Path, h: History, cands: list[Candidate], near: list[Candidate], cov: dict,
                 cov_source: str, offline: bool) -> str:
    proposable = [c for c in cands if c.proposable]
    changed = [c for c in proposable if c.mapping.status == "changed"]
    asks = [c for c in cands if not c.proposable] + near
    confident = [c for c in proposable if c.consistency >= 0.99 and c.precedent_count >= 30]
    env = escalation_envelope(h)
    L: list[str] = []
    L.append("# Onboarding report: Policy Learner\n")
    L.append(f"Mode: {'offline (template rationales)' if offline else 'online (Claude rationales, code-chosen categories)'}. "
             f"All policies are PROPOSED; none takes effect until the Head of Cost Cap approves it.\n")
    L.append("## Inputs\n")
    splits = h.split_lines()
    L.append(f"- 2025 GL lines: {len(h.gl_lines)}; with one 2025 cost cap classification: {len(h.joined())}; "
             f"split across categories: {len(splits)}")
    L.append(f"- 2025 approvals log rows: {env['approvals']} ({env['escalated']} escalated to the Head of Cost Cap)")
    L.append(f"- Accounts: {len(h.accounts)}; vendors: {len(h.vendors)}")
    L.append(f"- Thresholds: >= {MIN_PRECEDENTS} precedents and >= {MIN_CONSISTENCY:.0%} consistency\n")
    L.append("## What I learned\n")
    L.append(f"{len(proposable)} policies proposed, effective from {NEW_DATE} under SECD-ISS07.\n")
    L.append("| policy_key | covers | 2025 practice | 2026 policy | precedents | consistent | exceptions | status |")
    L.append("|---|---|---|---|---|---|---|---|")
    for c in sorted(proposable, key=lambda c: -c.precedent_count):
        m = c.mapping
        res = c.result or {}
        status = "rule change" if m.status == "changed" else "same as 2025"
        if res.get("skipped"):
            status += f" ({res['skipped']})"
        L.append(f"| `{c.policy_key}` | {c.description} | {c.category_2025} ({c.entry_2025_id}) | "
                 f"**{m.category_2026}** ({m.entry_2026_id}) | {c.precedent_count} | {c.consistency:.1%} | "
                 f"{len(c.exceptions)} | {status} |")
    L.append("")
    if changed:
        L.append("### Where 2026 differs from 2025 practice\n")
        for c in changed:
            L.append(f"- `{c.policy_key}`: {c.mapping.explanation} ({c.mapping.source})")
        L.append("")
    L.append("## What I'm confident on\n")
    if confident:
        for c in confident:
            L.append(f"- `{c.policy_key}`: {c.precedent_count} precedents, {c.consistency:.1%} consistent -> "
                     f"{c.mapping.category_2026}")
    else:
        L.append("- Nothing reaches 99% consistency over 30+ precedents; every policy above needs a look.")
    L.append("")
    L.append("## What I'll ask about\n")
    if not asks:
        L.append("- Nothing outstanding from history.")
    for c in asks:
        if c in near:
            L.append(f"- `{c.policy_key}` ({c.description}): {c.precedent_count} lines but only "
                     f"{c.consistency:.0%} consistent (mostly {c.category_2025}); exceptions e.g. "
                     f"{', '.join(c.exceptions[:5])}. I will ask per line rather than draft a policy.")
        elif c.llm_concerns:
            L.append(f"- `{c.policy_key}`: reviewer concern: {c.llm_concerns}")
        else:
            L.append(f"- `{c.policy_key}` ({c.description}): {c.mapping.explanation}")
    if splits:
        depts = Counter(g.get("department_id") for g, _ in splits)
        sample = splits[0][1]
        L.append(f"- {len(splits)} lines were split across categories in 2025 (mostly "
                 f"{', '.join(f'{d} ({n})' for d, n in depts.most_common(3))}; e.g. {splits[0][0]['id']}: "
                 f"{' + '.join(c['category_code'] for c in sample)}). A policy cites one category, so I will "
                 f"ask about these per line.")
    L.append("")
    L.append("## Operating envelope learned from 2025 approvals\n")
    L.append(f"- Smallest amount escalated to the Head of Cost Cap: {fmt_usd(env['min_escalated_usd_minor'])}")
    L.append(f"- Largest amount approved without escalation: {fmt_usd(env['max_unescalated_usd_minor'])}")
    L.append(f"- 2026 materiality setting: {fmt_usd(config.MATERIALITY_USD_MINOR)}\n")
    L.append("## Estimated coverage of January 2026\n")
    L.append(f"Source: {cov_source}.\n")
    if cov["lines"]:
        L.append(f"- {cov['covered']} of {cov['lines']} January lines ({cov['share']:.1%}; {cov['usd_share']:.1%} by USD) "
                 f"would be covered by a proposed policy (exactly one match, several that agree, or one refining "
                 f"the rest), if all are approved.")
        L.append(f"- {cov['conflicts']} lines match policies that disagree: those become questions.")
        if cov["top_uncovered_accounts"]:
            L.append("- Most uncovered accounts: " + ", ".join(f"{a} ({n})" for a, n in cov["top_uncovered_accounts"]))
    else:
        L.append("- No January 2026 lines available yet.")
    text = "\n".join(L) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return text


# ---- onboarding ----------------------------------------------------------------------------------


def onboard(world: WorldClient, rb: Rulebook, tools: AgentTools | None, *, client: Any = None, offline: bool = True,
            dry_run: bool = False, report_path: Path | None = None, rec: Any = None) -> dict:
    rec = rec or (tools.rec if tools is not None else NullRecorder())
    h = load_history(world)
    rec.record("read", "world:history_2025", {"sources": ["history_2025_gl_line", "history_2025_cap_classification",
                                                          "history_2025_approval", "account", "vendor"]},
               {"gl_lines": len(h.gl_lines), "classified": len(h.joined()), "splits": len(h.split_lines()),
                "approvals": len(h.approvals), "accounts": len(h.accounts), "vendors": len(h.vendors)})
    cands, near = mine_history(h, rb)
    rec.record("note", "mine_history", {"min_precedents": MIN_PRECEDENTS, "min_consistency": MIN_CONSISTENCY},
               {"candidates": [c.policy_key for c in cands], "near_misses": [c.policy_key for c in near]})
    for c in cands:
        c.rationale = template_rationale(c)
        if not offline and client is not None and c.mapping and c.mapping.status in ("same", "changed"):
            review = llm_review(client, c, rec)
            if review is not None:
                if not review.generalises:
                    c.llm_concerns = review.concerns or "reviewer judged the pattern too broad"
                elif review.rationale.strip():
                    # the rule-version statement stays deterministic and comes first
                    prefix = f"{c.mapping.explanation} " if c.mapping.status == "changed" else ""
                    c.rationale = f"{prefix}{review.rationale.strip()} ({c.precedent_count} precedents, " \
                                  f"{c.consistency:.0%} consistent)"
    propose_candidates(tools, cands, dry_run, rec)
    lines, source = january_lines(world)
    cov = coverage(cands, lines, h.vendors)
    rec.record("note", "coverage", {"source": source}, cov)
    report = write_report(Path(report_path or config.ONBOARDING_REPORT_PATH), h, cands, near, cov, source, offline)
    rec.record("note", "onboarding_report", {"path": str(report_path or config.ONBOARDING_REPORT_PATH)}, report)
    return {"candidates": cands, "near_misses": near, "coverage": cov, "report": report}


# ---- from corrections ----------------------------------------------------------------------------


def _common_memo_token(memos: list[str]) -> str | None:
    stop = {"with", "from", "for", "the", "and", "invoice", "inv", "ltd", "limited", "services", "costs", "cost"}
    sets = [set(re.findall(r"[a-z]{4,}", (m or "").lower())) - stop for m in memos]
    if not sets:
        return None
    common = set.intersection(*sets)
    return sorted(common, key=lambda t: (-len(t), t))[0] if common else None


def from_corrections(tools: AgentTools, *, client: Any = None, offline: bool = True, dry_run: bool = False,
                     min_alike: int = MIN_ALIKE_CORRECTIONS) -> list[Candidate]:
    rb_rows = tools.rulebook()
    codes = {e["category_code"] for e in rb_rows}
    # precedent.reason is prefixed with the decision by the module: "reject: ...", "answer: Q: .. A: .."
    precedents = tools.search_precedents(limit=100000, join_items=True)
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for pr in precedents:
        if pr.get("decision") not in ("reject", "answer"):
            continue
        corrected = category_from_text(pr.get("human_text"), codes)
        if corrected is None or pr.get("account_code") is None:
            continue
        pr = dict(pr, corrected=corrected, human_kind=pr["decision"])
        groups[(corrected, pr.get("vendor_id"), str(pr["account_code"]))].append(pr)
    # fall back to account-level groups for corrections spread over vendors
    by_acct: dict[tuple, list[dict]] = defaultdict(list)
    for (cat, vend, acct), rows in groups.items():
        if len(rows) < min_alike:
            by_acct[(cat, None, acct)].extend(rows)
    final = {k: v for k, v in groups.items() if len(v) >= min_alike}
    final.update({k: v for k, v in by_acct.items() if len(v) >= min_alike})

    current = tools.all_policies()
    out: list[Candidate] = []
    for (cat, vend, acct), rows in sorted(final.items(), key=lambda kv: str(kv[0])):
        periods = sorted(r.get("period_key") or "9999-12" for r in rows)
        effective_from = pol.period_bounds(periods[0])[0] if periods[0] != "9999-12" else NEW_DATE
        # module rule for proposePolicy: the entry must be in force on effective_from
        entry = pol.rulebook_entry_in_force(rb_rows, cat, effective_from)
        if entry is None:
            continue
        pattern: dict[str, Any] = {"account_code": acct}
        key = f"corr:{cat}|acct:{acct}"
        if vend:
            pattern["vendor_id"] = vend
            key = f"corr:{cat}|vendor:{vend}|acct:{acct}"
        token = _common_memo_token([r.get("memo") for r in rows])
        if token:
            pattern["memo_regex"] = rf"\b{re.escape(token)}\b"
            key += f"|memo:{token}"
        refs = [r["ref"] for r in rows] + [r["gl_line_id"] for r in rows if r.get("gl_line_id")]
        reasons = "; ".join(sorted({(r.get("human_text") or "").strip()[:80] for r in rows})[:3])
        what = f"account {acct}" + (f", vendor {vend}" if vend else "") + (f", memo '{token}'" if token else "")
        rationale = (f"Generalised from {len(rows)} alike human decisions ({', '.join(r['ref'] for r in rows)}) on "
                     f"{what}: classified {cat} under {entry['id']}. Human reasons: {reasons}.")
        nature = Nature(account_code=acct, memos=[r.get("memo") or "" for r in rows])
        mapping = VersionMapping("same", cat, entry["id"], cat, entry["id"], entry["treatment"],
                                 "from 2026 human decisions", "precedents")
        c = Candidate(key, "correction", pattern, what, cat, entry["id"], len(rows), 1.0, [], refs, nature,
                      mapping=mapping, rationale=rationale, effective_from=effective_from)
        if not offline and client is not None:
            review = llm_review(client, c, tools.rec)
            if review is not None:
                if not review.generalises:
                    c.llm_concerns = review.concerns or "reviewer judged the pattern too broad"
                elif review.rationale.strip():
                    c.rationale = f"{review.rationale.strip()} (precedents: {', '.join(r['ref'] for r in rows)})"
        dup = existing_policy(current, key, cat)
        if dup:
            c.result = {"ok": True, "skipped": f"already {dup['state']} as pol-{dup.get('id')}"}
            _record_policy_decision(tools.rec, c, "skip", c.result["skipped"])
        elif not c.proposable:
            _record_policy_decision(tools.rec, c, "ask", f"not proposable: {c.llm_concerns}")
        else:
            _record_policy_decision(tools.rec, c, "propose", f"{len(rows)} alike human decisions: {reasons}")
            if not dry_run:
                c.result = tools.propose_policy(key, cat, entry["id"], pattern, c.rationale, refs, len(rows),
                                                c.effective_from, None)
        out.append(c)
    return out


# ---- CLI -----------------------------------------------------------------------------------------


def _load_rulebook(tools: AgentTools | None) -> Rulebook:
    if config.RULEBOOK_PATH.exists():
        return Rulebook.from_file()
    if tools is not None:
        return Rulebook(tools.rulebook())
    raise FileNotFoundError(config.RULEBOOK_PATH)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m agents.policy_learner",
                                 description="Policy Learner: propose versioned policies (identity: policy_learner).")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--onboard", action="store_true", help="mine 2025 history and propose 2026 policies")
    mode.add_argument("--from-corrections", action="store_true", help="generalise >= 3 alike human corrections")
    ap.add_argument("--offline", action="store_true", help="template rationales, no LLM")
    ap.add_argument("--dry-run", action="store_true", help="compute and report; call no reducers")
    ap.add_argument("--report", type=Path, default=config.ONBOARDING_REPORT_PATH)
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING)

    client, offline = None, args.offline
    if not offline:
        try:
            client = llm.make_client()
        except llm.LLMUnavailable as e:
            print(f"warning: {e}; running offline", file=sys.stderr)
            offline = True
    # The learner records every step like the analyst (SCHEMA §6b); --dry-run records to the file.
    actor = identities.get("policy_learner")
    stdb = StdbClient()
    rec = Recorder(actor, stdb, sim_date_or_unknown(), to_file=args.dry_run)
    tools = AgentTools(actor, stdb, recorder=rec)
    mode = "onboard" if args.onboard else "from_corrections"
    with rec.run(f"policy_learner:{mode}", {**{k: str(v) for k, v in vars(args).items()}, "offline": offline,
                                            "model": None if offline else config.model()}):
        if args.onboard:
            rb = _load_rulebook(tools)
            res = onboard(WorldClient(), rb, tools, client=client, offline=offline, dry_run=args.dry_run,
                          report_path=args.report, rec=rec)
            proposed = [c for c in res["candidates"] if c.proposable]
            print(f"candidates: {len(res['candidates'])}, proposable: {len(proposed)}, "
                  f"near misses: {len(res['near_misses'])}")
            cov = res["coverage"]
            print(f"January coverage: {cov['covered']}/{cov['lines']} ({cov['share']:.1%})")
            print(f"report: {args.report}")
        else:
            cands = from_corrections(tools, client=client, offline=offline, dry_run=args.dry_run)
            for c in cands:
                print(f"{c.policy_key}: {c.precedent_count} precedents -> {c.category_2025}; {c.result}")
            if not cands:
                print("no group of >= 3 alike corrections yet")
    print(f"run {rec.run_id}: {len(rec.steps)} steps recorded to {rec.sink}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
