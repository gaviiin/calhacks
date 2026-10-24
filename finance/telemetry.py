"""Azure Monitor (Application Insights) telemetry through OpenTelemetry. Optional and off by default.

    APPLICATIONINSIGHTS_CONNECTION_STRING=InstrumentationKey=...;IngestionEndpoint=...
    pip install azure-monitor-opentelemetry

Then every API request is traced, and the ledger reports what the books are
doing as metrics an operations team can alert on:

    pitwall.entries          counter, by kind and status (posted / parked / refused / rejected)
    pitwall.kernel_refusals  counter, by failed check (K1..K12)
    pitwall.approvals_waiting  emitted with each parked entry (needs controller / cfo)

No amounts, names or sponsor details leave the process; only kinds, statuses and check ids.
"""

from __future__ import annotations

import os

_METER = None
_COUNTERS: dict = {}


def enabled() -> bool:
    return _METER is not None


def configure(app=None, env=os.environ) -> bool:
    global _METER
    if _METER is not None or not env.get("APPLICATIONINSIGHTS_CONNECTION_STRING"):
        return _METER is not None
    try:
        from azure.monitor.opentelemetry import configure_azure_monitor
        from opentelemetry import metrics

        configure_azure_monitor(connection_string=env["APPLICATIONINSIGHTS_CONNECTION_STRING"])
        _METER = metrics.get_meter("pitwall")
        if app is not None:
            try:
                from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

                FastAPIInstrumentor.instrument_app(app)
            except ImportError:
                pass
        return True
    except Exception as exc:  # telemetry must never stop the app
        print(f"  Azure Monitor telemetry not started: {exc}")
        return False


def _counter(name: str, description: str):
    if name not in _COUNTERS:
        _COUNTERS[name] = _METER.create_counter(name, description=description)
    return _COUNTERS[name]


def ledger_listener(name: str, payload: dict) -> None:
    if _METER is None or name != "entry":
        return
    _counter("pitwall.entries", "journal entries by kind and status").add(1, {"kind": payload["kind"], "status": payload["status"]})
    if payload["status"] == "refused":
        for c in payload.get("checks", []):
            if c["result"] == "fail":
                _counter("pitwall.kernel_refusals", "kernel refusals by check").add(1, {"check": c["check_id"]})
    if payload["status"] == "parked":
        for role in payload.get("needs", []):
            _counter("pitwall.approvals_waiting", "entries parked for a person").add(1, {"role": role})


def attach(ledger) -> None:
    if _METER is not None and ledger_listener not in ledger.listeners:
        ledger.listeners.append(ledger_listener)
