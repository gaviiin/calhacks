from decimal import Decimal

from live_racing.finance_projections import diff, forecast_for_rows, if_finished_now, usd


def _usd(world, cents, cur):
    return int(Decimal(cents) * world.fx(cur, "2024-11-03"))


def test_leading_car_earns_every_clause(world, brazil):
    fc = if_finished_now(world, brazil, {63: 1, 44: 12, 1: 2, 4: 3}, as_of_utc="2024-11-03T16:29:00.000Z")
    by = {(l.sponsor_id, l.clause_id): l for l in fc.lines}
    assert by[("halcyon", "4.1")].amount_usd_cents == 200_000_000 and by[("halcyon", "4.1")].car == 63
    assert by[("arcadia", "4.2")].amount_usd_cents == _usd(world, 40_000_000, "GBP")
    assert by[("volta", "5.1")].amount_usd_cents == _usd(world, 10_000_000, "EUR")
    assert by[("northwind", "6.3")].amount_usd_cents == 15_000_000
    assert fc.amount_cents == sum(l.amount_usd_cents for l in fc.lines)
    assert fc.prize is not None and fc.prize.constructors_position == 4
    assert fc.type == "if_finished_now" and fc.status == "indicative"


def test_fifth_and_eleventh_keep_only_top6_and_points(world, brazil):
    fc = if_finished_now(world, brazil, {63: 5, 44: 11}, as_of_utc=None)
    assert {(l.sponsor_id, l.clause_id, l.car) for l in fc.lines} == {("northwind", "6.3", 63), ("volta", "5.1", 63)}
    assert fc.amount_cents == 15_000_000 + _usd(world, 10_000_000, "EUR")


def test_diff_names_what_was_gained_and_lost(world, brazil):
    a = if_finished_now(world, brazil, {63: 1, 44: 12}, as_of_utc=None)
    b = if_finished_now(world, brazil, {63: 5, 44: 10}, as_of_utc=None)
    d = diff(a, b)
    assert d.before_cents == a.amount_cents and d.after_cents == b.amount_cents and d.delta_cents == b.amount_cents - a.amount_cents
    assert any("Halcyon Energy clause 4.1" in x for x in d.lost) and any("car 44" in x for x in d.gained)
    assert d.text.startswith("Expected sponsor bonuses if the race ended now: $2.74M -> $369k (-$2.37M)")
    assert diff(None, a).delta_cents is None


def test_spa_disqualification_moves_halcyon_from_3m_to_2m(world, spa):
    prov = world.classification(2024, 14, "race", "provisional")
    final = world.classification(2024, 14, "race", "final")
    before = forecast_for_rows(world, spa, prov, as_of_utc=None, type="provisional_classification", status="awaiting_official_classification")
    after = forecast_for_rows(world, spa, final, as_of_utc=None, type="final_classification", status="verified_final")
    halcyon = lambda f: sum(l.amount_usd_cents for l in f.lines if l.sponsor_id == "halcyon")  # noqa: E731
    assert halcyon(before) == 300_000_000 and halcyon(after) == 200_000_000  # v2 podium $1M (round 14 >= 12); car 44 inherits the $2M win
    assert before.amount_cents > after.amount_cents
    d = diff(before, after)
    assert any("car 63" in x for x in d.lost) and any("clause 4.1 win (car 44" in x for x in d.gained)


def test_usd_formatting():
    assert usd(274_000_000) == "$2.74M" and usd(36_900_000) == "$369k" and usd(-110_000_00) == "-$110k" and usd(None) == "unknown" and usd(2550) == "$25.50"
