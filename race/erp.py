"""The books: race entries posted to the ERP through the gateway, or held for a person's review. STUB.

    post(state, entries, sink) -> list[Posting]     # new entries since the last call
    apply_reviews(state, sink) -> list[Posting]     # held entries a person approved since the last call
"""

from __future__ import annotations

from race.events import Entry, Posting


def post(state, entries: list[Entry], sink) -> list[Posting]:
    return []


def apply_reviews(state, sink) -> list[Posting]:
    return []
