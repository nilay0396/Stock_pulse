"""
Iteration 3 — Market Pulse India data-ingestion & flows tests.
Covers 14 connectors, new flow endpoints, FMP/FRED settings round-trip,
and report summary containing upgraded fields.
"""
import os
import time
import pytest
import requests
from pathlib import Path

FE_ENV = Path(__file__).resolve().parents[2] / "frontend" / ".env"
if FE_ENV.exists():
    for line in FE_ENV.read_text().splitlines():
        if line.startswith("REACT_APP_BACKEND_URL"):
            os.environ.setdefault("REACT_APP_BACKEND_URL", line.split("=", 1)[1].strip().strip('"'))

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = os.environ.get("MP_TEST_ADMIN_EMAIL", "nilay0396@gmail.com")
ADMIN_PASSWORD = os.environ.get("MP_TEST_ADMIN_PASSWORD", "")

EXPECTED_14 = {
    "yfinance_equities", "yfinance_macro", "yfinance_news",
    "nse_bhavcopy", "nse_fii_dii", "nse_insider",
    "nse_sector_indices", "nse_corp_announcements", "nse_corp_actions",
    "nse_quote", "nse_shareholding",
    "gdelt_news", "fmp_fundamentals", "fred_macro",
}


@pytest.fixture(scope="module")
def admin_headers():
    r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=30)
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _run_connector(name, admin_headers, tries=2, timeout=120):
    last = None
    for i in range(tries):
        r = requests.post(f"{API}/admin/connectors/{name}/run", headers=admin_headers, timeout=timeout)
        last = r
        if r.status_code == 200:
            return r
        time.sleep(2)
    return last


# ---------- Registry ----------
class TestRegistry:
    def test_connectors_list_14(self, admin_headers):
        r = requests.get(f"{API}/admin/connectors", headers=admin_headers, timeout=15)
        assert r.status_code == 200
        names = {c["name"] for c in r.json()}
        missing = EXPECTED_14 - names
        assert not missing, f"missing connectors: {missing}. got={names}"
        # should have exactly the expected 14 registered (extras allowed but not expected)
        assert len(names) >= 14


# ---------- Individual connector runs ----------
class TestConnectorRuns:
    def test_nse_sector_indices_run(self, admin_headers):
        r = _run_connector("nse_sector_indices", admin_headers)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d.get("ok") is True, d
        rows = d.get("rows") or d.get("count") or d.get("inserted") or 0
        # verify via flow endpoint
        fr = requests.get(f"{API}/flows/sector-indices", headers=admin_headers, timeout=15)
        assert fr.status_code == 200
        assert len(fr.json()) >= 100, f"sector-indices rows={len(fr.json())}"

    def test_nse_corp_announcements_run(self, admin_headers):
        r = _run_connector("nse_corp_announcements", admin_headers)
        assert r.status_code == 200, r.text
        assert r.json().get("ok") is True, r.json()

    def test_nse_corp_actions_run(self, admin_headers):
        r = _run_connector("nse_corp_actions", admin_headers)
        assert r.status_code == 200, r.text
        assert r.json().get("ok") is True, r.json()

    def test_nse_quote_run(self, admin_headers):
        r = _run_connector("nse_quote", admin_headers, timeout=180)
        assert r.status_code == 200, r.text
        assert r.json().get("ok") is True, r.json()

    def test_nse_shareholding_run(self, admin_headers):
        r = _run_connector("nse_shareholding", admin_headers, timeout=180)
        assert r.status_code == 200, r.text
        # may have partial failures; overall ok must be true
        assert r.json().get("ok") is True, r.json()

    def test_fmp_fundamentals_run_skip(self, admin_headers):
        r = _run_connector("fmp_fundamentals", admin_headers, tries=1)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d.get("ok") is True, d
        # since key is absent, expect some skip indicator
        blob = str(d).lower()
        assert "no_api_key" in blob or "skipped" in blob or d.get("skipped"), d

    def test_fred_macro_run_skip(self, admin_headers):
        r = _run_connector("fred_macro", admin_headers, tries=1)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d.get("ok") is True, d
        blob = str(d).lower()
        assert "no_api_key" in blob or "skipped" in blob or d.get("skipped"), d


# ---------- New Flow endpoints ----------
class TestFlowEndpoints:
    def test_sector_indices(self, admin_headers):
        r = requests.get(f"{API}/flows/sector-indices", headers=admin_headers, timeout=20)
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list)
        assert len(data) >= 100, f"expected >=100 rows, got {len(data)}"

    def test_corporate_announcements(self, admin_headers):
        r = requests.get(f"{API}/flows/corporate-announcements", headers=admin_headers, timeout=20)
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list)
        assert len(data) >= 1, "expected at least 1 corporate announcement after run"

    def test_corporate_actions(self, admin_headers):
        r = requests.get(f"{API}/flows/corporate-actions", headers=admin_headers, timeout=20)
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list)
        assert len(data) >= 1, "expected at least 1 corporate action after run"

    def test_shareholding_reliance(self, admin_headers):
        r = requests.get(f"{API}/flows/shareholding/RELIANCE", headers=admin_headers, timeout=20)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_fred_empty_ok(self, admin_headers):
        r = requests.get(f"{API}/flows/fred", headers=admin_headers, timeout=15)
        assert r.status_code == 200
        assert isinstance(r.json(), list)  # empty OK when no key

    def test_fmp_for_symbol_null_ok(self, admin_headers):
        r = requests.get(f"{API}/flows/fmp/RELIANCE", headers=admin_headers, timeout=15)
        assert r.status_code == 200
        body = r.json()
        # null OK when no API key; a dict OK if populated
        assert body is None or isinstance(body, dict)


# ---------- Settings ----------
class TestSettings:
    def test_fmp_fred_keys_roundtrip(self, admin_headers):
        g = requests.get(f"{API}/admin/settings", headers=admin_headers, timeout=10)
        assert g.status_code == 200
        orig = g.json()
        assert "fmp_api_key" in orig, "fmp_api_key field missing in settings payload"
        assert "fred_api_key" in orig, "fred_api_key field missing in settings payload"

        # write dummy values
        p = requests.put(f"{API}/admin/settings",
                         json={"fmp_api_key": "TEST_FMP_KEY", "fred_api_key": "TEST_FRED_KEY"},
                         headers=admin_headers, timeout=10)
        assert p.status_code == 200, p.text
        g2 = requests.get(f"{API}/admin/settings", headers=admin_headers, timeout=10).json()
        assert g2["fmp_api_key"] == "TEST_FMP_KEY"
        assert g2["fred_api_key"] == "TEST_FRED_KEY"

        # revert to empty (REQUIRED by review request)
        p2 = requests.put(f"{API}/admin/settings",
                          json={"fmp_api_key": "", "fred_api_key": ""},
                          headers=admin_headers, timeout=10)
        assert p2.status_code == 200
        g3 = requests.get(f"{API}/admin/settings", headers=admin_headers, timeout=10).json()
        assert not g3.get("fmp_api_key")
        assert not g3.get("fred_api_key")


# ---------- Report summary ----------
class TestReportSummary:
    def test_latest_summary_has_new_fields(self, admin_headers):
        # try run-sync to guarantee freshness; ingress may time out (>=60s) but the
        # pipeline completes in background and latest report will reflect fields
        try:
            rs = requests.post(f"{API}/reports/run-sync?skip_llm=true", headers=admin_headers, timeout=240)
            if rs.status_code == 200:
                assert rs.json().get("status") == "success", rs.json()
        except requests.exceptions.RequestException:
            pass  # fall through to use latest

        r = requests.get(f"{API}/reports/latest", headers=admin_headers, timeout=15)
        assert r.status_code == 200
        d = r.json()
        assert d.get("status") == "success", d
        summary = d.get("summary") or {}
        expected = ["sector_indices", "commodity_impact", "insider_highlights",
                    "upcoming_actions_total", "geo_events", "fred_snapshot"]
        missing = [k for k in expected if k not in summary]
        assert len(missing) == 0, f"missing summary fields: {missing}. present keys: {list(summary.keys())}"
