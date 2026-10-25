"""Stage 5, ask: a person is asked when a wrong answer would cost more than the question. STUB.

    questions_for(incident, effects, state) -> list[Question]
    apply_answers(state, sink, book) -> list[Incident]   # incidents re-decided by answers since last call
"""

from __future__ import annotations

from race.events import Effect, Incident, Question


def questions_for(inc: Incident, effects: list[Effect], state) -> list[Question]:
    return []


def apply_answers(state, sink, book) -> list[Incident]:
    return []
