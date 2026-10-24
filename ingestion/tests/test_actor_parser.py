from pathlib import Path

from src import fia

FIXTURES = Path(__file__).resolve().parent.parent / "actor" / "tests" / "fixtures"
SEASON_2024 = "https://www.fia.com/documents/championships/fia-formula-one-world-championship-14/season/season-2024-2043"
BELGIAN_2024 = SEASON_2024 + "/event/Belgian%20Grand%20Prix"


def read(name: str) -> str:
    return (FIXTURES / name).read_text()


def test_finds_season_url_from_championship_page():
    assert fia.find_season_url(read("championship.html"), 2024) == SEASON_2024
    assert fia.find_season_url(read("championship.html"), 1999) is None


def test_finds_event_by_slug_including_accents():
    assert fia.find_event_url(read("season-2024.html"), 2024, "belgian-grand-prix") == (
        BELGIAN_2024,
        "Belgian Grand Prix",
    )
    url, name = fia.find_event_url(read("season-2024.html"), 2024, "sao-paulo-grand-prix")
    assert name == "São Paulo Grand Prix" and url.endswith("/event/S%C3%A3o%20Paulo%20Grand%20Prix")
    assert fia.find_event_url(read("season-2024.html"), 2024, "atlantis-grand-prix") is None


def test_parses_rows_and_skips_recalled_documents():
    listing = fia.parse_document_rows(read("belgian-2024-event.html"), page_url=BELGIAN_2024)
    assert listing.recalled_count == 1
    assert [r.document_number for r in listing.rows] == ["47", "46", "45", "44", "43", "42", "41"]
    doc44 = listing.rows[3]
    assert doc44.title == "Doc 44 - Infringement - Car 63 - Technical non-compliance (Weight)"
    assert doc44.published_at == "28.07.24 18:53 CET"
    assert doc44.document_url == (
        "https://www.fia.com/sites/default/files/decision-document/"
        "2024%20Belgian%20Grand%20Prix%20-%20Infringement%20-%20Car%2063%20-%20"
        "Technical%20non-compliance%20%28Weight%29.pdf"
    )


def test_decision_filter():
    titles = [r.title for r in fia.parse_document_rows(read("belgian-2024-event.html"), BELGIAN_2024).rows]
    kept = [t for t in titles if fia.is_decision_or_classification(t)]
    assert "Doc 44 - Infringement - Car 63 - Technical non-compliance (Weight)" in kept
    assert "Doc 41 - Provisional Race Classification" in kept
    assert "Doc 47 - Championship Points" not in kept
    assert "Doc 45 - Race Scrutineering" not in kept


def test_slugify():
    assert fia.slugify("São Paulo Grand Prix") == "sao-paulo-grand-prix"
    assert fia.slugify("Emilia Romagna Grand Prix") == "emilia-romagna-grand-prix"
