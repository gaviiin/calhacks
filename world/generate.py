"""Seeded generator for the systems of record (SCHEMA.md section 5).

    uv run python -m world.generate --seed 7 --out world/out

Writes one JSONL per source (file order == cursor order: sorted by visible_at, a re-emitted
record appears again later with the same id), world/out/answer_key.csv (the planted items),
world/out/truth_2026.csv (the correct 2026 treatment of every gl_line, for scoring; not part of
the SCHEMA contract) and world/out/truth_2026_allocations.csv (the correct split of every 2026 line
whose treatment is a split: mixed invoices by bill line, category-limit excesses).

Deterministic: every random draw comes from random.Random(f"{seed}:{year}:{stream}"); nothing
reads the clock or global random state.
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import sys
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Any

from . import company as C

SOURCES = [
    "account", "department", "vendor", "gl_line", "bill", "bill_line", "contract", "fair_value", "bank_txn",
    "history_2025_gl_line", "history_2025_cap_classification", "history_2025_approval", "rulebook_issue",
    "history_2025_bill_line", "history_2025_bill_line_classification",
]
REFERENCE_VISIBLE = "2025-01-01"
SIM_START = date(2026, 1, 1)
STREAM_END = date(2026, 11, 30)
HISTORY_END = date(2025, 12, 31)
V25, V26 = "ISS22", "SECD-ISS07"
PARTNERS = ["Halcyon Energy", "Arcadia Watches", "Northwind Cloud", "Volta Telecom"]
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


# ---------------------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------------------
def to_usd(amount_minor: int, fx: float) -> int:
    return int((Decimal(amount_minor) * Decimal(str(fx))).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def money(rng: random.Random, lo: float, hi: float) -> int:
    """Random amount in major units [lo, hi) as integer minor units (pence/cents)."""
    return int(rng.uniform(lo, hi) * 100)


def round_money(rng: random.Random, lo: float, hi: float, step: int = 10) -> int:
    return int(round(rng.uniform(lo, hi) / step) * step) * 100


def fmt_money(ccy: str, minor: int) -> str:
    sym = {"GBP": "GBP", "EUR": "EUR", "USD": "USD"}[ccy]
    sign = "-" if minor < 0 else ""
    return f"{sign}{sym} {abs(minor) / 100:,.2f}"


def bday_on_or_after(day: date) -> date:
    while not C.is_business_day(day):
        day += timedelta(days=1)
    return day


def bday_on_or_before(day: date) -> date:
    while not C.is_business_day(day):
        day -= timedelta(days=1)
    return day


def month_bdays(year: int, month: int, factory: bool = True) -> list[date]:
    out, day = [], date(year, month, 1)
    while day.month == month:
        if C.is_business_day(day) and not (factory and C.factory_closed(day)):
            out.append(day)
        day += timedelta(days=1)
    return out


def week_starts(year: int, last: date) -> list[date]:
    """First business day of each week the factory is open."""
    out, day = [], date(year, 1, 1)
    day -= timedelta(days=day.weekday())
    while day <= last:
        for k in range(5):
            dd = day + timedelta(days=k)
            if dd.year == year and dd <= last and C.is_business_day(dd) and not C.factory_closed(dd):
                out.append(dd)
                break
        day += timedelta(days=7)
    return out


def payroll_day(year: int, month: int) -> date:
    return bday_on_or_before(date(year, month, 26))


def month_end(year: int, month: int) -> date:
    nxt = date(year + (month == 12), month % 12 + 1, 1)
    return bday_on_or_before(nxt - timedelta(days=1))


# ---------------------------------------------------------------------------------------------
# bill-line descriptions shared by the 2025 history and the 2026 stream, so that description-level
# patterns learned from history_2025_bill_line_classification carry over to 2026 bills.
# Treatment tuples are (c25, c26, reason_2025, note_2026).
# ---------------------------------------------------------------------------------------------
def day_text(day: date) -> str:
    return f"{day.day} {MONTHS[day.month - 1]} {day.year}"


def desc_sponsor_dinner(partner: str, day: date) -> str:
    return f"Sponsor dinner - {partner} partners evening, factory atrium, {day_text(day)}"


def desc_partner_lunch(partner: str, day: date) -> str:
    return f"Partner guest hospitality - {partner} factory tour lunch, {day_text(day)}"


def desc_canteen_topup(day: date) -> str:
    wk = day - timedelta(days=day.weekday())
    return f"Factory canteen top-up - extended build shift service, w/c {wk.isoformat()}"


def desc_tunnel_lunch(day: date) -> str:
    return f"Engineering offsite lunch - aero team at Northbrook Wind Tunnel session, {day_text(day)}"


T_MARKETING = ("MARKETING", "MARKETING", "Hospitality for sponsor and partner guests: Directly Attributable to Marketing Activities.",
               "partner hospitality, D5.1.1.a")
T_CANTEEN = ("RELEVANT", "CATERING", "Factory canteen service for staff at team premises: no catering exclusion under ISS22, inside the cap.",
             "factory canteen at team premises, D5.1.1.z")
T_TUNNEL = ("RELEVANT", "RELEVANT", "Offsite engineering lunch at a third-party wind tunnel session: not Marketing and not at team premises, inside the cap.",
            "offsite engineering lunch at a third-party wind tunnel: not catering at premises or a Competition")


# ---------------------------------------------------------------------------------------------
# model
# ---------------------------------------------------------------------------------------------
@dataclass(eq=False)
class Line:
    posted: date
    acct: str
    dept: str
    vendor: str | None
    amount: int
    ccy: str
    memo: str
    entity: str
    c25: str  # correct 2025 treatment (ISS22), "SPLIT" = split by department share
    c26: str  # correct 2026 treatment (SECD-ISS07)
    tag: str
    reason: str = ""  # why the correct category (2025 classification reason)
    why: str = ""  # explanation used when the ERP coding is corrected
    confuse: tuple = ()  # realistic wrong ERP codes: "CODE" or {"erp":..,"dept":..,"acct":..}
    conf_p: float | None = None
    catch_p: float = 0.6  # 2025: chance the analyst caught a wrong ERP code before review
    erp: str | None = None
    escalate: str | None = None  # forced escalation reason (2025)
    fv: tuple | None = None  # (fair_value_id, fair_value_minor in line currency)
    # 2026 stream
    bill_lines: list | None = None  # [(description, amount_minor)]
    # per bill line treatment when the bill mixes categories: [(c25, c26, reason_2025, note_2026)], parallel to bill_lines
    bill_cats: list | None = None
    keep_bill_draw: bool = False  # base line given bill_lines after generation: consume the bills rng as before
    limit_cat: str | None = None  # truth is a split at a category limit (BONUS, PU_SUPPLY): the limited category
    no_bill: bool = False
    bill_of: "Line | None" = None  # journal that references another line's bill
    bill_date: date | None = None
    bill_iban: str | None = None
    bill_note: str = ""
    inv_no: str | None = None
    hold_payment: bool = False
    visible: date | None = None
    emissions: list | None = None  # [(visible_date, overrides)] ; last one is the final state
    correction_of: "Line | None" = None
    plant: str | None = None
    truth: list | None = None  # explicit 2026 truth rows [(category, amount_minor, relevant_usd|None, note)]
    note: str = ""
    prio: int = 1
    sort_key: float = 0.0
    id: str = ""
    num: int = 0
    bill: "Bill | None" = None


@dataclass(eq=False)
class Bill:
    vendor: str
    bill_date: date
    due: date
    ccy: str
    iban: str
    inv_no: str
    lines: list  # [(description, amount_minor, Line)]
    visible: date
    note: str = ""
    hold: bool = False
    sort_key: float = 0.0
    prio: int = 1
    num: int = 0

    @property
    def id(self) -> str:
        return f"bill-{self.num:05d}"

    @property
    def total(self) -> int:
        return sum(a for _, a, _ in self.lines)


def events(year: int) -> list[dict]:
    rounds = C.CALENDAR_2025 if year == 2025 else C.CALENDAR_2026
    tests = C.TESTS_2025 if year == 2025 else C.TESTS_2026
    out = [{"name": f"{n} Grand Prix", "city": city, "date": C.d(dt), "region": reg, "kind": "race", "round": r}
           for r, n, city, dt, reg in rounds]
    out += [{"name": n, "city": city, "date": C.d(dt), "region": reg, "kind": "test", "round": 0} for n, city, dt, reg in tests]
    return sorted(out, key=lambda e: e["date"])


# ---------------------------------------------------------------------------------------------
# year generator: the ordinary business of the team, same archetypes for 2025 and 2026
# ---------------------------------------------------------------------------------------------
class YearGen:
    def __init__(self, seed: int, year: int):
        self.seed = seed
        self.year = year
        self.last = HISTORY_END if year == 2025 else STREAM_END
        self.months = list(range(1, 13 if year == 2025 else 12))
        self.lines: list[Line] = []
        self.growth = 0.94 if year == 2025 else 1.045  # headcount grew into the 2026 regulation change
        self.events = events(year)

    def rng(self, name: str) -> random.Random:
        return random.Random(f"{self.seed}:{self.year}:{name}")

    def add(self, **kw) -> Line:
        ln = Line(**kw)
        if ln.posted.year != self.year or ln.posted > self.last:
            return ln  # outside the generated window: not recorded
        self.lines.append(ln)
        return ln

    def bf(self, m: int) -> float:
        return C.BUILD_FACTOR[self.year][m - 1]

    def ml(self, m: int) -> str:
        return f"{MONTHS[m - 1]} {self.year}"

    def y(self, c25: str, c26: str) -> str:
        return c25 if self.year == 2025 else c26

    def generate(self) -> list[Line]:
        for name in [n for n in dir(self) if n.startswith("gen_")]:
            getattr(self, name)()
        return self.lines

    # ---- payroll ------------------------------------------------------------------------
    def gen_payroll(self):
        rng = self.rng("payroll")
        for m in self.months:
            day = payroll_day(self.year, m)
            total_sal = 0
            for key, (cat25, cat26) in C.DEPT_PAYROLL_CATEGORY.items():
                dep = C.DEPARTMENTS[key]
                sal = int(dep["hc"] * dep["avg"] / 12 * self.growth * rng.uniform(0.99, 1.012) * 100)
                total_sal += sal
                split = cat25 == "SPLIT"
                hc = round(dep["hc"] * (1 if self.year == 2025 else 1.02))
                r_sal = {
                    "RELEVANT": "Payroll of F1 Activities staff: inside the cap.",
                    "MARKETING": "Marketing & Partnerships staff: Directly Attributable to Marketing Activities.",
                    "HR_FINANCE_LEGAL": "HR, Finance or Legal department staff: Excluded HR/Finance/Legal Activities.",
                    "HERITAGE": "Heritage & Collections staff: Heritage Asset Activities.",
                    "SPLIT": "Applied Technologies is a mixed F1/Non-F1 unit: 60% Relevant, 40% Non-F1 by f1_activity_share 0.6 (timesheet-supported).",
                }
                reason = r_sal["RELEVANT" if (key == "HOSPITALITY") else cat25]
                if key == "HOSPITALITY":
                    reason = "Hospitality & Catering crew (motorhome and factory catering): no catering exclusion under ISS22, inside the cap."
                self.add(posted=day, acct="5010", dept=key, vendor=None, amount=sal, ccy="GBP",
                         memo=f"Payroll {self.ml(m)} - {dep['name']} - salaries ({hc} FTE)", entity="TECHNOLOGY",
                         c25=cat25, c26=cat26, tag="payroll_salaries", reason=reason,
                         erp="NON_F1" if split else None)
                ni = int(sal * 0.138)
                self.add(posted=day, acct="5040", dept=key, vendor=None, amount=ni, ccy="GBP",
                         memo=f"Payroll {self.ml(m)} - {dep['name']} - employer NI (13.8% base)", entity="TECHNOLOGY",
                         c25=cat25, c26="SOCIAL_SECURITY", tag="payroll_ni_base",
                         reason=("Employer NI up to 13.8% of remuneration is not excluded by ISS22 3.1(q); it follows the department's treatment. "
                                 + reason),
                         erp="NON_F1" if (split and self.year == 2025) else None)
                pen = int(sal * 0.08)
                self.add(posted=day, acct="5050", dept=key, vendor=None, amount=pen, ccy="GBP",
                         memo=f"Payroll {self.ml(m)} - {dep['name']} - employer pension", entity="TECHNOLOGY",
                         c25=cat25, c26=cat26, tag="payroll_pension", reason="Employer pension follows the department's treatment. " + reason,
                         erp="NON_F1" if split else None)
            if m in (1, 2):  # new-car build overtime
                for key in ("MFG", "CHASSIS"):
                    dep = C.DEPARTMENTS[key]
                    ot = int(dep["hc"] * dep["avg"] / 12 * self.bf(m) * 0.09 * rng.uniform(0.95, 1.05) * 100)
                    self.add(posted=day, acct="5010", dept=key, vendor=None, amount=ot, ccy="GBP",
                             memo=f"Payroll {self.ml(m)} - {dep['name']} - new-car build overtime", entity="TECHNOLOGY",
                             c25="RELEVANT", c26="RELEVANT", tag="payroll_overtime", reason="Overtime of F1 Activities staff: inside the cap.")
            # three highest paid individuals
            for role, monthly in C.EXCLUDED_PERSONS:
                amt = int(monthly * self.growth * 100)
                self.add(posted=day, acct="5100", dept="EXEC", vendor=None, amount=amt, ccy="GBP",
                         memo=f"Payroll {self.ml(m)} - executive remuneration - {role}", entity="TECHNOLOGY",
                         c25="EXCLUDED_PERSONS", c26="EXCLUDED_PERSONS", tag="payroll_exec",
                         reason="One of the three highest-paid individuals: Excluded Persons.")
            exec_ni = int(sum(x[1] for x in C.EXCLUDED_PERSONS) * self.growth * 100 * 0.15)
            self.add(posted=day, acct="5040", dept="EXEC", vendor=None, amount=exec_ni, ccy="GBP",
                     memo=f"Payroll {self.ml(m)} - Executive Office - employer NI", entity="TECHNOLOGY",
                     c25="EXCLUDED_PERSONS", c26="EXCLUDED_PERSONS", tag="payroll_ni_exec",
                     reason="Employer NI of the Excluded Persons is excluded with their Consideration.")
            # employer NI above 13.8% (UK rate 15% from April 2025)
            if self.year == 2026 or m >= 4:
                exc = int(total_sal * 0.012)
                self.add(posted=day, acct="5041", dept="CORP", vendor=None, amount=exc, ccy="GBP",
                         memo=f"Payroll {self.ml(m)} - employer NI excess over 13.8% (all departments)", entity="TECHNOLOGY",
                         c25="SOCIAL_SECURITY", c26="SOCIAL_SECURITY", tag="payroll_ni_excess",
                         reason="Mandatory employer NI in excess of 13.8% of Total Employee Remuneration: ISS22 3.1(q).")
            levy = int(total_sal * 0.005)
            erp = None
            if self.year == 2025 and m in (2, 6, 10):
                erp = "SOCIAL_SECURITY"
            self.add(posted=day, acct="5110", dept="CORP", vendor=None, amount=levy, ccy="GBP",
                     memo=f"Apprenticeship Levy - {self.ml(m)} (0.5% of pay bill)", entity="TECHNOLOGY",
                     c25="RELEVANT", c26="RELEVANT", tag="apprenticeship_levy", erp=erp, catch_p=0.34,
                     reason="Apprenticeship Levy is a payroll tax, not an employer's social security contribution: stays Relevant.",
                     why="the Apprenticeship Levy is not employer's social security (Red Bull 2021 ABA item 6); it stays Relevant")
            # sick pay, indefinite sick, parental leave
            n = rng.randint(14, 26)
            self.add(posted=day, acct="5070", dept=rng.choice(["MFG", "AERO", "CHASSIS", "RACEOPS", "LOGISTICS"]), vendor=None,
                     amount=money(rng, 38_000, 66_000), ccy="GBP",
                     memo=f"Sick pay (statutory & contractual) - {self.ml(m)} - {n} employees, short-term absence", entity="TECHNOLOGY",
                     c25="RELEVANT", c26="RELEVANT", tag="sick_pay",
                     reason="Ordinary short-term sick pay: no exclusion applies (only indefinite sick leave is excluded).")
            self.add(posted=day, acct="5070", dept="MFG", vendor=None, amount=int(4_180 * self.growth * 100), ccy="GBP",
                     memo=f"Indefinite sick leave pay - employee E-07731 (formally placed on indefinite leave 2024-03, not expected to return) - {self.ml(m)}",
                     entity="TECHNOLOGY", c25="INDEFINITE_SICK", c26="INDEFINITE_SICK", tag="indefinite_sick",
                     reason="Employee formally placed on indefinite sick leave, HR letter on file: excluded.")
            n = rng.randint(9, 16)
            self.add(posted=day, acct="5080", dept="CORP", vendor=None, amount=money(rng, 52_000, 88_000), ccy="GBP",
                     memo=f"Statutory & enhanced parental leave pay - {self.ml(m)} - {n} employees (policy HR-07, all staff)",
                     entity="TECHNOLOGY", c25="PARENTAL_LEAVE", c26="PARENTAL_LEAVE", tag="parental_leave",
                     reason="Parental leave under a written policy applying to all employees: excluded.")
            if m == 3:  # annual bonus round
                pct = {"AERO": .06, "CHASSIS": .05, "VD": .06, "RACEOPS": .07, "MFG": .03, "LOGISTICS": .03, "MARKETING": .05,
                       "HOSPITALITY": .02, "HR": .04, "FINANCE": .04, "LEGAL": .04, "HERITAGE": .02, "APPLIED": .04, "FACILITIES": .02}
                for key, p in pct.items():
                    dep = C.DEPARTMENTS[key]
                    amt = int(dep["hc"] * dep["avg"] * p * self.growth * 100)
                    if self.year == 2025:
                        # ISS22: Employee Bonus Costs may be set by the team's points, podiums or race wins
                        memo = f"Championship bonus {self.year - 1} - team points, podiums & race wins scheme (BS-{(self.year - 1) % 100}) - {dep['name']}"
                    elif key in ("RACEOPS", "VD"):
                        memo = f"Podium & race-win bonus {self.year - 1} (BS-{(self.year - 1) % 100} points & podiums scheme) - {dep['name']}"
                    else:
                        memo = f"Annual bonus {self.year - 1} performance - {dep['name']}"
                    # 2026: only a Formal Bonus Scheme set solely by the final Constructors' classification and paid
                    # after the last Competition is Employee Bonus Costs (D1); these payments are Relevant.
                    self.add(posted=day, acct="5060", dept=key, vendor=None, amount=amt, ccy="GBP", memo=memo, entity="TECHNOLOGY",
                             c25="BONUS", c26="RELEVANT", tag="bonus", erp="BONUS",
                             reason="Formal Bonus Scheme (board-approved, communicated before the first Competition) paid by reference to the "
                                    "team's points, podiums and race wins: Employee Bonus Costs under ISS22, within the lower of 20% of "
                                    "fixed remuneration and the Excluded Bonus Maximum.")
                self.add(posted=day, acct="5060", dept="EXEC", vendor=None, amount=int(310_000 * self.growth * 100), ccy="GBP",
                         memo=f"Annual bonus {self.year - 1} performance - Executive Office (three highest paid)", entity="TECHNOLOGY",
                         c25="EXCLUDED_PERSONS", c26="EXCLUDED_PERSONS", tag="bonus_exec",
                         reason="Bonus of the Excluded Persons is part of their excluded Consideration.",
                         erp="BONUS", catch_p=1.0, why="bonus of the three highest paid sits under Excluded Persons, not the bonus allowance")

    # ---- people: drivers, academy, contractors, recruitment, training ------------------------
    def gen_people(self):
        rng = self.rng("people")
        sick_refs = 0
        for m in self.months:
            day = month_end(self.year, m)
            self.add(posted=day, acct="5090", dept="RACEOPS", vendor="ven-045", amount=int(950_000 * self.growth * 100), ccy="EUR",
                     memo=f"Driver retainer - race driver 1 (car 31) - {self.ml(m)}", entity="RACING",
                     c25="F1_DRIVER", c26="F1_DRIVER", tag="driver_retainer", reason="Consideration to an F1 Driver: excluded.")
            self.add(posted=day, acct="5090", dept="RACEOPS", vendor="ven-046", amount=int(520_000 * self.growth * 100), ccy="GBP",
                     memo=f"Driver retainer - race driver 2 (car 32) - {self.ml(m)}", entity="RACING",
                     c25="F1_DRIVER", c26="F1_DRIVER", tag="driver_retainer", reason="Consideration to an F1 Driver: excluded.")
            self.add(posted=bday_on_or_after(date(self.year, m, 10)), acct="5095", dept="RACEOPS", vendor="ven-031",
                     amount=money(rng, 85_000, 140_000), ccy="EUR",
                     memo=f"Academy programme - F3 & F4 entries and coaching - {self.ml(m)}", entity="RACING",
                     c25="OTHER_DRIVER_ACADEMY", c26="OTHER_DRIVER_ACADEMY", tag="academy",
                     reason="Other Racing Drivers and Academy programme: excluded.")
            days = month_bdays(self.year, m)
            for key in ["AERO", "CHASSIS", "MFG", "VD", "APPLIED"]:
                if not days:
                    continue
                if key == "APPLIED":
                    self.add(posted=rng.choice(days), acct="5200", dept=key, vendor="ven-044", amount=money(rng, 30_000, 60_000), ccy="GBP",
                             memo=f"Contract engineers - Applied Technologies - battery systems client project - {self.ml(m)}",
                             entity="TECHNOLOGY", c25="NON_F1", c26="NON_F1", tag="contractors_applied",
                             reason="Contractors working only on an Applied Technologies client project: Directly Attributable to Non-F1 Activities.")
                else:
                    n = rng.randint(4, 12)
                    self.add(posted=rng.choice(days), acct="5200", dept=key, vendor="ven-044",
                             amount=int(money(rng, 40_000, 95_000) * min(1.6, self.bf(m))), ccy="GBP",
                             memo=f"Contract engineers - {C.DEPARTMENTS[key]['name']} - {self.ml(m)} ({n} contractors)", entity="TECHNOLOGY",
                             c25="RELEVANT", c26="RELEVANT", tag="contractors", reason="Contract staff on F1 Activities: inside the cap.")
            if days and rng.random() < (0.85 if self.year == 2025 else 0.7):
                sick_refs += 1
                key = rng.choice(["MFG", "CHASSIS", "LOGISTICS", "RACEOPS"])
                self.add(posted=rng.choice(days), acct="5200", dept=key, vendor="ven-044", amount=money(rng, 6_500, 14_000), ccy="GBP",
                         memo=f"Agency sick cover for employee on sick leave (ref SC-{self.year % 100}-{sick_refs:02d}) - {C.DEPARTMENTS[key]['name']}",
                         entity="TECHNOLOGY", c25="SICK_COVER", c26="RELEVANT", tag="sick_cover", catch_p=0.7,
                         escalate="first sick-cover claim of the year" if sick_refs == 1 and self.year == 2025 else None,
                         reason="Agency cover engaged for an employee on sick leave, within the absent employee's pay: ISS22 3.1(v).",
                         why="agency cover for an employee on sick leave is excluded under ISS22 3.1(v)")
            roles = ["senior aerodynamicist", "composites technician", "race engineer", "CNC programmer", "data engineer",
                     "vehicle dynamics engineer", "stress engineer", "finance business partner"]
            for _ in range(2):
                if days:
                    role = rng.choice(roles)
                    self.add(posted=rng.choice(days), acct="5210", dept="HR", vendor="ven-020", amount=money(rng, 14_000, 34_000), ccy="GBP",
                             memo=f"Recruitment fee - {role} - placement {rng.randint(100, 999)}", entity="TECHNOLOGY",
                             c25="HR_FINANCE_LEGAL", c26="HR_FINANCE_LEGAL", tag="recruitment",
                             reason="Recruitment is a Human Resources Activity: excluded.")
            courses = [("composites repair certification", "MFG"), ("high-voltage safety awareness", "RACEOPS"),
                       ("CFD solver advanced course", "AERO"), ("GD&T and metrology", "MFG"), ("simulation tools training", "VD")]
            for _ in range(2 if self.year == 2025 else 1):
                if days:
                    course, key = rng.choice(courses)
                    self.add(posted=rng.choice(days), acct="5220", dept=key, vendor="ven-050", amount=money(rng, 3_500, 16_000), ccy="GBP",
                             memo=f"Training - {course} - {C.DEPARTMENTS[key]['name']}", entity="TECHNOLOGY",
                             c25="RELEVANT", c26="RELEVANT", tag="training", reason="Technical training for F1 staff: inside the cap.")
            self.add(posted=bday_on_or_after(date(self.year, m, 5)), acct="6620", dept="HR", vendor="ven-021",
                     amount=money(rng, 21_000, 26_000), ccy="GBP", memo=f"Payroll bureau & HR system subscription - {self.ml(m)}",
                     entity="TECHNOLOGY", c25="HR_FINANCE_LEGAL", c26="HR_FINANCE_LEGAL", tag="hr_services",
                     reason="Payroll bureau and HR system: Human Resources Activities, excluded.")

    def gen_expenses(self):
        """Monthly staff expense claims batch per department (mileage, subsistence, small purchases)."""
        rng = self.rng("expenses")
        reasons = {"RELEVANT": "Staff expenses of an F1 Activities department: inside the cap.",
                   "MARKETING": "Expenses of the Marketing & Partnerships team: Marketing Activities.",
                   "HR_FINANCE_LEGAL": "Expenses of an HR, Finance or Legal department: excluded.",
                   "HERITAGE": "Expenses of the Heritage team: Heritage Asset Activities.",
                   "SPLIT": "Applied Technologies expenses split by f1_activity_share 0.6."}
        for m in self.months:
            day = bday_on_or_after(date(self.year, m, 18))
            for key, (c25, c26) in C.DEPT_PAYROLL_CATEGORY.items():
                dep = C.DEPARTMENTS[key]
                n = max(3, int(dep["hc"] * rng.uniform(0.12, 0.25)))
                amt = int(n * rng.uniform(85, 210) * (0.4 if m == 8 else 1.0) * 100)
                r = reasons[c25] if key != "HOSPITALITY" else "Expenses of the catering crew: no catering exclusion under ISS22, inside the cap."
                self.add(posted=day, acct="5230", dept=key, vendor=None, amount=amt, ccy="GBP",
                         memo=f"Staff expense claims - {dep['name']} - {self.ml(m)} ({n} claims)", entity="TECHNOLOGY",
                         c25=c25, c26=c26, tag="staff_expenses", reason=r, erp="NON_F1" if c25 == "SPLIT" else None)

    # ---- parts and materials ---------------------------------------------------------------
    def gen_materials(self):
        rng = self.rng("materials")
        scale, amt_f = (1.0, 0.82) if self.year == 2025 else (1.12, 1.0)
        catalog = [
            ("ven-009", "6010", 17, (4_000, 68_000), ["T800 prepreg roll stock", "front wing mainplane layup kit", "floor edge laminate kit",
                                                     "monocoque honeycomb core", "rear wing endplate layup kit", "sidepod inlet tooling block",
                                                     "halo fairing laminate", "brake duct carbon mouldings"], ["CHASSIS", "MFG", "AERO"]),
            ("ven-010", "6010", 5, (6_000, 46_000), ["M46J unidirectional prepreg", "woven prepreg 2x2 twill", "film adhesive rolls"], ["MFG", "CHASSIS"]),
            ("ven-011", "6020", 15, (3_000, 58_000), ["upright machining", "wishbone inserts", "gearbox casing machining", "brake caliper mounts",
                                                     "titanium fasteners batch", "suspension rocker machining", "steering rack housing"],
             ["MFG", "VD", "CHASSIS"]),
            ("ven-012", "6020", 5, (2_500, 30_000), ["additive titanium hydraulic manifold", "printed cooling ducts", "additive heat exchanger cores"],
             ["MFG", "AERO"]),
            ("ven-013", "6030", 8, (2_000, 40_000), ["wiring loom set", "pressure sensor array", "strain gauge kits", "steering wheel electronics"],
             ["RACEOPS", "VD"]),
            ("ven-014", "6030", 4, (4_000, 46_000), ["telemetry transceivers", "data logger units", "IMU sensor modules"], ["RACEOPS", "VD"]),
            ("ven-015", "6040", 8, (800, 14_000), ["cutting tools and inserts", "vacuum bagging consumables", "release agents and resins",
                                                  "abrasives and PPE consumables", "CNC tool holders"], ["MFG"]),
        ]
        for m in self.months:
            days = month_bdays(self.year, m)
            if not days:
                continue
            for vid, acct, base, (lo, hi), items, depts in catalog:
                n = max(0, round(base * self.bf(m) * scale * rng.uniform(0.85, 1.15)))
                if m == 8:
                    n = min(n, 3)
                ccy = C.VENDORS[vid]["currency"]
                for _ in range(n):
                    item = rng.choice(items)
                    po = f"PO-{self.year % 100}-{rng.randint(10000, 99999)}"
                    self.add(posted=rng.choice(days), acct=acct, dept=rng.choice(depts), vendor=vid, amount=int(money(rng, lo, hi) * amt_f), ccy=ccy,
                             memo=f"{po} - {item}", entity="RACING", c25="RELEVANT", c26="RELEVANT", tag="materials",
                             reason="Parts and materials for the F1 car: inside the cap.",
                             confuse=() if acct != "6040" else ("PROPERTY",), conf_p=0.02 if self.year == 2025 else 0.0,
                             why="workshop consumables for car build are not Property Costs")

    def gen_crash_and_spares(self):
        rng = self.rng("crash")
        for ev in self.events:
            if ev["kind"] != "race":
                continue
            day = bday_on_or_after(ev["date"] + timedelta(days=rng.randint(2, 6)))
            vid = rng.choice(["ven-011", "ven-009"])
            self.add(posted=day, acct="6050", dept="RACEOPS", vendor=vid, amount=money(rng, 22_000, 58_000), ccy="GBP",
                     memo=f"Race spares replenishment - {ev['name']}", entity="RACING", c25="RELEVANT", c26="RELEVANT",
                     tag="race_spares", reason="Race spares: inside the cap.")
        crashes = {2025: [("Monaco Grand Prix", "2025-05-25", 0.6), ("Azerbaijan Grand Prix", "2025-09-21", 0.9)],
                   2026: [("Australian Grand Prix", "2026-03-08", 0.35), ("Sao Paulo Grand Prix", "2026-11-08", 3.3)]}[self.year]
        parts = [("ven-009", "monocoque damage assessment & repair"), ("ven-009", "front wing assembly replacement"),
                 ("ven-011", "gearbox casing replacement"), ("ven-011", "front & rear suspension replacement"),
                 ("ven-009", "floor and diffuser replacement"), ("ven-013", "loom and sensor replacement"),
                 ("ven-009", "rear wing assembly replacement"), ("ven-011", "upright and brake corner replacement"),
                 ("ven-012", "additive cooling parts remake"), ("ven-009", "sidepod and engine cover replacement")]
        for gp, dt, size_m in crashes:
            n = 4 if size_m < 1 else len(parts)
            weights = [rng.uniform(0.6, 1.4) for _ in range(n)]
            total = size_m * 1_000_000
            for (vid, what), w in zip(parts[:n], weights):
                day = bday_on_or_after(C.d(dt) + timedelta(days=rng.randint(2, 17)))
                amt = int(total * w / sum(weights) * 100)
                self.add(posted=day, acct="6050", dept="RACEOPS", vendor=vid, amount=amt, ccy="GBP",
                         memo=f"Crash damage - {gp} - {what}", entity="RACING", c25="RELEVANT", c26="RELEVANT", tag="crash_damage",
                         reason="Crash damage repairs and replacement parts are inside the cap.")

    # ---- power unit, fuel, tyres, wind tunnel, simulator -----------------------------------
    def gen_power_unit(self):
        rng = self.rng("pu")
        annual = 1_700_000_000 if self.year == 2025 else 1_920_000_000
        for m in self.months:
            day = bday_on_or_after(date(self.year, m, 3))
            self.add(posted=day, acct="6100", dept="RACEOPS", vendor="ven-004", amount=annual // 12, ccy="EUR",
                     memo=f"PU supply - lease instalment {m}/12 - {self.year} season", entity="RACING",
                     c25="PU_SUPPLY", c26="PU_SUPPLY", tag="pu_supply",
                     reason="Power Unit Supply Perimeter purchases within the Section A maximum price: excluded.")
            self.add(posted=bday_on_or_after(date(self.year, m, 6)), acct="6105", dept="RACEOPS", vendor="ven-004",
                     amount=15_000_000, ccy="EUR", memo=f"PU trackside & dyno support services - {self.ml(m)} (outside supply perimeter)",
                     entity="RACING", c25="RELEVANT", c26="RELEVANT", tag="pu_trackside", fv=("fv-003", 14_000_000),
                     reason="PU Transaction outside the supply perimeter: compared to fv-003, contract EUR 150,000 >= fair value EUR 140,000, included at contract.")

    def gen_fuel_tyres(self):
        rng = self.rng("fuel")
        for ev in self.events:
            day = bday_on_or_after(ev["date"] - timedelta(days=rng.randint(6, 12)))
            litres = rng.randint(1100, 1500) if ev["kind"] == "race" else rng.randint(2400, 3200)
            self.add(posted=day, acct="6110", dept="RACEOPS", vendor="ven-017", amount=int(litres * rng.uniform(15.5, 17.5) * 100), ccy="GBP",
                     memo=f"FIA homologated race fuel - {ev['name']} - {litres:,} L", entity="RACING", c25="RELEVANT", c26="FUEL",
                     tag="fuel", reason="No fuel exclusion under ISS22: FIA homologated fuel is inside the cap.")
        for q in range(1, 5):
            day = bday_on_or_after(date(self.year, 3 * q - 2, 15))
            self.add(posted=day, acct="6120", dept="RACEOPS", vendor="ven-016", amount=money(rng, 330_000, 390_000), ccy="EUR",
                     memo=f"Tyre supply & fitting fee - Q{q} {self.year}", entity="RACING", c25="RELEVANT", c26="RELEVANT",
                     tag="tyres", reason="Tyre supply: inside the cap.")

    def gen_aero(self):
        rng = self.rng("aero")
        weeks = week_starts(self.year, self.last)
        for i, wk in enumerate(weeks):
            wn = wk.isocalendar()[1]
            hrs = rng.randint(28, 40)
            self.add(posted=wk, acct="6200", dept="AERO", vendor="ven-007", amount=int(hrs * rng.uniform(1_150, 1_320) * 100), ccy="GBP",
                     memo=f"Wind tunnel occupancy - 60% model - week {wn} ({hrs} occupied hrs)", entity="RACING",
                     c25="RELEVANT", c26="RELEVANT", tag="wind_tunnel", reason="Aerodynamic testing: inside the cap.")
            if rng.random() < 0.58:
                self.add(posted=bday_on_or_after(wk + timedelta(days=rng.randint(1, 3))), acct="6410", dept="AERO", vendor="ven-001",
                         amount=money(rng, 1_700, 3_600), ccy="GBP",
                         memo=f"Offsite catering - aero team lunch at Northbrook Wind Tunnel session (week {wn})", entity="RACING",
                         c25="RELEVANT", c26="RELEVANT", tag="wind_tunnel_catering",
                         confuse=("CATERING",) if self.year == 2026 else ("MARKETING",), conf_p=0.25 if self.year == 2026 else 0.05,
                         reason="Offsite engineering lunch at a third-party wind tunnel session: not at team premises or a Competition; inside the cap.",
                         why="an engineering lunch at the Northbrook wind tunnel is an F1 Activities cost, not Marketing or premises catering")
        for m in self.months:
            self.add(posted=month_end(self.year, m), acct="6200", dept="AERO", vendor="ven-008",
                     amount=money(rng, 70_000, 108_000) if m != 8 else money(rng, 30_000, 40_000), ccy="GBP",
                     memo=f"CFD compute - {self.ml(m)} - {rng.randint(900, 1600)},000 core-hours", entity="RACING",
                     c25="RELEVANT", c26="RELEVANT", tag="cfd", reason="CFD compute: inside the cap.")
            if m % 2 == 0:
                days = month_bdays(self.year, m)
                if days:
                    self.add(posted=rng.choice(days), acct="6210", dept="VD", vendor="ven-048", amount=money(rng, 28_000, 82_000), ccy="GBP",
                             memo=f"Simulator motion platform service & parts - {self.ml(m)}", entity="TECHNOLOGY",
                             c25="RELEVANT", c26="RELEVANT", tag="simulator", reason="Simulator maintenance: inside the cap.")

    # ---- race weekends: freight, travel, motorhome catering, hospitality, fines ------------
    def gen_race_weekends(self):
        rng = self.rng("races")
        partner_rounds = set()
        races = [e for e in self.events if e["kind"] == "race"]
        for ev in races:
            if ev["round"] % 2 == 0 or ev["name"].startswith(("British", "Monaco", "Italian", "Abu Dhabi")):
                partner_rounds.add(ev["name"])
        drivers_rounds = {e["name"] for i, e in enumerate(races) if i % 3 == 1}
        tp_rounds = {e["name"] for i, e in enumerate(races) if i % 4 == 2}
        for ev in self.events:
            nm, dt, reg = ev["name"], ev["date"], ev["region"]
            fly = reg in ("FLY", "AM")
            # freight (inside the cap: only personnel travel is excluded)
            if fly:
                kg = rng.randint(11_000, 16_000)
                forced = self.year == 2025 and nm in ("Japanese Grand Prix", "Singapore Grand Prix")
                self.add(posted=bday_on_or_after(dt - timedelta(days=rng.randint(9, 14))), acct="6300", dept="LOGISTICS", vendor="ven-005",
                         amount=int(kg * rng.uniform(17.5, 21.0) * 100), ccy="GBP", memo=f"Air freight - {nm} - flyaway kit ({kg:,} kg)",
                         entity="RACING", c25="RELEVANT", c26="RELEVANT", tag="freight", confuse=("COMPETITION_TRAVEL",),
                         conf_p=0.12 if self.year == 2025 else 0.0, catch_p=0.0 if forced else 0.5,
                         erp="COMPETITION_TRAVEL" if forced else None,
                         reason="Air/sea freight to Competitions is inside the cap; only personnel travel is excluded.",
                         why="freight to a Competition is inside the cap; 3.1(r) covers personnel travel only")
                if ev["kind"] == "race":
                    cs = "ABCD"[ev["round"] % 4]
                    self.add(posted=bday_on_or_after(dt - timedelta(days=rng.randint(32, 44))), acct="6300", dept="LOGISTICS",
                             vendor="ven-006", amount=money(rng, 68_000, 108_000), ccy="EUR",
                             memo=f"Sea freight - container set {cs} - {nm}", entity="RACING", c25="RELEVANT", c26="RELEVANT",
                             tag="freight", confuse=("COMPETITION_TRAVEL",), conf_p=0.12 if self.year == 2025 else 0.0, catch_p=0.5,
                             reason="Air/sea freight to Competitions is inside the cap; only personnel travel is excluded.",
                             why="freight to a Competition is inside the cap; 3.1(r) covers personnel travel only")
                self.add(posted=bday_on_or_after(dt - timedelta(days=rng.randint(4, 8))), acct="6300", dept="LOGISTICS", vendor="ven-005",
                         amount=money(rng, 2_800, 7_200), ccy="GBP", memo=f"ATA carnet & customs brokerage - {nm}", entity="RACING",
                         c25="RELEVANT", c26="RELEVANT", tag="freight", reason="Customs brokerage for freight: inside the cap.")
            else:
                self.add(posted=bday_on_or_after(dt - timedelta(days=rng.randint(6, 10))), acct="6300", dept="LOGISTICS", vendor="ven-005",
                         amount=money(rng, 46_000, 64_000), ccy="GBP", memo=f"Road freight - {nm} - race trucks & garage kit",
                         entity="RACING", c25="RELEVANT", c26="RELEVANT", tag="freight", confuse=("COMPETITION_TRAVEL",),
                         conf_p=0.12 if self.year == 2025 else 0.0, catch_p=0.5,
                         reason="Road freight to Competitions is inside the cap; only personnel travel is excluded.",
                         why="freight to a Competition is inside the cap; 3.1(r) covers personnel travel only")
            # personnel travel
            pax = rng.randint(38, 46) if ev["kind"] == "race" else rng.randint(30, 36)
            fare = rng.uniform(1_050, 1_900) if fly else rng.uniform(260, 520)
            air = "ven-038" if fly else "ven-037"
            r_travel = "Flights, rail and hotels in connection with a Competition or Testing: excluded under 3.1(r)."
            self.add(posted=bday_on_or_after(dt - timedelta(days=rng.randint(12, 20))), acct="6310", dept="RACEOPS", vendor=air,
                     amount=int(pax * fare * 100), ccy="GBP", memo=f"Flights - {nm} - race team ({pax} pax)", entity="RACING",
                     c25="COMPETITION_TRAVEL", c26="COMPETITION_TRAVEL", tag="gp_travel", reason=r_travel)
            eng = rng.randint(9, 15)
            self.add(posted=bday_on_or_after(dt - timedelta(days=rng.randint(10, 18))), acct="6310", dept="VD", vendor=air,
                     amount=int(eng * fare * 100), ccy="GBP", memo=f"Flights - {nm} - trackside engineering ({eng} pax)", entity="RACING",
                     c25="COMPETITION_TRAVEL", c26="COMPETITION_TRAVEL", tag="gp_travel", reason=r_travel)
            hotel_v = "ven-040" if reg == "AM" else "ven-039"
            rooms, nights = pax + eng, 5 if ev["kind"] == "race" else 4
            rate = rng.uniform(260, 420) if reg == "AM" else rng.uniform(150, 320)
            hotel_ccy = "USD" if reg == "AM" else "GBP"
            rate_usd = 1.0 if hotel_ccy == "GBP" else 1.3
            self.add(posted=bday_on_or_after(dt + timedelta(days=rng.randint(2, 8))), acct="6320", dept="RACEOPS", vendor=hotel_v,
                     amount=int(rooms * nights * rate * rate_usd * 100), ccy=hotel_ccy,
                     memo=f"Hotel - {ev['city']} - {nm} - {rooms} rooms x {nights} nights", entity="RACING",
                     c25="COMPETITION_TRAVEL", c26="COMPETITION_TRAVEL", tag="gp_travel", reason=r_travel)
            self.add(posted=bday_on_or_after(dt + timedelta(days=rng.randint(3, 9))), acct="6330", dept="RACEOPS", vendor="ven-041",
                     amount=money(rng, 11_000, 24_000), ccy="GBP", memo=f"Car hire & transfers - {nm} - race team", entity="RACING",
                     c25="RELEVANT", c26="COMPETITION_TRAVEL", tag="gp_ground_transport",
                     confuse=("COMPETITION_TRAVEL",) if self.year == 2025 else (), conf_p=0.35, catch_p=0.55,
                     reason="ISS22 3.1(r) covers flight, rail and hotel costs only: race-weekend road transport stays Relevant.",
                     why="ISS22 3.1(r) excludes flights, rail and hotels only; road transport at a Competition stays Relevant")
            if nm in drivers_rounds:
                self.add(posted=bday_on_or_after(dt - timedelta(days=rng.randint(10, 16))), acct="6310", dept="RACEOPS", vendor=air,
                         amount=int(2 * fare * 3.2 * 100), ccy="GBP", memo=f"Flights - {nm} - race drivers (2 pax, business class)",
                         entity="RACING", c25="F1_DRIVER", c26="F1_DRIVER", tag="driver_travel",
                         erp="COMPETITION_TRAVEL" if self.year == 2025 else None, catch_p=0.8,
                         reason="Travel of the F1 Drivers is excluded with their Consideration (3.1(b)), not as Competition travel.",
                         why="F1 Driver travel is excluded under 3.1(b) together with driver Consideration")
            if nm in tp_rounds:
                self.add(posted=bday_on_or_after(dt - timedelta(days=rng.randint(10, 16))), acct="6310", dept="EXEC", vendor=air,
                         amount=int(fare * 3.0 * 100), ccy="GBP", memo=f"Flights - {nm} - Team Principal (business class)",
                         entity="RACING", c25="EXCLUDED_PERSONS", c26="EXCLUDED_PERSONS", tag="exec_travel",
                         erp="COMPETITION_TRAVEL" if self.year == 2025 else None, catch_p=0.8,
                         reason="Travel of an Excluded Person is excluded with their Consideration (3.1(d)).",
                         why="travel of the three highest paid individuals sits under Excluded Persons")
            crew = rng.randint(8, 12)
            self.add(posted=bday_on_or_after(dt - timedelta(days=rng.randint(12, 20))), acct="6310", dept="HOSPITALITY", vendor=air,
                     amount=int(crew * fare * 100), ccy="GBP", memo=f"Flights - {nm} - hospitality & catering crew ({crew} pax)", entity="RACING",
                     c25="COMPETITION_TRAVEL", c26="COMPETITION_TRAVEL", tag="gp_travel", reason=r_travel)
            if ev["kind"] == "race":
                mk = rng.randint(4, 8)
                self.add(posted=bday_on_or_after(dt - timedelta(days=rng.randint(10, 18))), acct="6310", dept="MARKETING", vendor=air,
                         amount=int(mk * fare * 100), ccy="GBP", memo=f"Flights - {nm} - partner hospitality team ({mk} pax)", entity="RACING",
                         c25="COMPETITION_TRAVEL", c26="COMPETITION_TRAVEL", tag="gp_travel", reason=r_travel)
                self.add(posted=bday_on_or_after(dt + timedelta(days=rng.randint(2, 8))), acct="6320", dept="HOSPITALITY", vendor=hotel_v,
                         amount=int((crew + mk) * nights * rate * rate_usd * 100), ccy=hotel_ccy,
                         memo=f"Hotel - {ev['city']} - {nm} - hospitality & partner team, {crew + mk} rooms x {nights} nights", entity="RACING",
                         c25="COMPETITION_TRAVEL", c26="COMPETITION_TRAVEL", tag="gp_travel", reason=r_travel)
                self.add(posted=bday_on_or_after(dt - timedelta(days=rng.randint(1, 4))), acct="6300", dept="LOGISTICS", vendor="ven-005",
                         amount=money(rng, 1_800, 6_500), ccy="GBP", memo=f"Courier - urgent parts hand-carry to {nm}", entity="RACING",
                         c25="RELEVANT", c26="RELEVANT", tag="courier", confuse=("COMPETITION_TRAVEL",), conf_p=0.1 if self.year == 2025 else 0.0,
                         catch_p=0.5, reason="Courier of parts to a Competition is freight: inside the cap.",
                         why="a parts courier is freight, not personnel travel")
            # catering at the track
            if ev["kind"] == "race" and self.year == 2025 and nm == "British Grand Prix":
                self.add(posted=bday_on_or_after(dt + timedelta(days=2)), acct="6410", dept="HOSPITALITY", vendor="ven-002",
                         amount=money(rng, 24_000, 30_000), ccy="GBP", memo=f"Motorhome catering - Paddock Club partner guests - {nm}",
                         entity="RACING", c25="MARKETING", c26="MARKETING", tag="motorhome_catering", erp="RELEVANT", catch_p=0.5,
                         reason="Guest catering for partners at the British GP: Directly Attributable to Marketing Activities.",
                         why="catering for partner guests is a Marketing Activity")
            self.add(posted=bday_on_or_after(dt + timedelta(days=rng.randint(1, 6))), acct="6410", dept="HOSPITALITY", vendor="ven-002",
                     amount=money(rng, 26_000, 46_000) if ev["kind"] == "race" else money(rng, 18_000, 28_000), ccy="GBP",
                     memo=f"Motorhome catering - race team - {nm}", entity="RACING", c25="RELEVANT", c26="CATERING",
                     tag="motorhome_catering", confuse=("MARKETING",), conf_p=0.08 if self.year == 2025 else 0.0, catch_p=0.5,
                     reason="Catering for the race team at a Competition: no catering exclusion under ISS22, inside the cap.",
                     why="team catering at the track is not Marketing; under ISS22 it is inside the cap")
            if nm in partner_rounds:
                self.add(posted=bday_on_or_after(dt + timedelta(days=rng.randint(2, 7))), acct="6420", dept="MARKETING", vendor="ven-002",
                         amount=money(rng, 42_000, 92_000), ccy="GBP", memo=f"Paddock Club hospitality - Halcyon partner guests - {nm}",
                         entity="RACING", c25="MARKETING", c26="MARKETING", tag="partner_hospitality",
                         reason="Partner hospitality under the Halcyon title partnership: Marketing Activities.")
            if ev["kind"] == "race" and ev["round"] % 4 == 1:
                self.add(posted=bday_on_or_after(dt - timedelta(days=rng.randint(20, 30))), acct="6420", dept="MARKETING", vendor="ven-043",
                         amount=int(rng.randint(20, 40) * rng.uniform(5_200, 6_400) * 100), ccy="USD",
                         memo=f"Paddock Club passes - partner guests - {nm}", entity="RACING", c25="MARKETING", c26="MARKETING",
                         tag="paddock_club_passes", reason="Paddock Club passes for partner guests: Marketing Activities.")
        # sporting fines (not Financial Regulations penalties)
        fines = {2025: [("pit lane speeding", "Bahrain Grand Prix", 6_200), ("unsafe release", "Spanish Grand Prix", 11_500),
                        ("team personnel on grid after signal", "Dutch Grand Prix", 5_000), ("pit lane speeding", "Singapore Grand Prix", 4_800),
                        ("breach of parc ferme procedure", "Mexico City Grand Prix", 25_000)],
                 2026: [("pit lane speeding", "Japanese Grand Prix", 5_600), ("unsafe release", "Austrian Grand Prix", 10_000),
                        ("pit lane speeding", "Italian Grand Prix", 7_200)]}[self.year]
        evd = {e["name"]: e["date"] for e in self.events}
        for i, (what, gp, eur) in enumerate(fines):
            self.add(posted=bday_on_or_after(evd[gp] + timedelta(days=rng.randint(8, 15))), acct="6910", dept="RACEOPS", vendor="ven-042",
                     amount=eur * 100, ccy="EUR", memo=f"FIA fine - {what} - {gp}", entity="RACING", c25="RELEVANT", c26="FINES",
                     tag="sporting_fine", erp="FINES" if self.year == 2025 else None, catch_p=0.6,
                     escalate="first sporting fine of the year" if i == 0 and self.year == 2025 else None,
                     reason="Sporting fine, not a penalty for breach of the Financial Regulations: ISS22 3.1(m) does not exclude it, inside the cap.",
                     why="ISS22 3.1(m) excludes only penalties for breaches of the Financial Regulations; sporting fines stay Relevant")

    # ---- non-competition travel --------------------------------------------------------------
    def gen_other_travel(self):
        rng = self.rng("travel")
        rel = "Business travel not in connection with a Competition or Testing: inside the cap."
        templates = [
            ("6310", "ven-037", "Flights - Munich - supplier audit Hexalam Prepreg (composites)", "CHASSIS", "RELEVANT", (380, 900)),
            ("6320", "ven-039", "Hotel - Landsberg - supplier audit Hexalam Prepreg, 3 rooms x 2 nights", "CHASSIS", "RELEVANT", (600, 1_200)),
            ("6310", "ven-037", "Flights - Milan - tyre supplier technical meeting Ruota", "VD", "RELEVANT", (420, 950)),
            ("6310", "ven-037", "Rail - Bedford - Northbrook Wind Tunnel session (aero team)", "AERO", "RELEVANT", (180, 640)),
            ("6320", "ven-039", "Hotel - Bedford - Northbrook Wind Tunnel session, 6 rooms x 3 nights", "AERO", "RELEVANT", (1_600, 2_500)),
            ("6310", "ven-037", "Flights - Paris - PU integration workshop Valcourt Powertrains", "VD", "RELEVANT", (900, 2_400)),
            ("6330", "ven-041", "Car hire - supplier audit West Midlands (machining)", "MFG", "RELEVANT", (240, 680)),
            ("6310", "ven-037", "Flights - Indianapolis - telemetry supplier visit Delta Telemetry", "RACEOPS", "RELEVANT", (2_600, 5_400)),
            ("6310", "ven-037", "Flights - Detroit - SAE vehicle dynamics conference", "VD", "RELEVANT", (1_900, 4_200)),
            ("6320", "ven-039", "Hotel - Coventry - battery supplier technical review (Applied Technologies)", "APPLIED", "NON_F1", (300, 700)),
            ("6310", "ven-037", "Rail - London - partner meeting Halcyon Energy", "MARKETING", "MARKETING", (120, 380)),
            ("6320", "ven-039", "Hotel - London - partner activation planning workshop", "MARKETING", "MARKETING", (700, 1_500)),
            ("6310", "ven-037", "Rail - Manchester - university recruitment fair", "HR", "HR_FINANCE_LEGAL", (150, 420)),
        ]
        weights = [9, 6, 6, 9, 7, 6, 5, 4, 3, 2, 2, 1, 1]
        why_map = {"RELEVANT": "not in connection with a Competition or Testing, so the travel stays Relevant",
                   "MARKETING": "travel for a partner meeting is Directly Attributable to Marketing Activities",
                   "HR_FINANCE_LEGAL": "recruitment travel is a Human Resources Activity",
                   "NON_F1": "travel for an Applied Technologies client project is Non-F1"}
        reason_map = {"RELEVANT": rel, "MARKETING": "Partner meeting travel: Directly Attributable to Marketing Activities.",
                      "HR_FINANCE_LEGAL": "Recruitment travel: Human Resources Activities.", "NON_F1": "Applied Technologies client project travel: Non-F1 Activities."}
        for m in self.months:
            days = month_bdays(self.year, m, factory=False)
            k = 2 if m == 8 else rng.randint(7, 10)
            for _ in range(k):
                acct, vid, memo, dept, cat, (lo, hi) = rng.choices(templates, weights)[0]
                exc = cat != "RELEVANT"
                self.add(posted=rng.choice(days), acct=acct, dept=dept, vendor=vid, amount=money(rng, lo, hi), ccy="GBP", memo=memo,
                         entity="RACING" if dept in ("RACEOPS", "VD", "MARKETING") else "TECHNOLOGY",
                         c25=cat, c26=cat, tag="non_gp_travel" if not exc else "non_gp_travel_exception",
                         confuse=("COMPETITION_TRAVEL",) if acct != "6330" else (),
                         conf_p=(0.75 if exc else 0.16) if self.year == 2025 else 0.0, catch_p=0.55,
                         reason=reason_map[cat], why=why_map[cat])

    # ---- catering and hospitality at the factory ------------------------------------------
    def gen_canteen(self):
        rng = self.rng("canteen")
        weeks = week_starts(self.year, self.last)
        r = ("Factory canteen for staff at team premises: no catering exclusion under ISS22, inside the cap."
             if self.year == 2025 else "Factory canteen: catering at the F1 Team's premises.")
        for wk in weeks:
            if wk == date(2025, 12, 15):
                continue  # this week's invoice arrives late, in January 2026 (plant P26)
            spike = 1.15 if wk.month in (1, 2) else 1.0
            inv_day = bday_on_or_after(wk + timedelta(days=4))
            if inv_day.year != self.year:
                continue
            self.add(posted=inv_day, acct="6410", dept="FACILITIES", vendor="ven-001",
                     amount=int(money(rng, 14_200, 18_900) * spike * (1 if self.year == 2025 else 1.04)), ccy="GBP",
                     memo=f"Factory canteen service - staff meals w/c {wk.isoformat()}", entity="TECHNOLOGY",
                     c25="RELEVANT", c26="CATERING", tag="canteen", confuse=("MARKETING",),
                     conf_p=0.04 if self.year == 2025 else 0.0, catch_p=0.5,
                     reason=r, why="the factory canteen is not Marketing; under ISS22 staff catering is inside the cap")
            self.add(posted=inv_day, acct="6410", dept="MFG", vendor="ven-001",
                     amount=int(money(rng, 3_800, 5_600) * spike), ccy="GBP",
                     memo=f"Night shift meal service - Manufacturing w/c {wk.isoformat()}", entity="TECHNOLOGY",
                     c25="RELEVANT", c26="CATERING", tag="canteen", reason=r)
        for wk in weeks[::2]:
            day = bday_on_or_after(wk + timedelta(days=2))
            if day.year != self.year:
                continue
            self.add(posted=day, acct="6410", dept="FACILITIES", vendor="ven-001", amount=money(rng, 1_100, 1_900), ccy="GBP",
                     memo=f"Canteen - hot drinks, vending & water restock (fortnight from {wk.isoformat()})", entity="TECHNOLOGY",
                     c25="RELEVANT", c26="CATERING", tag="canteen", reason=r)
        # partner open days catered by the canteen (genuine exceptions: Marketing)
        opens = {2025: ["2025-04-24", "2025-09-25"], 2026: ["2026-05-14"]}[self.year]
        for i, dt in enumerate(opens):
            self.add(posted=bday_on_or_after(C.d(dt) + timedelta(days=1)), acct="6410", dept="MARKETING", vendor="ven-001",
                     amount=money(rng, 5_200, 7_400), ccy="GBP",
                     memo=f"Factory canteen - partner open day buffet ({PARTNERS[i % len(PARTNERS)]} guests)", entity="RACING",
                     c25="MARKETING", c26="MARKETING", tag="canteen_partner_buffet",
                     erp="RELEVANT" if self.year == 2025 else "MARKETING", catch_p=0.5,
                     reason="Buffet for partner guests on a sponsor open day: Directly Attributable to Marketing Activities.",
                     why="a partner open day buffet is a Marketing Activity even when the canteen caters it")
        # partner dinners at the factory atrium, catered by the canteen operator
        n = 8 if self.year == 2025 else 6
        for i in range(n):
            m = rng.choice([mm for mm in self.months if mm != 8])
            days = month_bdays(self.year, m)
            partner = PARTNERS[i % len(PARTNERS)]
            self.add(posted=rng.choice(days), acct="6420", dept="MARKETING", vendor="ven-001", amount=money(rng, 7_800, 14_500), ccy="GBP",
                     memo=f"Partner dinner - {partner} partners evening - factory atrium", entity="RACING",
                     c25="MARKETING", c26="MARKETING", tag="partner_dinner",
                     reason="Partner dinner hosted for sponsor guests: Marketing Activities.")
        # supplier technical dinner: genuine exception on the hospitality account
        if self.year == 2025:
            self.add(posted=date(2025, 6, 19), acct="6420", dept="CHASSIS", vendor="ven-001", amount=money(rng, 1_900, 2_600), ccy="GBP",
                     memo="Supplier technical review dinner - Cotswold Composites engineers (layup quality)", entity="RACING",
                     c25="RELEVANT", c26="RELEVANT", tag="supplier_dinner", erp="MARKETING", catch_p=0.0,
                     reason="Working dinner with supplier engineers on F1 parts quality: not Marketing, inside the cap.",
                     why="a working dinner with supplier engineers is an F1 Activities cost, not Marketing")

    def gen_hospitality_invoices(self):
        """2025 only: Grove Catering invoices raised by Marketing that mix partner hospitality with staff catering.

        The requester codes the whole invoice MARKETING on 6420; the 2025 submission splits it by bill line
        (MARKETING for the guests, RELEVANT for the canteen top-up and the wind tunnel lunch)."""
        if self.year != 2025:
            return
        rng = self.rng("hospitality_invoices")
        for i in range(14):
            m = rng.choice([mm for mm in self.months if mm != 8])
            day = rng.choice(month_bdays(self.year, m))
            partner = PARTNERS[(i + 1) % len(PARTNERS)]
            parts, cats = [], []
            dinner = rng.random() < 0.6
            if dinner:
                parts.append((desc_sponsor_dinner(partner, day), money(rng, 5_500, 11_000)))
            else:
                parts.append((desc_partner_lunch(partner, day), money(rng, 1_800, 3_900)))
            cats.append(T_MARKETING)
            if rng.random() < 0.3:
                other = desc_partner_lunch(partner, day) if dinner else desc_sponsor_dinner(partner, day)
                parts.append((other, money(rng, 1_800, 3_900) if dinner else money(rng, 5_500, 11_000)))
                cats.append(T_MARKETING)
            canteen = rng.random() < 0.7
            tunnel = rng.random() < 0.5 or not canteen
            if canteen:
                parts.append((desc_canteen_topup(day), money(rng, 1_200, 4_800)))
                cats.append(T_CANTEEN)
            if tunnel:
                parts.append((desc_tunnel_lunch(day), money(rng, 1_700, 3_600)))
                cats.append(T_TUNNEL)
            self.add(posted=day, acct="6420", dept="MARKETING", vendor=C.V_CANTEEN, amount=sum(a for _, a in parts), ccy="GBP",
                     memo=f"Hospitality - {partner} partner visit & build week catering (requester: Marketing)", entity="RACING",
                     c25="MARKETING", c26="MARKETING", tag="hospitality_mixed", erp="MARKETING", catch_p=0.75,
                     bill_lines=parts, bill_cats=cats,
                     reason="Mixed hospitality invoice split by bill line: partner hospitality Marketing, staff catering and engineering lunches Relevant.",
                     why="only the partner-guest lines are Marketing; the canteen top-up and the wind tunnel lunch are F1 Activities costs")

    def gen_staff_entertainment(self):
        rng = self.rng("ent")
        items = {2025: [("2025-07-18", "All-staff summer party - Upper Heyford campus", 210_000, "STAFF_ENTERTAINMENT"),
                        ("2025-09-12", "All-staff family day - Upper Heyford campus", 96_000, "STAFF_ENTERTAINMENT"),
                        ("2025-12-12", "All-staff Christmas party", 262_000, "STAFF_ENTERTAINMENT"),
                        ("2025-04-17", "Aero department team dinner - wind tunnel correlation milestone", 6_400, "RELEVANT"),
                        ("2025-09-10", "Race team celebration dinner - podium, Italian Grand Prix (38 staff)", 8_800, "RELEVANT")],
                 2026: [("2026-07-17", "All-staff summer party - Upper Heyford campus", 224_000, "STAFF_ENTERTAINMENT"),
                        ("2026-09-11", "All-staff family day - Upper Heyford campus", 101_000, "STAFF_ENTERTAINMENT")]}[self.year]
        for dt, memo, amt, cat in items:
            exc = cat == "RELEVANT"
            self.add(posted=bday_on_or_after(C.d(dt)), acct="6400", dept="CORP" if not exc else ("AERO" if "Aero" in memo else "RACEOPS"),
                     vendor="ven-032", amount=amt * 100 + rng.randint(0, 99), ccy="GBP", memo=memo, entity="TECHNOLOGY",
                     c25=cat, c26=cat, tag="staff_entertainment" if not exc else "staff_entertainment_exception",
                     erp="STAFF_ENTERTAINMENT" if exc else None, catch_p=0.0,
                     reason=("Entertainment for all employees on a substantially equal basis, within the annual limit."
                             if not exc else "Entertainment for one team only, not all employees on an equal basis: ordinary staff cost, Relevant."),
                     why="the staff entertainment exclusion needs all employees on a substantially equal basis")

    # ---- marketing, legal, professional ---------------------------------------------------
    def gen_marketing(self):
        rng = self.rng("marketing")
        campaigns = ["season launch film", "social content series", "livery reveal event", "partner co-branded campaign", "fan zone activation",
                     "driver content day"]
        events_ = ["Goodwood Festival of Speed partner stand", "Halcyon hospitality roadshow", "London show car activation", "trade show stand"]
        for m in self.months:
            days = month_bdays(self.year, m, factory=False)
            self.add(posted=bday_on_or_after(date(self.year, m, 2)), acct="6500", dept="MARKETING", vendor="ven-022",
                     amount=money(rng, 44_000, 47_000), ccy="GBP", memo=f"Brand & content retainer - {self.ml(m)}", entity="RACING",
                     c25="MARKETING", c26="MARKETING", tag="marketing_agency", reason="Marketing agency retainer: Marketing Activities.")
            for _ in range(rng.randint(1, 3)):
                self.add(posted=rng.choice(days), acct="6500", dept="MARKETING", vendor="ven-022", amount=money(rng, 18_000, 82_000),
                         ccy="GBP", memo=f"Campaign - {rng.choice(campaigns)}", entity="RACING", c25="MARKETING", c26="MARKETING",
                         tag="marketing_agency", reason="Marketing campaign: Marketing Activities.")
            for _ in range(rng.randint(1, 2)):
                self.add(posted=rng.choice(days), acct="6510", dept="MARKETING", vendor="ven-023", amount=money(rng, 12_000, 64_000),
                         ccy="GBP", memo=f"Partner activation - {rng.choice(events_)}", entity="RACING", c25="MARKETING", c26="MARKETING",
                         tag="events_agency", reason="Partner activation event: Marketing Activities.")
        exc = {2025: ["2025-03-20", "2025-10-08"], 2026: []}[self.year]
        for dt in exc:
            self.add(posted=bday_on_or_after(C.d(dt)), acct="6500", dept="CHASSIS", vendor="ven-022", amount=money(rng, 6_000, 9_500), ccy="GBP",
                     memo="Technical illustrations for FIA homologation dossier (chassis crash structures)", entity="RACING",
                     c25="RELEVANT", c26="RELEVANT", tag="marketing_agency_exception", erp="MARKETING", catch_p=0.5,
                     reason="Technical drawings for FIA homologation are an F1 Activities cost even though the agency produced them.",
                     why="homologation illustrations are engineering documentation, not Marketing")

    def gen_professional(self):
        rng = self.rng("legal")
        matters = ["commercial contracts - supplier terms", "employment matters", "Financial Regulations advisory", "sponsorship agreement drafting - Halcyon",
                   "IP - trademark portfolio", "property lease review", "data protection compliance", "driver contract negotiation"]
        for m in self.months:
            days = month_bdays(self.year, m, factory=False)
            for _ in range(rng.randint(2, 4)):
                self.add(posted=rng.choice(days), acct="6600", dept="LEGAL", vendor="ven-018", amount=money(rng, 6_000, 48_000), ccy="GBP",
                         memo=f"Legal services - {rng.choice(matters)}", entity="RACING", c25="HR_FINANCE_LEGAL", c26="HR_FINANCE_LEGAL",
                         tag="law_firm", reason="Legal Activities: excluded.")
        exc = {2025: ["2025-05-13", "2025-11-18"], 2026: ["2026-06-16"]}[self.year]
        for dt in exc:
            self.add(posted=bday_on_or_after(C.d(dt)), acct="6600", dept="APPLIED", vendor="ven-018", amount=money(rng, 11_000, 19_000), ccy="GBP",
                     memo="Legal services - patent filing, Applied Technologies battery cooling plate (client project)", entity="TECHNOLOGY",
                     c25="NON_F1", c26="NON_F1", tag="law_firm_exception", erp="HR_FINANCE_LEGAL", catch_p=0.5,
                     reason="Patent work for an Applied Technologies client product: Directly Attributable to Non-F1 Activities.",
                     why="legal work for an Applied Technologies client product is Non-F1, which is the more specific exclusion")
        audit = {2025: [(2, "Statutory audit FY2024 - final fieldwork", 96_000), (3, "Cost Cap Agreed Upon Procedures FY2024", 74_000),
                        (6, "Interim cost cap review - H1", 22_000), (9, "Tax compliance & R&D claim preparation", 31_000),
                        (11, "Statutory audit FY2025 - interim fieldwork", 38_000), (12, "Transfer pricing study refresh", 18_000)],
                 2026: [(2, "Statutory audit FY2025 - final fieldwork", 101_000), (3, "Cost Cap Agreed Upon Procedures FY2025", 79_000),
                        (6, "Interim cost cap review - H1", 23_000), (9, "Tax compliance & R&D claim preparation", 33_000),
                        (11, "Statutory audit FY2026 - interim fieldwork", 40_000)]}[self.year]
        for m, memo, amt in audit:
            self.add(posted=bday_on_or_after(date(self.year, m, 20)), acct="6610", dept="FINANCE", vendor="ven-019", amount=amt * 100,
                     ccy="GBP", memo=memo, entity="RACING", c25="HR_FINANCE_LEGAL", c26="HR_FINANCE_LEGAL", tag="audit",
                     reason="Finance Activities (audit and accountancy): excluded.")

    # ---- property, facilities, IT, insurance, H&S, BCDR, sustainability -------------------
    def gen_facilities(self):
        rng = self.rng("facilities")
        maint_n = bm_n = 0
        machines = ["5-axis CNC mill 3", "autoclave 1", "CMM inspection cell", "seven-post rig hydraulics", "gearbox dyno cell",
                    "clean room HVAC filtration", "composite oven 2", "waterjet cutter"]
        buildings = ["Building 3 roof repairs", "car park lighting", "reception refurbishment", "Building 1 fire doors", "drainage works"]
        for m in self.months:
            days = month_bdays(self.year, m)
            odays = month_bdays(self.year, m, factory=False)
            if m in (1, 4, 7, 10):
                self.add(posted=bday_on_or_after(date(self.year, m, 1)), acct="6700", dept="FACILITIES", vendor="ven-027",
                         amount=118_000_000 if self.year == 2025 else 121_500_000, ccy="GBP",
                         memo=f"Rent - Upper Heyford campus - Q{(m + 2) // 3} {self.year}", entity="TECHNOLOGY",
                         c25="PROPERTY", c26="PROPERTY", tag="rent", reason="Property Costs: excluded.")
            self.add(posted=bday_on_or_after(date(self.year, m, 1)), acct="6700", dept="FACILITIES", vendor="ven-027",
                     amount=8_640_000, ccy="GBP", memo=f"Business rates - Upper Heyford campus - {self.ml(m)}", entity="TECHNOLOGY",
                     c25="PROPERTY", c26="PROPERTY", tag="rent", reason="Property Costs: excluded.")
            winter = 1.25 if m in (1, 2, 11, 12) else (0.55 if m == 8 else 1.0)
            self.add(posted=bday_on_or_after(date(self.year, m, 8)), acct="6710", dept="FACILITIES", vendor="ven-026",
                     amount=int(money(rng, 160_000, 205_000) * winter), ccy="GBP", memo=f"Electricity - Upper Heyford campus - {self.ml(m)}",
                     entity="TECHNOLOGY", c25="RELEVANT", c26="RELEVANT", tag="utilities", reason="Utilities for the F1 campus: inside the cap.")
            self.add(posted=bday_on_or_after(date(self.year, m, 8)), acct="6710", dept="FACILITIES", vendor="ven-026",
                     amount=int(money(rng, 26_000, 44_000) * winter), ccy="GBP", memo=f"Gas - Upper Heyford campus - {self.ml(m)}",
                     entity="TECHNOLOGY", c25="RELEVANT", c26="RELEVANT", tag="utilities", reason="Utilities for the F1 campus: inside the cap.")
            for _ in range(rng.randint(2, 4) if m != 8 else 1):
                if not odays:
                    continue
                maint_n += 1
                wrong = None
                if self.year == 2025 and maint_n % 7 == 3:
                    wrong = ({"erp": "HR_FINANCE_LEGAL", "dept": "HR", "acct": "6620"}, {"erp": "PROPERTY", "dept": "FACILITIES", "acct": "6730"})[(maint_n // 7) % 2]
                self.add(posted=rng.choice(odays), acct="6720", dept="MFG", vendor="ven-024", amount=money(rng, 3_500, 38_000), ccy="GBP",
                         memo=f"Planned maintenance - {rng.choice(machines)}", entity="TECHNOLOGY", c25="RELEVANT", c26="RELEVANT",
                         tag="plant_maintenance", confuse=(wrong,) if wrong else (), conf_p=1.0, catch_p=0.5,
                         reason="Maintenance of plant and equipment used for F1 Activities: inside the cap.",
                         why="maintenance of F1 plant and equipment is Relevant whoever raised the order (Red Bull 2021 ABA item 13)")
            for _ in range(rng.randint(1, 3)):
                if not odays:
                    continue
                bm_n += 1
                # Property Costs never include maintenance (ISS22: rent, lease, rates, taxes; SECD adds insurance, security,
                # landscaping, cleaning and waste). The ERP user still codes every third one PROPERTY out of habit.
                self.add(posted=rng.choice(odays), acct="6730", dept="FACILITIES", vendor="ven-025", amount=money(rng, 2_500, 26_000),
                         ccy="GBP", memo=f"Building maintenance - {rng.choice(buildings)}", entity="TECHNOLOGY", c25="RELEVANT", c26="RELEVANT",
                         tag="building_maintenance", erp="PROPERTY" if bm_n % 3 == 1 else "RELEVANT", catch_p=0.6,
                         reason="Building repairs and maintenance are not Property Costs (rent, lease, business rates and property taxes): inside the cap.",
                         why="building maintenance is not a Property Cost (rent, lease, rates and taxes only); it stays Relevant")
            self.add(posted=bday_on_or_after(date(self.year, m, 12)), acct="6740", dept="FACILITIES", vendor="ven-033",
                     amount=money(rng, 13_500, 19_500), ccy="GBP", memo=f"Occupational health & H&S compliance services - {self.ml(m)}",
                     entity="TECHNOLOGY", c25="HR_FINANCE_LEGAL", c26="HEALTH_SAFETY", tag="health_safety",
                     reason="ISS22 Human Resources Activities include health and safety matters: excluded as HR/Finance/Legal Activities (SECD moves them to the separate Health and Safety Costs exclusion).")
            self.add(posted=bday_on_or_after(date(self.year, m, 4)), acct="6750", dept="CORP", vendor="ven-049",
                     amount=money(rng, 38_000, 45_000), ccy="GBP", memo=f"Managed IT services - {self.ml(m)}", entity="TECHNOLOGY",
                     c25="RELEVANT", c26="RELEVANT", tag="it", reason="IT for F1 Activities: inside the cap.")
            self.add(posted=bday_on_or_after(date(self.year, m, 4)), acct="6750", dept="AERO", vendor="ven-008",
                     amount=money(rng, 9_000, 14_000), ccy="GBP", memo=f"HPC data storage & archive - {self.ml(m)}", entity="TECHNOLOGY",
                     c25="RELEVANT", c26="RELEVANT", tag="it", reason="IT for F1 Activities: inside the cap.")
            self.add(posted=bday_on_or_after(date(self.year, m, 7)), acct="6750", dept="VD", vendor="ven-028",
                     amount=money(rng, 6_000, 9_000), ccy="USD", memo=f"Simulation cloud seats (monthly) - {self.ml(m)}", entity="TECHNOLOGY",
                     c25="RELEVANT", c26="RELEVANT", tag="it", reason="Engineering software: inside the cap.")
            if m in (1, 4, 7, 10):
                q = (m + 2) // 3
                self.add(posted=bday_on_or_after(date(self.year, m, 15)), acct="6750", dept="CORP", vendor="ven-028",
                         amount=money(rng, 255_000, 318_000), ccy="USD", memo=f"CAD/PLM & simulation software licences - Q{q} {self.year}",
                         entity="TECHNOLOGY", c25="RELEVANT", c26="RELEVANT", tag="it", reason="Engineering software: inside the cap.")
                self.add(posted=bday_on_or_after(date(self.year, m, 20)), acct="6740", dept="FACILITIES", vendor="ven-033",
                         amount=money(rng, 4_800, 7_900), ccy="GBP", memo=f"Fire safety inspection & extinguisher service - Q{q}",
                         entity="TECHNOLOGY", c25="HR_FINANCE_LEGAL", c26="HEALTH_SAFETY", tag="health_safety",
                         reason="ISS22 Human Resources Activities include health and safety matters: excluded as HR/Finance/Legal Activities (SECD moves them to the separate Health and Safety Costs exclusion).")
                self.add(posted=bday_on_or_after(date(self.year, m, 22)), acct="6930", dept="CORP", vendor="ven-035",
                         amount=money(rng, 92_000, 118_000), ccy="GBP", memo=f"Disaster recovery site & offsite backup - Q{q} {self.year}",
                         entity="TECHNOLOGY", c25="RELEVANT", c26="BCDR", tag="bcdr",
                         reason="No business continuity exclusion under ISS22: inside the cap.")
                self.add(posted=bday_on_or_after(date(self.year, m, 25)), acct="6920", dept="CORP", vendor="ven-034",
                         amount=money(rng, 58_000, 88_000), ccy="GBP", memo=f"Sustainability programme - renewable PPA certificates & audit - Q{q}",
                         entity="TECHNOLOGY", c25="SUSTAINABILITY", c26="SUSTAINABILITY", tag="sustainability",
                         reason="Sustainability Initiative Costs: excluded.")
        self.add(posted=bday_on_or_after(date(self.year, 1, 9)), acct="6760", dept="CORP", vendor="ven-029",
                 amount=money(rng, 660_000, 700_000), ccy="GBP", memo=f"Motorsport equipment, transit & liability insurance - annual premium {self.year}",
                 entity="RACING", c25="RELEVANT", c26="RELEVANT", tag="insurance", reason="Insurance of F1 equipment and operations: inside the cap.")
        self.add(posted=bday_on_or_after(date(self.year, 1, 9)), acct="6760", dept="FACILITIES", vendor="ven-029",
                 amount=money(rng, 182_000, 196_000), ccy="GBP", memo=f"Buildings insurance - Upper Heyford campus - annual {self.year}",
                 entity="TECHNOLOGY", c25="RELEVANT", c26="PROPERTY", tag="insurance_property",
                 erp="RELEVANT" if self.year == 2025 else None,
                 reason="ISS22 Property Costs are property rent, lease costs, business rates and property taxes only: buildings insurance "
                        "stays inside the cap (SECD adds property insurance from 2026).")

    # ---- heritage, applied technologies, FIA ------------------------------------------------
    def gen_heritage_applied(self):
        rng = self.rng("heritage")
        cars = ["2012 KGP-12 show car", "2008 KGP-08 championship car", "1997 KGP-97 V10 car", "2019 KGP-19 demo car"]
        evs = ["Goodwood Festival of Speed", "Silverstone Classic", "partner demo run", "museum display rotation", "historic demo at Monza"]
        for m in self.months:
            days = month_bdays(self.year, m, factory=False)
            for _ in range(rng.randint(1, 3)):
                self.add(posted=rng.choice(days), acct="6800", dept="HERITAGE", vendor="ven-030", amount=money(rng, 4_000, 42_000), ccy="GBP",
                         memo=f"Heritage fleet - {rng.choice(cars)} - {rng.choice(evs)} preparation", entity="RACING",
                         c25="HERITAGE", c26="HERITAGE", tag="heritage", reason="Heritage Asset Activities: excluded.")
            for _ in range(rng.randint(2, 3)):
                self.add(posted=rng.choice(days), acct="6810", dept="APPLIED", vendor="ven-051", amount=money(rng, 9_000, 64_000), ccy="GBP",
                         memo=f"Applied Technologies - battery module testing - client programme {rng.choice(['AT-117', 'AT-122', 'AT-131'])}",
                         entity="TECHNOLOGY", c25="NON_F1", c26="NON_F1", tag="applied_projects",
                         reason="Applied Technologies client programme: Directly Attributable to Non-F1 Activities.")
            if m % 2 == 1:
                self.add(posted=rng.choice(days), acct="6810", dept="APPLIED", vendor="ven-011", amount=money(rng, 8_000, 30_000), ccy="GBP",
                         memo="Applied Technologies - machined battery enclosures - client programme AT-122", entity="TECHNOLOGY",
                         c25="NON_F1", c26="NON_F1", tag="applied_projects",
                         reason="Applied Technologies client programme: Directly Attributable to Non-F1 Activities.")
        self.add(posted=bday_on_or_after(date(self.year, 1, 14)), acct="6900", dept="RACEOPS", vendor="ven-042",
                 amount=76_000_000 if self.year == 2025 else 78_500_000, ccy="EUR", memo=f"FIA entry fee - {self.year} Championship",
                 entity="RACING", c25="FIA_FEES", c26="FIA_FEES", tag="fia_fees", reason="FIA entry fee: excluded.")
        self.add(posted=bday_on_or_after(date(self.year, 2, 10)), acct="6900", dept="RACEOPS", vendor="ven-042",
                 amount=2_840_000, ccy="EUR", memo=f"FIA super licence fees - race drivers (2) - {self.year}", entity="RACING",
                 c25="FIA_FEES", c26="FIA_FEES", tag="fia_fees", reason="Super licence fees: excluded.")

    # ---- accounting journals ------------------------------------------------------------------
    def gen_journals(self):
        rng = self.rng("journals")
        g = 1.0 if self.year == 2025 else 1.15  # 2026-regulation tooling capitalised in late 2025
        dep_lines = [("MFG", "machine tools, autoclaves & composite ovens", 46_000_000), ("VD", "test rigs & driver-in-loop simulator", 31_000_000),
                     ("AERO", "wind tunnel models, rigs & tooling", 22_000_000), ("RACEOPS", "race equipment, garage & pit kit", 14_000_000),
                     ("CORP", "IT hardware & HPC", 12_000_000)]
        for m in self.months:
            day = month_end(self.year, m)
            for dept, what, amt in dep_lines:
                self.add(posted=day, acct="7000", dept=dept, vendor=None, amount=int(amt * g), ccy="GBP",
                         memo=f"Depreciation - {what} - {self.ml(m)}", entity="TECHNOLOGY", c25="DEPRECIATION", c26="RELEVANT",
                         tag="pe_depreciation", reason="All depreciation is excluded under ISS22 3.1(o) (capital spend is tested against the separate capex limit).")
            self.add(posted=day, acct="7000", dept="APPLIED", vendor=None, amount=int(3_100_000 * g), ccy="GBP",
                     memo=f"Depreciation - Applied Technologies battery test lab (used only for non-F1 client work) - {self.ml(m)}", entity="TECHNOLOGY",
                     c25="DEPRECIATION", c26="DEPRECIATION", tag="pe_depreciation_non_f1",
                     reason="All depreciation is excluded under ISS22 3.1(o).")
            self.add(posted=day, acct="7010", dept="FACILITIES", vendor=None, amount=int(19_500_000 * g), ccy="GBP",
                     memo=f"Depreciation - buildings & leasehold improvements - {self.ml(m)}", entity="TECHNOLOGY",
                     c25="DEPRECIATION", c26="DEPRECIATION", tag="property_depreciation", reason="Depreciation of Property: excluded.")
            self.add(posted=day, acct="7100", dept="CORP", vendor="ven-036", amount=money(rng, 175_000, 225_000), ccy="GBP",
                     memo=f"Interest - revolving credit facility - {self.ml(m)}", entity="TECHNOLOGY", c25="FINANCE_COSTS", c26="FINANCE_COSTS",
                     tag="interest", no_bill=True, reason="Finance Costs: excluded.")
            fx = money(rng, -60_000, 85_000)
            self.add(posted=day, acct="7110", dept="CORP", vendor=None, amount=fx, ccy="GBP",
                     memo=f"FX revaluation - EUR/USD payables & cash - {self.ml(m)}", entity="RACING", c25="FX", c26="FX",
                     tag="fx_reval", reason="Foreign exchange gains and losses: excluded.")
            # recharge from the parent (related party)
            low = self.year == 2025 and m in (5, 10)
            if self.year == 2025:
                amt, fvv = (52_000_000 if low else 65_000_000), 62_000_000
                fv_id = "fv-001"
            else:
                amt, fvv, fv_id = 66_500_000, 65_000_000, "fv-002"
            reason = (f"Related Party Transaction: invoiced {fmt_money('GBP', amt)} after a volume credit, below fair value "
                      f"{fmt_money('GBP', fvv)} ({fv_id}); included at fair value (4.1(a))." if low else
                      f"Related Party Transaction: invoiced {fmt_money('GBP', amt)} >= fair value {fmt_money('GBP', fvv)} ({fv_id}); included at contract.")
            self.add(posted=bday_on_or_after(date(self.year, m, 1) + timedelta(days=27)), acct="7400", dept="CORP", vendor="ven-003",
                     amount=amt, ccy="GBP", memo=f"Recharge - simulator & engineering services - {self.ml(m)}" + (" (volume credit applied)" if low else ""),
                     entity="RACING", c25="ADJ_RELATED_PARTY_FAIR_VALUE" if low else "RELEVANT", c26="RELEVANT", tag="recharge",
                     fv=(fv_id, fvv), reason=reason, erp="RELEVANT" if low else None, catch_p=1.0 if m == 5 else 0.0,
                     why=(f"the volume credit takes the invoice below fair value {fmt_money('GBP', fvv)} ({fv_id}); include at fair value "
                          f"(ADJ_RELATED_PARTY_FAIR_VALUE, uplift {fmt_money('GBP', fvv - amt)})") if low else "")
        # RDEC above-the-line credits (negative), R&D tax relief
        qs = {2025: [(4, 1), (7, 2), (10, 3), (12, 4)], 2026: [(7, 2), (10, 3)]}[self.year]
        for m, q in qs:
            amt = -money(rng, 1_150_000, 1_550_000)
            self.add(posted=month_end(self.year, m), acct="7300", dept="CORP", vendor=None, amount=amt, ccy="GBP",
                     memo=f"RDEC above-the-line credit - Q{q} {self.year} qualifying R&D expenditure", entity="TECHNOLOGY",
                     c25="RELEVANT", c26="ADJ_GRANT_GROSS_UP", tag="rdec",
                     reason="Government R&D incentive offsets the R&D costs it relates to (ISS22 4.1(b)(ii)): the credit stays in Relevant Costs as a reduction.")
        if self.year == 2025:
            self.add(posted=date(2025, 3, 31), acct="7500", dept="VD", vendor=None, amount=-8_500_000, ccy="GBP",
                     memo="Gain on disposal - 2019 seven-post rig sold at auction", entity="TECHNOLOGY", c25="DEPRECIATION", c26="ADJ_GRANT_GROSS_UP",
                     tag="disposal", escalate="first disposal of the year",
                     reason="Gain on disposal of tangible assets is excluded with depreciation under ISS22 3.1(o).")
            self.add(posted=date(2025, 9, 30), acct="7500", dept="MFG", vendor=None, amount=1_240_000, ccy="GBP",
                     memo="Loss on disposal - scrapped CMM probe head", entity="TECHNOLOGY", c25="DEPRECIATION", c26="DEPRECIATION",
                     tag="disposal", reason="Loss on disposal of tangible assets is excluded with depreciation under ISS22 3.1(o).")
            self.add(posted=date(2025, 6, 30), acct="7200", dept="CORP", vendor=None, amount=4_210_000, ccy="GBP",
                     memo="Corporation tax - prior year adjustment FY2023", entity="TECHNOLOGY", c25="CORP_TAX", c26="CORP_TAX",
                     tag="corp_tax", reason="Corporate Income Tax: excluded.")


# ---------------------------------------------------------------------------------------------
# 2025 history: ERP coding, cap classification, approvals log
# ---------------------------------------------------------------------------------------------
def resolve_erp(ln: Line, year: int, rng: random.Random) -> None:
    truth = ln.c25 if year == 2025 else ln.c26
    if ln.erp is not None:
        return
    if truth == "SPLIT":
        ln.erp = "NON_F1"
        return
    p = ln.conf_p if ln.conf_p is not None else (0.10 if year == 2025 else 0.03)
    if ln.confuse and rng.random() < p:
        c = rng.choice(ln.confuse)
        if isinstance(c, dict):
            ln.erp = c["erp"]
            ln.dept = c.get("dept", ln.dept)
            ln.acct = c.get("acct", ln.acct)
        else:
            ln.erp = c
    else:
        ln.erp = truth


def usd_text(minor: int) -> str:
    return f"${abs(minor) / 100:,.0f}"


def mix_canteen_invoices_2025(lines: list[Line], seed: int, n: int = 12) -> None:
    """Some 2025 weekly canteen invoices also bill a wind tunnel session lunch (both RELEVANT under ISS22)."""
    rng = random.Random(f"{seed}:2025:mixed_bills")
    pool = [ln for ln in lines if ln.tag == "canteen" and ln.memo.startswith("Factory canteen service") and ln.posted.month != 8]
    for ln in sorted(rng.sample(pool, n), key=lambda x: x.posted):
        lunch = money(rng, 1_700, 3_600)
        ln.bill_lines = [(ln.memo, ln.amount - lunch), (desc_tunnel_lunch(ln.posted - timedelta(days=rng.randint(1, 3))), lunch)]
        ln.bill_cats = [T_CANTEEN, T_TUNNEL]


def bill_parts_2025(ln: Line, rng: random.Random) -> list[tuple[str, int, tuple]]:
    """[(description, amount_minor, (c25, c26, reason_2025, note_2026))] for a 2025 line with a vendor."""
    own = (ln.c25, ln.c26, ln.reason, "")
    if ln.bill_lines:
        cats = ln.bill_cats or [own] * len(ln.bill_lines)
        return [(desc, amt, cat) for (desc, amt), cat in zip(ln.bill_lines, cats)]
    if rng.random() < 0.3 and abs(ln.amount) > 200_000:
        carriage = int(ln.amount * rng.uniform(0.015, 0.04))
        carry = (ln.c25, ln.c26, "Carriage, packaging and handling on the invoice follows the goods it delivers: " + ln.reason, "")
        return [(ln.memo, ln.amount - carriage, own), ("Carriage, packaging & handling", carriage, carry)]
    return [(ln.memo, ln.amount, own)]


def build_history(seed: int) -> dict[str, list[dict]]:
    gen = YearGen(seed, 2025)
    lines = gen.generate()
    mix_canteen_invoices_2025(lines, seed)
    order = random.Random(f"{seed}:2025:order")
    for ln in lines:
        ln.sort_key = order.random()
    lines.sort(key=lambda l: (l.posted, l.sort_key))
    erp_rng = random.Random(f"{seed}:2025:erp")
    rev_rng = random.Random(f"{seed}:2025:review")
    bill_rng = random.Random(f"{seed}:2025:bills")
    gl, cls, apr, bls, blc = [], [], [], [], []
    n_bill = 0
    for i, ln in enumerate(lines, start=1):
        resolve_erp(ln, 2025, erp_rng)
        gid = f"gl-2025-{i:05d}"
        period = ln.posted.strftime("%Y-%m")
        fx = C.fx_rate(ln.ccy, period)
        usd = to_usd(ln.amount, fx)
        ven = C.VENDORS.get(ln.vendor) if ln.vendor else None
        parts, bill_id = [], None
        if ln.vendor is not None and not ln.no_bill:
            assert ln.c25 != "SPLIT", ln.memo  # department-share splits are payroll journals, never bills
            n_bill += 1
            bill_id = f"bill-2025-{n_bill:05d}"
            parts = bill_parts_2025(ln, bill_rng)
        stamp = min(ln.posted + timedelta(days=rev_rng.randint(0, 2)), HISTORY_END).isoformat()
        gl.append({
            "id": gid, "source": "history_2025_gl_line", "posted_date": ln.posted.isoformat(), "period_key": period,
            "account_id": f"acct-{ln.acct}", "department_id": f"dept-{ln.dept}", "vendor_id": ln.vendor, "bill_id": bill_id,
            "amount_minor": ln.amount, "currency": ln.ccy, "fx_rate_to_usd": fx, "amount_usd_minor": usd, "memo": ln.memo,
            "erp_category_code": ln.erp, "entity": ln.entity, "correction_of": None, "visible_at": stamp, "updated_at": stamp,
        })
        # escalation (materiality, related party, first-of-kind)
        esc_reason = None
        if abs(usd) >= C.MATERIALITY_USD_MINOR:
            esc_reason = f"Escalated to Head of Cost Cap: {usd_text(usd)} >= $250,000 materiality."
        elif ven and ven["related_party"]:
            esc_reason = f"Escalated to Head of Cost Cap: related-party transaction with {ven['name']} ({ven['related_party_entity']})."
        elif ln.escalate:
            esc_reason = f"Escalated to Head of Cost Cap: {ln.escalate}."
        escalated = esc_reason is not None
        decided_by = "head_of_cost_cap" if escalated else "analyst"
        decided_on = min(ln.posted + timedelta(days=rev_rng.randint(3, 16)), HISTORY_END).isoformat()
        prefix = (esc_reason + " ") if escalated else "Below $250,000 and within analyst authority; controller review. "
        # categories of the line: one, or one per distinct bill-line category for a mixed invoice
        line_cats = list(dict.fromkeys(c[0] for c in ln.bill_cats)) if ln.bill_cats else [ln.c25]
        truth = line_cats[0] if len(line_cats) == 1 else "MIXED"
        by_cat = {c: sum(amt for (_, amt), t in zip(ln.bill_lines, ln.bill_cats) if t[0] == c) for c in line_cats} if ln.bill_cats else {}
        split_txt = ", ".join(f"{c} {fmt_money(ln.ccy, by_cat[c])}" for c in line_cats) if by_cat else ""
        wrong = (ln.erp != truth and truth != "SPLIT") or truth == "MIXED"
        if truth == "SPLIT":
            decision, a_reason = "approved", prefix + "ERP coded NON_F1 for the whole line; analyst split 60% RELEVANT / 40% NON_F1 by dept-APPLIED f1_activity_share 0.6. Approved."
        elif truth == "MIXED":
            why = ln.why or ln.reason.rstrip(".")
            if rev_rng.random() < ln.catch_p:
                decision = "approved"
                a_reason = prefix + f"ERP coded the whole invoice {ln.erp}; analyst split it by bill line ({split_txt}): {why}. Approved."
            else:
                decision = "rejected"
                a_reason = (prefix + f"Rejected analyst proposal {ln.erp} for the whole invoice (followed the ERP coding): {why}. "
                            f"Split by bill line: {split_txt}.")
        elif wrong:
            why = ln.why or ln.reason.rstrip(".")
            if rev_rng.random() < ln.catch_p:
                decision = "approved"
                a_reason = prefix + f"Analyst reclassified ERP coding {ln.erp} to {truth}: {why}. Approved."
            else:
                decision = "rejected"
                a_reason = prefix + f"Rejected analyst proposal {ln.erp} (followed the ERP coding): {why}. Reclassified {truth}."
        elif ln.fv is not None:
            decision = "approved"
            a_reason = prefix + ln.reason + " Approved."
        else:
            decision, a_reason = "approved", prefix + f"Approved {truth}."
        apr.append({
            "id": f"h25a-{i:05d}", "source": "history_2025_approval", "gl_line_id": gid, "amount_usd_minor": usd,
            "escalated_to": "head_of_cost_cap" if escalated else None, "decision": decision, "reason": a_reason,
            "decided_on": decided_on, "visible_at": decided_on, "updated_at": decided_on,
        })
        if truth == "SPLIT":
            share = C.DEPARTMENTS[ln.dept]["share"]
            for suffix, cat, txt in [("", "RELEVANT", f"{share:.0%} F1 Activities share retained in Relevant Costs (dept-APPLIED f1_activity_share {share})."),
                                     ("-nf1", "NON_F1", f"{1 - share:.0%} Non-F1 share excluded (dept-APPLIED f1_activity_share {share}, timesheet-supported).")]:
                cls.append({"id": f"h25c-{i:05d}{suffix}", "source": "history_2025_cap_classification", "gl_line_id": gid,
                            "category_code": cat, "rulebook_entry_id": f"{cat}@{V25}", "decided_by": decided_by,
                            "reason": "Applied Technologies payroll split by department share: " + txt,
                            "visible_at": decided_on, "updated_at": decided_on})
        elif truth == "MIXED":
            for k, cat in enumerate(line_cats, start=1):
                cls.append({"id": f"h25c-{i:05d}" + ("" if k == 1 else f"-{k}"), "source": "history_2025_cap_classification",
                            "gl_line_id": gid, "category_code": cat, "rulebook_entry_id": f"{cat}@{V25}", "decided_by": decided_by,
                            "reason": f"Mixed invoice split by bill line: {cat} {fmt_money(ln.ccy, by_cat[cat])} of {fmt_money(ln.ccy, ln.amount)} "
                                      f"(see history_2025_bill_line_classification). (ERP coded {ln.erp} for the whole invoice; split.)",
                            "visible_at": decided_on, "updated_at": decided_on})
        else:
            reason = ln.reason
            if wrong:
                reason += f" (ERP coded {ln.erp}; reclassified.)"
            cls.append({"id": f"h25c-{i:05d}", "source": "history_2025_cap_classification", "gl_line_id": gid,
                        "category_code": truth, "rulebook_entry_id": f"{truth}@{V25}", "decided_by": decided_by,
                        "reason": reason, "visible_at": decided_on, "updated_at": decided_on})
        for k, (desc, amt, cat) in enumerate(parts, start=1):
            blid = f"bl-2025-{n_bill:05d}-{k}"
            bls.append({"id": blid, "source": "history_2025_bill_line", "bill_id": bill_id, "gl_line_id": gid, "line_no": k,
                        "description": desc, "amount_minor": amt, "visible_at": stamp, "updated_at": stamp})
            blc.append({"id": f"h25bc-{n_bill:05d}-{k}", "source": "history_2025_bill_line_classification", "bill_line_id": blid,
                        "gl_line_id": gid, "category_code": cat[0], "rulebook_entry_id": f"{cat[0]}@{V25}", "amount_minor": amt,
                        "decided_by": decided_by, "reason": cat[2], "visible_at": decided_on, "updated_at": decided_on})
    return {"history_2025_gl_line": gl, "history_2025_cap_classification": cls, "history_2025_approval": apr,
            "history_2025_bill_line": bls, "history_2025_bill_line_classification": blc}


# ---------------------------------------------------------------------------------------------
# 2026 stream
# ---------------------------------------------------------------------------------------------
class Stream:
    """The 2026 stream under construction: base lines + plants, then rendered to records."""

    def __init__(self, seed: int):
        self.seed = seed
        self.gen = YearGen(seed, 2026)
        self.lines: list[Line] = self.gen.generate()
        self.answer_rows: list[dict] = []
        self.extra_bills: list[Bill] = []

    def rng(self, name: str) -> random.Random:
        return random.Random(f"{self.seed}:2026:{name}")

    def add(self, **kw) -> Line:
        ln = Line(**kw)
        self.lines.append(ln)
        return ln

    def answer(self, plant_id: str, ref: Any, error_class: str, action: str, category: str, note: str,
               source: str = "gl_line", note_refs: list | None = None):
        self.answer_rows.append({"plant_id": plant_id, "source": source, "ref": ref, "error_class": error_class,
                                 "expected_action": action, "expected_category_code": category, "note": note,
                                 "note_refs": note_refs or []})

    # -- visibility, corrections -----------------------------------------------------------
    def apply_visibility(self):
        rng = self.rng("visibility")
        for ln in self.lines:
            if ln.visible is None:
                if ln.vendor is None or ln.no_bill:
                    ln.visible = ln.posted
                else:
                    r = rng.random()
                    lag = 0 if r < 0.55 else 1 if r < 0.80 else rng.randint(2, 4) if r < 0.94 else rng.randint(10, 24)
                    ln.visible = ln.posted + timedelta(days=lag)
            if ln.emissions is None:
                ln.emissions = [(ln.visible, {})]

    def apply_corrections(self):
        """ERP corrections: re-emitted lines (same id, later cursor) and reversal/repost pairs."""
        rng = self.rng("corrections")
        pool = [ln for ln in self.lines if ln.plant is None and ln.vendor is not None and not ln.no_bill
                and ln.acct in ("6010", "6020", "6030", "6040", "6200", "6300", "6310", "6320", "6500", "6600", "6720")
                and ln.posted <= date(2026, 10, 31)]
        rng.shuffle(pool)
        picked = pool[:40]
        recode = {"6020": "6040", "6040": "6020", "6030": "6020", "6010": "6040", "6310": "6320", "6320": "6310"}
        for k, ln in enumerate(picked[:30]):
            ln.emissions = None
            first = ln.visible or ln.posted
            later = first + timedelta(days=rng.randint(6, 35))
            if k < 19 or ln.acct not in recode:
                wrong = ln.amount + (rng.choice([-1, 1]) * int(ln.amount * rng.uniform(0.04, 0.18)))
                if k % 4 == 0:  # transposed digits
                    s = str(ln.amount)
                    if len(s) > 4 and s[-4] != s[-5]:
                        wrong = int(s[:-5] + s[-4] + s[-5] + s[-3:])
                ln.emissions = [(first, {"amount": wrong}), (later, {})]
                ln.note = (ln.note + " " if ln.note else "") + "re-emitted: amount corrected to match the bill"
            else:
                ln.emissions = [(first, {"acct": recode[ln.acct]}), (later, {})]
                ln.note = (ln.note + " " if ln.note else "") + "re-emitted: account recoded"
        for ln in picked[30:40]:
            # reversal + repost under new ids, both pointing at the original
            day = bday_on_or_after(ln.posted + timedelta(days=rng.randint(8, 24)))
            if day > STREAM_END:
                continue
            new_dept = {"MFG": "CHASSIS", "CHASSIS": "MFG", "AERO": "CHASSIS", "VD": "RACEOPS", "RACEOPS": "VD"}.get(ln.dept, ln.dept)
            common = dict(posted=day, acct=ln.acct, vendor=ln.vendor, ccy=ln.ccy, entity=ln.entity, c25=ln.c25, c26=ln.c26,
                          no_bill=True, bill_of=ln, correction_of=ln, erp=ln.erp, visible=day)
            self.add(dept=ln.dept, amount=-ln.amount, memo="Reversal of {ref}: posted to wrong cost centre", tag="reversal", **common)
            self.add(dept=new_dept, amount=ln.amount, memo=ln.memo + " (re-posted to correct cost centre, ref {ref})", tag="repost", **common)

    # -- ids --------------------------------------------------------------------------------
    def assign_ids(self):
        order = self.rng("order")
        for ln in self.lines:
            ln.sort_key = order.random() if ln.prio else 0.0
        self.lines.sort(key=lambda l: (l.posted, l.prio, l.sort_key))
        for i, ln in enumerate(self.lines, start=1):
            ln.num, ln.id = i, f"gl-{i:06d}"

    def build_bills(self):
        rng = self.rng("bills")
        bills: list[Bill] = []
        for ln in self.lines:
            if ln.vendor is None or ln.no_bill:
                continue
            ven = C.VENDORS[ln.vendor]
            bdate = ln.bill_date or bday_on_or_before(ln.posted - timedelta(days=rng.choice([0, 0, 1, 2, 3])))
            due = bdate + timedelta(days=ven["terms"])
            if ln.bill_lines:
                parts = [(desc, amt, ln) for desc, amt in ln.bill_lines]
                if ln.keep_bill_draw and rng.random() < 0.3 and abs(ln.amount) > 200_000:
                    rng.uniform(0.015, 0.04)  # the draws this line made before it was given bill lines
            elif rng.random() < 0.3 and abs(ln.amount) > 200_000:
                carriage = int(ln.amount * rng.uniform(0.015, 0.04))
                parts = [(ln.memo, ln.amount - carriage, ln), ("Carriage, packaging & handling", carriage, ln)]
            else:
                parts = [(ln.memo, ln.amount, ln)]
            b = Bill(vendor=ln.vendor, bill_date=bdate, due=due, ccy=ln.ccy, iban=ln.bill_iban or ven["bank_iban"], inv_no=ln.inv_no or "",
                     lines=parts, visible=ln.emissions[0][0], note=ln.bill_note, hold=ln.hold_payment, prio=ln.prio, sort_key=ln.sort_key)
            ln.bill = b
            bills.append(b)
        bills.sort(key=lambda b: (b.visible, b.prio, b.sort_key))
        seq: dict[str, int] = {}
        used = {b.inv_no for b in bills if b.inv_no}
        for i, b in enumerate(bills, start=1):
            b.num = i
            if not b.inv_no:
                ven = C.VENDORS[b.vendor]
                while True:
                    seq[b.vendor] = seq.get(b.vendor, 0) + 1
                    cand = f"{ven['inv_prefix']}-{b.bill_date.year % 100}-{seq[b.vendor]:04d}"
                    if cand not in used:
                        break
                b.inv_no = cand
                used.add(cand)
        for ln in self.lines:
            if ln.bill_of is not None:
                ln.bill = ln.bill_of.bill
        self.bills = bills

    # -- render -----------------------------------------------------------------------------
    def state(self, ln: Line, overrides: dict) -> dict:
        s = {"posted": ln.posted, "acct": ln.acct, "dept": ln.dept, "amount": ln.amount, "memo": ln.memo, "erp": ln.erp}
        s.update(overrides)
        return s

    def render_gl(self, ln: Line) -> list[dict]:
        out = []
        ref = ln.correction_of.id if ln.correction_of else ""
        for vis, ov in ln.emissions:
            s = self.state(ln, ov)
            period = s["posted"].strftime("%Y-%m")
            fx = C.fx_rate(ln.ccy, period)
            out.append({
                "id": ln.id, "source": "gl_line", "posted_date": s["posted"].isoformat(), "period_key": period,
                "account_id": f"acct-{s['acct']}", "department_id": f"dept-{s['dept']}", "vendor_id": ln.vendor,
                "bill_id": ln.bill.id if ln.bill else None, "amount_minor": s["amount"], "currency": ln.ccy, "fx_rate_to_usd": fx,
                "amount_usd_minor": to_usd(s["amount"], fx), "memo": s["memo"].replace("{ref}", ref), "erp_category_code": s["erp"],
                "entity": ln.entity, "correction_of": ref or None, "visible_at": vis.isoformat(), "updated_at": vis.isoformat(),
                "_prio": ln.prio, "_key": ln.sort_key,
            })
        return out

    def bill_text(self, b: Bill) -> str:
        ven = C.VENDORS[b.vendor]
        ent = C.ENTITIES[b.lines[0][2].entity]["legal_name"]
        rows = [ven["name"].upper(), ven["address"], f"VAT reg {ven['country']} {abs(hash_int(ven['id'])) % 10**9:09d}" if ven["country"] in ("GB",) else ven["country"],
                f"INVOICE {b.inv_no}", f"Invoice date: {b.bill_date.isoformat()}    Due date: {b.due.isoformat()}",
                f"Bill to: {ent}, Camp Road, Upper Heyford OX25 5HD", "-" * 48]
        for k, (desc, amt, _) in enumerate(b.lines, start=1):
            rows.append(f"{k:>2}  {desc}  {fmt_money(b.ccy, amt)}")
        rows += ["-" * 48, f"Total (net of recoverable VAT): {fmt_money(b.ccy, b.total)}"]
        if b.note:
            rows.append(b.note)
        rows.append(f"Remit to IBAN {b.iban}  ref {b.inv_no}")
        return "\n".join(rows)

    def render(self) -> dict[str, list[dict]]:
        gl = [rec for ln in self.lines for rec in self.render_gl(ln)]
        bills, bl = [], []
        for b in self.bills:
            v = b.visible.isoformat()
            bills.append({"id": b.id, "source": "bill", "vendor_id": b.vendor, "bill_date": b.bill_date.isoformat(), "due_date": b.due.isoformat(),
                          "total_minor": b.total, "currency": b.ccy, "bank_iban_on_bill": b.iban, "text": self.bill_text(b),
                          "visible_at": v, "updated_at": v, "_prio": b.prio, "_key": b.sort_key})
            for k, (desc, amt, ln) in enumerate(b.lines, start=1):
                bl.append({"id": f"bl-{b.num:05d}-{k}", "source": "bill_line", "bill_id": b.id, "gl_line_id": ln.id, "line_no": k,
                           "description": desc, "amount_minor": amt, "visible_at": v, "updated_at": v, "_prio": b.prio, "_key": b.sort_key})
        return {"gl_line": gl, "bill": bills, "bill_line": bl, "bank_txn": self.render_bank()}

    def render_bank(self) -> list[dict]:
        rng = self.rng("bank")
        txns = []
        for b in self.bills:
            if b.hold:
                continue
            booked = bday_on_or_after(b.due if b.due > b.bill_date else b.bill_date + timedelta(days=1))
            if booked > STREAM_END:
                continue
            ven = C.VENDORS[b.vendor]
            rail = {"GBP": "BACS", "EUR": "SEPA", "USD": "SWIFT"}[b.ccy]
            txns.append((booked, {"amount_minor": -b.total, "currency": b.ccy, "counterparty": ven["name"].upper()[:32],
                                  "memo": f"{rail} PAYMENT {b.inv_no} TO {b.iban[:4]}****{b.iban[-4:]}", "matched_bill_id": b.id}))
        payroll: dict[int, int] = {}
        for ln in self.lines:
            if ln.acct in ("5010", "5100") and ln.vendor is None:
                payroll[ln.posted.month] = payroll.get(ln.posted.month, 0) + ln.amount
        for m in sorted(payroll):
            day = payroll_day(2026, m)
            txns.append((day, {"amount_minor": -int(payroll[m] * 0.71), "currency": "GBP", "counterparty": "KESTREL TECHNOLOGY LTD PAYROLL",
                               "memo": f"BACS NET PAY {MONTHS[m - 1].upper()} 2026", "matched_bill_id": None}))
            hm = bday_on_or_after(date(2026, m, 22))
            txns.append((hm, {"amount_minor": -int(payroll.get(m - 1, payroll[m]) * 0.42), "currency": "GBP", "counterparty": "HMRC CUMBERNAULD",
                              "memo": f"PAYE/NIC {MONTHS[(m - 2) % 12].upper()} 2026", "matched_bill_id": None}))
        for ln in self.lines:
            if ln.acct == "7100":
                txns.append((ln.posted, {"amount_minor": -ln.amount, "currency": "GBP", "counterparty": "OXFORD & COUNTY BANK PLC",
                                         "memo": f"INTEREST RCF {ln.posted.strftime('%b %Y').upper()}", "matched_bill_id": None}))
        keyed = [(day, rng.random(), t) for day, t in txns]
        keyed.sort(key=lambda x: (x[0], x[1]))
        out = []
        for i, (day, _, t) in enumerate(keyed, start=1):
            v = day.isoformat()
            out.append({"id": f"bank-{i:06d}", "source": "bank_txn", "booked_date": v, **t, "visible_at": v, "updated_at": v})
        return out

    # -- truth -------------------------------------------------------------------------------
    def final_amounts(self, ln: Line) -> tuple[int, float, int, str]:
        final = self.state(ln, ln.emissions[-1][1])
        period = final["posted"].strftime("%Y-%m")
        fx = C.fx_rate(ln.ccy, period)
        return final["amount"], fx, to_usd(final["amount"], fx), period

    def allocations(self, ln: Line) -> list[dict] | None:
        """The correct 2026 split of a line, in USD minor units summing exactly to the line's amount_usd_minor.

        bill_line: one allocation per bill line of a mixed invoice (SCHEMA 11.1). cap_limit / cap_limit_excess: the
        part within a category limit and the Relevant excess over it. share: department-share apportionment."""
        amount, fx, usd, _ = self.final_amounts(ln)
        rows: list[dict] = []
        if ln.bill_cats is not None:
            for k, ((desc, amt), cat) in enumerate(zip(ln.bill_lines, ln.bill_cats), start=1):
                blid = f"bl-{ln.bill.num:05d}-{k}"
                rows.append({"bill_line_id": blid, "basis": "bill_line", "basis_ref": blid, "category_code": cat[1],
                             "amount_usd_minor": to_usd(amt, fx), "note": f"bill line {k}: {cat[3]}"})
        elif ln.limit_cat is not None:
            for cat, amt, rel, note in ln.truth:
                if cat == "RELEVANT":
                    rows.append({"bill_line_id": "", "basis": "cap_limit_excess", "basis_ref": ln.limit_cat, "category_code": "RELEVANT",
                                 "amount_usd_minor": rel, "note": note})
                else:
                    rows.append({"bill_line_id": "", "basis": "cap_limit", "basis_ref": ln.limit_cat, "category_code": cat,
                                 "amount_usd_minor": None, "note": note})
            within = usd - sum(r["amount_usd_minor"] for r in rows if r["amount_usd_minor"] is not None)
            for r in rows:
                if r["amount_usd_minor"] is None:
                    r["amount_usd_minor"] = within
        elif ln.c26 == "SPLIT":
            share = C.DEPARTMENTS[self.state(ln, ln.emissions[-1][1])["dept"]]["share"]
            rel = to_usd(int(round(amount * share)), fx)
            dep = f"dept-{ln.dept}"
            rows = [{"bill_line_id": "", "basis": "share", "basis_ref": f"{dep}:{share}", "category_code": "RELEVANT", "amount_usd_minor": rel,
                     "note": f"F1 share {share}"},
                    {"bill_line_id": "", "basis": "share", "basis_ref": f"{dep}:{round(1 - share, 6)}", "category_code": "NON_F1",
                     "amount_usd_minor": usd - rel, "note": f"Non-F1 share {round(1 - share, 6)}"}]
        else:
            return None
        if ln.bill_cats is not None:  # rounding residue on the largest allocation, so the split ties to the ledger exactly
            big = max(rows, key=lambda r: abs(r["amount_usd_minor"]))
            big["amount_usd_minor"] += usd - sum(r["amount_usd_minor"] for r in rows)
        assert sum(r["amount_usd_minor"] for r in rows) == usd, ln.memo
        for r in rows:
            r.update({"gl_line_id": ln.id, "rulebook_entry_id": f"{r['category_code']}@{V26}", "plant_id": ln.plant or ""})
        return rows

    def truth_rows(self, ln: Line) -> list[dict]:
        amount, fx, usd, period = self.final_amounts(ln)
        rows = []
        if ln.bill_cats is not None:
            for (desc, amt), cat, al in zip(ln.bill_lines, ln.bill_cats, self.allocations(ln)):
                rows.append((cat[1], V26, amt, al["amount_usd_minor"] if cat[1] == "RELEVANT" else 0, al["note"]))
        elif ln.truth is not None:
            for cat, amt, rel, note in ln.truth:
                ver = V25 if cat.endswith("@ISS22") else V26
                cat = cat.split("@")[0]
                rows.append((cat, ver, amt, to_usd(amt, fx) if rel is None and cat == "RELEVANT" else (rel or 0), note))
        elif ln.c26 == "SPLIT":
            share = C.DEPARTMENTS[self.state(ln, ln.emissions[-1][1])["dept"]]["share"]
            rel_amt = int(round(amount * share))
            rows.append(("RELEVANT", V26, rel_amt, to_usd(rel_amt, fx), f"split by f1_activity_share {share}"))
            rows.append(("NON_F1", V26, amount - rel_amt, 0, f"split by f1_activity_share {share}"))
        else:
            cat = ln.c26
            rel = 0
            if cat in ("RELEVANT", "ADJ_USED_INVENTORY"):
                rel = usd
            elif cat == "ADJ_RELATED_PARTY_FAIR_VALUE":
                rel = to_usd(max(amount, ln.fv[1]), fx)
            rows.append((cat, V26, amount, rel, ln.note))
        return [{"gl_line_id": ln.id, "category_code": c, "rulebook_entry_id": f"{c}@{v}", "amount_minor": a,
                 "relevant_usd_minor": r, "period_key": period, "plant_id": ln.plant or "", "note": n} for c, v, a, r, n in rows]


def hash_int(s: str) -> int:
    h = 0
    for ch in s:
        h = (h * 131 + ord(ch)) % (2**61 - 1)
    return h


# ---------------------------------------------------------------------------------------------
# reference sources
# ---------------------------------------------------------------------------------------------
def reference_records() -> dict[str, list[dict]]:
    v = REFERENCE_VISIBLE
    accounts = [{"id": f"acct-{a['code']}", "source": "account", "code": a["code"], "name": a["name"], "default_category_code": a["default"],
                 "kind": a["kind"], "visible_at": v, "updated_at": v} for a in C.ACCOUNT.values()]
    depts = [{"id": f"dept-{k}", "source": "department", "name": d_["name"], "head": d_["head"], "f1_activity_share": d_["share"],
              "visible_at": v, "updated_at": v} for k, d_ in C.DEPARTMENTS.items()]
    vendors = [{"id": x["id"], "source": "vendor", "name": x["name"], "country": x["country"], "related_party": x["related_party"],
                "related_party_entity": x["related_party_entity"], "bank_iban": x["bank_iban"], "category_hint": x["category_hint"],
                "visible_at": v, "updated_at": v} for x in C.VENDORS.values()]
    contracts = [{"id": c["id"], "source": "contract", "counterparty_vendor_id": c["counterparty_vendor_id"], "kind": c["kind"],
                  "start": c["start"], "end": c["end"], "terms": c["terms"], "visible_at": v, "updated_at": v} for c in C.CONTRACTS]
    fvs = [{**{k: f[k] for k in ("id",)}, "source": "fair_value", **{k: f[k] for k in f if k != "id"}, "visible_at": v, "updated_at": v}
           for f in C.FAIR_VALUES]
    for when, f in C.FAIR_VALUES_2026_UPDATES:
        fvs.append({"id": f["id"], "source": "fair_value", **{k: f[k] for k in f if k != "id"}, "visible_at": when, "updated_at": when})
    issues = [
        {"id": "ISS22", "source": "rulebook_issue", "published_on": "2024-12-11", "effective_from": "2021-01-01",
         "path": "rulebook/rulebook.json", "visible_at": "2024-12-11", "updated_at": "2024-12-11"},
        # The 2026 Financial Regulations were published in earlier issues before the season and are
        # known from day one. rulebook.json carries Issue 07 (25 June 2026), the latest text we have,
        # so the record keeps Issue 07's real date as published_on but is visible before 2026 starts.
        {"id": "SECD-ISS07", "source": "rulebook_issue", "published_on": "2026-06-25", "effective_from": "2026-01-01",
         "path": "rulebook/rulebook.json", "visible_at": "2025-12-01", "updated_at": "2025-12-01"},
    ]
    return {"account": accounts, "department": depts, "vendor": vendors, "contract": contracts, "fair_value": fvs, "rulebook_issue": issues}


# ---------------------------------------------------------------------------------------------
# build + write
# ---------------------------------------------------------------------------------------------
def build(seed: int) -> dict:
    from . import plants

    out = reference_records()
    out.update(build_history(seed))
    st = Stream(seed)
    erp_rng = st.rng("erp")
    plants.plant_all(st)
    for ln in st.lines:
        resolve_erp(ln, 2026, erp_rng)
    st.lines = [ln for ln in st.lines if ln.posted <= STREAM_END]
    st.apply_visibility()
    st.apply_corrections()
    st.apply_visibility()
    for ln in st.lines:
        if ln.erp is None:
            resolve_erp(ln, 2026, erp_rng)
    st.assign_ids()
    st.build_bills()
    out.update(st.render())
    truth = [row for ln in st.lines for row in st.truth_rows(ln)]
    allocations = [row for ln in st.lines for row in (st.allocations(ln) or [])]
    answers = []
    for r in st.answer_rows:
        ref = r["ref"]
        if r["source"] == "gl_line":
            rid = ref.id
        elif r["source"] == "bill_line":
            ln, k = ref
            rid = f"bl-{ln.bill.num:05d}-{k}"
        elif r["source"] == "bill":
            rid = ref[0].bill.id
        else:
            rid = ref
        note = r["note"].format(*[x.id for x in r["note_refs"]]) if r["note_refs"] else r["note"]
        answers.append({"plant_id": r["plant_id"], "source": r["source"], "record_id": rid, "error_class": r["error_class"],
                        "expected_action": r["expected_action"], "expected_category_code": r["expected_category_code"], "note": note})
    return {"records": out, "answer_key": answers, "truth": truth, "allocations": allocations}


def ordered(records: list[dict]) -> list[dict]:
    """File order == cursor order: by visible_at (stable), demo/priority rows first within a day."""
    keyed = sorted(enumerate(records), key=lambda ir: (ir[1]["visible_at"], ir[1].get("_prio", 1), ir[1].get("_key", 0.0), ir[0]))
    out = []
    for _, r in keyed:
        out.append({k: v for k, v in r.items() if not k.startswith("_")})
    return out


def write(result: dict, out_dir: Path) -> dict[str, int]:
    out_dir.mkdir(parents=True, exist_ok=True)
    counts = {}
    for src in SOURCES:
        recs = ordered(result["records"][src])
        with (out_dir / f"{src}.jsonl").open("w", encoding="utf-8", newline="\n") as f:
            for r in recs:
                f.write(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n")
        counts[src] = len(recs)
    cols = ["plant_id", "source", "record_id", "error_class", "expected_action", "expected_category_code", "note"]
    with (out_dir / "answer_key.csv").open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, lineterminator="\n")
        w.writeheader()
        w.writerows(result["answer_key"])
    tcols = ["gl_line_id", "category_code", "rulebook_entry_id", "amount_minor", "relevant_usd_minor", "period_key", "plant_id", "note"]
    with (out_dir / "truth_2026.csv").open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=tcols, lineterminator="\n")
        w.writeheader()
        w.writerows(result["truth"])
    acols = ["gl_line_id", "bill_line_id", "basis", "basis_ref", "category_code", "rulebook_entry_id", "amount_usd_minor", "plant_id", "note"]
    with (out_dir / "truth_2026_allocations.csv").open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=acols, lineterminator="\n")
        w.writeheader()
        w.writerows(result["allocations"])
    counts["answer_key"] = len(result["answer_key"])
    counts["truth_2026_allocations"] = len(result["allocations"])
    return counts


def summary(result: dict) -> str:
    truth = result["truth"]
    by_month: dict[str, int] = {}
    for t in truth:
        by_month[t["period_key"]] = by_month.get(t["period_key"], 0) + int(t["relevant_usd_minor"])
    total = sum(by_month.values())
    lines = [f"2026 Relevant Costs Jan-Nov (truth): ${total / 1e8:,.1f}m of $215.0m cap"]
    lines.append("  " + "  ".join(f"{k[5:]}:{v / 1e8:.1f}" for k, v in sorted(by_month.items())))
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Generate the Meridian Racing systems of record.")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", type=Path, default=Path("world/out"))
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)
    result = build(args.seed)
    counts = write(result, args.out)
    if not args.quiet:
        for k, v in counts.items():
            print(f"{k:34s} {v:6d}")
        print(summary(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
