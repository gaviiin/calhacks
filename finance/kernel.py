"""The kernel: deterministic checks every proposed entry must pass before it posts.

Nothing an agent (or a person, or code) proposes reaches the ledger without
these checks. Each check re-performs, from the world and the ledger, what the
proposal claims. A failure returns a reason written so the preparer can act on it.

    K1  debits equal credits; every line one-sided and positive
    K2  accounts allowed for the entry kind
    K3  period open
    K4  amount re-computed from the cited contract, result, schedule or estimate
    K5  bonus result is final
    K6  contract version in effect for that round
    K7  FX rate is the table rate for the date; USD re-computed
    K8  no duplicate (same bonus, billing or reversal already active)
    K9  a reversal references a posted entry and nets it exactly
    K10 a person decides what code could not settle: parks estimates, reversals, exceptions and anything
        an agent prepared, at any amount, for the controller (and the CFO as well at $1M or more)
    K11 segregation of duties at approval
    K12 evidence: policy IDs exist; agent entries cite a source; every quote is verbatim
"""

from __future__ import annotations

import json
from functools import cached_property

from .bonuses import bonuses_for
from .config import CAPTURES_DIR, CFO_CENTS, KIND_ACCOUNTS
from .money import prorate, to_usd


def ok(cid: str) -> dict:
    return {"id": cid, "result": "pass"}


def fail(cid: str, reason: str) -> dict:
    return {"id": cid, "result": "fail", "reason": reason}


class Kernel:
    def __init__(self, world, captures_dir=CAPTURES_DIR):
        self.world = world
        self.captures_dir = captures_dir

    @cached_property
    def fia_titles(self) -> dict[str, str]:
        """document_url -> title, from every saved Apify capture."""
        out = {}
        for path in sorted(self.captures_dir.glob("*.json")):
            for item in json.loads(path.read_text()).get("items", []):
                out[item["document_url"]] = item["title"]
        return out

    # ------------------------------------------------------------------ entry checks

    def check(self, p, ledger) -> list[dict]:
        def safe(cid, fn, *args):
            try:
                return fn(*args)
            except (KeyError, ValueError, TypeError, StopIteration) as exc:
                return fail(cid, f"could not check: missing or malformed {exc}")

        out = [safe("K1", self.k1, p), safe("K2", self.k2, p), safe("K3", self.k3, p, ledger),
               safe("K4", self.k4, p, ledger), safe("K5", self.k5, p, ledger), safe("K6", self.k6, p),
               safe("K7", self.k7, p), safe("K8", self.k8, p, ledger), safe("K9", self.k9, p, ledger), safe("K12", self.k12, p)]
        if not any(c["result"] == "fail" for c in out):
            out.append(safe("K10", self.k10, p))
        return out

    def k1(self, p) -> dict:
        if len(p.lines) < 2:
            return fail("K1", "an entry needs at least two lines")
        for line in p.lines:
            if line.debit < 0 or line.credit < 0 or (line.debit > 0) == (line.credit > 0):
                return fail("K1", f"line on {line.account} must have exactly one positive side")
        dr, cr = sum(x.debit for x in p.lines), sum(x.credit for x in p.lines)
        return ok("K1") if dr == cr else fail("K1", f"debits {dr} != credits {cr}")

    def k2(self, p) -> dict:
        allowed = KIND_ACCOUNTS.get(p.kind)
        if allowed is None:
            return fail("K2", f"unknown entry kind {p.kind!r}")
        bad = [x.account for x in p.lines if x.account not in allowed]
        return ok("K2") if not bad else fail("K2", f"{p.kind} may not touch account(s) {', '.join(bad)}; allowed: {', '.join(sorted(allowed))}")

    def k3(self, p, ledger) -> dict:
        period = p.effective_date[:7]
        if ledger.period_status(period) != "open":
            return fail("K3", f"period {period} is closed; post the correction in the current open period ({ledger.today[:7]})")
        return ok("K3")

    def _expected_lines(self, p, ledger) -> tuple[list[tuple], str | None]:
        """(expected (account, debit, credit) triples, error). Empty list = not re-performed for this kind."""
        b, w = p.basis, self.world
        if p.kind == "base_recognition":
            sponsor = w.sponsor(b["sponsor_id"])
            n = w.gp_rounds_in_season(b["season"])
            share = sponsor["base_fee"] // n
            if b["round"] == n:
                share = sponsor["base_fee"] - share * (n - 1)
            usd = to_usd(share, w.fx(sponsor["currency"], p.effective_date))
            if any(x.orig not in (None, share) for x in p.lines):
                return [], f"base share for {sponsor['id']} R{b['round']} is {share} {sponsor['currency']} cents"
            return [("1200", usd, 0), ("4000", 0, usd)], None
        if p.kind == "bonus":
            rows = w.classification(b["season"], b["round"], b["session"], "final", ledger.overlays())
            lines, _ = bonuses_for(w, b["season"], b["round"], b["session"], rows, ledger.rules)
            match = next((x for x in lines if x.key == p.key), None)
            if match is None:
                return [], "the cited final result does not earn this bonus under the contract in effect"
            usd = to_usd(match.amount_orig, w.fx(match.currency, p.effective_date))
            return [("1300", usd, 0), ("4010", 0, usd)], None
        if p.kind == "bonus_billing":
            bonus = ledger.active_by_key(b["bonus_key"])
            if bonus is None or bonus["status"] != "posted":
                return [], "no posted, unreversed bonus to bill for this key"
            carrying = next(x["debit_cents"] for x in bonus["lines"] if x["account"] == "1300")
            return [("1200", carrying, 0), ("1300", 0, carrying)], None
        if p.kind in ("prize_accrual", "prize_estimate_change"):
            season, n = b["season"], ledger.last_final_round(b["season"])
            if n != b["through_round"]:
                return [], f"prize basis says through R{b['through_round']} but R{n} is the last final round"
            total = w.gp_rounds_in_season(season)
            finals = ledger.finals_count(season, "race")
            booked = ledger.prize_booked(season)
            prev = ledger.last_prize_estimate(season)
            _, new_est, _ = w.prize_estimate(season, n, ledger.overlays())
            prev_est = prev["est_cents"] if prev else new_est  # the first estimate is not a change
            accrual = prorate(prev_est, finals, total) - booked if p.kind == "prize_accrual" else None
            if p.kind == "prize_accrual":
                amount = accrual
            else:
                amount = prorate(new_est, finals, total) - booked
            if amount == 0:
                return [], "nothing to book"
            dr, cr = ("1250", "4100") if amount > 0 else ("4100", "1250")
            return [(dr, abs(amount), 0), (cr, 0, abs(amount))], None
        if p.kind == "cash_receipt":
            sponsor = w.sponsor(b["sponsor_id"])
            usd_bal, orig_bal = ledger.ar(sponsor["id"])
            paid = int(b["paid_orig"])
            if paid <= 0 or paid > orig_bal:
                return [], f"payment {paid} exceeds the open receivable {orig_bal}"
            carrying = usd_bal if paid == orig_bal else prorate(usd_bal, paid, orig_bal)
            received = to_usd(paid, w.fx(sponsor["currency"], p.effective_date))
            out = [("1000", received, 0), ("1200", 0, carrying)]
            if received != carrying:
                out.append(("7100", carrying - received, 0) if carrying > received else ("7100", 0, received - carrying))
            return out, None
        return [], None

    def k4(self, p, ledger) -> dict:
        if p.kind == "bonus_reversal":
            return ok("K4")  # re-performed by K9
        try:
            expected, error = self._expected_lines(p, ledger)
        except (KeyError, ValueError) as exc:
            return fail("K4", f"could not re-perform: {exc}")
        if error:
            return fail("K4", error)
        got = sorted((x.account, x.debit, x.credit) for x in p.lines)
        if expected and got != sorted(expected):
            return fail("K4", f"re-performed lines {sorted(expected)} differ from proposed {got}")
        return ok("K4")

    def k5(self, p, ledger) -> dict:
        if p.kind not in ("bonus", "bonus_billing"):
            return ok("K5")
        b = p.basis
        if not ledger.is_final(b["season"], b["round"], b["session"]):
            return fail("K5", f"{b['season']} R{b['round']} {b['session']} is still provisional (REV-02a); "
                              "wait for the FIA Final Classification")
        return ok("K5")

    def k6(self, p) -> dict:
        if p.kind != "bonus":
            return ok("K6")
        b = p.basis
        in_effect = self.world.contract_for(b["sponsor_id"], b["round"])["contract_ref"]
        cited = [e["ref"].split("#")[0] for e in p.decision.evidence if e.get("type") == "contract"]
        if in_effect not in cited:
            return fail("K6", f"contract in effect for R{b['round']} is {in_effect}; cited {cited or 'none'} (REV-04)")
        return ok("K6")

    def k7(self, p) -> dict:
        for line in p.lines:
            if line.carrying or line.currency == "USD" or line.account in ("1000", "7100"):
                continue
            if line.orig is None or line.rate is None:
                return fail("K7", f"{line.currency} line on {line.account} needs its original amount and rate")
            table = self.world.fx(line.currency, p.effective_date)
            from decimal import Decimal

            if Decimal(line.rate) != table:
                return fail("K7", f"{line.currency} rate {line.rate} on {p.effective_date} should be {table} (REV-05)")
            usd = to_usd(line.orig, table)
            if (line.debit or line.credit) != usd:
                return fail("K7", f"{line.orig} {line.currency} cents at {table} is {usd} USD cents, not {line.debit or line.credit}")
        return ok("K7")

    def k8(self, p, ledger) -> dict:
        if not p.key:
            return ok("K8") if p.kind not in ("bonus", "bonus_billing", "bonus_reversal", "base_recognition") else fail("K8", "entry needs a key")
        if p.kind in ("prize_accrual", "prize_estimate_change", "cash_receipt"):
            return ok("K8")
        existing = ledger.active_by_key(p.key)
        if existing is not None:
            return fail("K8", f"{p.key} is already {existing['status']} as {existing['je_id']}")
        return ok("K8")

    def k9(self, p, ledger) -> dict:
        if p.kind != "bonus_reversal":
            return ok("K9") if not p.reverses_je_id else fail("K9", "only a bonus_reversal may reference another entry")
        try:
            orig = ledger.entry(p.reverses_je_id)
        except KeyError:
            return fail("K9", f"reversed entry {p.reverses_je_id} does not exist")
        if orig["kind"] != "bonus" or orig["status"] != "posted":
            return fail("K9", f"{p.reverses_je_id} is a {orig['status']} {orig['kind']}, not a posted bonus")
        if orig["reversed_by"] or ledger.pending_reversal(p.reverses_je_id):
            return fail("K9", f"{p.reverses_je_id} is already reversed or has a reversal pending")
        amount = next(x["credit_cents"] for x in orig["lines"] if x["account"] == "4010")
        billed = ledger.active_by_key("bill|" + orig["key"]) is not None
        credit_account = "1200" if billed else "1300"
        expected = sorted([("4010", amount, 0), (credit_account, 0, amount)])
        got = sorted((x.account, x.debit, x.credit) for x in p.lines)
        if got != expected:
            return fail("K9", f"reversal must be {expected} ({'billed: credit note to 1200' if billed else 'unbilled: credit 1300'})")
        return ok("K9")

    def k10(self, p) -> dict:
        # Code that books from the contract and the final result posts at any size; a person decides an
        # estimate, a reversal, an exception to the contract or the request, and whatever an agent
        # prepared. The amount only picks who: the controller, and the CFO as well at $1M or more.
        total = sum(x.debit for x in p.lines)
        if p.preparer != "code":
            why = "was prepared by an agent: no rule covered it"
        elif p.kind == "prize_estimate_change":
            why = "is an estimate"
        elif p.kind == "bonus_reversal":
            why = "reverses a booked bonus"
        elif p.basis.get("exception"):
            why = "is an exception to the contract or the request"
        else:
            return ok("K10")
        needs = ["controller", "cfo"] if total >= CFO_CENTS else ["controller"]
        return {"id": "K10", "result": "park", "needs": needs,
                "reason": f"${total / 100:,.0f} {p.kind} {why}; needs {' and '.join(needs)}"}

    def k12(self, p) -> dict:
        d = p.decision
        known = self.world.policy_ids()
        if not d.policy_ids:
            return fail("K12", "decision cites no policy")
        unknown = [x for x in d.policy_ids if x not in known]
        if unknown:
            return fail("K12", f"unknown policy id(s) {unknown}")
        sources = [e for e in d.evidence if e.get("type") in ("contract", "race_result", "fia_document", "standings", "billing_request", "fx", "schedule")]
        if p.preparer != "code" and not sources:
            return fail("K12", "an agent-prepared entry must cite at least one source document")
        for e in d.evidence:
            quote = e.get("quote")
            if not quote:
                continue
            if e["type"] == "contract":
                text = self.world.contract_text(e["ref"].split("#")[0])
            elif e["type"] == "fia_document":
                text = self.fia_titles.get(e.get("url", ""), "")
            elif e["type"] == "policy":
                text = self.world.policy_text()
            else:
                continue
            if quote not in text:
                return fail("K12", f"quote not found verbatim in {e['type']} {e.get('ref') or e.get('url')}: {quote[:60]!r}")
        return ok("K12")

    # ------------------------------------------------------------------ approvals

    def check_approval(self, je, approver: str, role: str, ledger) -> dict:
        if approver == "code" or approver.startswith("agent:") or approver == "saboteur":
            return fail("K11", f"{approver} may not approve entries")
        if approver == je["preparer"]:
            return fail("K11", "the preparer of an entry cannot approve it")
        needs = json.loads(je["needs"] or "[]")
        if role not in needs:
            return fail("K11", f"{role} approval is not what this entry needs ({needs})")
        done = ledger.q("SELECT approver FROM approvals WHERE je_id=? AND decision='approve'", je["je_id"])
        if any(r["approver"] == approver for r in done):
            return fail("K11", "one person cannot give two of the required approvals")
        return ok("K11")

    def check_at_post(self, je, ledger) -> str | None:
        """Re-check a parked entry when its last approval arrives. Returns a reason to refuse, or None."""
        if ledger.period_status(je["period_id"]) != "open":
            return f"period {je['period_id']} closed while the entry waited; re-propose it in the current period"
        if je["kind"] == "bonus_reversal" and je["reverses_je_id"]:
            orig = ledger.entry(je["reverses_je_id"])
            if orig["reversed_by"]:
                return "the original entry was already reversed"
        return None
