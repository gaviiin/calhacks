"""Red team: probe the roles matrix and prove every forbidden call is denied AND logged.

Runs as the red_team identity and, for the probes that need them, as the cap_analyst, controller,
policy_learner and gateway identities (it is the test harness, so it loads their tokens from
agents/identities.json). Each probe:

  1. records the highest audit_log id,
  2. makes one forbidden reducer call (a thrown error counts: the module refused it),
  3. checks that state did not change and that a new audit_log row exists with the probing actor,
     the action, the subject and allowed=false.

Probes: analyst approves its own proposal; analyst posts; red_team proposes; controller approves an
item at or above materiality; non-head actors lock a period; red_team approves; analyst approves a
policy. Prints a table; exit code 1 if any probe is not denied-and-logged.

TODO(data-mutation red team, PLAN.md "Red Team: mutate, probe"): inject mutated records into the
world stream and check the analyst asks or holds instead of classifying. Planned mutation classes
(SCHEMA §5 answer key): duplicate_invoice, split_under_threshold, backdated_locked_period,
bank_details_changed, prior_year_catering_in_jan, catering_as_marketing, pu_below_fair_value,
sick_pay_not_indefinite, tax_credit_not_grossed_up, heritage_parts, non_competition_travel,
maintenance_in_hr, plus a judge-supplied invoice or rule change through an injector endpoint.

Usage:
  uv run python -m agents.redteam --probe [--period 2026-01]
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from typing import Any, Callable

from . import config, identities
from . import reducers as R
from .identities import Actor
from .stdb import StdbClient, StdbError, sql_quote


@dataclass
class ProbeResult:
    name: str
    actor: str
    action: str
    subject: str
    threw: str | None
    state_before: Any
    state_after: Any
    audit_rows: list[dict]
    skipped: str | None = None

    @property
    def denied_logged(self) -> bool:
        return any(not r.get("allowed") for r in self.audit_rows) and not any(r.get("allowed") for r in self.audit_rows)

    @property
    def unchanged(self) -> bool:
        return self.state_before == self.state_after

    @property
    def passed(self) -> bool:
        return self.skipped is None and self.denied_logged and self.unchanged


def _norm_action(a: Any) -> str:
    return str(a or "").replace("_", "").lower()


class RedTeam:
    def __init__(self, stdb: StdbClient, actors: dict[str, Actor], period_key: str = "2026-01"):
        self.stdb = stdb
        self.actors = actors
        self.period_key = period_key
        self.reader = actors["red_team"]

    def sql(self, q: str) -> list[dict]:
        return self.stdb.sql(self.reader.token, q)

    def actor_rows(self, actor: Actor) -> list[dict]:
        # identities are filtered with a bare hex literal (REDUCERS.md)
        return self.sql(f"SELECT * FROM audit_log WHERE actor = 0x{actor.identity}")

    def max_audit_id(self, actor: Actor) -> int:
        return max((int(r["id"]) for r in self.actor_rows(actor)), default=0)

    def new_audit_rows(self, after: int, actor: Actor, action: str, subject: str) -> list[dict]:
        out = []
        for r in self.actor_rows(actor):
            if int(r["id"]) <= after:
                continue
            if r.get("actor") != actor.identity or _norm_action(r.get("action")) != _norm_action(action):
                continue
            if subject and str(r.get("subject_id")) != str(subject):
                continue
            out.append(r)
        return out

    def items(self, state: str | None = None) -> list[dict]:
        q = "SELECT * FROM work_item" + (f" WHERE state = {sql_quote(state)}" if state else "")
        return sorted(self.sql(q), key=lambda r: int(r["id"]))

    def item_state(self, wid: int) -> Any:
        rows = self.sql(f"SELECT * FROM work_item WHERE id = {int(wid)}")
        return rows[0].get("state") if rows else None

    def period_state(self, key: str) -> Any:
        rows = self.sql(f"SELECT * FROM period WHERE key = {sql_quote(key)}")
        return bool(rows[0].get("locked")) if rows else False

    def materiality(self) -> int:
        rows = self.sql("SELECT * FROM setting WHERE key = 'materiality_usd_minor'")
        return int(rows[0]["value"]) if rows else config.MATERIALITY_USD_MINOR

    def any_entry(self) -> str:
        rows = self.sql("SELECT * FROM rulebook_entry WHERE id = 'RELEVANT@SECD-ISS07'")
        return rows[0]["id"] if rows else "RELEVANT@SECD-ISS07"

    def probe(self, name: str, actor_name: str, action: str, reducer: str, args: list, subject: str,
              state: Callable[[], Any]) -> ProbeResult:
        actor = self.actors[actor_name]
        before_id = self.max_audit_id(actor)
        before = state()
        threw = None
        try:
            self.stdb.call(actor.token, reducer, args)
        except StdbError as e:
            threw = f"HTTP {e.status}"
        after = state()
        rows = self.new_audit_rows(before_id, actor, action, subject)
        return ProbeResult(name, actor_name, action, subject, threw, before, after, rows)

    def skip(self, name: str, actor: str, action: str, why: str) -> ProbeResult:
        return ProbeResult(name, actor, action, "-", None, None, None, [], skipped=why)

    def run(self) -> list[ProbeResult]:
        out: list[ProbeResult] = []
        analyst = self.actors["cap_analyst"]
        proposed = self.items("PROPOSED")
        own = [i for i in proposed if i.get("proposed_by") == analyst.identity]
        target = (own or proposed or self.items())
        if target:
            t = target[0]
            out.append(self.probe("analyst approves own proposal", "cap_analyst", "approve", R.APPROVE,
                                  R.approve(t["id"], "red team: self-approval"), str(t["id"]),
                                  lambda: self.item_state(t["id"])))
        else:
            out.append(self.skip("analyst approves own proposal", "cap_analyst", "approve", "no work items"))

        approved = self.items("APPROVED") or self.items()
        if approved:
            t = approved[0]
            out.append(self.probe("analyst posts", "cap_analyst", "post", R.POST,
                                  R.post(t["id"], "JE-REDTEAM-FORGED"), str(t["id"]),
                                  lambda: self.item_state(t["id"])))
            out.append(self.probe("red_team posts", "red_team", "post", R.POST,
                                  R.post(t["id"], "JE-REDTEAM-FORGED"), str(t["id"]),
                                  lambda: self.item_state(t["id"])))
        else:
            out.append(self.skip("analyst posts", "cap_analyst", "post", "no work items"))

        new = self.items("NEW") or self.items()
        if new:
            t = new[0]
            out.append(self.probe("red_team proposes", "red_team", "propose", R.PROPOSE,
                                  R.propose(t["id"], "RELEVANT", self.any_entry(), None, "red team probe", []),
                                  str(t["id"]), lambda: self.item_state(t["id"])))
        else:
            out.append(self.skip("red_team proposes", "red_team", "propose", "no work items"))

        if proposed:
            t = proposed[0]
            out.append(self.probe("red_team approves", "red_team", "approve", R.APPROVE,
                                  R.approve(t["id"], "red team probe"), str(t["id"]),
                                  lambda: self.item_state(t["id"])))

        mat = self.materiality()
        controller = self.actors["controller"]
        big = [i for i in proposed if int(i.get("amount_usd_minor") or 0) >= mat  # literal, as the module
               and i.get("proposed_by") != controller.identity]
        if big:
            t = big[0]
            out.append(self.probe("controller approves above materiality", "controller", "approve", R.APPROVE,
                                  R.approve(t["id"], "red team: above materiality"), str(t["id"]),
                                  lambda: self.item_state(t["id"])))
        else:
            out.append(self.skip("controller approves above materiality", "controller", "approve",
                                 f"no PROPOSED item >= {mat} USD minor"))

        for who in ("cap_analyst", "red_team", "controller", "policy_learner", "gateway", "sync"):
            if who in self.actors:
                out.append(self.probe(f"{who} locks period", who, "lock_period", R.LOCK_PERIOD,
                                      R.lock_period(self.period_key), self.period_key,
                                      lambda: self.period_state(self.period_key)))

        pols = sorted(self.sql("SELECT * FROM policy WHERE state = 'PROPOSED'"), key=lambda r: int(r["id"]))
        if pols:
            p = pols[0]
            # audit subject_id for policy actions is the policy_key (REDUCERS.md)
            out.append(self.probe("analyst approves a policy", "cap_analyst", "approve_policy", R.APPROVE_POLICY,
                                  R.approve_policy(p["id"], "red team probe"), str(p["policy_key"]),
                                  lambda: (self.sql(f"SELECT * FROM policy WHERE id = {int(p['id'])}") or [{}])[0].get("state")))
            learner = self.actors.get("policy_learner")
            if learner and p.get("proposed_by") == learner.identity:
                out.append(self.probe("learner approves own policy", "policy_learner", "approve_policy",
                                      R.APPROVE_POLICY, R.approve_policy(p["id"], "red team probe"), str(p["policy_key"]),
                                      lambda: (self.sql(f"SELECT * FROM policy WHERE id = {int(p['id'])}") or [{}])[0].get("state")))
        return out


def print_table(results: list[ProbeResult]) -> None:
    print(f"{'probe':<40} {'actor':<16} {'action':<14} {'subject':<9} {'state':<24} {'audit':<14} result")
    for r in results:
        if r.skipped:
            print(f"{r.name:<40} {r.actor:<16} {r.action:<14} {'-':<9} {'-':<24} {'-':<14} SKIP ({r.skipped})")
            continue
        st = f"{r.state_before}->{r.state_after}"
        audit = f"{len(r.audit_rows)} row(s) {'denied' if r.denied_logged else 'MISSING'}"
        extra = f" threw {r.threw}" if r.threw else ""
        print(f"{r.name:<40} {r.actor:<16} {r.action:<14} {r.subject:<9} {st:<24} {audit:<14} "
              f"{'PASS' if r.passed else 'FAIL'}{extra}")
    ran = [r for r in results if not r.skipped]
    print(f"{sum(r.passed for r in ran)}/{len(ran)} probes denied and logged; {len(results) - len(ran)} skipped")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m agents.redteam",
                                 description="Probe the roles matrix; every forbidden call must be denied and logged.")
    ap.add_argument("--probe", action="store_true", required=True, help="run the SoD / roles probes")
    ap.add_argument("--period", default="2026-01", help="period used for lock probes")
    args = ap.parse_args(argv)
    data = identities.load()
    actors = {n: identities.get(n) for n in data}
    for need in ("red_team", "cap_analyst", "controller"):
        if need not in actors:
            print(f"missing identity {need}; run agents.bootstrap", file=sys.stderr)
            return 2
    results = RedTeam(StdbClient(), actors, args.period).run()
    print_table(results)
    return 0 if all(r.passed for r in results if not r.skipped) else 1


if __name__ == "__main__":
    sys.exit(main())
