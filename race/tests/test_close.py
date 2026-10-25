"""Stage 7: the seal is deterministic and tamper-evident, the totals add up, and the briefs cite only the snapshot."""

import copy
import hashlib
import json

import pytest

from race import close as C
from race.events import Action, Effect, Entry, EntryLine, Incident, Question, RaceEvent, SimRun
from race.weekend import WeekendState

INFO = {"name": "São Paulo Grand Prix 2024", "short": "São Paulo 2024", "year": 2024, "round": 21, "team": "Williams",
        "sessions": [9627, 9636], "session_names": {"9627": "Qualifying", "9636": "Race"}, "cars": {"23": "Albon", "43": "Colapinto"},
        "next": {"name": "Las Vegas Grand Prix", "date": "2024-11-23"}}


def _ev(session, car, at, lap=0):
    return RaceEvent(kind="car_stopped", at=at, session_key=session, meeting_key=1249, lap=lap, driver_number=car, team_name="Williams")


def _eff(lo, mid, hi, kind="cost"):
    return Effect(kind=kind, bucket="6050", low_cents=lo, mid_cents=mid, high_cents=hi, memo="crash damage", basis="assumption",
                  decided_by="code", why="test")


def _entry(key, inc, cents, recognition, cap):
    return Entry(entry_key=key, incident_key=inc, memo=key, effective_date="2024-11-03", recognition=recognition, cap_relevant=cap,
                 lines=[EntryLine("6050", debit_cents=cents), EntryLine("2100", credit_cents=cents)], at="2024-11-03T18:00:00Z")


def make_state() -> WeekendState:
    st = WeekendState(meeting_key=1249, info=INFO, team="Williams")
    e1, e2, e3 = _ev(9627, 43, "2024-11-03T12:10:00Z"), _ev(9627, 23, "2024-11-03T13:20:00Z"), _ev(9636, 43, "2024-11-03T17:58:00Z", 31)
    st.effects = [(e1, [_eff(30_000_000, 70_000_000, 160_000_000)]),
                  (e2, [_eff(80_000_000, 130_000_000, 400_000_000), _eff(0, 2_000_000, 5_000_000)]),
                  (e3, [_eff(50_000_000, 120_000_000, 300_000_000), _eff(-1, 0, 1, kind="revenue_projection")])]
    for key, ev, sev, parts in (("1249-9627-43-1", e1, "heavy", {"floor": 0.9, "front_wing": 0.8}),
                                ("1249-9627-23-1", e2, "heavy", {"chassis": 0.6, "gearbox": 0.7, "floor": 0.5}),
                                ("1249-9636-43-1", e3, {"light": 0.2, "heavy": 0.8}, {"front_wing": 0.9, "rear_wing": 0.4})):
        st.incidents[key] = Incident(incident_key=key, meeting_key=1249, session_key=ev.session_key, driver_number=ev.driver_number,
                                     team_name="Williams", first_seen_at=ev.at, status="confirmed",
                                     belief={"severity": sev, "parts": parts, "out_of_session": True},
                                     evidence=[{"event_key": ev.key, "kind": ev.kind, "at": ev.at}])
    for e in (_entry("je-1", "1249-9627-43-1", 60_000_000, "first_use", True), _entry("je-2", "1249-9627-23-1", 90_000_000, "already_expensed", True),
              _entry("je-3", "1249-9627-23-1", 2_000_000, "incurred", True), _entry("je-4", "1249-9636-43-1", 5_000_000, "excluded", False)):
        st.entries[e.entry_key] = e
    for a in (Action("a-wo", "1249-9627-23-1", "work_order", "Grove: build chassis 3", due_at="2024-11-15T09:00:00Z", status="auto",
                     updated_at="2024-11-03T14:00:00Z", detail={"displaces": "the Abu Dhabi floor"}),
              Action("a-fr", "1249-9627-23-1", "freight", "Priority air: chassis to Las Vegas", status="awaiting_approval", owner_role="logistics",
                     reversible=False, outward=True, updated_at="2024-11-03T14:00:00Z")):
        st.actions[a.action_key] = a
    st.questions["q-1"] = Question("q-1", "1249-9636-43-1", "damage", "Floor or no floor?", [], "technical_director",
                                   expected_loss_cents=4_000_000, created_at="2024-11-03T18:00:00Z")
    st.sims = [SimRun("sim-base", 1249, "baseline", "2024-11-03T10:00:00Z",
                      {"target_position": 8, "p_target": 0.7183, "prize": {"expected_cents": 7_152_813_250},
                       "sponsor": {"expected_cents": 313_789_000}}),
               SimRun("sim-mid", 1249, "incident:x", "2024-11-03T13:00:00Z", {"target_position": 8, "p_target": 0.5}),
               SimRun("sim-last", 1249, "result:9636", "2024-11-03T18:00:00Z",
                      {"target_position": 8, "p_target": 0.0001, "prize": {"expected_cents": 6_550_083_250},
                       "attribution": {"ours_cents": -249_750, "rivals_cents": -602_480_250, "note": "split"},
                       "sponsor": {"expected_cents": 264_621_000},
                       "rivals": [{"team": "Alpine", "points_start": 16.0, "expected_points": 51.7}],
                       "cap": {"p_overspend": 0.31, "deferral_cents": 120_000_000}})]
    st.now = "2024-11-03T18:05:00Z"
    return st


@pytest.fixture
def state():
    return make_state()


# ---------------------------------------------------------------------- the seal

def test_merkle_root_is_deterministic_and_domain_separated():
    leaves = ["race_effects:{\"a\":1}", "race_entries:{\"b\":2}", "race_actions:{\"c\":3}"]
    assert C.merkle_root(leaves) == C.merkle_root(list(leaves))
    assert C.merkle_root(["x"]) == hashlib.sha256(b"\x00x").hexdigest() != hashlib.sha256(b"x").hexdigest()
    left, right = hashlib.sha256(b"\x00a").digest(), hashlib.sha256(b"\x00b").digest()
    assert C.merkle_root(["a", "b"]) == hashlib.sha256(b"\x01" + left + right).hexdigest()
    assert C.merkle_root([]) == hashlib.sha256(b"").hexdigest()
    # an odd node is carried up, not duplicated: [a, b, c] and [a, b, c, c] differ
    assert C.merkle_root(["a", "b", "c"]) != C.merkle_root(["a", "b", "c", "c"])


def test_root_is_the_same_whatever_order_the_rows_arrived(state, tmp_path):
    a = C.close_weekend(state, snapshot_dir=tmp_path)
    shuffled = make_state()
    shuffled.effects.reverse()
    shuffled.entries = dict(reversed(list(shuffled.entries.items())))
    b = C.close_weekend(shuffled, snapshot_dir=None)
    assert a.root_hash == b.root_hash and a.leaves == b.leaves


def test_root_changes_when_any_leaf_changes(state):
    leaves = C.snapshot_leaves(state)
    root = C.merkle_root(leaves)
    assert {x.split(":", 1)[0] for x in leaves} == {"race_effects", "race_entries", "race_actions", "race_questions", "race_incidents", "race_sims"}
    for i in range(len(leaves)):
        changed = list(leaves)
        changed[i] = changed[i][:-1] + " }"
        assert C.merkle_root(changed) != root, f"leaf {i} is not covered by the root"
    st = make_state()
    st.effects[0][1][0].mid_cents += 1
    assert C.merkle_root(C.snapshot_leaves(st)) != root
    st = make_state()
    st.incidents["1249-9627-43-1"].belief["severity"] = "light"
    assert C.merkle_root(C.snapshot_leaves(st)) != root


def test_seals_the_baseline_and_latest_run_only(state):
    sims = [json.loads(x.split(":", 1)[1])["sim_key"] for x in C.snapshot_leaves(state) if x.startswith("race_sims:")]
    assert sorted(sims) == ["sim-base", "sim-last"]


def test_snapshot_file_reverifies_and_detects_tampering(state, tmp_path):
    c = C.close_weekend(state, snapshot_dir=tmp_path)
    snap = C.load_snapshot(c.close_key, tmp_path)
    assert snap["verified"] and snap["root_hash"] == c.root_hash
    path = tmp_path / f"{c.close_key}.json"
    data = json.loads(path.read_text())
    i = next(n for n, x in enumerate(data["leaves"]) if x.startswith("race_effects:"))
    data["leaves"][i] = data["leaves"][i].replace("crash damage", "crash")
    path.write_text(json.dumps(data))
    assert not C.load_snapshot(c.close_key, tmp_path)["verified"]


# ---------------------------------------------------------------------- totals

def test_close_totals_add_up(state):
    c = C.close_weekend(state, snapshot_dir=None)
    t = c.totals
    assert c.close_key == "close-1249" and c.status == "draft" and len(c.root_hash) == 64
    assert t["race_cost"] == {"low_cents": 160_000_000, "mid_cents": 322_000_000, "high_cents": 865_000_000, "effects": 4}
    assert t["cap_relevant_cents"] == 62_000_000 and t["excluded_cents"] == 5_000_000 and t["already_counted_cents"] == 90_000_000
    assert (t["cap_relevant_cents"] + t["excluded_cents"] + t["already_counted_cents"] == t["entries_cents"]
            == sum(r["cents"] for r in t["by_recognition"].values()) == sum(e.amount_cents for e in state.entries.values()))
    assert sum(r["count"] for r in t["by_recognition"].values()) == t["entries"] == 4
    assert sum(i["mid_cents"] for i in t["incidents"]) == t["race_cost"]["mid_cents"]
    assert [i["severity"] for i in t["incidents"]] == ["heavy", "heavy", "heavy"]
    p = t["prize"]
    assert p["delta_cents"] == 6_550_083_250 - 7_152_813_250 and p["p_p8_before"] == 0.7183 and p["p_p8_after"] == 0.0001
    assert p["attribution"] == {"ours_cents": -249_750, "rivals_cents": -602_480_250}
    assert t["awaiting_count"] == 1 and t["awaiting_person"][0]["key"] == "a-fr"
    assert t["open_questions_count"] == 1
    assert t["work_orders"][0]["days_before_next"] == 8
    assert t["leaves"] == c.leaves == sum(t["by_table"].values())
    assert len(json.dumps(t, separators=(",", ":"))) < 8192
    assert json.loads(c.wire()["totals_json"]) == json.loads(json.dumps(t))


def test_two_crashes_of_one_car_in_one_session_do_not_share_effects():
    st = make_state()
    late = _ev(9636, 43, "2024-11-03T18:30:00Z", 40)
    st.effects.append((late, [_eff(1, 2, 3)]))
    st.incidents["1249-9636-43-2"] = Incident("1249-9636-43-2", 1249, 9636, 43, "Williams", late.at, evidence=[{"event_key": late.key}])
    t = C.close_weekend(st, snapshot_dir=None).totals
    by = {i["key"]: i["mid_cents"] for i in t["incidents"]}
    assert by["1249-9636-43-2"] == 2 and by["1249-9636-43-1"] == 120_000_000


def test_an_empty_weekend_still_seals(tmp_path):
    st = WeekendState(meeting_key=1249, info=INFO, team="Williams")
    c = C.close_weekend(st, snapshot_dir=tmp_path)
    assert c.leaves == 0 and c.root_hash == hashlib.sha256(b"").hexdigest()
    assert set(c.briefs) == set(C.ROLES)


# ---------------------------------------------------------------------- briefs

def test_briefs_cover_every_role_and_say_what_is_provisional(state):
    c = C.close_weekend(state, snapshot_dir=None)
    assert list(c.briefs) == list(C.ROLES)
    for role, text in c.briefs.items():
        assert "provisional" in text.lower(), role
        assert "[" in text, f"{role} brief cites no row"
        assert 1 <= len(text.splitlines()) <= 10, role
    assert "rejected" in c.briefs["head_of_cost_cap"] and "Las Vegas" in c.briefs["technical_director"]
    assert "a-fr" in c.briefs["cfo"] and "rivals' results" in c.briefs["cfo"]
    assert "\n" not in c.briefs["team_principal"]


def test_offline_briefs_cite_only_numbers_and_keys_in_the_snapshot(state):
    c = C.close_weekend(state, snapshot_dir=None)
    snapshot = {"close_key": c.close_key, "root_hash": c.root_hash, "totals": c.totals,
                "rows": [json.loads(x.split(":", 1)[1]) for x in C.snapshot_leaves(state)]}
    nums, keys = C.citable(snapshot)
    for role, text in c.briefs.items():
        assert C.check_brief(text, nums, keys) == [], role
        assert C._MONEY.search(text) or role == "head_of_cost_cap", f"{role} brief has no figure"


def test_check_brief_catches_invented_figures_and_keys(state):
    c = C.close_weekend(state, snapshot_dir=None)
    nums, keys = C.citable({"totals": c.totals})
    assert C.check_brief("Weekend cost $3.22m [totals.race_cost]", nums, keys) == []
    assert C.check_brief("Weekend cost $3.2m", nums, keys) == []  # same figure at lower precision
    assert C.check_brief("Weekend cost $3.5m", nums, keys)
    assert C.check_brief("P(P8) 45%", nums, keys)
    assert C.check_brief("Cost $3.22m [made-up-key]", nums, keys)


def test_claude_briefs_that_invent_numbers_fall_back(state, monkeypatch):
    def fake(snapshot, drafts):
        out = dict(drafts)
        out["cfo"] = "The weekend cost $9.99m [totals.race_cost]."  # not in the snapshot
        out["team_principal"] = drafts["team_principal"].replace("All of it", "Everything")
        return out

    monkeypatch.setattr(C, "claude_briefs", fake)
    c = C.close_weekend(state, offline=False, snapshot_dir=None)
    drafts = C.offline_briefs(c.totals, c.close_key, c.root_hash)
    assert c.briefs["cfo"] == drafts["cfo"] and c.totals["briefs_by"]["cfo"] == "offline"
    assert c.briefs["team_principal"].count("Everything") == 1 and c.totals["briefs_by"]["team_principal"] != "offline"


def test_claude_failure_keeps_the_deterministic_briefs(state, monkeypatch):
    def boom(snapshot, drafts):
        raise TimeoutError("60 s")

    monkeypatch.setattr(C, "claude_briefs", boom)
    c = C.close_weekend(state, offline=False, snapshot_dir=None)
    assert set(c.totals["briefs_by"].values()) == {"offline"}


# ---------------------------------------------------------------------- send

class FakeSink:
    def __init__(self, row):
        self.row, self.sent = row, []
        self.disabled = False

    def sql(self, q):
        return [self.row] if self.row else []

    def close_sent(self, key, at):
        self.sent.append(key)
        return True


def _row(status, state):
    c = C.close_weekend(state, snapshot_dir=None)
    w = c.wire()
    return {**w, "status": status, "approved_by": "CFO" if status != "draft" else ""}


def test_send_refuses_a_draft(state, capsys):
    sink = FakeSink(_row("draft", state))
    assert C.send("close-1249", sink=sink, env={"PITWALL_NOTIFY": "dry"}, outbox=":memory:") == 1
    assert sink.sent == [] and "Refusing" in capsys.readouterr().out


def test_send_dispatches_an_approved_close_dry_run(state, capsys):
    sink = FakeSink(_row("approved", state))
    assert C.send("close-1249", sink=sink, env={"PITWALL_NOTIFY": "dry"}, outbox=":memory:") == 0
    out = capsys.readouterr().out
    assert sink.sent == ["close-1249"]
    assert out.count("dry_run") >= len(C.ROLES) and "technical_director" in out
