"""Code tier: everything the policy book settles without judgment.

The engine turns events into proposals and hands every proposal to
`ledger.propose_entry`. It never writes to the books itself. Anything that
needs judgment (an ambiguous sprint clause, a decision published after the
final classification) comes back as `Unhandled` for the router to send to an agent.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .bonuses import BonusLine, bonus_key, bonuses_for
from .ledger import Decision, Line, Proposal
from .money import fmt, prorate, to_usd


@dataclass
class Unhandled:
    reason: str
    payload: dict = field(default_factory=dict)


def _fx_lines(dr: str, cr: str, orig: int, currency: str, rate, sponsor_id: str) -> list[Line]:
    usd = to_usd(orig, rate)
    kw = dict(currency=currency, orig=orig, rate=str(rate) if currency != "USD" else None, sponsor_id=sponsor_id)
    return [Line(dr, debit=usd, **kw), Line(cr, credit=usd, **kw)]


def result_ref(season: int, rnd: int, session: str, version: str) -> dict:
    return {"type": "race_result", "ref": f"{season}-R{rnd:02d}-{session}", "version": version}


class Engine:
    def __init__(self, world):
        self.world = world

    # ------------------------------------------------------------------ dispatch

    def handle(self, event: dict, ledger) -> list:
        fn = getattr(self, f"on_{event['type']}", None)
        if fn is None:
            return [Unhandled("unknown_event", {"type": event["type"]})]
        return fn(event, ledger)

    # ------------------------------------------------------------------ race weekend

    def on_race_provisional(self, event: dict, ledger) -> list:
        e = event["payload"]
        season, rnd, session = e["season"], e["round"], e["session"]
        out = []
        if session == "race":
            out += self._base_recognition(season, rnd, event, ledger)
        rows = self.world.classification(season, rnd, session, "provisional")
        lines, _ = bonuses_for(self.world, season, rnd, session, rows, ledger.rules)
        for line in lines:
            out.append(ledger.memo("expected_bonus", line.key, season, rnd, session, {
                "sponsor_id": line.sponsor_id, "car": line.car, "driver_id": line.driver_id, "position": line.position,
                "amount_orig": line.amount_orig, "currency": line.currency, "clause_id": line.clause_id,
                "note": "memo only: result provisional (REV-02a)"}, status="expected"))
        return out

    def on_fia_document(self, event: dict, ledger) -> list:
        e = event["payload"]
        season, rnd = e["season"], e["round"]
        team_cars = {c for c, info in self.world.car_map(season).items() if info["constructor_id"] == self.world.team}
        cars = [c for c in e.get("cars", []) if c in team_cars]
        if not cars or e["kind"] not in ("summons", "infringement", "decision"):
            return []
        session = e.get("session", "race")
        if ledger.is_final(season, rnd, session):
            return [Unhandled("decision_after_final", e)]
        out = []
        for m in ledger.memos("expected_bonus", season, rnd):
            if m["payload"]["car"] in cars and m["session"] == session and m["status"] in ("expected", "at_risk"):
                out.append(ledger.memo("expected_bonus", m["key"], season, rnd, session,
                                       {**m["payload"], "risk": e["title"], "risk_url": e.get("url"),
                                        "note": f"at risk: {e['title']}"}, status="at_risk"))
        if out:
            out.append(Unhandled("at_risk_alert", {**e, "cars": cars}))
        return out

    def on_race_final(self, event: dict, ledger) -> list:
        e = event["payload"]
        season, rnd, session = e["season"], e["round"], e["session"]
        ledger.mark_final(season, rnd, session, e.get("source", "final classification"))
        rows = self.world.classification(season, rnd, session, "final", ledger.overlays())
        lines, ambiguities = bonuses_for(self.world, season, rnd, session, rows, ledger.rules)
        out = [self._propose_bonus(line, event, ledger, version="final") for line in lines if not ledger.active_by_key(line.key)]
        earned = {line.key for line in lines}
        for m in ledger.memos("expected_bonus", season, rnd):
            if m["session"] == session and m["key"] not in earned and m["status"] in ("expected", "at_risk"):
                out.append(ledger.memo("expected_bonus", m["key"], season, rnd, session,
                                       {**m["payload"], "note": "not earned under the final classification; nothing was booked"},
                                       status="avoided"))
            elif m["session"] == session and m["key"] in earned:
                ledger.memo("expected_bonus", m["key"], season, rnd, session, m["payload"], status="booked")
        out += [Unhandled("ambiguous_clause", {"ambiguity": a}) for a in ambiguities]
        if session == "race":
            out += self.prize_trueup(season, event, ledger)
        out += self.rereview(ledger, season=season, rnd=rnd)
        return out

    def on_result_changed(self, event: dict, ledger) -> list:
        """A classification changed after it was final (a scenario overlay or a late decision)."""
        e = event["payload"]
        season, rnd, session = e["season"], e["round"], e["session"]
        rows = self.world.classification(season, rnd, session, "final", ledger.overlays())
        lines, ambiguities = bonuses_for(self.world, season, rnd, session, rows, ledger.rules)
        earned = {line.key: line for line in lines}
        out = []
        evidence = e.get("evidence", [])
        for bonus in ledger.active_bonuses(season, rnd, session):
            if bonus["key"] not in earned:
                out.append(self._propose_reversal(bonus, event, ledger, evidence))
        for key, line in earned.items():
            if not ledger.active_by_key(key):
                out.append(self._propose_bonus(line, event, ledger, version="final", exception=True, extra_evidence=evidence))
        out += [Unhandled("ambiguous_clause", {"ambiguity": a}) for a in ambiguities]
        if session == "race":
            out += self.prize_trueup(season, event, ledger)
        out += self.rereview(ledger, season=season, rnd=rnd)
        return out

    # ------------------------------------------------------------------ proposals

    def _base_recognition(self, season: int, rnd: int, event: dict, ledger) -> list:
        out = []
        n = self.world.gp_rounds_in_season(season)
        when = ledger.posting_date(self.world.round(season, rnd)["date"])
        for sponsor in self.world.sponsors:
            key = f"base|{season}|R{rnd}|{sponsor['id']}"
            if ledger.active_by_key(key):
                continue
            share = sponsor["base_fee"] // n
            if rnd == n:
                share = sponsor["base_fee"] - share * (n - 1)
            rate = self.world.fx(sponsor["currency"], when)
            ref = self.world.contract_for(sponsor["id"], rnd)["contract_ref"]
            p = Proposal(
                kind="base_recognition", effective_date=when, key=key, sponsor_id=sponsor["id"], preparer="code",
                memo=f"{sponsor['name']} base fee, R{rnd} share (1/{n})",
                lines=_fx_lines("1200", "4000", share, sponsor["currency"], rate, sponsor["id"]),
                decision=Decision(
                    question=f"Base fee share for {sponsor['name']}, {season} R{rnd}",
                    answer=f"1/{n} of the season fee: {fmt(share, sponsor['currency'])}",
                    policy_ids=["REV-01"] + (["REV-05"] if sponsor["currency"] != "USD" else []),
                    evidence=[{"type": "contract", "ref": ref}, {"type": "schedule", "ref": f"{season}-R{rnd:02d}"}],
                    outcome="recognize"),
                source_event_id=event["id"], basis={"sponsor_id": sponsor["id"], "season": season, "round": rnd},
            )
            out.append(ledger.propose_entry(p))
        return out

    def _propose_bonus(self, line: BonusLine, event: dict, ledger, version: str, exception: bool = False,
                       extra_evidence: list | None = None, preparer: str = "code", rule_id: str | None = None,
                       decision_note: str | None = None):
        when = ledger.posting_date(event["at"][:10])
        rate = self.world.fx(line.currency, when)
        sponsor = self.world.sponsor(line.sponsor_id)
        policy = ["REV-02"] + (["REV-04"] if line.contract_ref.endswith("_v2") else []) + (["REV-05"] if line.currency != "USD" else [])
        if line.session == "sprint":
            policy.append("REV-06")
        if exception:
            policy.append("REV-02a")
        evidence = [result_ref(line.season, line.round, line.session, version),
                    {"type": "contract", "ref": f"{line.contract_ref}#{line.clause_id}", "quote": line.quote}] + (extra_evidence or [])
        p = Proposal(
            kind="bonus", effective_date=when, key=line.key, sponsor_id=line.sponsor_id, preparer=preparer,
            memo=f"{sponsor['name']} {line.clause_type.replace('_', ' ')} bonus: car {line.car} ({line.driver_id}) "
                 f"P{line.position} {line.season} R{line.round} {line.session}",
            lines=_fx_lines("1300", "4010", line.amount_orig, line.currency, rate, line.sponsor_id),
            decision=Decision(
                question=f"Is {sponsor['name']}'s clause {line.clause_id} earned by car {line.car} in {line.season} R{line.round} {line.session}?",
                answer=decision_note or f"Yes. Final classification P{line.position}; clause {line.clause_id} pays {fmt(line.amount_orig, line.currency)}.",
                policy_ids=policy, evidence=evidence, outcome="recognize", rule_id=rule_id),
            source_event_id=event["id"],
            basis={"season": line.season, "round": line.round, "session": line.session, "sponsor_id": line.sponsor_id,
                   "clause_id": line.clause_id, "car": line.car, "exception": exception},
        )
        return ledger.propose_entry(p)

    def _propose_reversal(self, bonus: dict, event: dict, ledger, evidence: list):
        amount = next(x["credit_cents"] for x in bonus["lines"] if x["account"] == "4010")
        billed = ledger.active_by_key("bill|" + bonus["key"]) is not None
        credit = "1200" if billed else "1300"
        orig = next(x for x in bonus["lines"] if x["account"] == "4010")
        kw = dict(currency=orig["orig_currency"], orig=orig["orig_amount_cents"], sponsor_id=bonus["sponsor_id"], carrying=True)
        when = ledger.posting_date(event["at"][:10])
        p = Proposal(
            kind="bonus_reversal", effective_date=when, key="rev|" + bonus["key"], reverses_je_id=bonus["je_id"],
            sponsor_id=bonus["sponsor_id"], preparer="code",
            memo=f"Reverse {bonus['memo']}" + (" (credit note: already invoiced)" if billed else ""),
            lines=[Line("4010", debit=amount, **kw), Line(credit, credit=amount, **kw)],
            decision=Decision(
                question=f"Does {bonus['memo']} still stand after the change?",
                answer="No. The changed final classification no longer earns it; reversed in the current open period"
                       + (", as a credit note because it was already invoiced." if billed else "."),
                policy_ids=["REV-02a", "REV-08"], outcome="reverse",
                evidence=[result_ref(bonus["basis"]["season"], bonus["basis"]["round"], bonus["basis"]["session"], "final"),
                          {"type": "journal_entry", "ref": bonus["je_id"]}] + evidence),
            source_event_id=event["id"], basis={**bonus["basis"], "exception": True},
        )
        result = ledger.propose_entry(p)
        if billed:
            for b in ledger.billings():
                if b["je_id"] and b["status"] == "billed" and ledger.entry(b["je_id"])["key"] == "bill|" + bonus["key"]:
                    ledger.set_billing(b["payload"], "credited", "result_changed_after_billing", b["je_id"])
        return result

    def prize_trueup(self, season: int, event: dict, ledger) -> list:
        n = ledger.last_final_round(season)
        total = self.world.gp_rounds_in_season(season)
        finals = ledger.finals_count(season, "race")
        pos, est, why = self.world.prize_estimate(season, n, ledger.overlays())
        prev = ledger.last_prize_estimate(season)
        prev_est = prev["est_cents"] if prev else est
        when = ledger.posting_date(event["at"][:10])
        out = []
        accrual = prorate(prev_est, finals, total) - ledger.prize_booked(season)
        if accrual:
            out.append(ledger.propose_entry(self._prize_proposal(
                "prize_accrual", season, n, accrual, when, event,
                f"Prize money accrual at the current estimate ({fmt(prev_est)}), {finals}/{total} rounds",
                f"Pro-rata accrual: {fmt(prev_est)} x {finals}/{total} less {fmt(ledger.prize_booked(season))} booked")))
        change = prorate(est, finals, total) - ledger.prize_booked(season)
        if change:
            prev_pos = prev["position"] if prev else pos
            out.append(ledger.propose_entry(self._prize_proposal(
                "prize_estimate_change", season, n, change, when, event,
                f"Prize money estimate P{prev_pos} -> P{pos}: {fmt(prev_est)} -> {fmt(est)}",
                f"Re-estimated after R{n}: {why}. Cumulative {fmt(est)} x {finals}/{total}.")))
        ledger.record_prize_estimate(season, n, pos, est, why)
        return out

    def _prize_proposal(self, kind: str, season: int, n: int, amount: int, when: str, event: dict, memo: str, answer: str) -> Proposal:
        dr, cr = ("1250", "4100") if amount > 0 else ("4100", "1250")
        return Proposal(
            kind=kind, effective_date=when, key=f"prize|{season}|R{n}|{kind}", preparer="code", memo=memo,
            lines=[Line(dr, debit=abs(amount)), Line(cr, credit=abs(amount))],
            decision=Decision(question=f"Championship prize money after {season} R{n}", answer=answer,
                              policy_ids=["REV-03"], outcome="estimate",
                              evidence=[{"type": "standings", "ref": f"{season}-after-R{n:02d}"}]),
            source_event_id=event["id"], basis={"season": season, "through_round": n},
        )

    # ------------------------------------------------------------------ billing review (REV-07)

    def on_billing_request(self, event: dict, ledger) -> list:
        return [self.review(event["payload"], ledger, event["id"])]

    def review(self, r: dict, ledger, source_event_id: str = "") -> dict:
        season, rnd, session = r["season"], r["round"], r["session"]
        key = bonus_key(season, rnd, session, r["sponsor_id"], r["clause_id"], r["car"])
        current = ledger.billing(r["request_id"])
        if current and current["status"] in ("billed", "rejected", "credited", "pending_approval"):
            return {"type": "billing", "request_id": r["request_id"], "status": current["status"], "reason": current["reason_code"]}

        def decide(status: str, reason: str, je_id: str | None = None) -> dict:
            if current and current["status"] == status and current["reason_code"] == reason:
                return {"type": "billing", "request_id": r["request_id"], "status": status, "reason": reason, "unchanged": True}
            ledger.set_billing(r, status, reason, je_id)
            ledger.record_decision(Decision(
                question=f"Billing request {r['request_id']}: invoice {r['sponsor_id']} clause {r['clause_id']} for car {r['car']}, "
                         f"{season} R{rnd} {session}, {fmt(r['amount_orig'], r['currency'])}?",
                answer=f"{status}: {reason}", policy_ids=["REV-07"] + (["REV-02a"] if reason == "provisional" else []),
                evidence=[{"type": "billing_request", "ref": r["request_id"]}, result_ref(season, rnd, session,
                          "final" if ledger.is_final(season, rnd, session) else "provisional")],
                outcome=status), preparer="code", subject_type="billing", subject_id=r["request_id"])
            return {"type": "billing", "request_id": r["request_id"], "status": status, "reason": reason, "je_id": je_id}

        if not ledger.is_final(season, rnd, session):
            return decide("hold", "provisional")
        if ledger.open_question(key) and ledger.open_question(key)["status"] == "open":
            return decide("hold", "awaiting_controller")
        bonus = ledger.active_by_key(key)
        if bonus is None:
            clause = next((c for c in self.world.contract_for(r["sponsor_id"], rnd)["clauses"] if c["id"] == r["clause_id"]), None)
            if session == "sprint" and clause and clause["scope"] == "grand_prix":
                return decide("rejected", "sprint_excluded")
            if session == "sprint" and clause and clause["scope"] == "ambiguous":
                return decide("rejected", "excluded_by_ruling")
            was_expected = any(m["key"] == key for m in ledger.memos("expected_bonus", season, rnd))
            return decide("rejected", "overturned" if was_expected else "not_earned")
        if bonus["status"] == "parked":
            return decide("hold", "bonus_pending_approval")
        if ledger.active_by_key("bill|" + key):
            return decide("rejected", "duplicate")
        line = next(x for x in bonus["lines"] if x["account"] == "1300")
        contract_orig = line["orig_amount_cents"]
        corrected = r["amount_orig"] != contract_orig
        p = Proposal(
            kind="bonus_billing", effective_date=ledger.posting_date(ledger.today), key="bill|" + key,
            sponsor_id=r["sponsor_id"], preparer="code",
            memo=f"Invoice {r['sponsor_id']} {bonus['memo']}" + (f" at contract amount (requested {fmt(r['amount_orig'], r['currency'])})" if corrected else ""),
            lines=[Line("1200", debit=line["debit_cents"], currency=line["orig_currency"], orig=contract_orig, sponsor_id=r["sponsor_id"], carrying=True),
                   Line("1300", credit=line["debit_cents"], currency=line["orig_currency"], orig=contract_orig, sponsor_id=r["sponsor_id"], carrying=True)],
            decision=Decision(
                question=f"Approve billing request {r['request_id']}?",
                answer=("Approve at the contract amount " + fmt(contract_orig, line["orig_currency"]) +
                        f"; requested {fmt(r['amount_orig'], r['currency'])}") if corrected else "Approve: final, earned, not yet billed, amount matches contract.",
                policy_ids=["REV-07"], outcome="approve_corrected" if corrected else "approve",
                evidence=[{"type": "billing_request", "ref": r["request_id"]}, {"type": "journal_entry", "ref": bonus["je_id"]},
                          result_ref(season, rnd, session, "final")]),
            source_event_id=source_event_id,
            basis={"bonus_key": key, "season": season, "round": rnd, "session": session, "request_id": r["request_id"], "exception": corrected},
        )
        res = ledger.propose_entry(p)
        if res.status == "posted":
            return decide("billed", "amount_corrected" if corrected else "approved", res.je_id)
        if res.status == "parked":
            return decide("pending_approval", "amount_corrected" if corrected else "approved", res.je_id)
        return decide("error", res.reason or "refused", res.je_id)

    def rereview(self, ledger, season: int | None = None, rnd: int | None = None) -> list:
        out = []
        for b in ledger.billings("hold"):
            r = b["payload"]
            if (season is None or r["season"] == season) and (rnd is None or r["round"] == rnd):
                res = self.review(r, ledger)
                if not res.get("unchanged"):
                    out.append(res)
        for b in ledger.billings("pending_approval"):
            je = ledger.entry(b["je_id"])
            if je["status"] == "posted":
                ledger.set_billing(b["payload"], "billed", b["reason_code"], je["je_id"])
            elif je["status"] in ("rejected", "refused"):
                ledger.set_billing(b["payload"], "rejected", "controller_rejected", je["je_id"])
        return out

    # ------------------------------------------------------------------ cash and periods

    def on_cash_received(self, event: dict, ledger) -> list:
        e = event["payload"]
        sponsor = self.world.sponsor(e["sponsor_id"])
        usd_bal, orig_bal = ledger.ar(sponsor["id"])
        paid = int(e["paid_orig"]) if e.get("paid_orig") is not None else int(round(orig_bal * e.get("fraction", 1.0)))
        if paid <= 0 or orig_bal <= 0:
            return []
        when = ledger.posting_date(event["at"][:10])
        carrying = usd_bal if paid == orig_bal else prorate(usd_bal, paid, orig_bal)
        rate = self.world.fx(sponsor["currency"], when)
        received = to_usd(paid, rate)
        lines = [Line("1000", debit=received, currency=sponsor["currency"], orig=paid, rate=str(rate), sponsor_id=sponsor["id"]),
                 Line("1200", credit=carrying, currency=sponsor["currency"], orig=paid, sponsor_id=sponsor["id"], carrying=True)]
        if received != carrying:
            diff = carrying - received
            lines.append(Line("7100", debit=diff) if diff > 0 else Line("7100", credit=-diff))
        short = paid < orig_bal
        p = Proposal(
            kind="cash_receipt", effective_date=when, key=f"cash|{event['id']}", sponsor_id=sponsor["id"], preparer="code",
            memo=f"Cash from {sponsor['name']}: {fmt(paid, sponsor['currency'])}" + (f" of {fmt(orig_bal, sponsor['currency'])} due (short)" if short else ""),
            lines=lines,
            decision=Decision(question=f"Apply {sponsor['name']} remittance", outcome="apply",
                              answer=f"Applied {fmt(paid, sponsor['currency'])} at {rate}; carrying {fmt(carrying)}; FX {fmt(carrying - received)}"
                                     + ("; balance stays open" if short else ""),
                              policy_ids=["REV-05"], evidence=[{"type": "fx", "ref": f"{sponsor['currency']}-{when}"}]),
            source_event_id=event["id"], basis={"sponsor_id": sponsor["id"], "paid_orig": paid},
        )
        res = ledger.propose_entry(p)
        return [res] + ([ledger.memo("short_payment", f"short|{event['id']}", 0, 0, "", {
            "sponsor_id": sponsor["id"], "paid_orig": paid, "due_orig": orig_bal, "currency": sponsor["currency"]})] if short else [])

    def on_month_end(self, event: dict, ledger) -> list:
        ledger.close_period(event["payload"]["period_id"])
        return []

    def on_season_end(self, event: dict, ledger) -> list:
        return []
