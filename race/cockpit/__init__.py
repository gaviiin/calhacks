"""The strategy desk's decision cockpit: what each decision the pit wall has would do now, priced, never recommended.

After Varun Sanjeev's decision cockpit (var-updated-live: live_racing/race_state.py, pit_model.py, strategy.py),
ported to the race desk's replay (race/replay.py rows, race/events.py RaceEvent) and money model (race/prize.py,
the assumed sponsor clause in race/season_sim.py, the cost cap via race/cap_forecast.py).

    timing.py      the session's timing feed, indexed once, read strictly as of a moment (no look-ahead)
    pit_model.py   what a stop costs, measured from this race's own stops per condition; tyre pace evidence
    comparator.py  the per-car comparator: stay out, pit now, other compound, the same stop under green
"""
