"""Every number the simulator needs that the regulations do NOT fix, each labelled with where it came from.

Nothing in here is a rule. Change any of it through the API (`assumptions` field) or by editing the
defaults; every result echoes the assumptions it used.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass
class Source:
    claim: str
    url: str
    kind: str = "press"  # regulation | press | estimate | team_statement | hypothetical


@dataclass
class CrashModel:
    """Crash and accident damage per race weekend for the team (two cars). Inside the cap (crash repairs are Relevant Costs)."""

    incidents_per_race: float = 0.38  # Poisson mean
    # Severity mixture: (share, median USD, log-sd). Mean per incident about USD 0.5m.
    severity: list[tuple[float, float, float]] = field(default_factory=lambda: [
        (0.70, 180_000, 0.45),   # wing, nose, floor damage
        (0.25, 900_000, 0.40),   # "If a wheel hits the wall, you can almost certainly expect a million in damage" (Vowles)
        (0.05, 2_500_000, 0.40),  # chassis or gearbox write-off
    ])
    basis: str = ("Calibrated so a typical team spends about USD 4.5m a season on crash damage, near the 2024 median: F1Maximaal's "
                  "estimates range from EUR 2.3m (McLaren) to EUR 13.8m (Williams), Mercedes about EUR 4.3m, mean about EUR 4.8m. "
                  "Severity bands from team statements.")


@dataclass
class SpendModel:
    """Uncertainty in the parts of the plan that are not yet spent."""

    upgrade_overrun_logsd: float = 0.12  # each remaining upgrade package costs plan x lognormal(0, 0.12)
    upgrade_overrun_bias: float = 0.04   # packages run over by about 4% on average
    freight_per_race_sd: float = 0.08     # share of planned freight per race
    payroll_monthly_sd: float = 0.01      # share of planned payroll per month
    other_monthly_sd: float = 0.04
    basis: str = "Illustrative engineering-programme uncertainty; not from any team's data."


@dataclass
class SanctionModel:
    """What a breach might cost. The regulations set categories, not amounts (D12.1.1.a: 'case by case')."""

    # Minor overspend: fine as a multiple of the overspend. One precedent: Red Bull FY2021, overspend GBP 1.864m,
    # fined USD 7m. That is 2.7x the overspend at the 2021 average GBP/USD rate (about 1.375) and 3.3x at the
    # October 2022 rates (average about 1.13; 1.156 on 28 Oct 2022, the day of the decision). Default: the middle, 3.0x.
    minor_fine_multiple: float = 3.0
    minor_fine_floor: int = 450_000  # Aston Martin FY2021 procedural breach fine, USD 450k
    # Red Bull also lost 10% of aero testing (wind tunnel and CFD) for 12 months. Its own estimate of the lap time
    # cost was "anywhere between a quarter and half a second" (team claim). Expressed here as Constructors' points lost the following season.
    minor_testing_cut_points_next_year: float = 12.0
    minor_testing_cut_probability: float = 0.8
    # Material overspend: a points deduction is mandatory (D10.3.4), but no material overspend has ever been
    # sanctioned, so its size is a pure scenario input.
    material_points_deduction: float = 40.0
    material_fine_multiple: float = 5.0
    material_testing_cut_points_next_year: float = 25.0
    # Months from the end of the season to the CCA decision. FY2021: Oct 2022; FY2024: 28 Oct 2025 (about 10 months).
    months_to_decision: int = 10
    basis: str = ("Only one overspend has ever been sanctioned (Red Bull FY2021, minor). No material overspend has been. "
                  "Fine multiples and points figures are scenario inputs, not predictions.")


@dataclass
class Assumptions:
    crash: CrashModel = field(default_factory=CrashModel)
    spend: SpendModel = field(default_factory=SpendModel)
    sanction: SanctionModel = field(default_factory=SanctionModel)
    runs: int = 4000
    seed: int = 2026

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict | None) -> "Assumptions":
        a = cls()
        for part in ("crash", "spend", "sanction"):
            for k, v in (d or {}).get(part, {}).items():
                if not hasattr(getattr(a, part), k):
                    raise ValueError(f"unknown assumption {part}.{k}")
                setattr(getattr(a, part), k, v)
        for k in ("runs", "seed"):
            if d and k in d:
                setattr(a, k, int(d[k]))
        if not 100 <= a.runs <= 50_000:
            raise ValueError("runs must be between 100 and 50,000")
        return a


SOURCES = [
    Source("2026 cost cap USD 215m; minor < 2%, material >= 2%; mandatory points deduction for material", "https://www.fia.com/system/files/documents/fia_2026_f1_regulations_-_section_d_financial_-_f1_teams_-_iss_08_-_2026-10-01.pdf", "regulation"),
    Source("Red Bull FY2021: overspend GBP 1.864m, USD 7m fine, 10% aero testing cut for 12 months", "https://the-race.com/formula-1/fia-reveals-red-bulls-punishment-for-f1-cost-cap-breach/"),
    Source("FY2021 findings: Red Bull minor overspend (< 5%), Aston Martin procedural", "https://www.formula1.com/en/latest/article/fia-announces-2021-cost-cap-breaches-by-two-f1-teams.2N8xy1FHhoOlwsOO3Mx0A2"),
    Source("Aston Martin FY2021 procedural breach: USD 450k fine", "https://www.motorsport.com/f1/news/aston-martin-450k-fine-cost-cap-penalty/10391643/"),
    Source("FY2024 results 28 Oct 2025: Aston Martin procedural breach 'of a very minor nature' (audited accounts late), ABA 29 Sep 2025, others compliant", "https://racer.com/2025/10/28/fia-confirms-nine-teams-in-compliance-with-f1-cost-cap"),
    Source("Red Bull estimated the testing cut would cost between a quarter and half a second a lap", "https://www.the-race.com/formula-1/red-bull-thinks-breach-punishment-will-cost-it-half-a-second/", "team_statement"),
    Source("2024 crash damage estimates by team (F1Maximaal), Vowles 'a million' per wall hit", "https://www.planetf1.com/features/f1-2024-crash-damage-standings", "estimate"),
    Source("Williams: over USD 5m on three Interlagos 2024 crashes; FIA declined its request for USD 1m of relief after a team's tenth major crash", "https://www.grandprix.com/news/fia-turns-down-williams-budget-cap-request.html"),
    Source("2026 calendar: Saudi GP cancelled; Bahrain GP moved to Sepang in October (23 rounds, 6 sprints)", "https://www.aljazeera.com/sports/2026/7/26/malaysia-to-host-rescheduled-bahrain-grand-prix-f1-race-in-october"),
]
