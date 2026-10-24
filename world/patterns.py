"""The learnable regularities planted in the 2025 history, as executable matchers.

Every matcher uses only fields a consumer can see (account_id, vendor_id, department_id, memo),
so a pattern the Policy Learner discovers can be checked against this list. Counts are computed
from the generated history; PATTERNS.md carries the same table for seed 7, and the test suite
checks the two agree.

    uv run python -m world.patterns --out world/out          # print the tables
    uv run python -m world.patterns --out world/out --write  # rewrite the tables in PATTERNS.md
"""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

PATTERNS_MD = Path(__file__).resolve().parent / "PATTERNS.md"
GP = re.compile(r"Grand Prix|pre-season test", re.IGNORECASE)
F1_DEPTS = {f"dept-{k}" for k in ("AERO", "CHASSIS", "VD", "RACEOPS", "MFG", "LOGISTICS", "FACILITIES")}
SPLIT = "RELEVANT+NON_F1"


@dataclass(frozen=True)
class Pattern:
    key: str
    rule: str  # human-readable matcher, in policy-pattern vocabulary
    match: Callable[[dict], bool]
    expected_2025: str  # category code, or RELEVANT+NON_F1 for the department-share split
    policy_2026: str  # what the 2026 policy should say (rulebook entry id + note)


def acct(*codes: str) -> Callable[[dict], bool]:
    ids = {f"acct-{c}" for c in codes}
    return lambda g: g["account_id"] in ids


def memo(rx: str) -> Callable[[dict], bool]:
    r = re.compile(rx, re.IGNORECASE)
    return lambda g: bool(r.search(g["memo"] or ""))


def all_of(*fs: Callable[[dict], bool]) -> Callable[[dict], bool]:
    return lambda g: all(f(g) for f in fs)


def vendor(v: str) -> Callable[[dict], bool]:
    return lambda g: g["vendor_id"] == v


def dept(*ds: str) -> Callable[[dict], bool]:
    ids = {f"dept-{x}" for x in ds}
    return lambda g: g["department_id"] in ids


def not_(f: Callable[[dict], bool]) -> Callable[[dict], bool]:
    return lambda g: not f(g)


PATTERNS: list[Pattern] = [
    Pattern("canteen", "vendor ven-001 (Grove Catering) + account 6410 + memo ~ canteen|night shift meal", all_of(vendor("ven-001"), acct("6410"), memo(r"canteen|night shift meal")),
            "RELEVANT", "CATERING@SECD-ISS07 (D5.1.1.z). Rule change: catering at team premises is excluded from 2026"),
    Pattern("wind_tunnel_catering", "vendor ven-001 + account 6410 + memo ~ Northbrook Wind Tunnel", all_of(vendor("ven-001"), acct("6410"), memo(r"Northbrook Wind Tunnel")),
            "RELEVANT", "RELEVANT@SECD-ISS07: offsite engineering lunch at a third-party tunnel is not catering at premises or a Competition"),
    Pattern("motorhome_catering", "vendor ven-002 (Paddock Table) + account 6410 + memo ~ Motorhome catering", all_of(vendor("ven-002"), acct("6410"), memo(r"Motorhome catering")),
            "RELEVANT", "CATERING@SECD-ISS07 (D5.1.1.z): catering at a Competition. Partner-guest catering stays MARKETING"),
    Pattern("partner_hospitality", "account 6420", acct("6420"), "MARKETING", "MARKETING@SECD-ISS07 (D5.1.1.a)"),
    Pattern("gp_air_hotel", "account 6310|6320 + memo ~ Grand Prix|pre-season test", all_of(acct("6310", "6320"), lambda g: bool(GP.search(g["memo"]))),
            "COMPETITION_TRAVEL", "COMPETITION_TRAVEL@SECD-ISS07 (D5.1.1.r); drivers stay F1_DRIVER, the Team Principal EXCLUDED_PERSONS"),
    Pattern("gp_ground_transport", "account 6330 + memo ~ Grand Prix|pre-season test", all_of(acct("6330"), lambda g: bool(GP.search(g["memo"]))),
            "RELEVANT", "COMPETITION_TRAVEL@SECD-ISS07. Rule change: D5.1.1.r adds road transport (ISS22 3.1(r) was flights, rail, hotels)"),
    Pattern("non_gp_travel", "account 6310|6320|6330 + memo not ~ Grand Prix|pre-season test", all_of(acct("6310", "6320", "6330"), lambda g: not GP.search(g["memo"])),
            "RELEVANT", "RELEVANT@SECD-ISS07: travel not connected with a Competition or Testing stays in the cap"),
    Pattern("freight", "account 6300", acct("6300"), "RELEVANT", "RELEVANT@SECD-ISS07: freight is inside the cap, only personnel travel is excluded"),
    Pattern("related_party_recharge", "vendor ven-003 (Kestrel Technology, related_party=true)", vendor("ven-003"),
            "RELEVANT", "value at max(contract, fair value) against the fair_value schedule (ADJ_RELATED_PARTY_FAIR_VALUE@SECD-ISS07, D6.1.1.a)"),
    Pattern("pu_trackside", "account 6105 (PU services outside the supply perimeter)", acct("6105"),
            "RELEVANT", "RELEVANT@SECD-ISS07 at max(contract, fair value); compare to fv-003 / fv-005"),
    Pattern("pu_supply", "account 6100", acct("6100"), "PU_SUPPLY", "PU_SUPPLY@SECD-ISS07 up to the Section A maximum price; any excess is Relevant"),
    Pattern("marketing_agency", "vendor ven-022 (Brightwater Creative)", vendor("ven-022"), "MARKETING", "MARKETING@SECD-ISS07; technical/homologation work is RELEVANT"),
    Pattern("events_agency", "vendor ven-023 (Grandstand Events)", vendor("ven-023"), "MARKETING", "MARKETING@SECD-ISS07"),
    Pattern("law_firm", "vendor ven-018 (Harcourt Lyle)", vendor("ven-018"), "HR_FINANCE_LEGAL", "HR_FINANCE_LEGAL@SECD-ISS07; Applied Technologies client work is NON_F1"),
    Pattern("audit_hr_services", "account 6610|6620|5210", acct("6610", "6620", "5210"), "HR_FINANCE_LEGAL",
            "HR_FINANCE_LEGAL@SECD-ISS07; watch for plant maintenance booked here (Red Bull item 13)"),
    Pattern("plant_maintenance", "vendor ven-024 (Oxon Plant Services), any account", vendor("ven-024"), "RELEVANT",
            "RELEVANT@SECD-ISS07 whoever raised the PO (ERP sometimes codes it HR_FINANCE_LEGAL or PROPERTY)"),
    Pattern("applied_payroll_split", "department dept-APPLIED + account 5010|5040|5050|5230", all_of(dept("APPLIED"), acct("5010", "5040", "5050", "5230")),
            SPLIT, "split 60% RELEVANT / 40% NON_F1 by f1_activity_share 0.6 (employer NI is all SOCIAL_SECURITY in 2026)"),
    Pattern("applied_projects", "account 6810", acct("6810"), "NON_F1", "NON_F1@SECD-ISS07 (D5.1.1.h)"),
    Pattern("hr_finance_legal_payroll", "department dept-HR|FINANCE|LEGAL + account 5010|5050|5230",
            all_of(dept("HR", "FINANCE", "LEGAL"), acct("5010", "5050", "5230")), "HR_FINANCE_LEGAL", "HR_FINANCE_LEGAL@SECD-ISS07 (D5.1.1.i)"),
    Pattern("marketing_payroll", "department dept-MARKETING + account 5010|5050|5230", all_of(dept("MARKETING"), acct("5010", "5050", "5230")),
            "MARKETING", "MARKETING@SECD-ISS07"),
    Pattern("hospitality_payroll", "department dept-HOSPITALITY + account 5010|5050|5230", all_of(dept("HOSPITALITY"), acct("5010", "5050", "5230")),
            "RELEVANT", "CATERING@SECD-ISS07. Rule change: the catering crew's cost follows the catering exclusion"),
    Pattern("ni_base_f1_departments", "account 5040 + F1 department", all_of(acct("5040"), lambda g: g["department_id"] in F1_DEPTS),
            "RELEVANT", "SOCIAL_SECURITY@SECD-ISS07. Rule change: all mandatory employer NI is excluded (ISS22 excluded only the excess over 13.8%)"),
    Pattern("ni_excess", "account 5041", acct("5041"), "SOCIAL_SECURITY", "SOCIAL_SECURITY@SECD-ISS07"),
    Pattern("apprenticeship_levy", "account 5110", acct("5110"), "RELEVANT",
            "RELEVANT@SECD-ISS07: the levy is not social security (ERP coded 3 of 12 as SOCIAL_SECURITY in 2025)"),
    Pattern("excluded_persons", "account 5100, or department dept-EXEC", lambda g: g["account_id"] == "acct-5100" or g["department_id"] == "dept-EXEC",
            "EXCLUDED_PERSONS", "EXCLUDED_PERSONS@SECD-ISS07 (D5.1.1.d) incl. their NI, bonus and travel"),
    Pattern("f1_drivers", "account 5090, or memo ~ race drivers", lambda g: g["account_id"] == "acct-5090" or "race drivers" in g["memo"],
            "F1_DRIVER", "F1_DRIVER@SECD-ISS07 incl. driver travel"),
    Pattern("academy", "account 5095", acct("5095"), "OTHER_DRIVER_ACADEMY", "OTHER_DRIVER_ACADEMY@SECD-ISS07"),
    Pattern("sick_cover", "account 5200 + memo ~ sick cover", all_of(acct("5200"), memo(r"sick cover")), "SICK_COVER",
            "no 2026 home: SICK_COVER exists only in ISS22, so ask, then RELEVANT"),
    Pattern("indefinite_sick", "account 5070 + memo ~ indefinite", all_of(acct("5070"), memo(r"indefinite")), "INDEFINITE_SICK",
            "INDEFINITE_SICK@SECD-ISS07 only with a formal indefinite-leave letter"),
    Pattern("ordinary_sick_pay", "account 5070 + memo not ~ indefinite", all_of(acct("5070"), not_(memo(r"indefinite"))), "RELEVANT", "RELEVANT@SECD-ISS07"),
    Pattern("parental_leave", "account 5080", acct("5080"), "PARENTAL_LEAVE", "PARENTAL_LEAVE@SECD-ISS07"),
    Pattern("bonus", "account 5060 + department not dept-EXEC", all_of(acct("5060"), not_(dept("EXEC"))), "BONUS",
            "BONUS@SECD-ISS07 up to the lower of 20% of fixed remuneration and $12m; the excess is RELEVANT"),
    Pattern("staff_entertainment", "account 6400", acct("6400"), "STAFF_ENTERTAINMENT",
            "STAFF_ENTERTAINMENT@SECD-ISS07 for all-staff events up to $1.2m; single-team dinners are RELEVANT"),
    Pattern("fuel", "account 6110", acct("6110"), "RELEVANT", "FUEL@SECD-ISS07 (D5.1.1.t). Rule change: new exclusion"),
    Pattern("health_safety", "account 6740", acct("6740"), "RELEVANT", "HEALTH_SAFETY@SECD-ISS07 (D5.1.1.y). Rule change: new exclusion"),
    Pattern("bcdr", "account 6930", acct("6930"), "RELEVANT", "BCDR@SECD-ISS07 (D5.1.1.aa) up to $1.5m. Rule change: new exclusion"),
    Pattern("sporting_fines", "account 6910", acct("6910"), "RELEVANT",
            "FINES@SECD-ISS07. Rule change: D5.1.1.m covers any FIA fine (ISS22 3.1(m) only Financial Regulations penalties)"),
    Pattern("pe_depreciation", "account 7000 + memo not ~ non-F1", all_of(acct("7000"), not_(memo(r"non-F1"))), "DEPRECIATION",
            "RELEVANT@SECD-ISS07 (measured per D6.1.1.k). Rule change: plant & equipment depreciation is inside the cap from 2026"),
    Pattern("pe_depreciation_non_f1_asset", "account 7000 + memo ~ non-F1", all_of(acct("7000"), memo(r"non-F1")), "DEPRECIATION",
            "DEPRECIATION@SECD-ISS07 (D5.1.1.o.ii): asset used only for Non-F1 Activities"),
    Pattern("property_depreciation", "account 7010", acct("7010"), "DEPRECIATION", "DEPRECIATION@SECD-ISS07 (D5.1.1.o.i)"),
    Pattern("disposals", "account 7500", acct("7500"), "DEPRECIATION",
            "gains on disposal: ADJ_GRANT_GROSS_UP@SECD-ISS07 (D6.1.1.b.i.A.2). Rule change: gross up, do not exclude"),
    Pattern("rdec_credit", "account 7300", acct("7300"), "RELEVANT",
            "ADJ_GRANT_GROSS_UP@SECD-ISS07 (D6.1.1.b.i.A.1). Rule change: the offset direction flips"),
    Pattern("property", "account 6700|6730", acct("6700", "6730"), "PROPERTY", "PROPERTY@SECD-ISS07"),
    Pattern("heritage", "account 6800", acct("6800"), "HERITAGE", "HERITAGE@SECD-ISS07; parts raced this season are Used Inventory, not heritage"),
    Pattern("materials", "account 6010|6020|6030|6040", acct("6010", "6020", "6030", "6040"), "RELEVANT", "RELEVANT@SECD-ISS07"),
    Pattern("crash_and_spares", "account 6050", acct("6050"), "RELEVANT", "RELEVANT@SECD-ISS07: crash damage is inside the cap"),
    Pattern("finance_fx_tax", "account 7100|7110|7200", acct("7100", "7110", "7200"), "by account: FINANCE_COSTS / FX / CORP_TAX", "unchanged"),
]


def load_history(out_dir: Path) -> tuple[list[dict], dict[str, list[dict]], list[dict]]:
    def read(src: str) -> list[dict]:
        with (out_dir / f"{src}.jsonl").open(encoding="utf-8") as f:
            return [json.loads(x) for x in f if x.strip()]

    gl = read("history_2025_gl_line")
    cls: dict[str, list[dict]] = defaultdict(list)
    for c in read("history_2025_cap_classification"):
        cls[c["gl_line_id"]].append(c)
    return gl, cls, read("history_2025_approval")


def category_of(cs: list[dict]) -> str:
    cats = sorted({c["category_code"] for c in cs})
    return SPLIT if cats == ["NON_F1", "RELEVANT"] else "+".join(cats)


def pattern_counts(gl: list[dict], cls: dict[str, list[dict]]) -> list[dict]:
    rows = []
    for p in PATTERNS:
        matched = [g for g in gl if p.match(g)]
        if p.key == "finance_fx_tax":
            expect = {"acct-7100": "FINANCE_COSTS", "acct-7110": "FX", "acct-7200": "CORP_TAX"}
            prec = sum(1 for g in matched if category_of(cls[g["id"]]) == expect[g["account_id"]])
        else:
            prec = sum(1 for g in matched if category_of(cls[g["id"]]) == p.expected_2025)
        erp_fixed = sum(1 for g in matched if g["erp_category_code"] not in {c["category_code"] for c in cls[g["id"]]})
        rows.append({"key": p.key, "rule": p.rule, "expected_2025": p.expected_2025, "precedents": prec,
                     "exceptions": len(matched) - prec, "erp_corrected": erp_fixed, "policy_2026": p.policy_2026})
    return rows


def escalation_counts(gl: list[dict], approvals: list[dict], threshold: int = 25_000_000) -> dict:
    a_by = {a["gl_line_id"]: a for a in approvals}
    above = [a_by[g["id"]] for g in gl if abs(g["amount_usd_minor"]) >= threshold]
    below = [a_by[g["id"]] for g in gl if abs(g["amount_usd_minor"]) < threshold]
    rp = {g["id"] for g in gl if g["vendor_id"] == "ven-003"}
    return {
        "lines_at_or_above_250k": len(above),
        "escalated_at_or_above_250k": sum(1 for a in above if a["escalated_to"] == "head_of_cost_cap"),
        "escalated_below_250k_related_party": sum(1 for a in below if a["escalated_to"] and a["gl_line_id"] in rp),
        "escalated_below_250k_first_of_kind": sum(1 for a in below if a["escalated_to"] and a["gl_line_id"] not in rp),
        "not_escalated_below_250k": sum(1 for a in below if not a["escalated_to"]),
        "rejected": sum(1 for a in approvals if a["decision"] == "rejected"),
        "rejected_escalated": sum(1 for a in approvals if a["decision"] == "rejected" and a["escalated_to"]),
        "approved": sum(1 for a in approvals if a["decision"] == "approved"),
    }


def render_tables(out_dir: Path) -> str:
    gl, cls, apr = load_history(out_dir)
    lines = ["| key | matcher (public fields only) | 2025 treatment | precedents | exceptions | ERP corrected | expected 2026 policy |",
             "|---|---|---|---:|---:|---:|---|"]
    esc_pipe = lambda t: t.replace("|", "\\|")  # noqa: E731 - pipes inside a markdown cell
    for r in pattern_counts(gl, cls):
        lines.append(f"| `{r['key']}` | {esc_pipe(r['rule'])} | {r['expected_2025']} | {r['precedents']} | {r['exceptions']} | "
                     f"{r['erp_corrected']} | {esc_pipe(r['policy_2026'])} |")
    esc = escalation_counts(gl, apr)
    lines += ["", "| escalation measure (history_2025_approval) | count |", "|---|---:|"]
    lines += [f"| `{k}` | {v} |" for k, v in esc.items()]
    return "\n".join(lines)


START, END = "<!-- counts:start (generated by python -m world.patterns --write) -->", "<!-- counts:end -->"


def write_into_md(table: str, path: Path = PATTERNS_MD) -> None:
    text = path.read_text(encoding="utf-8")
    a, b = text.index(START) + len(START), text.index(END)
    path.write_text(text[:a] + "\n" + table + "\n" + text[b:], encoding="utf-8")


def md_block(path: Path = PATTERNS_MD) -> str:
    text = path.read_text(encoding="utf-8")
    return text[text.index(START) + len(START): text.index(END)].strip()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("world/out"))
    ap.add_argument("--write", action="store_true", help="rewrite the counts block in world/PATTERNS.md")
    args = ap.parse_args(argv)
    table = render_tables(args.out)
    if args.write:
        write_into_md(table)
    print(table)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
