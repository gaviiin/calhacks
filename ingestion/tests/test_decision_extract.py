"""Parser tests for the decision reader. No network and no Apify."""

import importlib.util
import sys
from pathlib import Path

import pytest

FIXTURES = Path(__file__).resolve().parents[1] / "decision_actor" / "tests" / "fixtures"
EXTRACT_PATH = Path(__file__).resolve().parents[1] / "decision_actor" / "src" / "extract.py"


def _load():
    spec = importlib.util.spec_from_file_location("fia_decision_extract", EXTRACT_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


extract = _load()


def test_doc44_disqualification_ignores_the_word_penalty_in_the_reason():
    parsed = extract.parse_decision(FIXTURES.joinpath("doc44.txt").read_text(), title="Doc 44")
    assert parsed.cars == "63"
    assert parsed.offence.startswith("Breach of Article 4.1")
    assert parsed.outcome == "disqualification"
    assert "disqualified" in parsed.excerpt
    assert "standard penalty" not in parsed.excerpt


def test_nbsp_from_a_real_pdf_extraction_still_parses():
    text = FIXTURES.joinpath("doc44.txt").read_text().replace(" ", "\u00a0")
    parsed = extract.parse_decision(text)
    assert parsed.outcome == "disqualification"
    assert parsed.cars == "63"


def test_no_recognized_outcome_stays_empty():
    parsed = extract.parse_decision(FIXTURES.joinpath("no_outcome.txt").read_text())
    assert parsed.outcome == ""
    assert parsed.cars == "1,14"
    assert parsed.offence.startswith("Alleged impeding")
    assert parsed.excerpt


def test_time_penalty_is_read_from_the_decision_line():
    text = "Infringement Leaving the track and gaining an advantage.\nDecision Car 18 is given a 5 second time penalty.\n"
    parsed = extract.parse_decision(text, title="unused title")
    assert parsed.outcome == "time_penalty"
    assert parsed.cars == "18"
    assert parsed.offence.startswith("Leaving the track")


def test_title_is_the_offence_when_the_pdf_has_no_infringement_line():
    parsed = extract.parse_decision("Decision No further action.\n", title="Summons - Car 4")
    assert parsed.offence == "Summons - Car 4"
    assert parsed.outcome == "no_further_action"
    assert parsed.cars == ""


def test_excerpt_is_capped():
    parsed = extract.parse_decision("Decision " + ("word " * 200))
    assert len(parsed.excerpt) <= extract.EXCERPT_MAX


def test_normalize_fact_rejects_an_unknown_outcome():
    import ingest

    item = {
        "source": "fia",
        "season": 2024,
        "event_slug": "belgian-grand-prix",
        "event_name": "Belgian Grand Prix",
        "document_number": "44",
        "title": "Doc 44 - Infringement - Car 63",
        "document_url": "https://www.fia.com/sites/default/files/decision-document/doc-44.pdf",
        "source_page_url": "https://www.fia.com/documents",
        "cars": "63",
        "offence": "Breach of Article 4.1",
        "outcome": "podium",
        "excerpt": "Car 63 is disqualified.",
        "pdf_sha256": "ab" * 32,
    }
    with pytest.raises(ValueError, match="unknown outcome"):
        ingest.normalize_fact(item, actor_run_id="", ingest_mode="test_fixture", extracted_at="2026-10-24T06:00:00Z")


def test_only_official_fia_urls_are_accepted():
    assert extract.is_official_fia_url("https://www.fia.com/sites/default/files/decision-document/x.pdf")
    assert not extract.is_official_fia_url("http://www.fia.com/x.pdf")
    assert not extract.is_official_fia_url("https://fia.com.example.net/x.pdf")
    assert not extract.is_official_fia_url("https://www.fia.com")
