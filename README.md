# Pair Trading Terminal

Bloomberg-style terminal for mean-reversion pair trading with **live price feed** for monitoring active signals.

- **Single Pair** — historical analysis of any 2 tickers, with stats and a chart
- **Multi-Pair Screener** — paste a free list of tickers, get all pairs ranked by score
- **Watchlist** — saved signals with **live P&L** updated every 25s from data912.com

```
pair-trading-screener/
├── backend/          FastAPI + yfinance + statsmodels + data912 proxy
│   ├── main.py
│   └── requirements.txt
├── frontend/         Static UI (no build step)
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── render.yaml       One-click Render deploy
└── README.md
```

## Data sources

| Purpose          | Source                          | Notes |
|------------------|---------------------------------|-------|
| Historical bars  | `yfinance`                      | Daily closes, used for analysis |
| Live prices      | `https://data912.com/live/usa_stocks` | ~20s refresh, 120 req/min limit |

The backend proxies data912 with a 15s in-memory cache so the frontend can poll every 25s without ever hitting their rate limit.

## Run locally

**Backend**
```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

**Frontend**
```bash
cd frontend
python -m http.server 5500
# open http://localhost:5500
```

The frontend defaults to `http://localhost:8000`. To point at a deployed backend, open browser console:
```js
localStorage.setItem('BACKEND_URL', 'https://your-api.onrender.com');
location.reload();
```

## Deploy to Render

### One-click (blueprint)
1. Push this repo to GitHub.
2. Render → **New +** → **Blueprint** → select the repo.
3. Wait for both services to deploy. Note the backend URL (something like `https://pair-trading-api.onrender.com`).
4. Open the static site and in the browser console:
   ```js
   localStorage.setItem('BACKEND_URL', 'https://pair-trading-api.onrender.com');
   location.reload();
   ```

To skip the localStorage step, edit `frontend/app.js`:
```js
const DEFAULT_BACKEND = 'https://pair-trading-api.onrender.com';
```
…and push again.

### Manual
**Backend (Web Service)** — root `backend`, build `pip install -r requirements.txt`, start `uvicorn main:app --host 0.0.0.0 --port $PORT`.

**Frontend (Static Site)** — root `frontend`, publish path `.`, no build.

## How the watchlist works

1. Run analysis (single-pair or screener).
2. If the pair has an active signal (±1σ or ±2σ), click **＋ ADD TO WATCHLIST** / **＋ WATCH**.
3. The signal is saved in `localStorage` with entry prices (P1, P2, ratio).
4. Open the **F3 · WATCHLIST** tab. Live prices poll every 25s from data912.
5. P&L is computed as:
   - **LONG**:  `(P1_now / P1_entry - 1) - (P2_now / P2_entry - 1)`
   - **SHORT**: `-(P1_now / P1_entry - 1) + (P2_now / P2_entry - 1)`
6. Status flips to **TARGET** when P&L crosses the target return, or **EXPIRED** after the window (default 30d) passes without hitting target.

Use **EXPORT JSON** to back up the watchlist before clearing browser data.

## Endpoints

| Method | Path | Body / Query |
|--------|------|--------------|
| GET    | `/`                  | health |
| POST   | `/api/single-pair`   | `{ticker1, ticker2, start_year, window_days, target_return}` |
| POST   | `/api/screener`      | `{tickers: [...], start_year, window_days, target_return, min_signals}` |
| GET    | `/api/live-prices?symbols=KO,PEP` | live prices proxied from data912 |

## Notes

- **Cold start**: Render's free tier sleeps after 15 min idle. First request takes ~30s.
- **data912 is unofficial** — endpoint is documented at https://data912.com but Anthropic-style stability isn't guaranteed. If they go down, the watchlist still shows stale prices from cache.
- **Not financial advice.** This is a backtesting tool. Mean reversion is a statistical pattern, not a guarantee.
