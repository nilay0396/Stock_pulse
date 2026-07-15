"""MongoDB connection singleton."""
import os
from motor.motor_asyncio import AsyncIOMotorClient
from pathlib import Path
from dotenv import load_dotenv

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

_mongo_url = os.environ["MONGO_URL"]
_db_name = os.environ["DB_NAME"]

client = AsyncIOMotorClient(_mongo_url)
db = client[_db_name]


# Collection references (for convenience)
users_col = db.users
preferences_col = db.user_preferences
watchlists_col = db.watchlists
stock_universe_col = db.stock_universe
sectors_col = db.sectors
connectors_col = db.source_connectors
ingestion_runs_col = db.ingestion_runs
raw_payloads_col = db.raw_ingestion_payloads
market_data_col = db.normalized_market_data
financials_col = db.company_financials
shareholding_col = db.company_shareholding
technicals_col = db.technical_snapshots
macro_col = db.macro_signals
news_col = db.news_items
news_clusters_col = db.news_clusters
analyst_col = db.analyst_updates
scores_col = db.stock_scores
ideas_col = db.trade_ideas
report_runs_col = db.report_runs
report_items_col = db.report_items
deliveries_col = db.whatsapp_deliveries  # generalized: telegram/email/whatsapp
audit_col = db.audit_logs
settings_col = db.system_settings
bhavcopy_col = db.bhavcopy_rows
fii_dii_col = db.fii_dii_flows
insider_col = db.insider_trades
gdelt_col = db.geopolitics_events
sector_indices_col = db.sector_indices
corp_ann_col = db.corp_announcements
corp_actions_col = db.corp_actions
shareholding_col_new = db.shareholding_filings
fmp_col = db.fmp_fundamentals
fred_col = db.fred_macro
fin_results_col = db.financial_results
rss_news_col = db.rss_news
ingestion_runs_col = db.ingestion_runs
backtest_runs_col = db.backtest_runs
backtest_trades_col = db.backtest_trades
deep_dives_col = db.stock_deep_dives


async def ensure_indexes() -> None:
    """Create indexes idempotently."""
    await users_col.create_index("email", unique=True)
    await stock_universe_col.create_index("symbol", unique=True)
    await scores_col.create_index([("symbol", 1), ("as_of", -1)])
    await ideas_col.create_index([("report_run_id", 1), ("conviction", -1)])
    await news_col.create_index([("published_at", -1)])
    await report_runs_col.create_index([("run_date", -1)])
    await deliveries_col.create_index([("report_run_id", 1), ("user_id", 1)])
    await connectors_col.create_index("name", unique=True)
    await settings_col.create_index("key", unique=True)
    await bhavcopy_col.create_index([("symbol", 1), ("as_of", -1)])
    await fii_dii_col.create_index([("date", -1), ("category", 1)])
    await insider_col.create_index([("symbol", 1), ("disclosure_date", -1)])
    await gdelt_col.create_index([("ingested_at", -1)])
    await sector_indices_col.create_index([("as_of", -1), ("index", 1)])
    await corp_ann_col.create_index([("disclosure_time", -1)])
    await corp_actions_col.create_index([("ex_date", 1), ("symbol", 1)])
    await shareholding_col_new.create_index([("symbol", 1), ("date", -1)])
    await fmp_col.create_index([("symbol", 1), ("ingested_at", -1)])
    await fred_col.create_index([("series_id", 1), ("date", -1)])
    await fin_results_col.create_index([("symbol", 1), ("bm_date", 1)])
    await rss_news_col.create_index([("id", 1)], unique=True)
    await rss_news_col.create_index([("ingested_at", -1)])
    await ingestion_runs_col.create_index([("run_id", 1), ("connector", 1)])
    await ingestion_runs_col.create_index([("started_at", -1)])
    await backtest_runs_col.create_index([("report_run_id", 1)])
    await backtest_runs_col.create_index([("created_at", -1)])
    await backtest_trades_col.create_index([("backtest_run_id", 1), ("symbol", 1)])
    await deep_dives_col.create_index([("symbol", 1), ("fetched_at", -1)])


def close_client() -> None:
    client.close()
