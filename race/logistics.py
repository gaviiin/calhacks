"""Stage 3, respond: what the playbook sets off for an incident. STUB, see the brief in the plan.

    manifest = load_manifest(state)       # part -> {"at_track": n, "factory": n}
    actions = plan(incident, state)       # idempotent: the same incident version gives the same actions

Reversible, internal actions are `auto`; outward-facing or irreversible ones (withdraw a car, book freight,
an FIA notice) are `awaiting_approval` with the owner_role who decides.
"""

from __future__ import annotations

from race.events import Action, Incident


def load_manifest(state) -> dict:
    return {}


def plan(inc: Incident, state) -> list[Action]:
    return [Action(action_key=f"{inc.incident_key}:garage_check", incident_key=inc.incident_key, kind="garage_check",
                   title=f"Garage: confirm the damage on car {inc.driver_number}", owner_role="chief_mechanic", updated_at=inc.updated_at)]
