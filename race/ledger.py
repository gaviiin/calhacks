"""Stage 4, account: balanced provisional entries for an incident. STUB, see the brief in the plan.

    entries = entries_for(incident, effects, state)   # idempotent by entry_key
"""

from __future__ import annotations

from race.events import Effect, Entry, Incident


def entries_for(inc: Incident, effects: list[Effect], state) -> list[Entry]:
    return []
