"""Market Pulse India — FastAPI entrypoint."""
import logging
import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import APIRouter, FastAPI
from starlette.middleware.cors import CORSMiddleware

from pathlib import Path

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

from auth import seed_admin
from db import close_client, ensure_indexes
from routes import (
    admin as admin_routes,
    auth_routes,
    flows as flows_routes,
    health as health_routes,
    macro as macro_routes,
    news as news_routes,
    preferences as preferences_routes,
    reports as reports_routes,
    stocks as stocks_routes,
    trade_ideas as ideas_routes,
)
from scheduler import start_scheduler, stop_scheduler
from stock_universe import seed_universe, seed_full_nse_universe

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("market_pulse")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await ensure_indexes()
    await seed_admin()
    n = await seed_universe()
    logger.info("Seeded curated stock universe (new rows: %s)", n)
    # Bulk seed the FULL NSE EQ-series universe (~2,000 stocks). This is the
    # basis for the institutional Stage-1 funnel. Best-effort — if NSE is
    # unreachable on boot we log and continue with whatever is in the DB.
    try:
        full = await seed_full_nse_universe()
        logger.info("Seeded full NSE universe: %s", full)
    except Exception as e:  # noqa: BLE001
        logger.warning("Full NSE universe seed failed (will retry on next boot): %s", e)
    await start_scheduler()
    try:
        yield
    finally:
        await stop_scheduler()
        close_client()


app = FastAPI(title="Market Pulse India", version="1.0.0", lifespan=lifespan)

api_router = APIRouter(prefix="/api")
api_router.include_router(health_routes.router)
api_router.include_router(auth_routes.router)
api_router.include_router(preferences_routes.router)
api_router.include_router(reports_routes.router)
api_router.include_router(ideas_routes.router)
api_router.include_router(stocks_routes.router)
api_router.include_router(macro_routes.router)
api_router.include_router(news_routes.router)
api_router.include_router(flows_routes.router)
api_router.include_router(admin_routes.router)


@api_router.get("/")
async def root():
    return {"name": "Market Pulse India API", "status": "ok"}


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)
