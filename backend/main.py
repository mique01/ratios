"""
Pair Trading Screener API
- /api/single-pair    historical analysis of one pair (yfinance)
- /api/screener       screener over a free list of tickers (yfinance)
- /api/live-prices    proxies data912.com live prices (real-time)
"""

import itertools
import math
import time
from datetime import datetime, timezone
from typing import List, Optional

import numpy as np
import pandas as pd
import requests
import yfinance as yf
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from statsmodels.tsa.stattools import adfuller, coint

app = FastAPI(title="Pair Trading Screener API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ========================================================================
# MODELS
# ========================================================================

class SinglePairRequest(BaseModel):
    ticker1: str
    ticker2: str
    start_year: int = 2022
    window_days: int = 30
    target_return: float = 0.05


class ScreenerRequest(BaseModel):
    tickers: List[str] = Field(..., min_length=2)
    start_year: int = 2022
    window_days: int = 30
    target_return: float = 0.05
    min_signals: int = 3


# ========================================================================
# HELPERS
# ========================================================================

def _safe_float(x):
    if x is None:
        return None
    try:
        v = float(x)
        if math.isnan(v) or math.isinf(v):
            return None
        return v
    except (TypeError, ValueError):
        return None


def calculate_half_life(spread: pd.Series) -> float:
    spread = spread.dropna()
    if len(spread) < 50:
        return float("inf")
    lag = spread.shift(1).dropna()
    delta = spread.diff().dropna()
    common = lag.index.intersection(delta.index)
    lag = lag.loc[common]
    delta = delta.loc[common]
    if len(lag) < 50:
        return float("inf")
    try:
        beta = np.polyfit(lag, delta, 1)[0]
        if beta >= 0:
            return float("inf")
        return -np.log(2) / beta
    except Exception:
        return float("inf")


def analyze_pair(ticker1, ticker2, prices, window_days, target_return, min_signals):
    if ticker1 not in prices.columns or ticker2 not in prices.columns:
        return None, None
    pair_prices = prices[[ticker1, ticker2]].dropna()
    if len(pair_prices) < 2:
        return None, None

    s1, s2 = pair_prices[ticker1], pair_prices[ticker2]
    ratio = s1 / s2
    median, std = ratio.median(), ratio.std()
    if std == 0 or np.isnan(std):
        return None, None

    upper1, lower1 = median + std,   median - std
    upper2, lower2 = median + 2*std, median - 2*std

    spread = np.log(s1) - np.log(s2)
    corr = s1.corr(s2)
    try:    adf_p = adfuller(spread.dropna())[1]
    except Exception: adf_p = float("nan")
    try:    coint_p = coint(np.log(s1), np.log(s2))[1]
    except Exception: coint_p = float("nan")
    half_life = calculate_half_life(spread)

    signals = []
    i = 1
    while i < len(ratio) - window_days:
        r, r_prev = ratio.iloc[i], ratio.iloc[i-1]
        signal, level = None, None
        if   r_prev < upper2 and r >= upper2: signal, level = "SHORT", "2σ"
        elif r_prev > lower2 and r <= lower2: signal, level = "LONG",  "2σ"
        elif r_prev < upper1 and r >= upper1: signal, level = "SHORT", "1σ"
        elif r_prev > lower1 and r <= lower1: signal, level = "LONG",  "1σ"
        if signal is None:
            i += 1; continue

        p1_start, p2_start = s1.iloc[i], s2.iloc[i]
        best_return = -999.0
        days_to_target = None
        for j in range(i+1, i+window_days):
            ret1 = s1.iloc[j]/p1_start - 1
            ret2 = s2.iloc[j]/p2_start - 1
            pair_return = (-ret1 + ret2) if signal == "SHORT" else (ret1 - ret2)
            if pair_return > best_return: best_return = pair_return
            if pair_return >= target_return and days_to_target is None:
                days_to_target = j - i

        signals.append({
            "entry": ratio.index[i].strftime("%Y-%m-%d"),
            "signal": signal, "level": level,
            "max_return_30d": _safe_float(best_return),
            "days_to_target": days_to_target,
            "success": bool(best_return >= target_return),
        })
        i += window_days

    ratio_now  = ratio.iloc[-1]

    if   ratio_now >= upper2: current_signal = "SHORT 2σ"
    elif ratio_now <= lower2: current_signal = "LONG 2σ"
    elif ratio_now >= upper1: current_signal = "SHORT 1σ"
    elif ratio_now <= lower1: current_signal = "LONG 1σ"
    else:                     current_signal = "SIN SEÑAL"

    if not signals:
        if min_signals <= 1:
            summary = {
                "pair": f"{ticker1}/{ticker2}",
                "ticker1": ticker1, "ticker2": ticker2,
                "signals": 0,
                "winrate_5pct_30d": None,
                "avg_return_30d": None,
                "avg_days_to_target": None,
                "corr": _safe_float(corr),
                "adf_p": _safe_float(adf_p),
                "coint_p": _safe_float(coint_p),
                "half_life": _safe_float(half_life),
                "ratio_now": _safe_float(ratio_now),
                "median":  _safe_float(median),
                "upper1":  _safe_float(upper1), "lower1": _safe_float(lower1),
                "upper2":  _safe_float(upper2), "lower2": _safe_float(lower2),
                "p1_now":  _safe_float(s1.iloc[-1]),
                "p2_now":  _safe_float(s2.iloc[-1]),
                "current_signal": current_signal,
                "score": 0,
            }
            return summary, []
        return None, None
    if len(signals) < min_signals:
        return None, signals

    df = pd.DataFrame(signals)
    winrate    = df["success"].mean()
    avg_return = df["max_return_30d"].mean()
    avg_days   = df["days_to_target"].dropna().mean() if df["days_to_target"].notna().any() else None

    adf_pen   = 1/(1+adf_p)   if pd.notna(adf_p)   else 0.5
    coint_pen = 1/(1+coint_p) if pd.notna(coint_p) else 0.5
    hl_pen    = 1/(1+half_life/50) if np.isfinite(half_life) else 0.1
    score = winrate * max(avg_return, 0) * abs(corr) * adf_pen * coint_pen * hl_pen

    summary = {
        "pair": f"{ticker1}/{ticker2}",
        "ticker1": ticker1, "ticker2": ticker2,
        "signals": len(df),
        "winrate_5pct_30d": _safe_float(winrate),
        "avg_return_30d":   _safe_float(avg_return),
        "avg_days_to_target": _safe_float(avg_days),
        "corr": _safe_float(corr),
        "adf_p": _safe_float(adf_p),
        "coint_p": _safe_float(coint_p),
        "half_life": _safe_float(half_life),
        "ratio_now": _safe_float(ratio_now),
        "median":  _safe_float(median),
        "upper1":  _safe_float(upper1), "lower1": _safe_float(lower1),
        "upper2":  _safe_float(upper2), "lower2": _safe_float(lower2),
        "p1_now":  _safe_float(s1.iloc[-1]),
        "p2_now":  _safe_float(s2.iloc[-1]),
        "current_signal": current_signal,
        "score": _safe_float(score),
    }
    return summary, signals


# ========================================================================
# DATA912 — live price cache (20s TTL since they update every 20s)
# ========================================================================

_LIVE_CACHE = {"data": None, "ts": 0.0}
DATA912_URL = "https://data912.com/live/usa_stocks"
CACHE_TTL = 15  # seconds — under their 20s refresh

# data912 returns 403 for the default `requests` User-Agent.
# A standard browser UA works fine.
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}


def _download_yahoo_chart(tickers: List[str], start_date: str) -> pd.DataFrame:
    """
    Fallback for Render/yfinance quirks. Uses Yahoo's public chart endpoint
    directly and returns a Close-like dataframe indexed by date.
    """
    start_ts = int(datetime.strptime(start_date, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())
    end_ts = int(time.time())
    series = {}

    for ticker in tickers:
        url = (
            f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
            f"?period1={start_ts}&period2={end_ts}&interval=1d&events=history"
        )
        try:
            r = requests.get(url, headers=_HEADERS, timeout=15)
            r.raise_for_status()
            result = (r.json().get("chart", {}).get("result") or [None])[0]
            if not result:
                continue

            timestamps = result.get("timestamp") or []
            indicators = result.get("indicators", {})
            adjclose = (indicators.get("adjclose") or [{}])[0].get("adjclose")
            close = (indicators.get("quote") or [{}])[0].get("close")
            values = adjclose or close or []

            if not timestamps or not values:
                continue

            idx = pd.to_datetime(timestamps, unit="s").date
            series[ticker] = pd.Series(values, index=pd.to_datetime(idx), dtype="float64")
        except Exception:
            continue

    if not series:
        return pd.DataFrame()

    return pd.DataFrame(series).dropna(axis=1, how="all")


def _download_prices(tickers: List[str], start_date: str) -> pd.DataFrame:
    try:
        data = yf.download(tickers, start=start_date, auto_adjust=True, progress=False)
        if "Close" in data:
            prices = data["Close"]
            if isinstance(prices, pd.Series):
                prices = prices.to_frame(tickers[0])
            prices = prices.dropna(axis=1, how="all")
            if len(prices.dropna()) >= 2:
                return prices
    except Exception:
        pass

    return _download_yahoo_chart(tickers, start_date)


def _fetch_live():
    now = time.time()
    if _LIVE_CACHE["data"] is not None and (now - _LIVE_CACHE["ts"] < CACHE_TTL):
        return _LIVE_CACHE["data"]
    try:
        r = requests.get(DATA912_URL, headers=_HEADERS, timeout=10)
        r.raise_for_status()
        arr = r.json()
        idx = {row["symbol"].upper(): row for row in arr if "symbol" in row}
        _LIVE_CACHE["data"] = idx
        _LIVE_CACHE["ts"] = now
        return idx
    except Exception as e:
        if _LIVE_CACHE["data"] is not None:
            return _LIVE_CACHE["data"]  # serve stale on failure
        raise HTTPException(status_code=502, detail=f"data912 unreachable: {e}")


# ========================================================================
# ENDPOINTS
# ========================================================================

@app.get("/")
def root():
    return {"status": "ok", "service": "pair-trading-screener"}


@app.post("/api/single-pair")
def single_pair(req: SinglePairRequest):
    t1 = req.ticker1.upper().strip()
    t2 = req.ticker2.upper().strip()
    if t1 == t2 or not t1 or not t2:
        raise HTTPException(status_code=400, detail="Tickers must be different and non-empty.")
    start_date = f"{req.start_year}-01-01"

    prices = _download_prices([t1, t2], start_date)
    if prices.empty:
        raise HTTPException(status_code=400, detail="No price data returned.")

    if isinstance(prices, pd.Series) or t1 not in prices.columns or t2 not in prices.columns:
        raise HTTPException(status_code=400, detail="Ticker not found.")
    prices = prices[[t1, t2]].dropna()
    if len(prices) < 2:
        raise HTTPException(status_code=400, detail="Not enough history.")

    summary, signals = analyze_pair(t1, t2, prices, req.window_days, req.target_return, 1)
    if summary is None:
        raise HTTPException(status_code=400, detail="Pair could not be analyzed.")

    ratio = (prices[t1] / prices[t2]).dropna()
    chart = {
        "dates":  [d.strftime("%Y-%m-%d") for d in ratio.index],
        "ratio":  [_safe_float(v) for v in ratio.values],
        "median": summary["median"],
        "upper1": summary["upper1"], "lower1": summary["lower1"],
        "upper2": summary["upper2"], "lower2": summary["lower2"],
    }
    return {"summary": summary, "signals": signals or [], "chart": chart}


@app.post("/api/screener")
def screener(req: ScreenerRequest):
    tickers = sorted({t.upper().strip() for t in req.tickers if t.strip()})
    if len(tickers) < 2:
        raise HTTPException(status_code=400, detail="Provide at least 2 tickers.")
    start_date = f"{req.start_year}-01-01"

    prices = _download_prices(tickers, start_date)
    if prices.empty:
        raise HTTPException(status_code=400, detail="No price data returned.")

    if isinstance(prices, pd.Series):
        raise HTTPException(status_code=400, detail="Need at least 2 valid tickers.")
    prices = prices.dropna(axis=1, how="all")

    results = []
    for t1, t2 in itertools.combinations(prices.columns, 2):
        summary, _ = analyze_pair(t1, t2, prices, req.window_days, req.target_return, req.min_signals)
        if summary:
            results.append(summary)

    results.sort(key=lambda r: (r["score"] or 0), reverse=True)
    return {
        "results": results,
        "total_pairs_with_signals": len(results),
        "tickers_used": list(prices.columns),
        "tickers_dropped": sorted(set(tickers) - set(prices.columns)),
    }


@app.get("/api/live-prices")
def live_prices(symbols: str):
    """
    Comma-separated symbols. Returns {SYM: {c, pct_change, ts}}.
    The frontend hits this every 20-30s while the watchlist tab is open.
    """
    wanted = [s.upper().strip() for s in symbols.split(",") if s.strip()]
    if not wanted:
        raise HTTPException(status_code=400, detail="No symbols provided.")
    idx = _fetch_live()
    out = {}
    for s in wanted:
        row = idx.get(s)
        if row is None:
            out[s] = None
        else:
            out[s] = {
                "c": _safe_float(row.get("c")),
                "pct_change": _safe_float(row.get("pct_change")),
                "px_bid": _safe_float(row.get("px_bid")),
                "px_ask": _safe_float(row.get("px_ask")),
            }
    return {"prices": out, "as_of": _LIVE_CACHE["ts"]}
