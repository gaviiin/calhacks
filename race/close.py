"""Stage 7, close: the sealed weekend and one brief per role. STUB.

    close_weekend(state, offline=True) -> Close | None
    merkle_root(leaves: list[str]) -> str
"""

from __future__ import annotations

import hashlib

from race.events import Close


def merkle_root(leaves: list[str]) -> str:
    level = [hashlib.sha256(x.encode()).hexdigest() for x in leaves] or [hashlib.sha256(b"").hexdigest()]
    while len(level) > 1:
        if len(level) % 2:
            level.append(level[-1])
        level = [hashlib.sha256((level[i] + level[i + 1]).encode()).hexdigest() for i in range(0, len(level), 2)]
    return level[0]


def close_weekend(state, offline: bool = True) -> Close | None:
    return None
