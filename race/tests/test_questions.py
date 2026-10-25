"""Stage 5: who is asked, what the buttons say, and what an answer changes."""

from race.questions import apply_answers, expected_loss, severity_band
from race.weekend import Weekend


def weekend() -> Weekend:
    return Weekend(1249, pace=0, sink=None, offline=True, forecast=False, quiet=True)


def test_bands_order_by_severity_and_the_loss_grows_with_doubt():
    assert severity_band("light")[1] < severity_band("moderate")[1] < severity_band("heavy")[1]
    sure, _ = expected_loss({"heavy": 0.95, "moderate": 0.05, "light": 0.0})
    torn, top = expected_loss({"heavy": 0.4, "moderate": 0.4, "light": 0.15})
    assert top == "heavy" and torn > sure > 0


def test_each_williams_crash_asks_the_chief_mechanic_once_with_two_lived_cases():
    w = weekend()
    w.run()
    qs = {q.incident_key: q for q in w.state.questions.values()}
    stops = [k for k, inc in w.state.incidents.items() if inc.belief.get("impact_kph")]
    assert len(stops) == 3 and all(k in qs for k in stops), "the three telemetry stops each ask"
    for k in stops:
        q = qs[k]
        assert q.route_role == "chief_mechanic" and len(q.options) == 2 and q.options[0]["severity"] != q.options[1]["severity"]
        assert q.default_option in ("a", "b") and q.deadline_at
        assert all(o["band"][0] <= o["band"][1] <= o["band"][2] for o in q.options)
    assert len({q.question_key for q in w.state.questions.values()}) == len(w.state.questions), "never asked twice"


def test_an_answer_assesses_the_incident_corrects_the_line_and_teaches_the_store():
    w = weekend()
    w.sessions = [9627]
    w.run()
    q = next(q for q in w.state.questions.values() if q.incident_key.endswith("-43-1"))
    w.state.applied_answers.discard(q.question_key)  # the deadline may have defaulted it during the run
    moderate = next((o for o in q.options if o["severity"] == "moderate"), q.options[-1])
    q.status, q.answer, q.answered_by = "answered", {"option": moderate["id"]}, "Chief Mechanic"
    before = len(w.state.replay.precedents)
    changed = apply_answers(w.state, None, w.book)
    inc = w.state.incidents[q.incident_key]
    assert changed == [inc] and inc.status == "assessed" and inc.belief["assessed_as"] == moderate["severity"]
    assert "Chief Mechanic answered" in inc.cause
    assert len(w.state.replay.precedents) == before + 1, "the answer joins the live store"
    lines = [e for ev, effs in w.state.effects for i, e in enumerate(effs) if f"{ev.key}:{i}" in q.effect_keys]
    assert lines and all(e.status in ("confirmed", "corrected") for e in lines)
    assert apply_answers(w.state, None, w.book) == [], "an answer is applied once"
