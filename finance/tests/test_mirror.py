from finance.sim import new_run
from finance.spacetime_mirror import SpacetimeMirror


class Recorder(SpacetimeMirror):
    def __init__(self):
        super().__init__("test-run", base_url="http://unused", database="x")
        self.calls = []

    def call(self, reducer, args):
        self.calls.append((reducer, args))


def test_mirror_sends_balanced_entries_and_review_status(world, store, tmp_path):
    run = new_run(2024, world=world, store=store, data_dir=tmp_path, requests=[], cash=False)
    rec = Recorder()
    run.ledger.listeners.append(rec)
    run.run_until(lambda e: e["payload"].get("round") == 15)
    entries = [a for r, a in rec.calls if r == "mirror_entry"]
    assert entries
    for entry, lines in entries:
        assert sum(x["debit_cents"] for x in lines) == sum(x["credit_cents"] for x in lines)
        assert set(entry) >= {"je_id", "run_id", "status", "total_cents"}
    items = [a for r, a in rec.calls if r == "mirror_item"]
    assert items and all(isinstance(a, list) and len(a) == 6 and all(isinstance(x, str) for x in a) for a in items)
    reviews = [a for r, a in rec.calls if r == "set_review_status"]
    assert any(status == "linked_to_entry" for _, status in reviews)  # Spa summons/infringement raised an alert
    assert all(len(key) == 64 for key, _ in reviews)
