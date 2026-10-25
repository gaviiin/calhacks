"""Strategy: what each decision the pit wall has would do right now, priced and never recommended. STUB.

    options_for(state, event) -> list[OptionSet]   # at decision points (SC, VSC, red flag, pit window, each lap)
"""

from __future__ import annotations

from race.events import OptionSet, RaceEvent


def options_for(state, ev: RaceEvent) -> list[OptionSet]:
    return []
