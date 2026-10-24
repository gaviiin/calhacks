"""The real StdbClient against a MockTransport: URLs, auth, JSON array bodies, SQL decoding."""

import json

import httpx

from agents.stdb import StdbClient, decode_sql_response, none, opt, some


def _client(handler):
    return StdbClient(url="http://stdb.test", http=httpx.Client(transport=httpx.MockTransport(handler)))


def test_default_database_name_is_hyphenated(monkeypatch):
    monkeypatch.delenv("STDB_DB", raising=False)
    assert StdbClient().db == "cost-cap-desk"  # 2.13 rejects underscores (REDUCERS.md)


def test_helpers():
    assert some(5) == {"some": 5}
    assert none() == {"none": []}
    assert opt(None) == none() and opt("x") == some("x")


def test_create_identity_and_call():
    seen = []

    def handler(req: httpx.Request):
        seen.append(req)
        if req.url.path == "/v1/identity":
            return httpx.Response(200, json={"identity": "0xC200ABC", "token": "tok"})
        return httpx.Response(200, text="")

    c = _client(handler)
    assert c.create_identity() == ("c200abc", "tok")
    c.call("tok", "propose", [7, "CATERING", "CATERING@SECD-ISS07", none(), "r", "[]"])
    req = seen[-1]
    assert req.method == "POST"
    assert req.url.path == "/v1/database/cost-cap-desk/call/propose"
    assert req.headers["Authorization"] == "Bearer tok"
    assert json.loads(req.content) == [7, "CATERING", "CATERING@SECD-ISS07", {"none": []}, "r", "[]"]


def test_call_error_raises():
    c = _client(lambda req: httpx.Response(530, text="no such work item"))
    try:
        c.call("tok", "propose", [])
    except Exception as e:
        assert "530" in str(e)
    else:
        raise AssertionError("expected StdbError")


def test_sql_zips_names_and_unwraps_options():
    payload = [{
        "schema": {"elements": [
            {"name": {"some": "id"}, "algebraic_type": {"U64": []}},
            {"name": {"some": "question"}, "algebraic_type": {"Sum": {"variants": [
                {"name": {"some": "some"}, "algebraic_type": {"String": []}},
                {"name": {"some": "none"}, "algebraic_type": {"Product": {"elements": []}}}]}}},
            {"name": {"some": "proposed_by"}, "algebraic_type": {"Sum": {"variants": [
                {"name": {"some": "some"}, "algebraic_type": {"Product": {"elements": [
                    {"name": {"some": "__identity__"}, "algebraic_type": {"U256": []}}]}}},
                {"name": {"some": "none"}, "algebraic_type": {"Product": {"elements": []}}}]}}},
            {"name": {"some": "created_at"}, "algebraic_type": {"Product": {"elements": [
                {"name": {"some": "__timestamp_micros_since_unix_epoch__"}, "algebraic_type": {"I64": []}}]}}},
            {"name": "state", "algebraic_type": {"String": []}},
        ]},
        # SQL results encode options as tagged arrays (REDUCERS.md "SQL result encoding")
        "rows": [
            [7, [0, "which vendor?"], [0, ["0xABCDEF"]], [1700000000000000], "NEEDS_INFO"],
            [8, [1, []], [1, []], [1700000000000001], "NEW"],
        ],
    }]
    seen = []

    def handler(req):
        seen.append(req)
        return httpx.Response(200, json=payload)

    rows = _client(handler).sql("tok", "SELECT * FROM work_item")
    assert seen[0].url.path == "/v1/database/cost-cap-desk/sql"
    assert seen[0].content == b"SELECT * FROM work_item"
    assert rows == [
        {"id": 7, "question": "which vendor?", "proposed_by": "abcdef", "created_at": 1700000000000000, "state": "NEEDS_INFO"},
        {"id": 8, "question": None, "proposed_by": None, "created_at": 1700000000000001, "state": "NEW"},
    ]


def test_decode_without_types_still_unwraps():
    out = decode_sql_response([{"schema": {"elements": [{"name": "a"}, {"name": "b"}]},
                                "rows": [[{"some": 1}, {"none": []}]]}])
    assert out == [[{"a": 1, "b": None}]]


def test_decode_live_encoding_with_unrecognised_types():
    """The exact row shapes REDUCERS.md shows from the live audit_log, with types we do not parse."""
    els = [{"name": {"some": n}, "algebraic_type": {"Mystery": []}} for n in
           ("id", "at", "actor", "allowed", "policy_id", "policy_version", "fx_rate_e_6", "proposed_category_code")]
    row = [9, [1792827492523140], ["0xc2003eeeCD7"], True, [1, []], [1, []], 1270000, [0, "CATERING"]]
    (rows,) = decode_sql_response([{"schema": {"elements": els}, "rows": [row]}])
    assert rows == [{"id": 9, "at": 1792827492523140, "actor": "c2003eeecd7", "allowed": True, "policy_id": None,
                     "policy_version": None, "fx_rate_e_6": 1270000, "fx_rate_e6": 1270000,
                     "proposed_category_code": "CATERING"}]
