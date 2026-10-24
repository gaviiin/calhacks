import sys
from pathlib import Path

INGESTION = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(INGESTION), str(INGESTION / "actor")]
