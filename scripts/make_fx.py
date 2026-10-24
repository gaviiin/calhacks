"""Generate world/fx_rates.csv: SYNTHETIC daily EUR/USD and GBP/USD rates.

Seeded random walk inside realistic 2023-2025 ranges. Not market data.
    python scripts/make_fx.py
"""
import csv
import random
from datetime import date, timedelta
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "world" / "fx_rates.csv"
rng = random.Random(1307)
eur, gbp = 1.0700, 1.2100
start, end = date(2023, 1, 1), date(2025, 12, 31)
with OUT.open("w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["date", "EURUSD", "GBPUSD"])
    d = start
    while d <= end:
        eur = min(1.12, max(1.04, eur + rng.gauss(0, 0.0035)))
        gbp = min(1.34, max(1.20, gbp + rng.gauss(0, 0.0040)))
        w.writerow([d.isoformat(), f"{eur:.4f}", f"{gbp:.4f}"])
        d += timedelta(days=1)
print(f"wrote {OUT}")
