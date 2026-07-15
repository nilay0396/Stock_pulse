"""Pydantic request/response models for Market Pulse India."""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any, Literal
from pydantic import BaseModel, Field, EmailStr, ConfigDict
import uuid


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _uid() -> str:
    return str(uuid.uuid4())


# ---------- Auth / Users ----------
class UserRegister(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=72)
    name: str = Field(default="", max_length=120)


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    email: EmailStr
    name: str = ""
    role: Literal["user", "admin"] = "user"
    created_at: datetime


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=72)


# ---------- Preferences ----------
class Preferences(BaseModel):
    model_config = ConfigDict(extra="ignore")
    user_id: str
    telegram_chat_id: str = ""
    email_alerts: bool = True
    telegram_alerts: bool = True
    delivery_time: str = "07:00"  # HH:MM IST
    language: Literal["en", "hi"] = "en"
    preferred_sectors: List[str] = Field(default_factory=list)
    horizon: Literal["weekly", "monthly", "both"] = "both"
    risk_appetite: Literal["low", "medium", "high"] = "medium"
    watchlist: List[str] = Field(default_factory=list)
    updated_at: datetime = Field(default_factory=_now)


# ---------- Stocks / Universe ----------
class StockUniverseItem(BaseModel):
    model_config = ConfigDict(extra="ignore")
    symbol: str        # NSE ticker e.g. RELIANCE
    yf_symbol: str     # yfinance symbol e.g. RELIANCE.NS
    name: str
    sector: str
    industry: str = ""
    market_cap_tier: Literal["large", "mid", "small"] = "large"


# ---------- Technical snapshot ----------
class TechnicalSnapshot(BaseModel):
    model_config = ConfigDict(extra="ignore")
    symbol: str
    as_of: datetime
    last_close: float
    change_pct_1d: float = 0.0
    change_pct_1w: float = 0.0
    change_pct_1m: float = 0.0
    rsi_14: Optional[float] = None
    sma_20: Optional[float] = None
    sma_50: Optional[float] = None
    sma_100: Optional[float] = None
    sma_200: Optional[float] = None
    ema_20: Optional[float] = None
    ema_50: Optional[float] = None
    macd: Optional[float] = None
    macd_signal: Optional[float] = None
    macd_hist: Optional[float] = None
    bb_upper: Optional[float] = None
    bb_lower: Optional[float] = None
    bb_mid: Optional[float] = None
    atr_14: Optional[float] = None
    volatility_20: Optional[float] = None
    volume_spike: float = 1.0           # vs avg
    relative_strength: float = 0.0      # vs NIFTY
    setup: Literal["breakout", "pullback", "range", "downtrend", "neutral"] = "neutral"
    volume_avg_20: float = 0.0


# ---------- Scoring ----------
class StockScore(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=_uid)
    symbol: str
    as_of: datetime = Field(default_factory=_now)
    technical: float = 0.0
    fundamental: float = 0.0
    valuation: float = 0.0
    ownership: float = 0.0
    analyst: float = 0.0
    event_news: float = 0.0
    macro_sector: float = 0.0
    conviction: float = 0.0
    direction: Literal["bullish", "bearish", "watch", "avoid"] = "watch"
    reasons: List[str] = Field(default_factory=list)
    risks: List[str] = Field(default_factory=list)
    setup_type: Literal["breakout", "pullback", "event-led", "accumulation", "neutral"] = "neutral"


# ---------- Trade idea ----------
class TradeIdea(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=_uid)
    report_run_id: str
    symbol: str
    name: str
    sector: str
    direction: Literal["bullish", "bearish", "watch", "avoid"]
    horizon: Literal["weekly", "monthly"]
    setup_type: str
    conviction: float
    entry_low: float
    entry_high: float
    stop_loss: float
    target_low: float
    target_high: float
    reasons: List[str] = Field(default_factory=list)
    risks: List[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=_now)


# ---------- Report ----------
class ReportRun(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=_uid)
    run_date: str                       # YYYY-MM-DD (IST)
    started_at: datetime = Field(default_factory=_now)
    finished_at: Optional[datetime] = None
    status: Literal["running", "success", "failed"] = "running"
    error: Optional[str] = None
    summary: Dict[str, Any] = Field(default_factory=dict)
    narrative: str = ""
    triggered_by: str = "scheduler"     # "scheduler" or "manual:<user_id>"


class Delivery(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=_uid)
    report_run_id: str
    user_id: str
    channel: Literal["telegram", "email", "whatsapp"]
    recipient: str
    status: Literal["sent", "failed", "dry_run", "pending"] = "pending"
    attempts: int = 0
    error: Optional[str] = None
    response_meta: Dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=_now)


# ---------- Settings ----------
class SystemSetting(BaseModel):
    model_config = ConfigDict(extra="ignore")
    key: str
    value: Any
    updated_at: datetime = Field(default_factory=_now)


class SettingsUpdate(BaseModel):
    telegram_bot_token: Optional[str] = None
    telegram_default_chat_id: Optional[str] = None
    gmail_address: Optional[str] = None
    gmail_app_password: Optional[str] = None
    gmail_from_name: Optional[str] = None
    report_hour: Optional[int] = None
    report_minute: Optional[int] = None
    dry_run: Optional[bool] = None
    fmp_api_key: Optional[str] = None
    fred_api_key: Optional[str] = None
    # F&O broker credentials + NSE-direct toggle
    UPSTOX_ACCESS_TOKEN: Optional[str] = None
    FYERS_CLIENT_ID: Optional[str] = None
    FYERS_ACCESS_TOKEN: Optional[str] = None
    FNO_ENABLE_NSE_DIRECT: Optional[str] = None


# ---------- Connector ----------
class ConnectorStatus(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str
    category: str
    enabled: bool = True
    last_run_at: Optional[datetime] = None
    last_status: Literal["success", "failed", "idle"] = "idle"
    last_error: Optional[str] = None
    success_count: int = 0
    failure_count: int = 0
    avg_duration_ms: float = 0.0


class IngestionRun(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=_uid)
    connector: str
    started_at: datetime = Field(default_factory=_now)
    finished_at: Optional[datetime] = None
    status: Literal["running", "success", "failed"] = "running"
    rows: int = 0
    error: Optional[str] = None
