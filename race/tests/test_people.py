"""The demo snapshot: frozen a few minutes after Colapinto's lap-32 crash, with the team's earlier decisions replayed."""

from race import people
from race.weekend import Weekend


def test_snapshot_stops_after_the_lap_32_crash_with_the_decisions_in():
    script = people.load_script(1249)
    w = Weekend(1249, pace=0, sink=None, offline=True, forecast=False, quiet=True, until=script["until"], script=script)
    w.run()
    st = w.state
    assert st.now <= script["until"] and st.close is None, "a snapshot is not sealed"
    race_crash = st.incidents["1249-9636-43-2"]
    assert race_crash.status == "assessed" and "replayed" in race_crash.cause
    assert st.actions["1249-9627-23-1:withdraw_car"].detail["chosen"] == "withdraw"
    answered = [q for q in st.questions.values() if q.status == "answered"]
    assert answered and all("(replayed)" in q.answered_by for q in answered)
    assert any(o.trigger == "safety_car" for o in st.options.values()), "the strategy desk priced the lap-30 safety car"
    assert st.sims and st.entries and st.postings
