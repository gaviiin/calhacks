"""Record genuinely everything an agent does (SCHEMA.md §6b).

The audit log records state changes. This records everything in between: every read, every tool
call, every model call, every decision with the alternatives it considered, framed by run_start
and run_end. Steps are written to the system of work as the agent's own identity via the
`recordStep` reducer, so they sit next to the audit log and are queryable by work item.

A step is never dropped. If the reducer call fails (module not reachable, older module without
`recordStep`), the step is appended to agents/out/steps.jsonl with the failure reason, and the
recorder keeps writing there for the rest of the run so step order stays intact in one place.
"""

from __future__ import annotations

import hashlib
import json
import logging
import secrets
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

from . import config
from . import reducers as R
from .identities import Actor

log = logging.getLogger(__name__)

MAX_INPUT_BYTES = 8 * 1024
MAX_EXCERPT_BYTES = 2 * 1024
TRUNCATED = "…[truncated]"
KINDS = ("run_start", "read", "tool_call", "model_call", "decision", "note", "error", "run_end")
FALLBACK_PATH = config.OUT_DIR / "steps.jsonl"


def _to_text(x: Any) -> str:
    if x is None:
        return ""
    if isinstance(x, str):
        return x
    return json.dumps(x, default=str, sort_keys=True, ensure_ascii=False)


def cap_bytes(s: str, limit: int) -> str:
    """Truncate to at most `limit` UTF-8 bytes, marking the cut. Never splits a character."""
    b = s.encode("utf-8")
    if len(b) <= limit:
        return s
    room = limit - len(TRUNCATED.encode("utf-8"))
    return b[:room].decode("utf-8", errors="ignore") + TRUNCATED


def digest(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def new_run_id(actor_name: str, sim_date: str) -> str:
    return f"{actor_name}-{sim_date}-{secrets.token_hex(4)}"


@dataclass
class Step:
    run_id: str
    step: int
    kind: str
    name: str
    input: str
    output_digest: str
    output_excerpt: str
    work_item_id: int | None
    model: str | None
    sink: str  # "stdb" | "file"
    fallback_reason: str | None = None


@dataclass
class Recorder:
    """One recorder per agent run. `stdb=None` (or `to_file=True`) writes only to the fallback file,
    which is what --dry-run uses because it may not call reducers."""

    actor: Actor
    stdb: Any
    sim_date: str
    to_file: bool = False
    fallback_path: Path = FALLBACK_PATH
    run_id: str = ""
    steps: list[Step] = field(default_factory=list)
    _n: int = 0
    _work_item: int | None = None
    _degraded: str | None = None

    def __post_init__(self) -> None:
        if not self.run_id:
            self.run_id = new_run_id(self.actor.name, self.sim_date)
        if self.stdb is None:
            self.to_file = True

    # ---- the one write path
    def record(self, kind: str, name: str, input: Any = None, output: Any = None, *,
               work_item_id: int | None = None, model: str | None = None) -> Step:
        if kind not in KINDS:
            raise ValueError(f"unknown step kind {kind!r}")
        self._n += 1
        full_out = _to_text(output)
        wid = work_item_id if work_item_id is not None else self._work_item
        st = Step(
            run_id=self.run_id,
            step=self._n,
            kind=kind,
            name=name,
            input=cap_bytes(_to_text(input), MAX_INPUT_BYTES),
            output_digest=digest(full_out),
            output_excerpt=cap_bytes(full_out, MAX_EXCERPT_BYTES),
            work_item_id=int(wid) if wid is not None else None,
            model=model,
            sink="file",
        )
        reason = "dry run: no reducer calls" if self.to_file else self._degraded
        if reason is None:
            try:
                self.stdb.call(self.actor.token, R.RECORD_STEP,
                               R.record_step(st.run_id, st.step, st.kind, st.name, st.input, st.output_digest,
                                             st.output_excerpt, st.work_item_id, st.model))
                st.sink = "stdb"
            except Exception as e:  # never drop a step: degrade to the file for the rest of the run
                self._degraded = reason = f"recordStep failed: {type(e).__name__}: {e}"[:300]
                log.warning("%s; recording run %s to %s from step %d", self._degraded, self.run_id,
                            self.fallback_path, st.step)
        if st.sink == "file":
            st.fallback_reason = reason
            self._append_file(st)
        self.steps.append(st)
        return st

    def _append_file(self, st: Step) -> None:
        self.fallback_path.parent.mkdir(parents=True, exist_ok=True)
        row = {k: v for k, v in st.__dict__.items() if k != "sink"}
        row["actor"] = self.actor.name
        row["actor_role"] = self.actor.role
        with self.fallback_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    # ---- framing
    @contextmanager
    def run(self, name: str, params: Any = None) -> Iterator["Recorder"]:
        """run_start ... run_end, with an error step if the body raises."""
        self.record("run_start", name, params)
        try:
            yield self
        except BaseException as e:
            self.record("error", name, None, f"{type(e).__name__}: {e}")
            self.record("run_end", name, None, {"status": "error", "steps": self._n + 1})
            raise
        self.record("run_end", name, None, {"status": "ok", "steps": self._n + 1})

    @contextmanager
    def on_item(self, work_item_id: int) -> Iterator[None]:
        """Attribute every step inside the block to one work item."""
        prev, self._work_item = self._work_item, int(work_item_id)
        try:
            yield
        finally:
            self._work_item = prev

    @property
    def sink(self) -> str:
        return "file" if (self.to_file or self._degraded) else "stdb"


class NullRecorder:
    """For code paths and tests that run without recording. Same surface, records nothing."""

    run_id = ""
    steps: list = []

    def record(self, *a: Any, **k: Any) -> None:
        return None

    @contextmanager
    def run(self, *a: Any, **k: Any) -> Iterator["NullRecorder"]:
        yield self

    @contextmanager
    def on_item(self, *a: Any, **k: Any) -> Iterator[None]:
        yield


def model_call_output(message: Any) -> dict:
    """What a model_call step keeps: stop reason, usage, the tool calls made, and the text."""
    usage = getattr(message, "usage", None)
    blocks = getattr(message, "content", None) or []
    return {
        "id": getattr(message, "id", None),
        "stop_reason": getattr(message, "stop_reason", None),
        "usage": {
            "input_tokens": getattr(usage, "input_tokens", None),
            "output_tokens": getattr(usage, "output_tokens", None),
        } if usage is not None else None,
        "tool_calls": [{"name": getattr(b, "name", None), "input": getattr(b, "input", None)}
                       for b in blocks if getattr(b, "type", None) == "tool_use"],
        "text": "\n".join(getattr(b, "text", "") for b in blocks if getattr(b, "type", None) == "text"),
    }
