"""What the Pit Wall agent says when someone asks it something on ASI:One.

Every number in an answer comes from the Pit Wall API. A model (ASI:One's
asi1, when ASI1_API_KEY is set) only picks which question is being asked and
which race or sponsor it is about; it never writes a figure. Without a key, a
keyword parser does the same job.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime

INTENTS = ["summary", "weekend", "approvals", "sponsor", "audit", "impact", "invoices", "approve", "help"]

CIRCUITS = {
    "bahrain": "bahrain", "sakhir": "bahrain", "jeddah": "saudi", "saudi": "saudi", "melbourne": "australian", "australia": "australian",
    "suzuka": "japanese", "japan": "japanese", "shanghai": "chinese", "china": "chinese", "miami": "miami", "imola": "emilia",
    "monaco": "monaco", "montreal": "canadian", "canada": "canadian", "barcelona": "spanish", "spain": "spanish",
    "spielberg": "austrian", "austria": "austrian", "silverstone": "british", "britain": "british", "uk": "british",
    "hungaroring": "hungarian", "hungary": "hungarian", "budapest": "hungarian", "spa": "belgian", "belgium": "belgian",
    "zandvoort": "dutch", "netherlands": "dutch", "monza": "italian", "italy": "italian", "baku": "azerbaijan",
    "singapore": "singapore", "austin": "united states", "cota": "united states", "usa": "united states",
    "mexico": "mexico", "interlagos": "são paulo", "brazil": "são paulo", "sao paulo": "são paulo", "vegas": "las vegas",
    "qatar": "qatar", "lusail": "qatar", "abu dhabi": "abu dhabi", "yas": "abu dhabi",
}
SPONSORS = {"halcyon": "halcyon", "volta": "volta", "arcadia": "arcadia", "northwind": "northwind", "ridgeline": "ridgeline"}
PIT_WALL_HELP = (
    "I'm Pit Wall, Meridian Racing's revenue accountant (a fictional F1 team mirroring Mercedes, run on the real 2024 season). "
    "Ask me:\n- How much revenue have we booked?\n- What happened at Spa? (any race)\n- What's waiting for approval?\n"
    "- What does Halcyon owe us? (any sponsor)\n- Run an audit\n- How much time and money did you save?\n- Which invoices are unpaid?"
)


def money(cents: int, cur: str = "USD") -> str:
    sym = {"USD": "$", "EUR": "€", "GBP": "£"}.get(cur, cur + " ")
    return f"{'-' if cents < 0 else ''}{sym}{abs(cents) / 100:,.0f}"


def hhmm(ts: str | None) -> str:
    if not ts:
        return "?"
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).strftime("%a %H:%M UTC")


# ------------------------------------------------------------------------------- understanding the question


def parse(text: str, rounds: dict[str, str] | None = None) -> dict:
    t = text.lower()
    out: dict = {"intent": None, "round": None, "sponsor": None}
    for name, sid in SPONSORS.items():
        if name in t:
            out["sponsor"] = sid
    rounds = rounds or {}
    m = re.search(r"\b(?:r|round\s*)(\d{1,2})\b", t)
    if m and m.group(1) in rounds:
        out["round"] = int(m.group(1))
    else:
        for alias, key in sorted(CIRCUITS.items(), key=lambda kv: -len(kv[0])):
            if re.search(rf"\b{re.escape(alias)}\b", t):
                hit = next((int(n) for n, name in rounds.items() if key in name.lower()), None)
                if hit:
                    out["round"] = hit
                    break
    if re.search(r"\b(approve|reject|sign off)\b", t):
        out["intent"] = "approve"
    elif re.search(r"audit|tamper|integrity", t):
        out["intent"] = "audit"
    elif re.search(r"waiting|approval|queue|pending|parked|need(s)? me", t):
        out["intent"] = "approvals"
    elif re.search(r"invoice|unpaid|paid|payment|collect", t):
        out["intent"] = "invoices"
    elif re.search(r"save|saved|impact|useful|time|hours|protect", t):
        out["intent"] = "impact"
    elif out["round"] is not None or re.search(r"happen|weekend|race|grand prix|disqualif|dsq", t):
        out["intent"] = "weekend"
    elif out["sponsor"]:
        out["intent"] = "sponsor"
    elif re.search(r"revenue|earn|booked|money|how much|total|summary|status|books", t):
        out["intent"] = "summary"
    else:
        out["intent"] = "help"
    return out


def parse_with_model(text: str, rounds: dict[str, str], client=None) -> dict:
    """ASI:One picks the intent and entities; falls back to the keyword parser on any problem."""
    base = parse(text, rounds)
    if client is None:
        return base
    try:
        r = client.chat.completions.create(model=os.environ.get("ASI1_MODEL", "asi1"), max_tokens=120, messages=[
            {"role": "system", "content": "Classify a question to a racing team's finance agent. Reply with JSON only: "
                                          f'{{"intent": one of {INTENTS}, "round": round number or null, "sponsor": one of '
                                          f'{list(SPONSORS)} or null}}. Rounds: {json.dumps(rounds)}'},
            {"role": "user", "content": text}])
        raw = r.choices[0].message.content
        data = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
        intent = data.get("intent") if data.get("intent") in INTENTS else base["intent"]
        rnd = data.get("round")
        rnd = int(rnd) if str(rnd).isdigit() and str(rnd) in rounds else base["round"]
        sponsor = data.get("sponsor") if data.get("sponsor") in SPONSORS else base["sponsor"]
        return {"intent": intent, "round": rnd, "sponsor": sponsor, "parser": "asi1"}
    except Exception:  # noqa: BLE001 - the keyword parser is always there
        return {**base, "parser": "keywords"}


# ------------------------------------------------------------------------------- answers (numbers only from the API)


def answer_summary(s: dict) -> str:
    r = s["revenue"]
    owed = [f"{k.title()} {v}" for k, v in s["receivables"].items() if v.lstrip("$€£") not in ("0.00", "-0.00")]
    w = s["waiting"]
    lines = [f"Meridian Racing, {s['season']} season, booked through Round {s['last_final_round']} ({s['last_final_race']}).",
             f"Revenue {s['total_revenue']}: base fees {r['base']}, performance bonuses {r['bonus']}, prize money {r['prize']}.",
             f"Books tie: {'yes' if s['books_tie'] else 'NO'}."]
    lines.append("Sponsors owe: " + (", ".join(owed) if owed else "nothing outstanding") + ".")
    if any(w.values()):
        lines.append(f"Waiting for a person: {w['parked_entries']} entries, {w['open_questions']} questions, {w['held_billing']} held invoices.")
    if s.get("audit"):
        lines.append(f"Last independent audit: {s['audit']['opinion']} ({s['audit']['findings']} findings).")
    return "\n".join(lines)


def answer_weekend(w: dict) -> str:
    docs = w["fia_documents"]
    prov = next((d for d in docs if d["kind"] == "provisional_race_classification"), None)
    final = next((d for d in docs if d["kind"] == "final_race_classification"), None)
    team_cars = {m["car"] for m in w["memos"] if m["kind"] == "expected_bonus"}
    trouble = [d for d in docs if d["kind"] in ("summons", "infringement", "decision") and set(d["cars"]) & team_cars]
    booked = [m for m in w["memos"] if m["kind"] == "expected_bonus" and m["status"] == "booked"]
    avoided = [m for m in w["memos"] if m["kind"] == "expected_bonus" and m["status"] == "avoided"]
    out = [f"{w['name']} (Round {w['round']})."]
    if prov:
        out.append(f"{hhmm(prov['at'])}: FIA provisional classification. Pit Wall noted the expected bonuses as memos only; nothing is booked on a provisional result (REV-02a).")
    for d in trouble:
        out.append(f"{hhmm(d['at'])}: FIA {d['kind']} for car {', '.join(map(str, d['cars']))}: \"{d['title']}\".")
    alert = next((m for m in w["memos"] if m["kind"] == "alert"), None)
    if alert:
        out.append(f"Pit Wall alerted the controller: {alert['text']}")
    if final:
        out.append(f"{hhmm(final['at'])}: FIA Final Classification.")
    if avoided:
        out.append("Never booked because the final result didn't earn them: " + "; ".join(
            f"{m['sponsor_id'].title()} {m['clause_id']} car {m['car']} ({money(m['amount_orig'], m['currency'])})" for m in avoided) + ".")
    if booked:
        out.append("Booked once final: " + "; ".join(
            f"{m['sponsor_id'].title()} {m['clause_id']} car {m['car']} P{m['position']} ({money(m['amount_orig'], m['currency'])})" for m in booked) + ".")
    rejected = [b for b in w["billing"] if b["status"] == "rejected"]
    billed = [b for b in w["billing"] if b["status"] == "billed"]
    if w["billing"]:
        out.append(f"Commercial team's invoice requests: {len(billed)} billed, {len(rejected)} rejected"
                   + (f" ({', '.join(sorted({b['reason_code'] for b in rejected}))})" if rejected else "") + ".")
    if not booked and not avoided:
        out.append("No Meridian bonuses were in play this weekend.")
    return "\n".join(out)


def answer_approvals(q: dict) -> str:
    latest = f"\nMost recent alert: {q['alerts'][-1]['text'][:240]}" if q.get("alerts") else ""
    if not (q["parked"] or q["questions"] or q["held_billing"]):
        return "Nothing is waiting for a person right now. Every entry so far posted under the kernel's checks or was approved." + latest
    out = []
    for e in q["parked"]:
        out.append(f"- {e['memo']}: {money(e['total_cents'])}, needs {' and '.join(e['needs'])} ({e['reason']})")
    for x in q["questions"]:
        out.append(f"- Question for the {x['to_role']}: {x['text'][:200]}")
    for b in q["held_billing"]:
        out.append(f"- Held invoice: {b['sponsor_id'].title()} car {b['car']} {money(b['amount_orig'], b['currency'])} ({b['reason']})")
    return ("Waiting for a person:\n" + "\n".join(out) + latest
            + "\nApprovals happen in Pit Wall, Teams, Slack or a signed email link, never in this chat.")


def answer_sponsor(sponsors: list[dict], sid: str) -> str:
    s = next((x for x in sponsors if x["sponsor_id"] == sid), None)
    if s is None:
        return f"I don't know a sponsor called {sid}."
    b = s["billing"]
    return (f"{s['name']} ({s['currency']}): owes {s['receivable']}. Bonuses earned {s['bonuses_earned']}, reversed {s['bonuses_reversed']}. "
            f"Invoice requests: {b['billed']} billed, {b['rejected']} rejected, {b['hold']} on hold, {b['credited']} credited.")


def answer_audit(a: dict) -> str:
    s = a["summary"]
    out = [f"Independent audit as of {a['as_of']}: opinion {a['opinion'].upper()}.",
           f"Tested {s['posted']} posted entries; {len(a['sample'])} re-performed from contracts, results and FX; {s['findings']} findings "
           f"({s['high']} high, {s['medium']} medium, {s['low']} low)."]
    for f in a["findings"][:3]:
        out.append(f"- [{f['severity']}] {f['title']}: {f['detail'][:160]}")
    out.append(f"The auditor is read-only and runs separately from the preparer; reviewer: {a['reviewer'].get('backend')}.")
    return "\n".join(out)


def answer_impact(i: dict) -> str:
    h, e = i["headline"], i["effort"]
    return (f"{h['entries_posted']} entries posted, {h['posted_without_a_person']} ({h['straight_through_rate']:.1%}) with no person involved. "
            f"Dollars protected from wrong or early invoices: {h['dollars_protected']}. "
            f"Bonuses booked as soon as the FIA result is final; a month-end close would take a median {h['manual_close_days_after_race_median']} days. "
            f"About {e['analyst_hours_replaced']} analyst hours of entry and billing checks done; people spent about {e['people_minutes_spent']:.0f} minutes "
            f"(assumes {e['assumptions']['minutes_per_manual_entry']:.0f} min per entry).")


def answer_invoices(inv: list[dict]) -> str:
    if not inv:
        return "No open bonus invoices: everything billed has been paid or settled."
    total: dict[str, int] = {}
    for x in inv:
        total[x["currency"]] = total.get(x["currency"], 0) + x["amount_orig"]
    lines = [f"{len(inv)} open bonus invoice(s), " + ", ".join(money(v, k) for k, v in total.items()) + ":"]
    for x in inv[:8]:
        lines.append(f"- {x['request_id']} {x['sponsor']} {x['amount']} for car {x['car']}, {x['season']} R{x['round']} {x['session']} "
                     f"(clause {x['clause_id']}); payment {x['payment']['status']}")
    return "\n".join(lines)


def respond(text: str, pw, llm=None) -> str:
    """The whole turn: understand, call the API, answer. Never raises."""
    try:
        s = pw.summary()
        rounds = {str(k): v for k, v in s["rounds"].items()}
        q = parse_with_model(text, rounds, llm)
        it = q["intent"]
        if it == "summary":
            return answer_summary(s)
        if it == "weekend":
            rnd = q["round"] or s["last_final_round"]
            if int(rnd) > s["last_final_round"]:
                return f"{rounds.get(str(rnd), 'That race')} hasn't been run yet in this replay (booked through Round {s['last_final_round']})."
            return answer_weekend(pw.weekend(int(rnd)))
        if it == "approvals":
            return answer_approvals(pw.queue())
        if it == "sponsor":
            return answer_sponsor(pw.sponsors(), q["sponsor"])
        if it == "audit":
            return answer_audit(pw.audit())
        if it == "impact":
            return answer_impact(pw.impact())
        if it == "invoices":
            return answer_invoices(pw.invoices())
        if it == "approve":
            return ("I can't approve or reject entries, and nobody can through this chat: approvals need a named person (controller or CFO) "
                    "and the ledger refuses agents (kernel check K11). Use the signed link in your Teams card or email.")
        return PIT_WALL_HELP
    except Exception as exc:  # noqa: BLE001
        return f"I couldn't reach Pit Wall's books just now ({type(exc).__name__}). Is the API running at {getattr(pw, 'base', '?')}?"
