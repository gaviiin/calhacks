"""Price book for the race desk: what a crash costs, per part, as a GBP band with its basis.

Copied from replay/gen/prices.py (the Williams replay generator, main checkout) so this worktree stands
alone. "press" means a published figure converted at USD_PER_GBP where it was in dollars; "assumption" is
our estimate. Change a number here, not inside effects.py or the forecast agent.

Calibration anchors (research/05-williams-replay-sources.md in the main checkout):
- Vowles, Nov 2024: the Mexico and Brazil crashes cost "more than three, less than ten" million dollars and
  destroyed 2 chassis, 5 floors, 5 front wings, 5 rear wings, 3 gearboxes, 2 engines.
- PlanetF1's 2024 season crash-damage estimate for Williams: EUR 13.84m, the most of any team.
- Vowles, Nov 2025 (Mexico + Brazil 2025): "less than 10 but more than three" million again.
- São Paulo 2024 alone (Albon's 315 km/h Q3 crash, Colapinto's 166 km/h qualifying crash and his 188 km/h race
  crash): about $4m, Auto Motor und Sport's figure as reported by RacingNews365. The bands below, pooled with the
  telemetry impact (`impact_parts`), land the three São Paulo crashes near it; race/tests/test_effects.py holds it.
"""

from __future__ import annotations

from dataclasses import dataclass

USD_PER_GBP = 1.27  # fallback when world/fx_rates.csv has no rate for the day (assumption, 2024-26 average)
USD_PER_EUR = 1.08  # same, for euro-denominated sponsor clauses
FALLBACK_USD_PER = {"USD": 1.0, "GBP": USD_PER_GBP, "EUR": USD_PER_EUR}


@dataclass(frozen=True)
class Price:
    low: float
    mid: float
    high: float
    basis: str  # press | assumption
    note: str = ""

    def __post_init__(self) -> None:
        assert self.low <= self.mid <= self.high, self

    def usd_cents(self) -> tuple[int, int, int]:
        lo, mid, hi = (int(round(x * USD_PER_GBP * 100)) for x in (self.low, self.mid, self.high))
        return lo, mid, hi


# ---------------------------------------------------------------- crash damage, per part (GBP)
PARTS: dict[str, Price] = {
    "chassis": Price(600_000, 850_000, 1_200_000, "assumption", "new monocoque with its homologation crash tests; repairs priced separately. "
                     "Raised from 500k/700k/1m to land São Paulo 2024 near the press figure (about $4m)"),
    "chassis_repair": Price(80_000, 150_000, 300_000, "assumption", "chassis returned to the factory and repaired"),
    "gearbox": Price(300_000, 390_000, 470_000, "press", "about $500k quoted in press; casing and internals"),
    "floor": Price(150_000, 220_000, 320_000, "assumption", "floor, diffuser and edge wings; raised from 120k/180k/280k with the chassis"),
    "front_wing": Price(80_000, 100_000, 120_000, "press", "about $125-150k quoted in press"),
    "rear_wing": Price(45_000, 65_000, 90_000, "assumption"),
    "front_suspension": Price(40_000, 65_000, 110_000, "assumption", "one corner: wishbones, pushrod, upright"),
    "rear_suspension": Price(40_000, 65_000, 110_000, "assumption", "one corner"),
    "steering_rack": Price(15_000, 28_000, 45_000, "assumption"),
    "bodywork": Price(15_000, 35_000, 70_000, "assumption", "sidepods, engine cover, nose panels"),
    "brakes": Price(12_000, 25_000, 45_000, "assumption", "one corner of discs, pads, caliper"),
    "rear_brakes": Price(20_000, 40_000, 70_000, "assumption", "both rear corners"),
    "electronics": Price(15_000, 35_000, 70_000, "assumption", "loom and sensors"),
    "wheel_speed_sensor": Price(1_000, 3_000, 6_000, "assumption"),
    "power_unit": Price(250_000, 450_000, 800_000, "assumption", "crash-damaged PU elements a customer team pays for"),
    "tyre": Price(0, 0, 0, "assumption", "supplied by the tyre maker; no team cost"),
}

# Parts a severity class implies when the fact does not list them: (part, probability).
SEVERITY_TEMPLATES: dict[str, list[tuple[str, float]]] = {
    "light": [("front_wing", 0.6), ("bodywork", 0.5), ("brakes", 0.1)],
    "moderate": [("front_wing", 0.7), ("floor", 0.5), ("front_suspension", 0.4), ("rear_suspension", 0.25),
                 ("rear_wing", 0.3), ("bodywork", 0.6)],
    "heavy": [("chassis", 0.6), ("chassis_repair", 0.4), ("gearbox", 0.8), ("floor", 0.9), ("front_wing", 0.9),
              ("rear_wing", 0.7), ("front_suspension", 0.9), ("rear_suspension", 0.7), ("bodywork", 0.9),
              ("electronics", 0.6), ("power_unit", 0.35)],
}
# "chassis" and "chassis_repair" are alternatives: a heavy template draws one of them.

REPAIR_LABOUR: dict[str, Price] = {  # overtime and contract labour per incident
    "none": Price(0, 0, 0, "assumption"),
    "light": Price(2_000, 5_000, 10_000, "assumption"),
    "moderate": Price(12_000, 25_000, 45_000, "assumption", "a night's work for one car's crew between sessions"),
    "heavy": Price(60_000, 110_000, 180_000, "assumption", "a rebuild: both crews overnight, factory overtime on the replacement parts"),
}
EXPEDITED_FREIGHT = Price(10_000, 25_000, 60_000, "assumption", "hand-carry or priority air of replacement parts to a flyaway")
FIA_FINE_EUR = (5_000, 10_000, 25_000)  # a stewards' fine on the team (unsafe release, procedure): assumption, the
#                                       race-control message names the fine, not its amount
RELIABILITY_INVESTIGATION = Price(5_000, 15_000, 40_000, "assumption",
                                  "logistics and investigation after a supplier-covered failure; the supplier replaces the part")

# Manufacturing lead time per replacement part, in days, for the forecast timeline (assumption).
LEAD_DAYS: dict[str, tuple[int, int, int]] = {
    "chassis": (10, 14, 21), "chassis_repair": (5, 8, 12), "gearbox": (5, 7, 10), "floor": (3, 5, 8), "front_wing": (2, 3, 5),
    "rear_wing": (2, 3, 5), "front_suspension": (3, 5, 8), "rear_suspension": (3, 5, 8), "steering_rack": (3, 5, 8),
    "bodywork": (2, 3, 5), "brakes": (1, 2, 3), "rear_brakes": (1, 2, 3), "electronics": (2, 3, 5), "wheel_speed_sensor": (1, 1, 2),
    "power_unit": (7, 10, 14), "tyre": (0, 0, 0),
}

# Plain words for Jev and the dashboard.
PART_LABELS: dict[str, str] = {
    "chassis": "chassis (monocoque) replaced", "chassis_repair": "chassis repaired", "gearbox": "gearbox", "floor": "floor and diffuser",
    "front_wing": "front wing", "rear_wing": "rear wing", "front_suspension": "front suspension corner", "rear_suspension": "rear suspension corner",
    "steering_rack": "steering rack", "bodywork": "bodywork panels", "brakes": "front brake corner", "rear_brakes": "rear brakes",
    "electronics": "loom and sensors", "wheel_speed_sensor": "wheel speed sensor", "power_unit": "power unit elements", "tyre": "tyres",
}


# ---------------------------------------------------------------- what the telemetry impact says
# Peak speed before the stop (race/telemetry.py) -> the severity class it implies. ASSUMPTION, anchored on
# São Paulo 2024: 315 km/h into the wall at Turn 1 wrote off Albon's chassis; Colapinto's 166 km/h qualifying
# crash was repaired inside the five hours before the race. A crash below 60 km/h is a spin or a nudge.
IMPACT_SEVERITY: list[tuple[float, str]] = [(250.0, "heavy"), (120.0, "moderate"), (60.0, "light")]
IMPACT_WEIGHT = 0.5  # the impact template's share when pooled with the belief (equal weight, assumption)


def impact_severity(kph: float | None) -> str | None:
    if not kph:
        return None
    for floor, sev in IMPACT_SEVERITY:
        if kph >= floor:
            return sev
    return "light"


def impact_parts(parts_p: dict[str, float], kph: float | None) -> dict[str, float]:
    """Pool the part probabilities with the template the impact speed implies (linear pool, IMPACT_WEIGHT).
    Jev and a precedent judge the words; the telemetry knows how hard the car hit. Without an impact, unchanged."""
    sev = impact_severity(kph)
    if sev is None:
        return dict(parts_p)
    tpl = dict(SEVERITY_TEMPLATES[sev])
    if not parts_p:
        return tpl
    w = IMPACT_WEIGHT
    return {k: round((1 - w) * parts_p.get(k, 0.0) + w * tpl.get(k, 0.0), 4) for k in sorted(set(parts_p) | set(tpl))}


def impact_severity_p(sev_p: dict[str, float], kph: float | None) -> dict[str, float]:
    """The same pool for the severity distribution."""
    sev = impact_severity(kph)
    if sev is None:
        return dict(sev_p)
    if not sev_p:
        return {k: (1.0 if k == sev else 0.0) for k in ("none", "light", "moderate", "heavy")}
    w = IMPACT_WEIGHT
    return {k: round((1 - w) * sev_p.get(k, 0.0) + w * (1.0 if k == sev else 0.0), 4) for k in ("none", "light", "moderate", "heavy")}
