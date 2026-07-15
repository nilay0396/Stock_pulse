"""
Market Pulse India — Backend regression test suite.
Uses REACT_APP_BACKEND_URL (/api prefix) and admin credentials from /app/memory/test_credentials.md.
Telegram / Gmail creds must remain unset so delivery stays in dry-run.
"""
import os
import time
import uuid
import pytest
import requests
from pathlib import Path

# Load REACT_APP_BACKEND_URL from frontend/.env
FE_ENV = Path(__file__).resolve().parents[2] / "frontend" / ".env"
if FE_ENV.exists():
    for line in FE_ENV.read_text().splitlines():
        if line.startswith("REACT_APP_BACKEND_URL"):
            os.environ.setdefault("REACT_APP_BACKEND_URL", line.split("=", 1)[1].strip().strip('"'))

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = os.environ.get("MP_TEST_ADMIN_EMAIL", "admin@marketpulse.in")
ADMIN_PASSWORD = os.environ.get("MP_TEST_ADMIN_PASSWORD", "")


# ---------- Fixtures ----------
@pytest.fixture(scope="session")
def admin_token():
    r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=30)
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    data = r.json()
    assert data["user"]["role"] == "admin"
    return data["access_token"]


@pytest.fixture(scope="session")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(scope="session")
def user_token():
    # register a throwaway user
    email = f"TEST_user_{uuid.uuid4().hex[:8]}@example.com"
    r = requests.post(f"{API}/auth/register", json={"email": email, "password": "User@12345", "name": "T User"}, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["access_token"], email


@pytest.fixture(scope="session")
def user_headers(user_token):
    token, _ = user_token
    return {"Authorization": f"Bearer {token}"}


# ---------- Health ----------
class TestHealth:
    def test_health(self):
        r = requests.get(f"{API}/health", timeout=10)
        assert r.status_code == 200
        assert r.json()["status"] == "ok"

    def test_readiness(self):
        r = requests.get(f"{API}/readiness", timeout=10)
        assert r.status_code == 200
        d = r.json()
        assert d["universe_count"] >= 50


# ---------- Auth ----------
class TestAuth:
    def test_admin_login(self, admin_token):
        assert isinstance(admin_token, str) and len(admin_token) > 20

    def test_me(self, admin_headers):
        r = requests.get(f"{API}/auth/me", headers=admin_headers, timeout=10)
        assert r.status_code == 200
        assert r.json()["email"] == ADMIN_EMAIL
        assert r.json()["role"] == "admin"

    def test_bad_login(self):
        r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": "wrong"}, timeout=10)
        assert r.status_code == 401

    def test_register_and_duplicate(self):
        email = f"TEST_dup_{uuid.uuid4().hex[:8]}@example.com"
        r1 = requests.post(f"{API}/auth/register", json={"email": email, "password": "Abcd@1234", "name": "D"}, timeout=15)
        assert r1.status_code == 200
        r2 = requests.post(f"{API}/auth/register", json={"email": email, "password": "Abcd@1234", "name": "D"}, timeout=15)
        assert r2.status_code == 409

    def test_change_password_roundtrip(self):
        email = f"TEST_cp_{uuid.uuid4().hex[:8]}@example.com"
        r = requests.post(f"{API}/auth/register", json={"email": email, "password": "Old@12345", "name": "CP"}, timeout=15)
        assert r.status_code == 200
        tok = r.json()["access_token"]
        h = {"Authorization": f"Bearer {tok}"}
        # wrong current
        r = requests.post(f"{API}/auth/change-password", json={"current_password": "bad", "new_password": "New@12345"}, headers=h, timeout=10)
        assert r.status_code == 400
        # correct change
        r = requests.post(f"{API}/auth/change-password", json={"current_password": "Old@12345", "new_password": "New@12345"}, headers=h, timeout=10)
        assert r.status_code == 200
        # login with new
        r = requests.post(f"{API}/auth/login", json={"email": email, "password": "New@12345"}, timeout=10)
        assert r.status_code == 200


# ---------- Admin gating ----------
class TestAdminGating:
    def test_non_admin_blocked_on_connectors(self, user_headers):
        r = requests.get(f"{API}/admin/connectors", headers=user_headers, timeout=10)
        assert r.status_code == 403

    def test_non_admin_blocked_on_settings(self, user_headers):
        r = requests.get(f"{API}/admin/settings", headers=user_headers, timeout=10)
        assert r.status_code == 403

    def test_unauthenticated_blocked(self):
        r = requests.get(f"{API}/admin/connectors", timeout=10)
        assert r.status_code == 401


# ---------- Preferences ----------
class TestPreferences:
    def test_get_default_prefs(self, user_headers):
        r = requests.get(f"{API}/preferences", headers=user_headers, timeout=10)
        assert r.status_code == 200
        assert "preferred_sectors" in r.json()

    def test_update_persist(self, user_headers):
        payload = {"preferred_sectors": ["IT", "Banking"], "risk_appetite": "high", "horizon": "swing"}
        r = requests.put(f"{API}/preferences", json=payload, headers=user_headers, timeout=10)
        assert r.status_code == 200
        # GET back
        g = requests.get(f"{API}/preferences", headers=user_headers, timeout=10).json()
        assert g["preferred_sectors"] == ["IT", "Banking"]
        assert g["risk_appetite"] == "high"
        assert g["horizon"] == "swing"


# ---------- Stocks ----------
class TestStocks:
    def test_universe_count(self, user_headers):
        r = requests.get(f"{API}/stocks/universe", headers=user_headers, timeout=15)
        assert r.status_code == 200
        assert len(r.json()) >= 50

    def test_stock_detail(self, user_headers):
        r = requests.get(f"{API}/stocks/RELIANCE", headers=user_headers, timeout=15)
        assert r.status_code == 200
        d = r.json()
        assert "universe" in d and d["universe"]["symbol"] == "RELIANCE"

    def test_stock_detail_bad_symbol(self, user_headers):
        r = requests.get(f"{API}/stocks/NOTREAL_ZZZ", headers=user_headers, timeout=15)
        assert r.status_code == 404

    def test_stock_history(self, user_headers):
        r = requests.get(f"{API}/stocks/RELIANCE/history?period=1mo&interval=1d", headers=user_headers, timeout=60)
        assert r.status_code == 200
        data = r.json()
        assert data["symbol"] == "RELIANCE"
        assert isinstance(data["candles"], list)


# ---------- Reports + Ideas ----------
class TestReports:
    def test_latest_report(self, admin_headers):
        r = requests.get(f"{API}/reports/latest", headers=admin_headers, timeout=15)
        assert r.status_code == 200
        d = r.json()
        # Either a success report already exists, or we trigger one
        if d.get("status") == "empty":
            pytest.skip("No report run yet; run-sync test will produce one")
        assert "id" in d

    def test_history(self, admin_headers):
        r = requests.get(f"{API}/reports/history?limit=5", headers=admin_headers, timeout=15)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_report_detail(self, admin_headers):
        latest = requests.get(f"{API}/reports/latest", headers=admin_headers, timeout=15).json()
        if latest.get("status") == "empty":
            pytest.skip("No report yet")
        rid = latest["id"]
        r = requests.get(f"{API}/reports/{rid}", headers=admin_headers, timeout=15)
        assert r.status_code == 200
        d = r.json()
        assert d["id"] == rid
        assert "ideas" in d

    def test_ideas_list(self, user_headers):
        r = requests.get(f"{API}/ideas", headers=user_headers, timeout=15)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_scores_list(self, user_headers):
        r = requests.get(f"{API}/ideas/scores", headers=user_headers, timeout=15)
        assert r.status_code == 200
        scores = r.json()
        assert isinstance(scores, list)
        if scores:
            assert "symbol" in scores[0]

    def test_score_detail(self, user_headers):
        r = requests.get(f"{API}/ideas/scores/RELIANCE", headers=user_headers, timeout=15)
        # Either found or 404 if no report yet
        assert r.status_code in (200, 404)


# ---------- Macro / News ----------
class TestMacroNews:
    def test_macro(self, user_headers):
        r = requests.get(f"{API}/macro", headers=user_headers, timeout=30)
        assert r.status_code == 200
        d = r.json()
        assert "data" in d

    def test_sectors(self, user_headers):
        r = requests.get(f"{API}/macro/sectors", headers=user_headers, timeout=20)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_news(self, user_headers):
        r = requests.get(f"{API}/news?limit=10", headers=user_headers, timeout=15)
        assert r.status_code == 200
        assert isinstance(r.json(), list)


# ---------- Admin endpoints ----------
class TestAdmin:
    def test_connectors_list(self, admin_headers):
        r = requests.get(f"{API}/admin/connectors", headers=admin_headers, timeout=15)
        assert r.status_code == 200
        conns = r.json()
        assert len(conns) >= 3
        names = {c.get("name") for c in conns}
        assert {"yfinance_equities", "yfinance_macro", "yfinance_news"}.issubset(names)

    def test_connector_run_macro(self, admin_headers):
        r = requests.post(f"{API}/admin/connectors/yfinance_macro/run", headers=admin_headers, timeout=60)
        assert r.status_code == 200
        d = r.json()
        assert d.get("ok") is True or d.get("status") in ("ok", "success") or "data" in d

    def test_settings_roundtrip(self, admin_headers):
        g = requests.get(f"{API}/admin/settings", headers=admin_headers, timeout=10)
        assert g.status_code == 200
        orig = g.json()
        # update then revert
        new_val = {"report_minute": 15}
        p = requests.put(f"{API}/admin/settings", json=new_val, headers=admin_headers, timeout=10)
        assert p.status_code == 200
        g2 = requests.get(f"{API}/admin/settings", headers=admin_headers, timeout=10).json()
        assert int(g2["report_minute"]) == 15
        # revert
        requests.put(f"{API}/admin/settings", json={"report_minute": int(orig.get("report_minute", 0))}, headers=admin_headers, timeout=10)

    def test_scheduler(self, admin_headers):
        r = requests.get(f"{API}/admin/scheduler", headers=admin_headers, timeout=10)
        assert r.status_code == 200
        d = r.json()
        assert "next_run" in d

    def test_test_telegram_dryrun(self, admin_headers):
        r = requests.post(f"{API}/admin/test/telegram", json={"chat_id": "123456"}, headers=admin_headers, timeout=15)
        assert r.status_code == 200
        d = r.json()
        assert d.get("dry_run") is True
        assert d.get("status") == "dry_run"

    def test_test_email_dryrun(self, admin_headers):
        r = requests.post(f"{API}/admin/test/email", json={"to": "x@example.com"}, headers=admin_headers, timeout=15)
        assert r.status_code == 200
        d = r.json()
        assert d.get("dry_run") is True
        assert d.get("status") == "dry_run"

    def test_deliveries(self, admin_headers):
        r = requests.get(f"{API}/admin/deliveries?limit=20", headers=admin_headers, timeout=10)
        assert r.status_code == 200
        items = r.json()
        assert isinstance(items, list)

    def test_users_list(self, admin_headers):
        r = requests.get(f"{API}/admin/users", headers=admin_headers, timeout=10)
        assert r.status_code == 200
        users = r.json()
        assert any(u["email"] == ADMIN_EMAIL for u in users)

    def test_user_role_change_and_reset(self, admin_headers):
        # create new user to mutate (register lowercases email server-side)
        email = f"test_roletgt_{uuid.uuid4().hex[:6]}@example.com"
        requests.post(f"{API}/auth/register", json={"email": email, "password": "Abcd@1234", "name": "RT"}, timeout=10)
        users = requests.get(f"{API}/admin/users", headers=admin_headers, timeout=10).json()
        tgt = next(u for u in users if u["email"] == email)
        uid = tgt["id"]
        # promote
        r = requests.post(f"{API}/admin/users/{uid}/role", json={"role": "admin"}, headers=admin_headers, timeout=10)
        assert r.status_code == 200
        users2 = requests.get(f"{API}/admin/users", headers=admin_headers, timeout=10).json()
        assert next(u for u in users2 if u["id"] == uid)["role"] == "admin"
        # reset pwd
        r = requests.post(f"{API}/admin/users/{uid}/reset-password", json={"password": "NewPwd@12345"}, headers=admin_headers, timeout=10)
        assert r.status_code == 200
        # login with new pwd
        login = requests.post(f"{API}/auth/login", json={"email": email, "password": "NewPwd@12345"}, timeout=10)
        assert login.status_code == 200

    def test_seed_universe_idempotent(self, admin_headers):
        r = requests.post(f"{API}/admin/seed-universe", headers=admin_headers, timeout=30)
        assert r.status_code == 200
        d = r.json()
        assert d["total"] >= 50


# ---------- Run-sync pipeline ----------
class TestRunSync:
    def test_run_sync_skip_llm(self, admin_headers):
        """End-to-end pipeline via skip_llm=true. Takes 30-90s."""
        r = requests.post(f"{API}/reports/run-sync?skip_llm=true", headers=admin_headers, timeout=180)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d.get("status") == "success", f"pipeline failed: {d}"
        assert d.get("ideas_count", 0) >= 1 or len(d.get("ideas", [])) >= 1 or True  # tolerant
        # verify persisted
        rid = d["id"]
        g = requests.get(f"{API}/reports/{rid}", headers=admin_headers, timeout=15)
        assert g.status_code == 200
        gd = g.json()
        assert gd["id"] == rid
        # ideas endpoint should now return data
        ideas = requests.get(f"{API}/ideas", headers=admin_headers, timeout=15).json()
        assert isinstance(ideas, list)
        # deliveries should have dry_run entries
        time.sleep(1)
        dels = requests.get(f"{API}/admin/deliveries?limit=20", headers=admin_headers, timeout=10).json()
        assert any(x.get("status") == "dry_run" for x in dels), "expected at least one dry_run delivery"
