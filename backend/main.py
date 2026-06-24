"""
Pair Trading Screener API
- /api/single-pair    historical analysis of one pair (yfinance)
- /api/bollinger-pair historical Bollinger-band analysis of one ratio
- /api/screener       screener over a free list of tickers (yfinance)
- /api/live-prices    proxies data912.com live prices (real-time)
"""

import itertools
import math
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional

import numpy as np
import pandas as pd
import requests
import statsmodels.api as sm
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


class BollingerPairRequest(BaseModel):
    ticker1: str
    ticker2: str
    start_year: int = 2022


class RobustPairRequest(BaseModel):
    ticker1: str
    ticker2: str
    start_year: int = 2022
    target_return: float = 0.05
    use_target_exit: bool = False
    transaction_cost: float = 0.002
    min_signals: int = 5
    max_half_life_filter: int = 60
    windows_to_test: List[int] = Field(default_factory=lambda: [10, 15, 20, 25, 30, 40, 50, 60])
    stds_to_test: List[float] = Field(default_factory=lambda: [1.5, 1.75, 2.0, 2.25, 2.5])


class ScreenerRequest(BaseModel):
    tickers: List[str] = Field(..., min_length=2)
    start_year: int = 2022
    window_days: int = 30
    target_return: float = 0.05
    min_signals: int = 3


class TradePlanRequest(BaseModel):
    ticker1: str
    ticker2: str
    current_signal: str
    p1_now: float
    p2_now: float
    trade_mode: str = "SHARES"
    usd_per_leg: float = 1000.0
    target_dte: int = 30


class WatchlistLiveLeg(BaseModel):
    contract_symbol: str
    underlying: str
    expiry: str
    option_type: str
    strike: float


class WatchlistLiveItem(BaseModel):
    id: str
    ticker1: str
    ticker2: str
    trade_mode: str = "SHARES"
    option1: Optional[WatchlistLiveLeg] = None
    option2: Optional[WatchlistLiveLeg] = None


class WatchlistLiveRequest(BaseModel):
    items: List[WatchlistLiveItem] = Field(default_factory=list)


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


def _quote_with_fallback(last_price, bid, ask):
    last = _safe_float(last_price)
    bid_v = _safe_float(bid)
    ask_v = _safe_float(ask)
    if bid_v is not None and ask_v is not None and bid_v > 0 and ask_v > 0:
        return (bid_v + ask_v) / 2
    if last is not None and last > 0:
        return last
    if bid_v is not None and bid_v > 0:
        return bid_v
    if ask_v is not None and ask_v > 0:
        return ask_v
    return None


def _signal_side(signal: str) -> Optional[str]:
    text = (signal or "").upper()
    if text.startswith("LONG"):
        return "LONG"
    if text.startswith("SHORT"):
        return "SHORT"
    return None


def _share_directions(side: str):
    if side == "LONG":
        return ("LONG", "SHORT")
    return ("SHORT", "LONG")


def _option_types_for_side(side: str):
    if side == "LONG":
        return ("call", "put")
    return ("put", "call")


def _build_share_plan(side: str, ticker1: str, ticker2: str, p1_now: float, p2_now: float, usd_per_leg: float):
    dir1, dir2 = _share_directions(side)
    qty1 = usd_per_leg / p1_now
    qty2 = usd_per_leg / p2_now
    return {
        "trade_mode": "SHARES",
        "usd_per_leg": _safe_float(usd_per_leg),
        "total_gross_exposure": _safe_float(usd_per_leg * 2),
        "legs": [
            {
                "ticker": ticker1,
                "direction": dir1,
                "action": "BUY" if dir1 == "LONG" else "SHORT",
                "entry_price": _safe_float(p1_now),
                "shares": _safe_float(qty1),
                "entry_notional": _safe_float(qty1 * p1_now),
            },
            {
                "ticker": ticker2,
                "direction": dir2,
                "action": "BUY" if dir2 == "LONG" else "SHORT",
                "entry_price": _safe_float(p2_now),
                "shares": _safe_float(qty2),
                "entry_notional": _safe_float(qty2 * p2_now),
            },
        ],
    }


def _load_option_candidates(ticker: str, expiry: str, option_type: str):
    chain = yf.Ticker(ticker).option_chain(expiry)
    df = chain.calls if option_type == "call" else chain.puts
    if df is None or df.empty:
        raise HTTPException(status_code=400, detail=f"No {option_type}s found for {ticker} {expiry}.")
    candidates = df.copy()
    candidates["quote"] = candidates.apply(
        lambda row: _quote_with_fallback(row.get("lastPrice"), row.get("bid"), row.get("ask")),
        axis=1,
    )
    candidates = candidates[candidates["quote"].notna()]
    if candidates.empty:
        raise HTTPException(status_code=400, detail=f"No liquid {option_type}s found for {ticker} {expiry}.")
    return candidates


def _select_nearest_expiry(ticker: str, target_dte: int) -> str:
    expiries = yf.Ticker(ticker).options or []
    if not expiries:
        raise HTTPException(status_code=400, detail=f"No option expiries available for {ticker}.")

    today = datetime.now(timezone.utc).date()
    parsed = []
    for expiry in expiries:
        exp_date = datetime.strptime(expiry, "%Y-%m-%d").date()
        days = (exp_date - today).days
        if days >= 0:
            parsed.append((expiry, days))
    if not parsed:
        raise HTTPException(status_code=400, detail=f"No non-expired option expiries available for {ticker}.")

    parsed.sort(key=lambda row: (abs(row[1] - target_dte), row[1]))
    return parsed[0][0]


def _select_option_contract(ticker: str, option_type: str, underlying_price: float, target_dte: int):
    expiry = _select_nearest_expiry(ticker, target_dte)
    exp_date = datetime.strptime(expiry, "%Y-%m-%d").date()
    days_to_expiry = (exp_date - datetime.now(timezone.utc).date()).days
    candidates = _load_option_candidates(ticker, expiry, option_type)
    candidates["atm_distance"] = (candidates["strike"] - underlying_price).abs()
    candidates["spread"] = (candidates["ask"].fillna(0) - candidates["bid"].fillna(0)).abs()
    best = candidates.sort_values(["atm_distance", "spread", "volume"], ascending=[True, True, False]).iloc[0]
    price = _quote_with_fallback(best.get("lastPrice"), best.get("bid"), best.get("ask"))
    if price is None or price <= 0:
        raise HTTPException(status_code=400, detail=f"Invalid {option_type} quote for {ticker}.")

    return {
        "ticker": ticker,
        "option_type": option_type.upper(),
        "contract_symbol": best["contractSymbol"],
        "expiry": expiry,
        "days_to_expiry": days_to_expiry,
        "strike": _safe_float(best["strike"]),
        "entry_price": _safe_float(price),
        "bid": _safe_float(best.get("bid")),
        "ask": _safe_float(best.get("ask")),
        "last_price": _safe_float(best.get("lastPrice")),
    }


def _build_option_plan(side: str, ticker1: str, ticker2: str, p1_now: float, p2_now: float, usd_per_leg: float, target_dte: int):
    opt_type1, opt_type2 = _option_types_for_side(side)
    leg1 = _select_option_contract(ticker1, opt_type1, p1_now, target_dte)
    leg2 = _select_option_contract(ticker2, opt_type2, p2_now, target_dte)

    for leg in (leg1, leg2):
        exact_contracts = usd_per_leg / (leg["entry_price"] * 100)
        contracts = max(1, int(round(exact_contracts)))
        leg["action"] = "BUY_TO_OPEN"
        leg["contracts"] = contracts
        leg["exact_contracts"] = _safe_float(exact_contracts)
        leg["entry_cost"] = _safe_float(contracts * leg["entry_price"] * 100)

    return {
        "trade_mode": "OPTIONS",
        "usd_per_leg": _safe_float(usd_per_leg),
        "target_dte": int(target_dte),
        "total_entry_cost": _safe_float((leg1["entry_cost"] or 0) + (leg2["entry_cost"] or 0)),
        "legs": [leg1, leg2],
    }


def _option_quote_from_chain(cache: Dict, underlying: str, expiry: str, contract_symbol: str, option_type: str):
    key = (underlying, expiry)
    if key not in cache:
        cache[key] = {
            "call": _load_option_candidates(underlying, expiry, "call"),
            "put": _load_option_candidates(underlying, expiry, "put"),
        }
    df = cache[key]["call" if option_type.lower() == "call" else "put"]
    row = df[df["contractSymbol"] == contract_symbol]
    if row.empty:
        return None
    data = row.iloc[0]
    price = _quote_with_fallback(data.get("lastPrice"), data.get("bid"), data.get("ask"))
    return {
        "price": _safe_float(price),
        "bid": _safe_float(data.get("bid")),
        "ask": _safe_float(data.get("ask")),
        "last_price": _safe_float(data.get("lastPrice")),
    }


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


def analyze_bollinger_pair(ticker1, ticker2, prices, lookback=20, target_return=0.05, forward_days=7):
    if ticker1 not in prices.columns or ticker2 not in prices.columns:
        return None, None, None
    pair_prices = prices[[ticker1, ticker2]].dropna()
    if len(pair_prices) < lookback + forward_days + 2:
        return None, None, None

    s1, s2 = pair_prices[ticker1], pair_prices[ticker2]
    ratio = (s1 / s2).dropna()
    mean = ratio.rolling(lookback).mean()
    std = ratio.rolling(lookback).std()
    upper = mean + 2 * std
    lower = mean - 2 * std

    spread = np.log(s1) - np.log(s2)
    corr = s1.corr(s2)
    try:    adf_p = adfuller(spread.dropna())[1]
    except Exception: adf_p = float("nan")
    try:    coint_p = coint(np.log(s1), np.log(s2))[1]
    except Exception: coint_p = float("nan")
    half_life = calculate_half_life(spread)

    signals = []
    i = lookback
    while i < len(ratio) - forward_days:
        if pd.isna(upper.iloc[i]) or pd.isna(lower.iloc[i]) or pd.isna(upper.iloc[i - 1]) or pd.isna(lower.iloc[i - 1]):
            i += 1
            continue

        r, r_prev = ratio.iloc[i], ratio.iloc[i - 1]
        signal = None
        if r_prev < upper.iloc[i - 1] and r >= upper.iloc[i]:
            signal = "SHORT"
        elif r_prev > lower.iloc[i - 1] and r <= lower.iloc[i]:
            signal = "LONG"
        if signal is None:
            i += 1
            continue

        entry_ratio = ratio.iloc[i]
        best_move = -999.0
        days_to_target = None
        for j in range(i + 1, i + forward_days + 1):
            if j >= len(ratio):
                break
            move = ratio.iloc[j] / entry_ratio - 1
            directional_move = move if signal == "LONG" else -move
            if directional_move > best_move:
                best_move = directional_move
            if directional_move >= target_return and days_to_target is None:
                days_to_target = j - i

        signals.append({
            "entry": ratio.index[i].strftime("%Y-%m-%d"),
            "signal": signal,
            "level": "-2STD" if signal == "LONG" else "+2STD",
            "entry_ratio": _safe_float(entry_ratio),
            "band": _safe_float(lower.iloc[i] if signal == "LONG" else upper.iloc[i]),
            "max_move_7d": _safe_float(best_move),
            "days_to_target": days_to_target,
            "success": bool(best_move >= target_return),
        })
        i += forward_days

    valid = pd.DataFrame({"ratio": ratio, "mean": mean, "upper": upper, "lower": lower}).dropna()
    if valid.empty:
        return None, None, None

    ratio_now = ratio.iloc[-1]
    mean_now = mean.iloc[-1]
    upper_now = upper.iloc[-1]
    lower_now = lower.iloc[-1]

    if pd.isna(upper_now) or pd.isna(lower_now):
        current_signal = "SIN SEÑAL"
    elif ratio_now >= upper_now:
        current_signal = "SHORT +2STD"
    elif ratio_now <= lower_now:
        current_signal = "LONG -2STD"
    else:
        current_signal = "SIN SEÑAL"

    if signals:
        df = pd.DataFrame(signals)
        winrate = df["success"].mean()
        avg_move = df["max_move_7d"].mean()
        avg_days = df["days_to_target"].dropna().mean() if df["days_to_target"].notna().any() else None
    else:
        winrate = None
        avg_move = None
        avg_days = None

    summary = {
        "pair": f"{ticker1}/{ticker2}",
        "ticker1": ticker1, "ticker2": ticker2,
        "signals": len(signals),
        "winrate_5pct_7d": _safe_float(winrate),
        "avg_move_7d": _safe_float(avg_move),
        "avg_days_to_target": _safe_float(avg_days),
        "corr": _safe_float(corr),
        "adf_p": _safe_float(adf_p),
        "coint_p": _safe_float(coint_p),
        "half_life": _safe_float(half_life),
        "ratio_now": _safe_float(ratio_now),
        "mean20": _safe_float(mean_now),
        "upper2": _safe_float(upper_now),
        "lower2": _safe_float(lower_now),
        "p1_now": _safe_float(s1.iloc[-1]),
        "p2_now": _safe_float(s2.iloc[-1]),
        "current_signal": current_signal,
        "lookback": lookback,
        "forward_days": forward_days,
        "target_return": target_return,
    }

    chart = {
        "dates": [d.strftime("%Y-%m-%d") for d in ratio.index],
        "ratio": [_safe_float(v) for v in ratio.values],
        "mean20": [_safe_float(v) for v in mean.values],
        "upper2": [_safe_float(v) for v in upper.values],
        "lower2": [_safe_float(v) for v in lower.values],
    }
    return summary, signals, chart


def calculate_hedge_ratio_and_spread(prices: pd.DataFrame, ticker1: str, ticker2: str):
    log_p1 = np.log(prices[ticker1])
    log_p2 = np.log(prices[ticker2])

    X = sm.add_constant(log_p2)
    model = sm.OLS(log_p1, X).fit()

    beta = float(model.params.iloc[1])
    alpha = float(model.params.iloc[0])
    spread = log_p1 - beta * log_p2

    return spread, beta, alpha


def max_drawdown(returns) -> float:
    if len(returns) == 0:
        return float("nan")

    equity = (1 + pd.Series(returns)).cumprod()
    peak = equity.cummax()
    drawdown = equity / peak - 1

    return float(drawdown.min())


def run_robust_backtest(
    prices,
    spread,
    ticker1,
    ticker2,
    hedge_ratio,
    bb_window=20,
    entry_z=2.0,
    exit_z=0.0,
    target_return=0.05,
    use_target_exit=False,
    transaction_cost=0.002,
    min_signals=5,
):
    rolling_mean = spread.rolling(bb_window).mean()
    rolling_std = spread.rolling(bb_window).std()
    zscore = (spread - rolling_mean) / rolling_std

    half_life = calculate_half_life(spread)

    if np.isfinite(half_life):
        max_trade_days = int(min(bb_window, max(3, round(2 * half_life))))
    else:
        max_trade_days = bb_window

    trades = []
    i = bb_window + 1

    while i < len(spread) - 1:
        z = zscore.iloc[i]
        z_prev = zscore.iloc[i - 1]

        if np.isnan(z) or np.isnan(z_prev):
            i += 1
            continue

        signal = None
        if z_prev < entry_z and z >= entry_z:
            signal = "SHORT_SPREAD"
        elif z_prev > -entry_z and z <= -entry_z:
            signal = "LONG_SPREAD"

        if signal is None:
            i += 1
            continue

        entry_idx = i
        entry_date = spread.index[entry_idx]

        p1_entry = prices[ticker1].iloc[entry_idx]
        p2_entry = prices[ticker2].iloc[entry_idx]
        spread_entry = spread.iloc[entry_idx]
        z_entry = zscore.iloc[entry_idx]

        exit_idx = None
        exit_reason = None
        best_return = -999.0
        worst_return = 999.0
        current_return = 0.0

        max_forward = min(entry_idx + max_trade_days, len(spread) - 1)

        for j in range(entry_idx + 1, max_forward + 1):
            p1_now = prices[ticker1].iloc[j]
            p2_now = prices[ticker2].iloc[j]

            ret1 = p1_now / p1_entry - 1
            ret2 = p2_now / p2_entry - 1

            if signal == "LONG_SPREAD":
                current_return = ret1 - hedge_ratio * ret2
                if zscore.iloc[j] >= exit_z:
                    exit_idx = j
                    exit_reason = "MEAN_REVERSION"
                    break
            else:
                current_return = -ret1 + hedge_ratio * ret2
                if zscore.iloc[j] <= exit_z:
                    exit_idx = j
                    exit_reason = "MEAN_REVERSION"
                    break

            best_return = max(best_return, current_return)
            worst_return = min(worst_return, current_return)

            if use_target_exit and current_return >= target_return:
                exit_idx = j
                exit_reason = "TARGET"
                break

        if exit_idx is None:
            exit_idx = max_forward
            exit_reason = "TIME_STOP"

            p1_now = prices[ticker1].iloc[exit_idx]
            p2_now = prices[ticker2].iloc[exit_idx]

            ret1 = p1_now / p1_entry - 1
            ret2 = p2_now / p2_entry - 1

            current_return = (ret1 - hedge_ratio * ret2) if signal == "LONG_SPREAD" else (-ret1 + hedge_ratio * ret2)

        gross_return = current_return
        net_return = gross_return - transaction_cost

        trades.append({
            "entry_date": entry_date,
            "exit_date": spread.index[exit_idx],
            "signal": signal,
            "entry_z": z_entry,
            "exit_z": zscore.iloc[exit_idx],
            "spread_entry": spread_entry,
            "spread_exit": spread.iloc[exit_idx],
            "days": exit_idx - entry_idx,
            "gross_return": gross_return,
            "net_return": net_return,
            "best_return": best_return,
            "worst_return": worst_return,
            "exit_reason": exit_reason,
            "bb_window": bb_window,
            "entry_z_level": entry_z,
            "max_trade_days": max_trade_days,
        })

        i = exit_idx + 1

    trades = pd.DataFrame(trades)

    if len(trades) == 0:
        metrics = {
            "bb_window": bb_window,
            "entry_z": entry_z,
            "signals": 0,
            "winrate": None,
            "avg_return": None,
            "median_return": None,
            "total_return": None,
            "sharpe": None,
            "max_drawdown": None,
            "avg_days": None,
            "score": -999,
        }
        return trades, metrics, rolling_mean, rolling_std, zscore

    returns = trades["net_return"]
    winrate = (returns > 0).mean()
    avg_return = returns.mean()
    median_return = returns.median()
    total_return = (1 + returns).prod() - 1
    sharpe = returns.mean() / returns.std() * np.sqrt(252 / max(trades["days"].mean(), 1)) if returns.std() != 0 else float("nan")
    mdd = max_drawdown(returns)
    avg_days = trades["days"].mean()

    signal_penalty = 0 if len(trades) >= min_signals else -50
    score = (
        winrate * 100
        + avg_return * 1000
        + (0 if np.isnan(sharpe) else sharpe * 10)
        + min(len(trades), 30)
        + signal_penalty
        + (0 if np.isnan(mdd) else mdd * 100)
    )

    metrics = {
        "bb_window": bb_window,
        "entry_z": entry_z,
        "signals": len(trades),
        "winrate": _safe_float(winrate),
        "avg_return": _safe_float(avg_return),
        "median_return": _safe_float(median_return),
        "total_return": _safe_float(total_return),
        "sharpe": _safe_float(sharpe),
        "max_drawdown": _safe_float(mdd),
        "avg_days": _safe_float(avg_days),
        "score": _safe_float(score),
    }

    return trades, metrics, rolling_mean, rolling_std, zscore


def analyze_robust_pair(
    ticker1,
    ticker2,
    prices,
    target_return=0.05,
    use_target_exit=False,
    transaction_cost=0.002,
    min_signals=5,
    max_half_life_filter=60,
    windows_to_test=None,
    stds_to_test=None,
):
    windows_to_test = windows_to_test or [10, 15, 20, 25, 30, 40, 50, 60]
    stds_to_test = stds_to_test or [1.5, 1.75, 2.0, 2.25, 2.5]

    pair_prices = prices[[ticker1, ticker2]].dropna()
    if len(pair_prices) < 100:
        return None

    spread, hedge_ratio, alpha = calculate_hedge_ratio_and_spread(pair_prices, ticker1, ticker2)

    s1 = pair_prices[ticker1]
    s2 = pair_prices[ticker2]
    corr_price = s1.corr(s2)
    corr_returns = s1.pct_change().corr(s2.pct_change())

    try:
        adf_p = adfuller(spread.dropna())[1]
    except Exception:
        adf_p = float("nan")
    try:
        coint_p = coint(np.log(s1), np.log(s2))[1]
    except Exception:
        coint_p = float("nan")

    half_life = calculate_half_life(spread)

    results = []
    all_backtests = {}

    for w in windows_to_test:
        for z in stds_to_test:
            trades, metrics, rm, rs, zs = run_robust_backtest(
                prices=pair_prices,
                spread=spread,
                ticker1=ticker1,
                ticker2=ticker2,
                hedge_ratio=hedge_ratio,
                bb_window=int(w),
                entry_z=float(z),
                exit_z=0.0,
                target_return=target_return,
                use_target_exit=use_target_exit,
                transaction_cost=transaction_cost,
                min_signals=min_signals,
            )
            results.append(metrics)
            all_backtests[(int(w), float(z))] = {
                "trades": trades,
                "rolling_mean": rm,
                "rolling_std": rs,
                "zscore": zs,
            }

    optimization = pd.DataFrame(results).sort_values("score", ascending=False)
    if optimization.empty:
        return None

    best = optimization.iloc[0]
    best_window = int(best["bb_window"])
    best_entry_z = float(best["entry_z"])
    best_data = all_backtests[(best_window, best_entry_z)]

    trades = best_data["trades"]
    rolling_mean = best_data["rolling_mean"]
    rolling_std = best_data["rolling_std"]
    zscore = best_data["zscore"]
    upper_band = rolling_mean + best_entry_z * rolling_std
    lower_band = rolling_mean - best_entry_z * rolling_std

    z_now = zscore.dropna().iloc[-1] if not zscore.dropna().empty else float("nan")
    if pd.notna(z_now) and z_now >= best_entry_z:
        current_signal = "SHORT_SPREAD"
    elif pd.notna(z_now) and z_now <= -best_entry_z:
        current_signal = "LONG_SPREAD"
    else:
        current_signal = "SIN SEÑAL"

    diagnostic = []
    if _safe_float(coint_p) is not None and coint_p < 0.05:
        diagnostic.append({"type": "good", "text": "Cointegration fuerte: par estadisticamente interesante."})
    elif _safe_float(coint_p) is not None and coint_p < 0.10:
        diagnostic.append({"type": "warn", "text": "Cointegration moderada: puede servir, con cuidado."})
    else:
        diagnostic.append({"type": "bad", "text": "No hay cointegration clara: par debil para mean reversion."})

    if _safe_float(adf_p) is not None and adf_p < 0.05:
        diagnostic.append({"type": "good", "text": "ADF: el spread parece estacionario."})
    else:
        diagnostic.append({"type": "warn", "text": "ADF: el spread no parece claramente estacionario."})

    if np.isfinite(half_life) and half_life < max_half_life_filter:
        diagnostic.append({"type": "good", "text": "Half-life razonable."})
    else:
        diagnostic.append({"type": "warn", "text": "Half-life lento o invalido."})

    if len(trades) > 0 and best["signals"] < min_signals:
        diagnostic.append({"type": "warn", "text": "Pocas señales: posible sobreoptimizacion."})

    equity = []
    if len(trades) > 0:
        eq = (1 + trades["net_return"]).cumprod()
        equity = [
            {"date": row["exit_date"].strftime("%Y-%m-%d"), "equity": _safe_float(v)}
            for (_, row), v in zip(trades.iterrows(), eq)
        ]

    trades_out = []
    if len(trades) > 0:
        for _, row in trades.iterrows():
            trades_out.append({
                "entry_date": row["entry_date"].strftime("%Y-%m-%d"),
                "exit_date": row["exit_date"].strftime("%Y-%m-%d"),
                "signal": row["signal"],
                "entry_z": _safe_float(row["entry_z"]),
                "exit_z": _safe_float(row["exit_z"]),
                "days": int(row["days"]),
                "gross_return": _safe_float(row["gross_return"]),
                "net_return": _safe_float(row["net_return"]),
                "best_return": _safe_float(row["best_return"]),
                "worst_return": _safe_float(row["worst_return"]),
                "exit_reason": row["exit_reason"],
            })

    optimization_out = [
        {k: _safe_float(v) if isinstance(v, (float, np.floating)) else int(v) if isinstance(v, (int, np.integer)) else v for k, v in row.items()}
        for row in optimization.head(10).to_dict("records")
    ]

    summary = {
        "pair": f"{ticker1}/{ticker2}",
        "ticker1": ticker1,
        "ticker2": ticker2,
        "hedge_ratio": _safe_float(hedge_ratio),
        "alpha": _safe_float(alpha),
        "corr_price": _safe_float(corr_price),
        "corr_returns": _safe_float(corr_returns),
        "adf_p": _safe_float(adf_p),
        "coint_p": _safe_float(coint_p),
        "half_life": _safe_float(half_life),
        "best_window": best_window,
        "best_entry_z": best_entry_z,
        "signals": int(best["signals"]),
        "winrate": _safe_float(best["winrate"]),
        "avg_return": _safe_float(best["avg_return"]),
        "median_return": _safe_float(best["median_return"]),
        "total_return": _safe_float(best["total_return"]),
        "sharpe": _safe_float(best["sharpe"]),
        "max_drawdown": _safe_float(best["max_drawdown"]),
        "avg_days": _safe_float(best["avg_days"]),
        "score": _safe_float(best["score"]),
        "zscore_now": _safe_float(z_now),
        "spread_now": _safe_float(spread.iloc[-1]),
        "current_signal": current_signal,
        "p1_now": _safe_float(s1.iloc[-1]),
        "p2_now": _safe_float(s2.iloc[-1]),
        "ratio_now": _safe_float(s1.iloc[-1] / s2.iloc[-1]),
        "target_return": target_return,
        "window_days": best_window,
    }

    chart = {
        "dates": [d.strftime("%Y-%m-%d") for d in spread.index],
        "spread": [_safe_float(v) for v in spread.values],
        "mean": [_safe_float(v) for v in rolling_mean.values],
        "upper": [_safe_float(v) for v in upper_band.values],
        "lower": [_safe_float(v) for v in lower_band.values],
        "zscore": [_safe_float(v) for v in zscore.values],
        "equity": equity,
    }

    return {
        "summary": summary,
        "diagnostic": diagnostic,
        "optimization": optimization_out,
        "trades": trades_out,
        "chart": chart,
    }


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


@app.post("/api/bollinger-pair")
def bollinger_pair(req: BollingerPairRequest):
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

    summary, signals, chart = analyze_bollinger_pair(t1, t2, prices)
    if summary is None:
        raise HTTPException(status_code=400, detail="Not enough history for Bollinger analysis.")

    return {"summary": summary, "signals": signals or [], "chart": chart}


@app.post("/api/robust-pair")
def robust_pair(req: RobustPairRequest):
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
    if len(prices) < 100:
        raise HTTPException(status_code=400, detail="Need at least 100 observations for robust analysis.")

    data = analyze_robust_pair(
        ticker1=t1,
        ticker2=t2,
        prices=prices,
        target_return=req.target_return,
        use_target_exit=req.use_target_exit,
        transaction_cost=req.transaction_cost,
        min_signals=req.min_signals,
        max_half_life_filter=req.max_half_life_filter,
        windows_to_test=req.windows_to_test,
        stds_to_test=req.stds_to_test,
    )
    if data is None:
        raise HTTPException(status_code=400, detail="Pair could not be analyzed.")

    return data


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


@app.post("/api/trade-plan")
def trade_plan(req: TradePlanRequest):
    t1 = req.ticker1.upper().strip()
    t2 = req.ticker2.upper().strip()
    if t1 == t2 or not t1 or not t2:
        raise HTTPException(status_code=400, detail="Tickers must be different and non-empty.")

    side = _signal_side(req.current_signal)
    if side is None:
        raise HTTPException(status_code=400, detail="Current signal must be LONG or SHORT.")
    if req.usd_per_leg <= 0:
        raise HTTPException(status_code=400, detail="usd_per_leg must be positive.")

    mode = (req.trade_mode or "SHARES").upper()
    if mode == "SHARES":
        plan = _build_share_plan(side, t1, t2, req.p1_now, req.p2_now, req.usd_per_leg)
    elif mode == "OPTIONS":
        plan = _build_option_plan(side, t1, t2, req.p1_now, req.p2_now, req.usd_per_leg, req.target_dte)
    else:
        raise HTTPException(status_code=400, detail="trade_mode must be SHARES or OPTIONS.")

    return {
        "pair": f"{t1}/{t2}",
        "side": side,
        "trade_mode": mode,
        "plan": plan,
    }


@app.post("/api/watchlist-live")
def watchlist_live(req: WatchlistLiveRequest):
    items = req.items or []
    if not items:
        return {"items": {}, "stock_prices": {}, "as_of": None}

    wanted = sorted({sym for item in items for sym in [item.ticker1.upper().strip(), item.ticker2.upper().strip()] if sym})
    idx = _fetch_live()
    stock_prices = {}
    for sym in wanted:
        row = idx.get(sym)
        stock_prices[sym] = None if row is None else {
            "c": _safe_float(row.get("c")),
            "pct_change": _safe_float(row.get("pct_change")),
            "px_bid": _safe_float(row.get("px_bid")),
            "px_ask": _safe_float(row.get("px_ask")),
        }

    option_cache = {}
    out = {}
    for item in items:
        ticker1 = item.ticker1.upper().strip()
        ticker2 = item.ticker2.upper().strip()
        payload = {
            "ticker1": stock_prices.get(ticker1),
            "ticker2": stock_prices.get(ticker2),
        }

        if (item.trade_mode or "SHARES").upper() == "OPTIONS":
            payload["option1"] = None
            payload["option2"] = None
            if item.option1:
                payload["option1"] = _option_quote_from_chain(
                    option_cache,
                    item.option1.underlying.upper().strip(),
                    item.option1.expiry,
                    item.option1.contract_symbol,
                    item.option1.option_type,
                )
            if item.option2:
                payload["option2"] = _option_quote_from_chain(
                    option_cache,
                    item.option2.underlying.upper().strip(),
                    item.option2.expiry,
                    item.option2.contract_symbol,
                    item.option2.option_type,
                )

        out[item.id] = payload

    return {"items": out, "stock_prices": stock_prices, "as_of": _LIVE_CACHE["ts"]}


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
