"""The FIA cost cap rules a season forecast needs, exactly as written, with their article numbers.

Only what the regulations actually say lives here. Everything the regulations leave open (fine amounts,
size of a points deduction, how much a testing restriction costs in lap time) is NOT here: see
capsim/assumptions.py, where each such number is labelled as an assumption with its basis.

Sources (extracted text in research/fia/ on the cost-cap-desk branch):
- 2026 F1 Regulations, Section D [Financial - F1 Teams], Issue 08, 1 Oct 2026 (WMSC 30 Sep 2026)
  https://www.fia.com/system/files/documents/fia_2026_f1_regulations_-_section_d_financial_-_f1_teams_-_iss_08_-_2026-10-01.pdf
- FIA Formula 1 Financial Regulations, Issue 22, 11 Dec 2024 (the 2021-2025 regime; its cap text covers FY2024 and FY2025)
  https://api.fia.com/sites/default/files/fia_formula_1_financial_regulations_-_issue_22_-_2024-12-11.pdf
- 2026 F1 Regulations, Section A [General Regulatory Provisions], Issue 02 (sanctioning factors, A7.12)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal


@dataclass(frozen=True)
class Provision:
    article: str
    says: str  # plain-English summary
    quote: str  # verbatim fragment of the regulation text (whitespace-normalised)
    source: str = "SECD-ISS08"


@dataclass(frozen=True)
class RuleSet:
    rule_set: str
    years: tuple[int, int]
    base_cap: int  # USD
    competition_threshold: int
    per_competition: int  # USD per Competition above (and, for ISS22, below) the threshold
    cap_falls_with_fewer_competitions: bool
    sprint_free: int  # sprints with no adjustment
    per_sprint: int  # USD downward adjustment to Relevant Costs per sprint above sprint_free
    material_pct: Decimal  # overspend at or above this share of the cap is material
    unused_carry_max: int  # USD; 0 if not available
    unused_carry_from: int | None  # first period the carry-forward can be used
    indexation_from: int | None  # first period Indexation applies
    provisions: dict[str, Provision] = field(default_factory=dict)


SECD_ISS08 = RuleSet(
    rule_set="SECD-ISS08", years=(2026, 2030), base_cap=215_000_000, competition_threshold=24, per_competition=1_800_000,
    cap_falls_with_fewer_competitions=False, sprint_free=6, per_sprint=300_000, material_pct=Decimal("0.02"),
    unused_carry_max=2_000_000, unused_carry_from=2027, indexation_from=2027,
    provisions={
        "cap": Provision("D4.1.2.a", "With 24 Competitions or fewer, the Cost Cap is USD 215m (plus Indexation, which is defined only from FY2027).",
                         "24 Competitions or fewer take place in the Full Year Financial Regulations Reporting Period, US Dollars 215,000,000 adjusted, if applicable, for Indexation"),
        "cap_extra_races": Provision("D4.1.2.b", "Each Competition above 24 adds USD 1.8m to the cap.",
                                     "1,800,000 multiplied by \"X\", where \"X\" is equal to the number of Competitions taking place in that Full Year Financial Regulations Reporting Period minus 24"),
        "sprint": Provision("D6.1.1.p", "Each sprint beyond six gives a USD 300,000 downward adjustment to Relevant Costs.",
                            "In the event that more than 6 Sprint take place during Competitions in the Full Year Financial Regulations Reporting Period"),
        "tyre_tests": Provision("D6.1.1.i", "Each Pirelli tyre test day gives a downward adjustment of an amount the Cost Cap Administration sets by Determination.",
                                "equal to the amount communicated by the Cost Cap Administration via a Determination"),
        "pu_integration": Provision("D6.1.1.q.i-ii", "Mandatory USD 3m downward adjustment across 2026 and 2027 (2027/2028 PU updates and integration), split as the "
                                    "team chooses and declared by 30 Nov 2026. If not declared, the split is 1.5m/1.5m (draft Determination text in the article).",
                                    "equal to a total amount in aggregate across both Full Year Financial Regulations Reporting Periods of US Dollars 3,000,000"),
        "pu_integration_default": Provision("D6.1.1.q.ii (Determination content)", "Undeclared allocation defaults to an equal 50:50 split and cannot be amended later.",
                                            "then the downward adjustment must be allocated in an equal 50:50 split"),
        "pu_integration_2": Provision("D6.1.1.q.iii-iv", "A second mandatory USD 3m across 2027 and 2028, declared by 30 Nov 2027.",
                                      "in respect of the Full Year Financial Regulations Reporting Period ending on 31 December 2027 and the Full Year Financial Regulations Reporting Period ending on 31 December 2028"),
        "unused_carry": Provision("D6.1.1.n", "From FY2027 a team may choose to reduce Relevant Costs by the unused part of the previous year's cap (as reassessed), up to USD 2m adjusted for Indexation.",
                                  "subject to a maximum amount of US Dollars 2,000,000, adjusted for Indexation"),
        "unused_definition": Provision("Appendix D1, Unused Cost Cap Amount", "Prior-year cap minus reassessed Relevant Costs; zero if the CCA review or an investigation is not finished by 30 November.",
                                       "The Unused Cost Cap Amount will be equal to zero in all cases where the Cost Cap Administration"),
        "minor": Provision("D10.3.1", "Reported or determined Relevant Costs above the cap by less than 2% is a Minor Overspend Breach.",
                           "exceed the Cost Cap by less than 2%"),
        "minor_sanction": Provision("D10.3.2", "Minor overspend: a Financial Penalty and any other appropriate Minor Sporting Penalties.",
                                    "shall impose a Financial Penalty and any other appropriate Minor Sporting Penalties"),
        "material": Provision("D10.3.3", "Above the cap by 2% or more is a Material Overspend Breach.", "exceed the Cost Cap by 2% or more"),
        "material_sanction": Provision("D10.3.4", "Material overspend: a mandatory Constructors' points deduction, plus a Financial Penalty and any other appropriate Material Sporting Penalties.",
                                       "shall impose a Constructors' Championship points deduction in accordance with Article D12.1.1.c.i and additionally shall impose a Financial Penalty"),
        "fine_case_by_case": Provision("D12.1.1.a", "Fines have no fixed scale: the amount is set case by case.",
                                       "a fine in an amount to be determined on a case by case basis"),
        "enhanced_monitoring": Provision("D12.2.1", "The Adjudication Panel may add enhanced monitoring to any sanction.",
                                         "the Cost Cap Adjudication Panel has the power to impose enhanced monitoring in respect of an F1 Team"),
        "points_year": Provision("D12.1.1.c.i", "A points deduction applies to the Championship of the year in which the breach happened.",
                                 "deduction of Constructors' Championship points awarded for the Championship that took place within the Financial Regulations Reporting Period of the breach"),
        "cap_reduction": Provision("D12.1.1.b.vi", "A cap reduction applies to the full year immediately after the sanction is imposed, and to later years where applicable (D12.1.1.b.vi, c.vii).",
                                   "reduction of the Cost Cap, provided that this sanction shall be applied only with respect to the Full Year Financial Regulations Reporting Period immediately following the date of the imposition of the sanction"),
        "fines_excluded": Provision("D5.1.1.m", "FIA fines are Excluded Costs: paying one does not use up cap.",
                                    "all Financial Penalties in respect of any breach of the Section D: Financial Regulations (F1 Teams)"),
        "fine_payment": Provision("D12.5.1", "Fines are payable within 30 days of the decision (suspended on appeal).",
                                  "Payment of all fines under these Financial Regulations shall be made within 30 days of the date of the relevant decision"),
        "factors": Provision("A7.12.7", "Aggravating: failure to cooperate, bad faith or concealment, prior or multiple breaches, size of the overspend. Mitigating: voluntary disclosure, track record of compliance, Force Majeure, full cooperation.",
                             "voluntary disclosure of a breach to the FIA", source="SECA-ISS02"),
    },
)

ISS22 = RuleSet(
    rule_set="ISS22", years=(2024, 2025), base_cap=135_000_000, competition_threshold=21, per_competition=1_800_000,
    cap_falls_with_fewer_competitions=True, sprint_free=0, per_sprint=300_000, material_pct=Decimal("0.05"),
    unused_carry_max=0, unused_carry_from=None, indexation_from=2024,
    provisions={
        "cap": Provision("2.3(a)", "USD 135m for 21 Competitions (FY2024 and FY2025 under Issue 22), adjusted for Indexation; USD 1.8m less per race below 21, more per race "
                         "above. A race cancelled less than three months before it was due counts as having taken place.",
                         "in the event that 21 Competitions take place in that Full Year Reporting Period, US Dollars 135,000,000", source="ISS22"),
        "minor": Provision("8.10", "Under 5% over the cap was a Minor Overspend Breach (2021-2025).", "exceed the Cost Cap by less than 5%", source="ISS22"),
        "material": Provision("8.12", "5% or more over the cap was a Material Overspend Breach (2021-2025).", "exceed the Cost Cap by 5% or more", source="ISS22"),
        "late_cancellation": Provision("2.3", "A Competition cancelled less than three months before its start is deemed to have taken place.",
                                       "such Competition shall be deemed to have taken place", source="ISS22"),
        "minor_sanction": Provision("8.11", "Minor overspend: the panel MAY impose a Financial Penalty and/or Minor Sporting Penalties.",
                                    "the Cost Cap Adjudication Panel may impose a Financial Penalty", source="ISS22"),
    },
)

RULES = {y: SECD_ISS08 for y in range(2026, 2031)}
PU_INTEGRATION_MAX = {2026: 3_000_000, 2027: 6_000_000, 2028: 3_000_000}
PU_INTEGRATION_DEFAULT_2026 = 1_500_000  # the 50:50 split if nothing is declared by 30 Nov 2026 (D6.1.1.q.ii)


def rules_for(year: int) -> RuleSet:
    if year in RULES:
        return RULES[year]
    if 2024 <= year <= 2025:
        return ISS22
    raise ValueError(f"no cost cap rule set for {year} (covered: 2024-2025 under Issue 22, 2026-2027 under Section D Issue 08)")


def cost_cap(year: int, competitions: int, indexation: Decimal | float = 0, cancelled_late: int = 0) -> int:
    """The Cost Cap in USD for a season (D4.1.2; ISS22 2.3(a)).

    cancelled_late: Competitions cancelled less than three months before their start. Under ISS22 2.3 they count as
    having taken place. Section D Issue 08 has no such rule (and with 24 or fewer races the 2026 cap does not move anyway)."""
    r = rules_for(year)
    if r.rule_set == "ISS22":
        competitions += cancelled_late
    extra = competitions - r.competition_threshold
    cap = r.base_cap
    if extra > 0:
        cap += r.per_competition * extra
    elif extra < 0 and r.cap_falls_with_fewer_competitions:
        cap += r.per_competition * extra
    if indexation and (r.indexation_from is None or year < r.indexation_from):
        raise ValueError(f"Indexation is not defined for {year} under {r.rule_set}")
    return int((Decimal(cap) * (1 + Decimal(str(indexation)))).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


@dataclass
class Adjustments:
    """Downward adjustments to Relevant Costs (D6.1.1). Positive numbers reduce Relevant Costs."""

    sprint: int = 0
    tyre_tests: int = 0
    pu_integration: int = 0
    unused_carry: int = 0

    @property
    def total(self) -> int:
        return self.sprint + self.tyre_tests + self.pu_integration + self.unused_carry


def adjustments(year: int, sprints: int, tyre_test_days: int = 0, tyre_day_amount: int | None = None,
                pu_integration_this_year: int = 0, unused_carry: int = 0) -> Adjustments:
    r = rules_for(year)
    a = Adjustments()
    a.sprint = r.per_sprint * max(0, sprints - r.sprint_free)
    if tyre_test_days:
        if tyre_day_amount is None:
            raise ValueError("the tyre test day amount is set by CCA Determination (D6.1.1.i); pass tyre_day_amount")
        a.tyre_tests = tyre_test_days * tyre_day_amount
    if pu_integration_this_year:
        # D6.1.1.q.i: USD 3m across 2026+2027; q.iii: another USD 3m across 2027+2028. So a year can carry at most
        # 3m (2026), 6m (2027: the rest of q.i plus part of q.iii) or 3m (2028).
        limit = PU_INTEGRATION_MAX.get(year) if r.rule_set == "SECD-ISS08" else None
        if limit is None:
            raise ValueError("the PU integration adjustments exist only for 2026, 2027 and 2028 (D6.1.1.q)")
        if not 0 <= pu_integration_this_year <= limit:
            raise ValueError(f"at most USD {limit:,} of PU integration adjustment can fall in {year} (D6.1.1.q)")
        a.pu_integration = pu_integration_this_year
    if unused_carry:
        if r.unused_carry_from is None or year < r.unused_carry_from:
            raise ValueError(f"no Unused Cost Cap Amount carry-forward in {year} (D6.1.1.n: from FY2027)")
        a.unused_carry = min(unused_carry, r.unused_carry_max)
    return a


@dataclass(frozen=True)
class Position:
    cap: int
    relevant_costs: int  # after adjustments
    headroom: int  # cap - relevant costs (negative = over)
    overspend: int
    overspend_pct: Decimal
    category: str  # compliant | minor_overspend | material_overspend
    material_line: int  # Relevant Costs at which an overspend becomes material
    article: str


def classify(year: int, relevant_costs: int, cap: int) -> Position:
    """D10.3: under the cap -> compliant; over by less than 2% -> minor; 2% or more -> material."""
    r = rules_for(year)
    over = relevant_costs - cap
    pct = (Decimal(over) / Decimal(cap)) if over > 0 else Decimal(0)
    # Material starts at exactly 2% of the cap ("by 2% or more"): compare exactly, never after rounding.
    material = over > 0 and Decimal(over) >= Decimal(cap) * r.material_pct
    # The first whole dollar at which the overspend is material (ceiling of 2% of the cap).
    material_line = cap + int((Decimal(cap) * r.material_pct).to_integral_value(rounding=ROUND_CEILING))
    if over <= 0:
        cat, art = "compliant", "D4.1.1.b"
    elif material:
        cat, art = "material_overspend", "D10.3.3"
    else:
        cat, art = "minor_overspend", "D10.3.1"
    if r.rule_set == "ISS22":
        art = {"compliant": "2.2(b)", "minor_overspend": "8.10", "material_overspend": "8.12"}[cat]
    return Position(cap, relevant_costs, cap - relevant_costs, max(over, 0), pct, cat, material_line, art)


SANCTIONS = {
    "compliant": {"mandatory": [], "possible": [], "articles": []},
    "minor_overspend": {
        "mandatory": ["Financial Penalty (amount set case by case)"],
        "possible": ["public reprimand", "Constructors' or Drivers' points deduction (breach year)", "suspension from stages of a Competition",
                     "limits on aerodynamic or other testing", "reduction of the Cost Cap for the next year (and later years where applicable)",
                     "enhanced monitoring (D12.2.1)"],
        "articles": ["D10.3.2", "D12.1.1.a", "D12.1.1.b"],
    },
    "material_overspend": {
        "mandatory": ["Constructors' Championship points deduction (breach year)", "Financial Penalty (amount set case by case)"],
        "possible": ["Drivers' points deduction", "suspension from stages of, or entire, Competitions", "limits on testing",
                     "exclusion from the Championship for a period",
                     "reduction of the Cost Cap for the next year (and later years where applicable)", "enhanced monitoring (D12.2.1)"],
        "articles": ["D10.3.4", "D12.1.1.a", "D12.1.1.c"],
    },
}
