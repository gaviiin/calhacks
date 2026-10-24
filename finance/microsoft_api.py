"""HTTP endpoints for the independent auditor, impact metrics and the Microsoft integrations.

    POST /api/runs/{id}/audit                 run the independent audit (Azure OpenAI second opinion when configured)
    GET  /api/runs/{id}/audit                 latest audit report
    GET  /api/runs/{id}/audit/findings.csv    findings as a workpaper the controller can open in Excel
    POST /api/runs/{id}/audit/drill           tamper drill on a copy of the books: does the auditor catch it?
    POST /api/runs/{id}/audit/share           send the audit summary to the controller and CFO (Teams card, Outlook, Slack)
    GET  /api/runs/{id}/impact                measurable usefulness: straight-through rate, dollars protected, speed, effort
    GET  /api/runs/{id}/erp/business-central  export status
    POST /api/runs/{id}/erp/business-central/export   {"mode": "dry" | "live", "post": false}
    GET  /api/runs/{id}/erp/business-central/reconcile
    GET  /api/microsoft/status                which Microsoft services are configured (no secrets)
"""

from __future__ import annotations

import csv
import io
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from .audit import drill
from .audit.auditor import Auditor, latest
from .audit.reviewer import make_reviewer
from .erp.business_central import BCError, BusinessCentral
from .impact import impact
from .money import fmt
from .notify.messages import Action, Message

class AuditBody(BaseModel):
    sample_rate: float = 0.15
    review: bool = True


class ShareBody(BaseModel):
    channels: list[str] | None = None  # default: each person's own channels


class ExportBody(BaseModel):
    mode: str = "dry"
    post: bool = False
    limit: int = 500


def audit_message(run_id: str, report: dict) -> Message:
    s = report["summary"]
    top = report["findings"][:3]
    body = report["memo"][:1500] if report.get("memo") else ""
    return Message(
        kind="audit_report", dedupe_key=f"audit|{report['audit_id']}",
        title=f"Independent audit: {report['opinion'].upper()} ({s['findings']} finding{'s' if s['findings'] != 1 else ''})",
        body=body,
        facts=[("Opinion", report["opinion"]), ("Posted entries tested", str(s["posted"])),
               ("Re-performed from source", str(len(report["sample"]))), ("High / medium / low", f"{s['high']} / {s['medium']} / {s['low']}"),
               ("Exposure (high)", fmt(s["exposure_cents"])), ("Reviewer", report["reviewer"].get("backend", "rules"))]
              + [(f"Finding {i + 1}", f"[{f['severity']}] {f['title']}") for i, f in enumerate(top)],
        actions=[Action("Open in Pit Wall", "open")], context={"run_id": run_id, "audit_id": report["audit_id"]},
        severity="urgent" if report["opinion"] == "adverse" else "warning" if report["opinion"] == "qualified" else "info",
    )


def build_router(get_run, store=None) -> APIRouter:
    r = APIRouter()

    def folder(run) -> Path:
        return Path(run.ledger.path).parent

    # ------------------------------------------------------------------ audit

    @r.post("/api/runs/{run_id}/audit")
    def run_audit(run_id: str, body: AuditBody | None = None):
        body = body or AuditBody()
        run = get_run(run_id)
        sealer = getattr(run.ledger, "sealer", None)
        if sealer:
            sealer.anchor_now()
        reviewer = make_reviewer(store=store, run_id=run_id) if body.review else None
        return Auditor(run.ledger.path, run.world, run_id, run.season, reviewer=reviewer, sample_rate=body.sample_rate).run(review=body.review)

    @r.get("/api/runs/{run_id}/audit")
    def last_audit(run_id: str):
        rep = latest(folder(get_run(run_id)))
        if rep is None:
            raise HTTPException(404, "no audit yet; POST /api/runs/{id}/audit")
        return rep

    @r.get("/api/runs/{run_id}/audit/findings.csv", response_class=PlainTextResponse)
    def findings_csv(run_id: str):
        rep = latest(folder(get_run(run_id)))
        if rep is None:
            raise HTTPException(404, "no audit yet")
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["id", "procedure", "severity", "title", "detail", "je_id", "amount_usd", "recommendation", "second_opinion"])
        for f in rep["findings"]:
            w.writerow([f["id"], f["procedure"], f["severity"], f["title"], f["detail"], f["je_id"] or "", f"{f['amount_cents'] / 100:.2f}",
                        f["recommendation"], (f.get("second_opinion") or {}).get("concern", "")])
        return PlainTextResponse(buf.getvalue(), media_type="text/csv",
                                 headers={"Content-Disposition": f"attachment; filename=pitwall-audit-{rep['audit_id']}.csv"})

    @r.post("/api/runs/{run_id}/audit/drill")
    def audit_drill(run_id: str):
        run = get_run(run_id)
        sealer = getattr(run.ledger, "sealer", None)
        if sealer is None:
            raise HTTPException(409, "this run has no evidence seals (PITWALL_SEALS=0)")
        sealer.anchor_now()
        return drill.run(folder(run), run.world, run_id, run.season)

    @r.post("/api/runs/{run_id}/audit/share")
    def audit_share(run_id: str, body: ShareBody | None = None):
        run = get_run(run_id)
        rep = latest(folder(run))
        if rep is None:
            raise HTTPException(404, "no audit yet")
        n = getattr(run.ledger, "notifier", None)
        if n is None:
            raise HTTPException(409, "notifications are not enabled for this run")
        msg = audit_message(run_id, rep)
        sent = []
        for role in ("controller", "cfo"):
            for person in n.directory.by_role(role):
                sent += n.send(msg, person, channel_names=(body.channels if body else None))
        return {"sent": [{k: s[k] for k in ("channel", "recipient", "person", "status")} for s in sent], "mode": n.mode}

    # ------------------------------------------------------------------ impact

    @r.get("/api/runs/{run_id}/impact")
    def get_impact(run_id: str):
        return impact(get_run(run_id))

    # ------------------------------------------------------------------ Business Central

    def bc(run) -> BusinessCentral:
        conn = getattr(run.ledger, "business_central", None)
        if conn is None:
            conn = BusinessCentral(run.ledger)
            run.ledger.business_central = conn
        return conn

    @r.get("/api/runs/{run_id}/erp/business-central")
    def bc_status(run_id: str):
        return bc(get_run(run_id)).status()

    @r.post("/api/runs/{run_id}/erp/business-central/export")
    def bc_export(run_id: str, body: ExportBody | None = None):
        body = body or ExportBody()
        if body.mode not in ("dry", "live"):
            raise HTTPException(400, "mode is dry or live")
        try:
            return bc(get_run(run_id)).export(body.mode, body.limit, body.post)
        except BCError as exc:
            raise HTTPException(409, str(exc))

    @r.get("/api/runs/{run_id}/erp/business-central/reconcile")
    def bc_reconcile(run_id: str):
        try:
            return bc(get_run(run_id)).reconcile()
        except BCError as exc:
            raise HTTPException(502, str(exc))

    # ------------------------------------------------------------------ status

    @r.get("/api/microsoft/status")
    def ms_status():
        from . import telemetry
        from .microsoft.auth import configured

        e = os.environ
        return {
            "entra_id": {"configured": configured(e), "mode": "managed_identity" if e.get("PITWALL_MS_AUTH") == "managed_identity"
                         else "client_secret" if e.get("MS_CLIENT_SECRET") else "none"},
            "azure_openai_auditor": {"configured": bool(e.get("AZURE_OPENAI_ENDPOINT") and e.get("AZURE_OPENAI_DEPLOYMENT")),
                                     "deployment": e.get("AZURE_OPENAI_DEPLOYMENT") or None},
            "teams": {"configured": bool(e.get("TEAMS_WEBHOOK_URL"))},
            "outlook_graph": {"configured": e.get("EMAIL_TRANSPORT") == "graph" and bool(e.get("GRAPH_SENDER")),
                              "sender": e.get("GRAPH_SENDER") or None},
            "business_central": {"configured": all(e.get(k) for k in ("BC_ENVIRONMENT", "BC_COMPANY_ID", "BC_JOURNAL_ID"))
                                 and configured(e), "environment": e.get("BC_ENVIRONMENT") or None},
            "application_insights": {"configured": bool(e.get("APPLICATIONINSIGHTS_CONNECTION_STRING")), "active": telemetry.enabled()},
            "confidential_ledger": {"configured": bool(e.get("AZURE_CONFIDENTIAL_LEDGER_ENDPOINT"))},
            "notify_mode": e.get("PITWALL_NOTIFY", "dry"),
        }

    return r
