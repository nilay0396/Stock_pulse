"""Market Pulse India — multi-factor scoring engine.

Final Score = 0.22T + 0.20F + 0.10V + 0.10O + 0.08A + 0.18N + 0.12M

Each sub-score is built on 0-100 scale from sub-components with exact weights.
Percentile-ranking is used for scale-sensitive inputs (P/E, P/B, volume, growth, etc.)
within sector first (fallback: full universe) to avoid sector bias.

Hard filters (`apply_hard_filters`) eliminate candidates before trade-rule checks.
`classify_trade` returns weekly / monthly / avoid per the spec.

Conventions
-----------
* Every `score_*` returns `(score: float [0..100], reasons: list[str])`.
* Every `*_component` returns `float in [0..100]`.
* Missing data → neutral 50 (so a missing input never dominates the score).
"""
from __future__ import annotations
import math
from typing import Any, Dict, List, Optional, Tuple


# ====================================================================
# Final weights (must sum to 1.00)
# ====================================================================
FINAL_WEIGHTS = {
    "technical":     0.22,
    "fundamental":   0.20,
    "valuation":     0.10,
    "ownership":     0.10,
    "analyst":       0.08,
    "event_news":    0.18,
    "macro_sector":  0.12,
}
assert abs(sum(FINAL_WEIGHTS.values()) - 1.0) < 1e-9, "weights must sum to 1.0"

# Sub-component weights (each block sums to 100)
TECHNICAL_WEIGHTS = {"TR": 20, "MO": 15, "RSI": 15, "BB": 10, "MACD": 10, "VOL": 10, "ATR": 10, "REL": 10}
FUND_WEIGHTS      = {"GR": 20, "PR": 15, "CF": 15, "DE": 10, "IC": 10, "RO": 10, "MG": 10, "BS": 10}
VAL_WEIGHTS       = {"PE": 35, "PB": 20, "EV": 20, "PEG": 15, "DY": 10}
OWN_WEIGHTS       = {"FI": 25, "DI": 20, "PH": 20, "PR": 15, "VL": 20}
AN_WEIGHTS        = {"RT": 35, "TP": 25, "ER": 20, "CV": 20}
NEWS_WEIGHTS      = {"SE": 30, "IM": 25, "RE": 20, "FR": 15, "TM": 10}
MACRO_WEIGHTS     = {"SR": 30, "VX": 20, "FX": 20, "CM": 15, "GL": 15}

for name, w in (("TECH", TECHNICAL_WEIGHTS), ("FUND", FUND_WEIGHTS), ("VAL", VAL_WEIGHTS),
                ("OWN", OWN_WEIGHTS), ("AN", AN_WEIGHTS), ("NEWS", NEWS_WEIGHTS), ("MACRO", MACRO_WEIGHTS)):
    assert sum(w.values()) == 100, f"{name} components must sum to 100"


# ====================================================================
# Generic helpers
# ====================================================================
def _clip(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


def _neutral() -> float:
    return 50.0


def _num(x: Any) -> Optional[float]:
    """Coerce arbitrary upstream values (None, str, int, float, bool, NaN) to
    a clean float — or None if the value can't be a number. Centralises every
    'why is yfinance/FMP returning a string here' edge case in one place so
    downstream comparators (`<`, `>`) are always numeric.
    """
    if x is None or isinstance(x, bool):
        return None
    if isinstance(x, (int, float)):
        return None if (isinstance(x, float) and math.isnan(x)) else float(x)
    try:
        f = float(x)
        return None if math.isnan(f) else f
    except (TypeError, ValueError):
        return None


def percentile_rank(values: List[Optional[float]], v: Optional[float], higher_is_better: bool = True) -> float:
    """Return percentile rank (0..100) of v within values. Missing v → 50.

    Defensive: every element is coerced to float; non-numeric strings (e.g.
    NSE returns "-" for missing P/E) are silently dropped instead of raising
    `'<' not supported between instances of 'str' and 'float'`.
    """
    def _num(x):
        if x is None:
            return None
        if isinstance(x, bool):
            return None
        if isinstance(x, (int, float)):
            return None if (isinstance(x, float) and math.isnan(x)) else float(x)
        try:
            f = float(x)
            return None if math.isnan(f) else f
        except (TypeError, ValueError):
            return None

    nv = _num(v)
    if nv is None:
        return 50.0
    clean = [n for n in (_num(x) for x in values) if n is not None]
    if not clean:
        return 50.0
    below = sum(1 for x in clean if x < nv)
    equal = sum(1 for x in clean if x == nv)
    p = (below + 0.5 * equal) / len(clean) * 100
    return p if higher_is_better else (100 - p)


def linear(x: Optional[float], lo: float, hi: float, invert: bool = False) -> float:
    """Map x ∈ [lo, hi] → [0, 100] (or [100, 0] if invert).
    Coerces upstream strings/None/NaN to a clean float so the comparison
    operators below cannot crash on dirty input.
    """
    nx = _num(x)
    if nx is None:
        return 50.0
    if hi == lo:
        return 50.0
    t = (nx - lo) / (hi - lo)
    t = max(0.0, min(1.0, t))
    return (1 - t) * 100 if invert else t * 100


def band(x: Optional[float], ideal_lo: float, ideal_hi: float, decay: float = 20.0) -> float:
    """100 inside band, linearly fading to 0 `decay` units outside."""
    nx = _num(x)
    if nx is None:
        return 50.0
    if ideal_lo <= nx <= ideal_hi:
        return 100.0
    dist = ideal_lo - nx if nx < ideal_lo else nx - ideal_hi
    return _clip(100 - (dist / decay) * 100)


def _pct(v: Any) -> Optional[float]:
    """Convert yfinance ratios (sometimes fraction, sometimes %) to percent."""
    n = _num(v)
    if n is None:
        return None
    return n * 100 if abs(n) < 5 else n


# ====================================================================
# TECHNICAL  = 20TR + 15MO + 15RSI + 10BB + 10MACD + 10VOL + 10ATR + 10REL
# ====================================================================
def _comp_trend(s: Dict[str, Any]) -> float:
    last = s.get("last_close") or 0
    sma20, sma50, sma100, sma200 = s.get("sma_20") or 0, s.get("sma_50") or 0, s.get("sma_100") or 0, s.get("sma_200") or 0
    score = 0
    # Price above each SMA: 4 points each (max 16)
    for sma in (sma20, sma50, sma100, sma200):
        if sma and last > sma: score += 16
    # Golden-cross alignment: 20
    if sma50 and sma200 and sma50 > sma200: score += 20
    # SMA20 > SMA50 > SMA200 stack: 16 extra
    if sma20 and sma50 and sma200 and sma20 > sma50 > sma200: score += 16
    return _clip(score)


def _comp_momentum(s: Dict[str, Any]) -> float:
    # Weighted blend of 1w / 1m change
    w, m = s.get("change_pct_1w") or 0, s.get("change_pct_1m") or 0
    # 1w in [-10, +10] → [0..100]; 1m in [-20, +20] → [0..100]
    return 0.5 * linear(w, -10, 10) + 0.5 * linear(m, -20, 20)


def _comp_rsi(s: Dict[str, Any]) -> float:
    r = s.get("rsi_14")
    if r is None: return 50.0
    # Sweet spot 50-65 (healthy uptrend). Above 75 overbought, below 30 oversold.
    if 50 <= r <= 65: return 100.0
    if 40 <= r < 50: return 80.0
    if 65 < r <= 72: return 75.0
    if 30 <= r < 40: return 55.0
    if 72 < r <= 78: return 50.0
    if r > 78: return _clip(100 - (r - 78) * 6)
    if r < 30: return _clip(30 - (30 - r) * 4)
    return 50.0


def _comp_bb(s: Dict[str, Any]) -> float:
    last = s.get("last_close") or 0
    up, lo, mid = s.get("bb_upper"), s.get("bb_lower"), s.get("bb_mid")
    if not (up and lo and mid and last): return 50.0
    width = up - lo
    if width <= 0: return 50.0
    pos = (last - lo) / width   # 0..1 within bands
    # Best: 0.55-0.85 (breakout zone above mid). Worst: <0.15 (falling knife) or >1.05 (extended)
    if 0.55 <= pos <= 0.85: return 100.0
    if 0.85 < pos <= 1.0: return 85.0
    if 1.0 < pos <= 1.10: return 70.0
    if 0.40 <= pos < 0.55: return 70.0
    if 0.20 <= pos < 0.40: return 55.0
    if pos > 1.10: return _clip(70 - (pos - 1.10) * 150)
    return _clip(40 * pos)


def _comp_macd(s: Dict[str, Any]) -> float:
    hist = s.get("macd_hist")
    macd, sig = s.get("macd"), s.get("macd_signal")
    if hist is None: return 50.0
    base = 60 if hist > 0 else 40
    # Magnitude relative to price
    last = s.get("last_close") or 0
    rel = abs(hist) / last * 100 if last else 0
    base += min(25, rel * 50) if hist > 0 else -min(25, rel * 50)
    # MACD above zero line extra
    if macd is not None and macd > 0: base += 10
    return _clip(base)


def _comp_vol(s: Dict[str, Any]) -> float:
    spike = s.get("volume_spike") or 1.0
    # 1.5-3x spike = accumulation signal (ideal). Too high = blow-off risk.
    if 1.3 <= spike <= 3.0: return 100.0
    if 1.0 <= spike < 1.3: return 65.0
    if 0.7 <= spike < 1.0: return 50.0
    if 3.0 < spike <= 5.0: return 70.0
    if spike > 5.0: return _clip(70 - (spike - 5.0) * 10)
    return _clip(60 * spike)


def _comp_atr(s: Dict[str, Any]) -> float:
    """Volatility sanity check: too-tight stocks have no tradeable range;
    too-wild stocks are un-trade-able by retail. Ideal ATR/price = 1.5-3.5%."""
    atr = s.get("atr_14")
    last = s.get("last_close") or 0
    if not (atr and last): return 50.0
    ratio = atr / last * 100
    return band(ratio, 1.5, 3.5, decay=3.0)


def _comp_rel(s: Dict[str, Any]) -> float:
    r = s.get("relative_strength") or 0  # already vs NIFTY, in %
    return linear(r, -10, 10)


def score_technical(s: Dict[str, Any]) -> Tuple[float, List[str]]:
    c = {
        "TR":   _comp_trend(s),
        "MO":   _comp_momentum(s),
        "RSI":  _comp_rsi(s),
        "BB":   _comp_bb(s),
        "MACD": _comp_macd(s),
        "VOL":  _comp_vol(s),
        "ATR":  _comp_atr(s),
        "REL":  _comp_rel(s),
    }
    score = sum(TECHNICAL_WEIGHTS[k] * v / 100 for k, v in c.items())
    reasons: List[str] = []
    if c["TR"] >= 80: reasons.append(f"Strong multi-timeframe uptrend (TR {c['TR']:.0f})")
    if c["RSI"] >= 85: reasons.append(f"RSI in sweet spot ({s.get('rsi_14')})")
    if c["BB"] >= 85: reasons.append("Price in breakout half of Bollinger")
    if c["MACD"] >= 70: reasons.append("MACD momentum positive")
    if c["VOL"] >= 85: reasons.append(f"Volume {s.get('volume_spike',1):.1f}x avg (accumulation)")
    if c["REL"] >= 70: reasons.append(f"Outperforming NIFTY {s.get('relative_strength',0):+.1f}%")
    if c["TR"] <= 30: reasons.append("Below key moving averages")
    if c["MACD"] <= 30: reasons.append("MACD momentum negative")
    return _clip(score), reasons


# ====================================================================
# FUNDAMENTAL  = 20GR + 15PR + 15CF + 10DE + 10IC + 10RO + 10MG + 10BS
# ====================================================================
def score_fundamentals(fin: Dict[str, Any], fmp: Optional[Dict[str, Any]] = None) -> Tuple[float, List[str]]:
    fin = fin or {}
    ratios = (fmp or {}).get("ratios_ttm") or {}
    metrics = (fmp or {}).get("metrics_ttm") or {}

    gr = _pct(fin.get("revenueGrowth"))
    pr = _pct(fin.get("earningsGrowth"))
    # Cash-flow positivity proxy (FMP gives operatingCashFlowPerShare, yfinance gives operatingCashflow)
    cf_raw = _num(ratios.get("operatingCashFlowPerShareTTM") or fin.get("operatingCashflow"))
    cf = 75.0 if (cf_raw is not None and cf_raw > 0) else 35.0
    de = _num(fin.get("debtToEquity"))
    ic = _num(ratios.get("interestCoverageTTM") or ratios.get("interestCoverage"))
    ro = _pct(fin.get("returnOnEquity"))
    mg = _pct(fin.get("profitMargins")) or _pct(fin.get("operatingMargins"))
    cr = _num(ratios.get("currentRatioTTM") or ratios.get("currentRatio") or fin.get("currentRatio"))

    c = {
        "GR": linear(gr, -10, 30),
        "PR": linear(pr, -15, 35),
        "CF": cf,
        "DE": linear(de, 200, 0),  # lower is better → inverted linear
        "IC": linear(ic, 1, 10),
        "RO": linear(ro, 0, 30),
        "MG": linear(mg, 0, 25),
        "BS": band(cr, 1.2, 3.0, decay=1.5),
    }
    score = sum(FUND_WEIGHTS[k] * v / 100 for k, v in c.items())
    reasons: List[str] = []
    if gr is not None and gr > 15: reasons.append(f"Revenue growth {gr:.1f}%")
    if ro is not None and ro > 20: reasons.append(f"ROE {ro:.1f}%")
    if de is not None and de < 40: reasons.append(f"Low leverage D/E {de:.0f}")
    if ic is not None and ic > 6: reasons.append(f"Interest coverage {ic:.1f}x")
    if mg is not None and mg > 15: reasons.append(f"Profit margin {mg:.1f}%")
    if gr is not None and gr < 0: reasons.append(f"Revenue contracting {gr:.1f}%")
    if de is not None and de > 150: reasons.append(f"High leverage D/E {de:.0f}")
    return _clip(score), reasons


# ====================================================================
# VALUATION  = 35PE + 20PB + 20EV + 15PEG + 10DY
# Uses sector-percentile where possible (lower percentile = cheaper = better).
# ====================================================================
def score_valuation(
    fin: Dict[str, Any], fmp: Optional[Dict[str, Any]] = None,
    sector_pe: Optional[List[float]] = None, sector_pb: Optional[List[float]] = None,
    sector_ev: Optional[List[float]] = None,
) -> Tuple[float, List[str]]:
    fin = fin or {}
    metrics = (fmp or {}).get("metrics_ttm") or {}
    pe = _num(fin.get("trailingPE"))
    pb = _num(fin.get("priceToBook"))
    ev = _num(metrics.get("enterpriseValueOverEBITDATTM") or metrics.get("enterpriseValueMultipleTTM"))
    peg = _num(fin.get("pegRatio") or metrics.get("pegRatioTTM"))
    dy = _pct(fin.get("dividendYield"))

    # Cheaper = better → higher_is_better=False
    pe_pct = percentile_rank(sector_pe or [], pe, higher_is_better=False)
    pb_pct = percentile_rank(sector_pb or [], pb, higher_is_better=False)
    ev_pct = percentile_rank(sector_ev or [], ev, higher_is_better=False)

    c = {
        "PE":  pe_pct if sector_pe else band(pe, 10, 22, decay=20),
        "PB":  pb_pct if sector_pb else band(pb, 1, 4, decay=6),
        "EV":  ev_pct if sector_ev else band(ev, 6, 15, decay=10),
        "PEG": band(peg, 0.5, 1.5, decay=1.0),
        "DY":  linear(dy, 0, 5),
    }
    score = sum(VAL_WEIGHTS[k] * v / 100 for k, v in c.items())
    reasons: List[str] = []
    if pe is not None and pe < 18: reasons.append(f"Attractive P/E {pe:.1f}")
    if pe is not None and pe > 55: reasons.append(f"Rich P/E {pe:.1f}")
    if ev is not None and ev < 10: reasons.append(f"EV/EBITDA {ev:.1f}")
    if peg is not None and 0.5 < peg < 1.2: reasons.append(f"Good PEG {peg:.2f}")
    if dy is not None and dy > 3: reasons.append(f"Dividend yield {dy:.1f}%")
    return _clip(score), reasons


# ====================================================================
# OWNERSHIP  = 25FI + 20DI + 20PH + 15PR + 20VL
# FI = FII daily net; DI = DII daily net; PH = promoter holding %;
# PR = promoter-buy signal (insider); VL = delivery % (conviction vs churn)
# ====================================================================
def score_ownership(
    fin: Dict[str, Any],
    bhav: Optional[Dict[str, Any]] = None,
    insider: Optional[Dict[str, Any]] = None,
    fii_net_cr: Optional[float] = None,
    dii_net_cr: Optional[float] = None,
) -> Tuple[float, List[str]]:
    fin = fin or {}
    ph = _pct(fin.get("heldPercentInsiders"))
    institutions = _pct(fin.get("heldPercentInstitutions"))
    promoter_buys_cr = ((insider or {}).get("promoter_buys") or 0) / 1e7
    net_insider_cr = (((insider or {}).get("buys") or 0) - ((insider or {}).get("sells") or 0)) / 1e7
    deliv_pct = (bhav or {}).get("deliv_pct")

    c = {
        "FI":  linear(fii_net_cr,  -2000, 2000),
        "DI":  linear(dii_net_cr,  -2000, 2000),
        "PH":  linear(ph, 20, 70),
        "PR":  linear(promoter_buys_cr, 0, 20) if promoter_buys_cr > 0 else linear(net_insider_cr, -10, 10),
        "VL":  linear(deliv_pct, 25, 75),
    }
    # Add institutional % as a small bias into PH if promoter-holding missing
    if ph is None and institutions is not None:
        c["PH"] = linear(institutions, 10, 55)
    score = sum(OWN_WEIGHTS[k] * v / 100 for k, v in c.items())
    reasons: List[str] = []
    if promoter_buys_cr > 0: reasons.append(f"Promoter buy ₹{promoter_buys_cr:.1f} Cr (30d)")
    if deliv_pct is not None and deliv_pct > 60: reasons.append(f"High delivery {deliv_pct:.0f}%")
    if deliv_pct is not None and deliv_pct < 25: reasons.append(f"Speculative trade (deliv {deliv_pct:.0f}%)")
    if fii_net_cr is not None and fii_net_cr > 1000: reasons.append(f"FII +₹{fii_net_cr:.0f} Cr")
    if fii_net_cr is not None and fii_net_cr < -1000: reasons.append(f"FII -₹{abs(fii_net_cr):.0f} Cr")
    return _clip(score), reasons


# ====================================================================
# ANALYST  = 35RT + 25TP + 20ER + 20CV
# ====================================================================
def score_analyst(fin: Dict[str, Any], fmp: Optional[Dict[str, Any]] = None) -> Tuple[float, List[str]]:
    fin = fin or {}
    rec = fin.get("recommendationMean")       # 1=strong buy ... 5=strong sell
    tp = fin.get("targetMeanPrice")
    cp = fin.get("currentPrice")
    n_analysts = fin.get("numberOfAnalystOpinions") or fin.get("recommendationKey") and 8
    estimates = (fmp or {}).get("estimates") or []

    rt_score = linear(rec, 5, 1)  # lower rec = better → invert by swapping lo/hi
    implied_up = ((tp - cp) / cp * 100) if (tp and cp and cp > 0) else None
    tp_score = linear(implied_up, -10, 30)
    # Estimate revision
    er_score = 50.0
    if len(estimates) >= 2:
        latest = (estimates[0] or {}).get("estimatedEpsAvg") or 0
        prev = (estimates[1] or {}).get("estimatedEpsAvg") or 0
        if latest and prev:
            delta = (latest - prev) / prev * 100
            er_score = linear(delta, -10, 10)
    cv_score = linear(n_analysts if isinstance(n_analysts, (int, float)) else None, 1, 25)

    c = {"RT": rt_score, "TP": tp_score, "ER": er_score, "CV": cv_score}
    score = sum(AN_WEIGHTS[k] * v / 100 for k, v in c.items())
    reasons: List[str] = []
    if rec is not None and rec <= 2: reasons.append(f"Analyst Buy consensus (mean {rec:.1f})")
    if implied_up is not None and implied_up > 15: reasons.append(f"Target implies {implied_up:.0f}% upside")
    if implied_up is not None and implied_up < -10: reasons.append(f"Target implies {abs(implied_up):.0f}% downside")
    if er_score > 65: reasons.append("EPS estimates revised up")
    if er_score < 35: reasons.append("EPS estimates revised down")
    return _clip(score), reasons


# ====================================================================
# NEWS / EVENT  = 30SE + 25IM + 20RE + 15FR + 10TM
# ====================================================================
def score_event_news(
    avg_sentiment: float, headline_count: int,
    upcoming_actions: Optional[list] = None, recency_hours: Optional[float] = None,
    tone_trend: Optional[float] = None,
) -> Tuple[float, List[str]]:
    # "No data" → neutral 50 so stocks without news aren't penalised vs stocks with neutral news.
    # If there's a corporate action lined up, fold that in even when headlines absent.
    if not headline_count:
        base = 50.0
        for act in (upcoming_actions or [])[:3]:
            subj = (act.get("subject") or "").lower()
            if "buyback" in subj: base = min(100.0, base + 12)
            elif "bonus" in subj: base = min(100.0, base + 6)
            elif "split" in subj: base = min(100.0, base + 5)
            elif "dividend" in subj: base = min(100.0, base + 2)
        reasons: List[str] = []
        if upcoming_actions:
            for act in upcoming_actions[:2]:
                subj = act.get("subject") or ""
                if any(k in subj.lower() for k in ("buyback", "bonus", "split", "dividend")):
                    reasons.append(f"{subj} (ex {act.get('ex_date')})")
        return _clip(base), reasons

    # SE sentiment [-1, +1] → [0, 100]
    se = linear(avg_sentiment, -1.0, 1.0)
    # IM impact = |sentiment| * log(1+count) — non-directional intensity
    im = _clip(abs(avg_sentiment) * 50 + math.log1p(headline_count or 0) * 12)
    # RE recency: fresher = better; ≤6h ideal, 72h+ stale
    re = linear(recency_hours, 72, 0) if recency_hours is not None else 60.0
    # FR frequency: 3-10 headlines is a healthy signal window
    fr = band(headline_count, 3, 10, decay=5)
    # TM tone momentum: trend in sentiment over time (if provided, else neutral + corp action bump)
    tm = linear(tone_trend, -0.5, 0.5) if tone_trend is not None else 50.0
    # Corporate-action bonus folded into TM
    for act in (upcoming_actions or [])[:3]:
        subj = (act.get("subject") or "").lower()
        if "buyback" in subj: tm = min(100, tm + 20)
        elif "bonus" in subj: tm = min(100, tm + 10)
        elif "split" in subj: tm = min(100, tm + 8)
        elif "dividend" in subj: tm = min(100, tm + 3)

    c = {"SE": se, "IM": im, "RE": re, "FR": fr, "TM": tm}
    score = sum(NEWS_WEIGHTS[k] * v / 100 for k, v in c.items())
    reasons: List[str] = []
    if avg_sentiment > 0.3: reasons.append(f"Positive news flow ({headline_count} items)")
    if avg_sentiment < -0.3: reasons.append(f"Negative news flow ({headline_count} items)")
    if upcoming_actions:
        for act in upcoming_actions[:2]:
            subj = act.get("subject") or ""
            if any(k in subj.lower() for k in ("buyback", "bonus", "split", "dividend")):
                reasons.append(f"{subj} (ex {act.get('ex_date')})")
    return _clip(score), reasons


# ====================================================================
# MACRO / SECTOR  = 30SR + 20VX + 20FX + 15CM + 15GL
# ====================================================================
def score_macro_sector(
    sector: str, sector_breadth: Dict[str, float],
    vix: Optional[float] = None, usdinr_chg: Optional[float] = None, dxy_chg: Optional[float] = None,
    commodity_impact: float = 0.0, global_avg_chg: Optional[float] = None,
    is_export_sector: bool = False,
) -> Tuple[float, List[str]]:
    # SR sector trend: percentile of this sector's 1M move within all sectors
    sec_vals = list(sector_breadth.values())
    sec_val = sector_breadth.get(sector)
    sr = percentile_rank(sec_vals, sec_val) if sec_vals else 50.0
    # VX volatility: low VIX = bullish
    vx = linear(vix, 30, 10)
    # FX: USDINR rising is mixed — good for exporters, bad for importers
    fx_base = linear(usdinr_chg, 1.0, -1.0)    # by default, strong rupee (negative USDINR chg) is positive
    if is_export_sector:
        fx_base = 100 - fx_base                 # invert for IT/Pharma
    # Blend DXY: USD strength typically EM-negative
    dxy_effect = linear(dxy_chg, 1.0, -1.0)
    fx = 0.6 * fx_base + 0.4 * dxy_effect
    # CM commodity mapping (already in [-15, +15]) → map to [0..100]
    cm = _clip(50 + (commodity_impact * 3.3))
    # GL global: avg change % across major global indices in [-1%, +1%]
    gl = linear(global_avg_chg, -1.0, 1.0)

    c = {"SR": sr, "VX": vx, "FX": fx, "CM": cm, "GL": gl}
    score = sum(MACRO_WEIGHTS[k] * v / 100 for k, v in c.items())
    reasons: List[str] = []
    if sr >= 75: reasons.append(f"Sector {sector} leading the market")
    elif sr <= 25: reasons.append(f"Sector {sector} lagging")
    if vix is not None and vix < 13: reasons.append(f"Benign VIX {vix:.1f}")
    if vix is not None and vix > 20: reasons.append(f"Elevated VIX {vix:.1f}")
    if commodity_impact >= 3: reasons.append(f"Commodity tailwind +{commodity_impact:.1f}")
    if commodity_impact <= -3: reasons.append(f"Commodity headwind {commodity_impact:.1f}")
    return _clip(score), reasons


# ====================================================================
# Hybrid universe normalization
# --------------------------------------------------------------------
# Each sub-score has a mix of "relative" components (growth, momentum,
# valuation vs peers, flows) and "absolute regime" components (debt ratio,
# RSI zone, VIX, freshness). We therefore blend each sub-score with its
# universe percentile rank using a per-block alpha:
#
#     new_sub = alpha * absolute_raw + (1 - alpha) * universe_percentile
#
# alpha = 1.0 -> fully absolute (regime variable)
# alpha = 0.0 -> fully relative (percentile)
#
# Rationale (per user direction):
#   * Technical / Valuation / Analyst -> heavily relative (lower alpha)
#   * Fundamental / Ownership         -> balanced (growth/flow relative,
#                                         safety ratios absolute)
#   * Event_news -> mostly absolute (sentiment threshold + freshness matter
#                   more than relative rank)
#   * Macro_sector -> fully absolute (regime, already has internal pctl)
# ====================================================================
# ====================================================================
# Earnings event-risk penalty
# --------------------------------------------------------------------
# If a stock's next earnings fall inside this window, its Technical and
# Event/News sub-scores are blended toward a neutral 50 to prevent a
# pre-earnings momentum blip from forcing it into the weekly idea list.
# The blend factor scales linearly with proximity — the closer the
# earnings, the more of the score is pulled to neutral.
#
#   dampen = max(0, (window - days_to_earnings) / window)
#   new_score = score * (1 - dampen) + 50 * dampen
#
# This is INDEPENDENT of the hard earnings-exclusion filter in
# `_select_ideas`. That filter removes qualifying ideas when earnings
# land inside the holding horizon; this penalty makes it harder for
# pre-earnings noise to push a score across the qualification bar in
# the first place.
# ====================================================================
EARNINGS_PENALTY_WINDOW_DAYS = 7
EARNINGS_PENALTY_FIELDS = ("technical", "event_news")


def apply_earnings_penalty(
    sub: Dict[str, float], days_to_earnings: Optional[int],
    window: int = EARNINGS_PENALTY_WINDOW_DAYS,
) -> Dict[str, float]:
    """Return a copy of `sub` with event-risk dampening applied in place for
    the technical + event_news components when earnings are ≤ `window` days
    out. If `days_to_earnings` is None or > window, returns sub unchanged.
    """
    if days_to_earnings is None or days_to_earnings > window or window <= 0:
        return sub
    dampen = max(0.0, min(1.0, (window - max(0, days_to_earnings)) / window))
    out = dict(sub)
    for k in EARNINGS_PENALTY_FIELDS:
        v = sub.get(k)
        if v is None:
            continue
        try:
            fv = float(v)
        except (TypeError, ValueError):
            continue
        out[k] = round(_clip(fv * (1 - dampen) + 50.0 * dampen), 2)
    return out


HYBRID_ALPHA = {
    "technical":    0.35,
    "fundamental":  0.50,
    "valuation":    0.30,
    "ownership":    0.45,
    "analyst":      0.40,
    "event_news":   0.35,   # sentiment intensity + headline flow are peer-relative
    "macro_sector": 0.50,   # sector rank component is inherently relative; VIX/FX handled absolutely inside score_macro_sector
}


def normalize_subscores_universe(all_subs: List[Dict[str, float]]) -> List[Dict[str, float]]:
    """Return a new list where each sub-score is blended with its universe
    percentile rank using HYBRID_ALPHA. Missing keys are left untouched."""
    if not all_subs:
        return []
    # Pre-compute universe value arrays per key
    by_key: Dict[str, List[float]] = {k: [] for k in FINAL_WEIGHTS}
    for s in all_subs:
        for k in by_key:
            v = s.get(k)
            if v is None:
                continue
            try:
                fv = float(v)
            except (TypeError, ValueError):
                continue
            if math.isnan(fv):
                continue
            by_key[k].append(fv)
    out: List[Dict[str, float]] = []
    for s in all_subs:
        new = dict(s)
        for k, alpha in HYBRID_ALPHA.items():
            if k not in s or s[k] is None:
                continue
            try:
                raw = float(s[k])
            except (TypeError, ValueError):
                continue
            if alpha >= 0.999 or not by_key[k]:
                new[k] = round(_clip(raw), 2)
                continue
            p = percentile_rank(by_key[k], raw, higher_is_better=True)
            new[k] = round(_clip(alpha * raw + (1 - alpha) * p), 2)
        out.append(new)
    return out


# ====================================================================
# Final score + trade classification
# ====================================================================
def final_conviction(sub: Dict[str, float]) -> float:
    return round(sum(FINAL_WEIGHTS[k] * sub.get(k, 50) for k in FINAL_WEIGHTS), 2)


def classify_trade(
    final: float, technical: float, fundamental: float, macro_sector: float,
) -> Tuple[str, Optional[str]]:
    """Return (direction, horizon).

    Weekly: Final ≥ 72 AND Technical ≥ 70
    Monthly: Final ≥ 75 AND Fundamental ≥ 70 AND Macro ≥ 65
    Avoid: Final ≤ 40
    Everything else = watch
    """
    if final <= 40:
        return "avoid", None
    monthly_ok = final >= 75 and fundamental >= 70 and macro_sector >= 65
    weekly_ok  = final >= 72 and technical  >= 70
    if monthly_ok and weekly_ok:
        return "bullish", "both"
    if monthly_ok:
        return "bullish", "monthly"
    if weekly_ok:
        return "bullish", "weekly"
    if final <= 48 and technical <= 45:
        return "bearish", None
    return "watch", None


# ====================================================================
# Hard filters
# ====================================================================
def apply_hard_filters(
    snapshot: Dict[str, Any],
    universe_row: Dict[str, Any],
    bhav: Optional[Dict[str, Any]],
    risk_flags: Optional[List[str]] = None,
    min_price: float = 50.0,
    min_turnover_cr: float = 1.0,
    min_market_cap_tier: str = "small",
    max_data_age_days: int = 3,
) -> Tuple[bool, List[str]]:
    """Return (passes, rejection_reasons). A candidate passes only if ALL filters pass."""
    rejects: List[str] = []
    last = snapshot.get("last_close") or 0
    if last < min_price:
        rejects.append(f"price ₹{last:.0f} < ₹{min_price:.0f}")
    # liquidity — prefer bhavcopy turnover_lacs if available
    turnover_cr = 0.0
    if bhav and bhav.get("turnover_lacs") is not None:
        turnover_cr = (bhav["turnover_lacs"] or 0) / 100.0   # lacs → crores
    else:
        # fallback: avg_volume × last_close
        avg_vol = snapshot.get("volume_avg_20") or 0
        turnover_cr = (avg_vol * last) / 1e7
    if turnover_cr < min_turnover_cr:
        rejects.append(f"turnover ₹{turnover_cr:.1f} Cr < ₹{min_turnover_cr:.1f} Cr")
    # market-cap tier gate
    tier_rank = {"large": 3, "mid": 2, "small": 1}
    if tier_rank.get(universe_row.get("market_cap_tier") or "large", 3) < tier_rank.get(min_market_cap_tier, 1):
        rejects.append("below min market-cap tier")
    # freshness — technicals "as_of" must be recent
    # (we don't have exact dates per snapshot beyond run, so accept by default)
    # red flags
    for f in (risk_flags or []):
        rejects.append(f"risk flag: {f}")
    return (len(rejects) == 0), rejects


# ====================================================================
# ATR-based entry / stop / target with minimum 2:1 reward-risk
# ====================================================================
def entry_stop_target(
    last: float, atr: Optional[float], direction: str, horizon: str,
    min_rr: float = 2.0,
) -> Dict[str, float]:
    """Return entry band + stop + target band enforcing at least `min_rr`:1 R/R."""
    atr = atr or (last * 0.02)
    if direction == "bullish":
        entry_low  = round(last * 0.995, 2)
        entry_high = round(last * 1.010, 2)
        stop = round(last - 1.5 * atr, 2)
        risk = max(0.01, last - stop)
        t_mult_low  = 2.0 if horizon == "weekly" else 3.0
        t_mult_high = 3.0 if horizon == "weekly" else 5.0
        t_low  = round(last + max(t_mult_low  * atr, min_rr * risk), 2)
        t_high = round(last + max(t_mult_high * atr, (min_rr + 1) * risk), 2)
    elif direction == "bearish":
        entry_low  = round(last * 0.990, 2)
        entry_high = round(last * 1.005, 2)
        stop = round(last + 1.5 * atr, 2)
        risk = max(0.01, stop - last)
        t_mult_low  = 2.0 if horizon == "weekly" else 3.0
        t_mult_high = 3.0 if horizon == "weekly" else 5.0
        t_low  = round(last - max(t_mult_high * atr, (min_rr + 1) * risk), 2)
        t_high = round(last - max(t_mult_low  * atr, min_rr * risk), 2)
    else:
        entry_low, entry_high = round(last * 0.99, 2), round(last * 1.01, 2)
        stop = round(last * 0.95, 2)
        t_low, t_high = round(last * 1.04, 2), round(last * 1.08, 2)
    return {"entry_low": entry_low, "entry_high": entry_high, "stop_loss": stop,
            "target_low": t_low, "target_high": t_high,
            "risk_reward": round((t_low - last) / max(0.01, last - stop), 2) if direction == "bullish"
                          else round((last - t_high) / max(0.01, stop - last), 2) if direction == "bearish" else min_rr}
