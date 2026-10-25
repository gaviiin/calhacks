"""Meridian Racing's 2026 calendar, Relevant Costs budget, and spend to date.

The calendar is the real 2026 one (23 rounds, 6 sprints: Saudi Arabia cancelled, Bahrain held at Sepang in
October). The budget is ILLUSTRATIVE: sized like a front-running team that plans close to the USD 215m cap,
with category sizes in line with public figures (payroll the largest line; air freight USD 8-20m a season;
crash damage EUR 2-14m a season). Every amount is USD, Relevant Costs only (after exclusions).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import date

M = 1_000_000


@dataclass(frozen=True)
class Race:
    round: int
    name: str
    day: date  # race day
    sprint: bool = False
    flyaway: bool = True


CALENDAR_2026 = [
    Race(1, "Australian GP", date(2026, 3, 8)),
    Race(2, "Chinese GP", date(2026, 3, 15), sprint=True),
    Race(3, "Japanese GP", date(2026, 3, 29)),
    Race(4, "Miami GP", date(2026, 5, 3), sprint=True),
    Race(5, "Canadian GP", date(2026, 5, 24), sprint=True),
    Race(6, "Monaco GP", date(2026, 6, 7), flyaway=False),
    Race(7, "Barcelona-Catalunya GP", date(2026, 6, 14), flyaway=False),
    Race(8, "Austrian GP", date(2026, 6, 28), flyaway=False),
    Race(9, "British GP", date(2026, 7, 5), sprint=True, flyaway=False),
    Race(10, "Belgian GP", date(2026, 7, 19), flyaway=False),
    Race(11, "Hungarian GP", date(2026, 7, 26), flyaway=False),
    Race(12, "Dutch GP", date(2026, 8, 23), sprint=True, flyaway=False),
    Race(13, "Italian GP", date(2026, 9, 6), flyaway=False),
    Race(14, "Spanish GP (Madring)", date(2026, 9, 13), flyaway=False),
    Race(15, "Azerbaijan GP", date(2026, 9, 26)),
    Race(16, "Bahrain GP (at Sepang)", date(2026, 10, 4)),
    Race(17, "Singapore GP", date(2026, 10, 11), sprint=True),
    Race(18, "United States GP", date(2026, 10, 25)),
    Race(19, "Mexico City GP", date(2026, 11, 1)),
    Race(20, "São Paulo GP", date(2026, 11, 8)),
    Race(21, "Las Vegas GP", date(2026, 11, 21)),
    Race(22, "Qatar GP", date(2026, 11, 29)),
    Race(23, "Abu Dhabi GP", date(2026, 12, 6)),
]
CALENDAR_SOURCE = ("RaceFans 2026 calendar; Al Jazeera 26 Jul 2026 and Sky Sports on the Bahrain GP moving to Sepang; "
                   "Saudi Arabian GP cancelled 14 Mar 2026 with no replacement.")


@dataclass
class Upgrade:
    key: str
    name: str
    round: int  # first race it runs at; cost lands in that race's month
    cost: int
    status: str = "committed"  # committed | delivered | proposed


@dataclass
class Plan:
    """Annual Relevant Costs budget by category (USD)."""

    season: int = 2026
    payroll_month: int = 8_250_000  # F1 Activities staff inside the cap (top three earners, bonuses up to the limit excluded)
    depreciation_month: int = 1_000_000  # plant and equipment depreciation: inside the cap from 2026, because D5.1.1.o now
    # excludes only Property and assets used solely for excluded activities; measured as D6.1.1.k says (cost model, straight line)
    overheads_month: int = 700_000  # IT, software, facilities services inside F1 Activities
    other_month: int = 250_000
    sea_freight_month: int = 125_000
    manufacturing: dict[int, int] = field(default_factory=lambda: {
        1: 6_000_000, 2: 6_500_000, 3: 4_000_000, 4: 2_500_000, 5: 2_300_000, 6: 2_200_000,
        7: 2_000_000, 8: 1_500_000, 9: 2_000_000, 10: 2_000_000, 11: 1_800_000, 12: 1_200_000})  # car build and spares: USD 34m
    aero_year: int = 14_000_000  # wind tunnel and CFD operations, spread evenly (remainder in December)
    race_ops: int = 380_000  # per race weekend: consumables, garage, parts logistics
    freight_flyaway: int = 850_000  # per flyaway race: air freight (inside the cap; personnel travel is excluded)
    freight_europe: int = 350_000  # per European race: trucks
    crash_reserve: int = 4_500_000  # expected crash damage for the season (budget line; actual damage is simulated)
    upgrades: list[Upgrade] = field(default_factory=lambda: [
        Upgrade("U1", "Miami floor and sidepods", 4, 3_200_000, "delivered"),
        Upgrade("U2", "Silverstone floor evolution", 9, 2_600_000, "delivered"),
        Upgrade("U3", "Monza low-drag package", 13, 1_600_000, "delivered"),
        Upgrade("U4", "Singapore high-downforce package", 17, 2_200_000, "committed"),
        Upgrade("U5", "Final package (Mexico City)", 19, 2_400_000, "proposed"),
    ])
    calendar: list[Race] = field(default_factory=lambda: list(CALENDAR_2026))

    def races_in(self, month: int) -> list[Race]:
        return [r for r in self.calendar if r.day.month == month]

    def fixed(self, month: int) -> int:
        return (self.payroll_month + self.depreciation_month + self.overheads_month + self.other_month + self.sea_freight_month
                + self.manufacturing.get(month, 0) + self.aero(month))

    def aero(self, month: int) -> int:
        base = self.aero_year // 12
        return base + (self.aero_year - base * 12 if month == 12 else 0)

    def freight(self, race: Race) -> int:
        return self.freight_flyaway if race.flyaway else self.freight_europe

    def race_cost(self, race: Race) -> int:
        return self.race_ops + self.freight(race)

    def upgrades_in(self, month: int, include: set[str] | None = None) -> list[Upgrade]:
        out = []
        for u in self.upgrades:
            race = next(r for r in self.calendar if r.round == u.round)
            if race.day.month == month and (u.status != "proposed" or (include and u.key in include)):
                out.append(u)
        return out

    def month_budget(self, month: int, include: set[str] | None = None, with_crash_reserve: bool = True) -> int:
        races = self.races_in(month)
        crash = self.crash_reserve_in(month) if with_crash_reserve else 0
        return (self.fixed(month) + sum(self.race_cost(r) for r in races) + sum(u.cost for u in self.upgrades_in(month, include))
                + crash)

    def crash_reserve_in(self, month: int) -> int:
        """The season's crash reserve spread by race count, cumulatively rounded so the months add up exactly."""
        n = len(self.calendar)
        upto = sum(1 for r in self.calendar if r.day.month <= month)
        before = sum(1 for r in self.calendar if r.day.month < month)
        return self.crash_reserve * upto // n - self.crash_reserve * before // n

    def annual_budget(self, include: set[str] | None = None) -> int:
        return sum(self.month_budget(m, include) for m in range(1, 13))

    def summary(self) -> dict:
        return {"season": self.season, "budget_without_proposed": self.annual_budget(),
                "proposed": [asdict(u) for u in self.upgrades if u.status == "proposed"],
                "by_category": {
                    "payroll": self.payroll_month * 12, "depreciation": self.depreciation_month * 12,
                    "overheads": self.overheads_month * 12, "other": self.other_month * 12,
                    "manufacturing": sum(self.manufacturing.values()), "aero_testing": self.aero_year,
                    "race_operations": self.race_ops * len(self.calendar),
                    "freight": sum(self.freight(r) for r in self.calendar) + self.sea_freight_month * 12,
                    "upgrades_committed": sum(u.cost for u in self.upgrades if u.status != "proposed"),
                    "crash_reserve": self.crash_reserve},
                "races": len(self.calendar), "sprints": sum(r.sprint for r in self.calendar), "calendar_source": CALENDAR_SOURCE}


@dataclass
class Event:
    """Something that has already happened and moved spend away from the plan."""

    month: int
    what: str
    amount: int  # USD added to that month's Relevant Costs (negative = saving)
    real: bool = False  # True: the incident happened in the real 2026 season (race data); the amount is still an estimate


# Meridian's 2026 so far, month by month. Incidents marked real are Mercedes' actual 2026 retirements (world/race_data/2026.json);
# their cap cost is an estimate. Routine wing and floor damage is booked at the budget rate (crash reserve).
EVENTS_2026 = [
    Event(5, "Miami floor and sidepods ran 9% over (illustrative)", 290_000),
    Event(5, "Canadian GP: Russell retired, engine. Power Unit Supply Perimeter costs are excluded up to the regulated price "
             "(D5.1.1.n), so no cap cost", 0, real=True),
    Event(6, "Barcelona GP: Antonelli retired, engine (D5.1.1.n: no cap cost)", 0, real=True),
    Event(7, "Silverstone floor evolution: second iteration after a correlation miss (illustrative)", 640_000),
    Event(7, "Belgian GP: Russell retired after a collision; chassis, floor and suspension (estimate: 'if a wheel hits the wall, "
             "you can almost certainly expect a million', Vowles)", 900_000, real=True),
    Event(8, "Summer shutdown: overtime and contractors below plan (illustrative)", -350_000),
    Event(9, "Monza low-drag package came in under budget (illustrative)", -120_000),
]


def actuals(plan: Plan, through_month: int, events: list[Event] | None = None) -> dict[int, int]:
    """Relevant Costs booked per closed month: the plan (routine damage at the crash-reserve rate) plus what happened."""
    events = EVENTS_2026 if events is None else events
    out = {}
    for m in range(1, through_month + 1):
        out[m] = plan.month_budget(m) + sum(e.amount for e in events if e.month == m)
    return out
