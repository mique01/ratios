/* ============================================================
   PAIR TRADING TERMINAL — frontend logic
   ============================================================ */

// ---------- backend URL --------------------------------------------------
const DEFAULT_BACKEND = 'http://localhost:8000';
const BACKEND_URL = (
  (typeof window !== 'undefined' && window.BACKEND_URL) ||
  localStorage.getItem('BACKEND_URL') ||
  DEFAULT_BACKEND
).replace(/\/$/, '');

document.getElementById('backend-host').textContent = BACKEND_URL;

// ---------- watchlist storage --------------------------------------------
const WATCH_KEY = 'ptt.watchlist.v1';
function loadWatch()  { try { return JSON.parse(localStorage.getItem(WATCH_KEY)) || []; } catch { return []; } }
function saveWatch(w) { localStorage.setItem(WATCH_KEY, JSON.stringify(w)); updateWatchCount(); }
function updateWatchCount() { document.getElementById('watchlist-count').textContent = loadWatch().length; }
updateWatchCount();

// ---------- clock --------------------------------------------------------
function tickClock() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const offset = -d.getTimezoneOffset() / 60;
  document.getElementById('clock').textContent =
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} UTC${offset >= 0 ? '+' : ''}${offset}`;
}
setInterval(tickClock, 1000); tickClock();

// ---------- backend health -----------------------------------------------
async function checkBackend() {
  const dot = document.getElementById('status-dot');
  const txt = document.getElementById('status-text');
  try {
    const r = await fetch(`${BACKEND_URL}/`);
    if (!r.ok) throw new Error('bad');
    dot.classList.add('ok'); txt.textContent = 'CONNECTED';
  } catch {
    dot.classList.remove('ok'); txt.textContent = 'OFFLINE — CHECK BACKEND_URL';
  }
}
checkBackend(); setInterval(checkBackend, 30000);

// ---------- tabs ---------------------------------------------------------
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const id = btn.dataset.tab;
    document.getElementById(`tab-${id}`).classList.add('active');
    if (id === 'watchlist') {
      renderWatchlist();
      refreshLivePrices();
    }
  });
});

// ---------- helpers ------------------------------------------------------
const fmtPct = v => (v === null || v === undefined || isNaN(v)) ? '—' : (v * 100).toFixed(2) + '%';
const fmtNum = (v, d = 3) => (v === null || v === undefined || isNaN(v)) ? '—' : Number(v).toFixed(d);
const fmtMoney = v => (v === null || v === undefined || isNaN(v)) ? '—' : '$' + Number(v).toFixed(2);

function setMsg(id, text, cls = '') {
  const el = document.getElementById(id);
  el.textContent = text; el.className = 'msg ' + cls;
}
function setFooter(text) { document.getElementById('footer-mid').textContent = text; }

// ============================================================
// SINGLE PAIR
// ============================================================

let ratioChart = null;
let lastSingleSummary = null;

async function runSingle() {
  const t1 = document.getElementById('t1').value.toUpperCase().trim();
  const t2 = document.getElementById('t2').value.toUpperCase().trim();
  const startYear   = parseInt(document.getElementById('start-year').value, 10);
  const windowDays  = parseInt(document.getElementById('window-days').value, 10);
  const targetRet   = parseFloat(document.getElementById('target-return').value);

  if (!t1 || !t2 || t1 === t2) {
    setMsg('single-msg', 'TICKERS MUST BE DIFFERENT & NON-EMPTY', 'err');
    return;
  }

  const btn = document.getElementById('run-single');
  const addBtn = document.getElementById('add-watch-single');
  btn.disabled = true; btn.textContent = '⏳ RUNNING…';
  addBtn.disabled = true;
  setMsg('single-msg', `ANALYZING ${t1}/${t2} FROM ${startYear}…`);
  setFooter(`SINGLE-PAIR: ${t1}/${t2}`);

  try {
    const r = await fetch(`${BACKEND_URL}/api/single-pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker1: t1, ticker2: t2, start_year: startYear, window_days: windowDays, target_return: targetRet })
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${r.status}`);
    }
    const data = await r.json();
    lastSingleSummary = { ...data.summary, window_days: windowDays, target_return: targetRet };
    renderSingle(data, t1, t2);
    addBtn.disabled = lastSingleSummary.current_signal === 'SIN SEÑAL';
    setMsg('single-msg', `✓ ${t1}/${t2} ANALYZED · ${data.signals.length} HISTORICAL SIGNALS`, 'ok');
  } catch (e) {
    setMsg('single-msg', `✗ ERROR · ${e.message}`, 'err');
  } finally {
    btn.disabled = false; btn.textContent = '▶ RUN ANALYSIS';
    setFooter('IDLE');
  }
}

function renderSingle(data, t1, t2) {
  const s = data.summary;
  const setVal = (id, v, cls = '') => {
    const el = document.getElementById(id); el.textContent = v; el.className = 'val ' + cls;
  };

  setVal('s-corr',    fmtNum(s.corr, 3),  s.corr > 0.7 ? 'good' : s.corr > 0.4 ? 'warn' : 'bad');
  setVal('s-adf',     fmtNum(s.adf_p, 4), s.adf_p < 0.05 ? 'good' : s.adf_p < 0.10 ? 'warn' : 'bad');
  setVal('s-coint',   fmtNum(s.coint_p, 4), s.coint_p < 0.05 ? 'good' : s.coint_p < 0.10 ? 'warn' : 'bad');
  setVal('s-hl',      s.half_life === null ? '∞' : fmtNum(s.half_life, 1) + 'd',
                       s.half_life && s.half_life < 60 ? 'good' : 'warn');
  setVal('s-ratio',   fmtNum(s.ratio_now, 4));
  setVal('s-median',  fmtNum(s.median, 4));
  setVal('s-winrate', fmtPct(s.winrate_5pct_30d),
                       s.winrate_5pct_30d > 0.7 ? 'good' : s.winrate_5pct_30d > 0.5 ? 'warn' : 'bad');
  setVal('s-avgret',  fmtPct(s.avg_return_30d),
                       s.avg_return_30d > 0.05 ? 'good' : s.avg_return_30d > 0 ? 'warn' : 'bad');

  const cs = document.getElementById('current-signal');
  cs.textContent = `▍ CURRENT: ${s.current_signal}`;
  cs.className = 'current-signal';
  if (s.current_signal.startsWith('LONG'))       cs.classList.add('long');
  else if (s.current_signal.startsWith('SHORT')) cs.classList.add('short');

  const lines = [];
  if (s.winrate_5pct_30d > 0.7)      lines.push({ cls: 'good', txt: '🔥 STRONG · high probability of reaching target' });
  else if (s.winrate_5pct_30d > 0.5) lines.push({ cls: 'warn', txt: '⚠ MODERATE · acceptable but not outstanding' });
  else                               lines.push({ cls: 'bad',  txt: '✗ WEAK · low consistency' });
  if (s.adf_p < 0.05) lines.push({ cls: 'good', txt: '✓ ADF: pair has statistical mean reversion' });
  else                lines.push({ cls: 'warn', txt: '⚠ ADF: pair is NOT mean-reverting (tactical, not statistical)' });
  if (s.half_life && s.half_life < 60) lines.push({ cls: 'good', txt: `✓ HALF-LIFE: ${fmtNum(s.half_life,1)}d · fast reversion` });
  else                                  lines.push({ cls: 'warn', txt: '⚠ HALF-LIFE: slow reversion · may fail in 30d window' });

  document.getElementById('interpret').innerHTML =
    lines.map(l => `<div class="line ${l.cls}"><strong>›</strong> ${l.txt}</div>`).join('');

  renderChart(data.chart, t1, t2);
  renderSignalsTable(data.signals);
}

function renderChart(chart, t1, t2) {
  const ctx = document.getElementById('ratio-chart').getContext('2d');
  if (ratioChart) ratioChart.destroy();
  const len = chart.dates.length;
  const flat = v => Array(len).fill(v);
  ratioChart = new Chart(ctx, {
    type: 'line',
    data: { labels: chart.dates, datasets: [
      { label: `${t1}/${t2}`, data: chart.ratio,  borderColor: '#ffb000', borderWidth: 1.5, pointRadius: 0, tension: 0.05 },
      { label: 'MEDIAN',      data: flat(chart.median), borderColor: '#8a8a8a', borderWidth: 1, borderDash: [6, 4], pointRadius: 0 },
      { label: '+1σ', data: flat(chart.upper1), borderColor: '#4ea1ff', borderWidth: 1, borderDash: [3, 3], pointRadius: 0 },
      { label: '-1σ', data: flat(chart.lower1), borderColor: '#4ea1ff', borderWidth: 1, borderDash: [3, 3], pointRadius: 0 },
      { label: '+2σ', data: flat(chart.upper2), borderColor: '#ff3b3b', borderWidth: 1, borderDash: [6, 2], pointRadius: 0 },
      { label: '-2σ', data: flat(chart.lower2), borderColor: '#00d166', borderWidth: 1, borderDash: [6, 2], pointRadius: 0 },
    ]},
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { labels: { color: '#8a8a8a', font: { family: 'JetBrains Mono', size: 10 }, boxWidth: 18 } },
        tooltip: { backgroundColor: '#0a0a0a', borderColor: '#ffb000', borderWidth: 1,
          titleColor: '#ffb000', bodyColor: '#e8e6e1',
          titleFont: { family: 'JetBrains Mono', size: 11 }, bodyFont:  { family: 'JetBrains Mono', size: 11 } }
      },
      scales: {
        x: { ticks: { color: '#5a5a5a', font: { family: 'JetBrains Mono', size: 9 }, maxTicksLimit: 12 }, grid: { color: '#1c1c1f' } },
        y: { ticks: { color: '#5a5a5a', font: { family: 'JetBrains Mono', size: 9 } },                    grid: { color: '#1c1c1f' } }
      }
    }
  });
}

function renderSignalsTable(signals) {
  const tbody = document.querySelector('#signals-table tbody');
  if (!signals || signals.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">— NO HISTORICAL SIGNALS —</td></tr>'; return;
  }
  tbody.innerHTML = signals.slice().reverse().map(s => {
    const sideCls = s.signal === 'LONG' ? 'long' : 'short';
    const ret = s.max_return_30d;
    const retCls = ret >= 0.05 ? 'good' : ret >= 0 ? 'warn' : 'bad';
    return `<tr>
      <td>${s.entry}</td>
      <td><span class="signal-badge ${sideCls}">${s.signal}</span></td>
      <td class="dim">${s.level}</td>
      <td class="num ${retCls}">${fmtPct(ret)}</td>
      <td class="num dim">${s.days_to_target ?? '—'}</td>
      <td><span class="signal-badge ${s.success ? 'hit' : 'miss'}">${s.success ? 'HIT' : 'MISS'}</span></td>
    </tr>`;
  }).join('');
}

document.getElementById('run-single').addEventListener('click', runSingle);

document.getElementById('add-watch-single').addEventListener('click', () => {
  if (!lastSingleSummary) return;
  addToWatchlist(lastSingleSummary);
  setMsg('single-msg', `✓ ADDED ${lastSingleSummary.pair} TO WATCHLIST`, 'ok');
});

// ============================================================
// SCREENER
// ============================================================

let screenerResults = [];

async function runScreener() {
  const raw = document.getElementById('sc-tickers').value;
  const tickers = [...new Set(raw.split(/[,\s]+/).map(s => s.toUpperCase().trim()).filter(Boolean))];

  if (tickers.length < 2) {
    setMsg('screener-msg', 'PROVIDE AT LEAST 2 TICKERS', 'err'); return;
  }

  const btn = document.getElementById('run-screener');
  btn.disabled = true; btn.textContent = '⏳ SCANNING…';
  const nPairs = tickers.length * (tickers.length - 1) / 2;
  setMsg('screener-msg', `DOWNLOADING DATA · ANALYZING ${nPairs} PAIRS FROM ${tickers.length} TICKERS…`);
  setFooter(`SCREENER: ${tickers.length} TICKERS · ${nPairs} PAIRS`);

  try {
    const r = await fetch(`${BACKEND_URL}/api/screener`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tickers,
        start_year:    parseInt(document.getElementById('sc-start-year').value, 10),
        window_days:   parseInt(document.getElementById('sc-window').value, 10),
        target_return: parseFloat(document.getElementById('sc-target').value),
        min_signals:   parseInt(document.getElementById('sc-minsig').value, 10)
      })
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${r.status}`);
    }
    const data = await r.json();
    screenerResults = data.results;
    const dropped = data.tickers_dropped?.length ? ` · DROPPED: ${data.tickers_dropped.join(', ')}` : '';
    setMsg('screener-msg', `✓ ${data.total_pairs_with_signals} PAIRS HAVE SIGNALS · USED ${data.tickers_used.length} TICKERS${dropped}`, 'ok');
    renderScreener();
  } catch (e) {
    setMsg('screener-msg', `✗ ERROR · ${e.message}`, 'err');
  } finally {
    btn.disabled = false; btn.textContent = '▶ RUN SCREENER';
    setFooter('IDLE');
  }
}

function renderScreener() {
  const sig = document.getElementById('sc-signal').value;
  let rows = screenerResults.slice();
  if (sig === 'ACTIVE')     rows = rows.filter(r => r.current_signal !== 'SIN SEÑAL');
  else if (sig === 'LONG')  rows = rows.filter(r => r.current_signal.startsWith('LONG'));
  else if (sig === 'SHORT') rows = rows.filter(r => r.current_signal.startsWith('SHORT'));

  const tbody = document.querySelector('#screener-table tbody');
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="13" class="empty">— NO RESULTS MATCH FILTERS —</td></tr>'; return;
  }

  const watched = new Set(loadWatch().map(w => `${w.pair}@${w.opened}`));

  tbody.innerHTML = rows.map((r, i) => {
    const sigCls = r.current_signal.startsWith('LONG') ? 'long'
                 : r.current_signal.startsWith('SHORT') ? 'short' : 'none';
    const winCls = r.winrate_5pct_30d >= 0.7 ? 'good' : r.winrate_5pct_30d >= 0.5 ? 'warn' : 'bad';
    const adfCls = r.adf_p < 0.05 ? 'good' : r.adf_p < 0.10 ? 'warn' : 'bad';
    const coinCls = r.coint_p < 0.05 ? 'good' : r.coint_p < 0.10 ? 'warn' : 'bad';

    const canWatch = r.current_signal !== 'SIN SEÑAL';
    const btnTxt = canWatch ? '＋ WATCH' : '—';

    return `<tr>
      <td class="dim">${String(i + 1).padStart(2, '0')}</td>
      <td><strong>${r.pair}</strong></td>
      <td class="num dim">${r.signals}</td>
      <td class="num ${winCls}">${fmtPct(r.winrate_5pct_30d)}</td>
      <td class="num">${fmtPct(r.avg_return_30d)}</td>
      <td class="num dim">${fmtNum(r.avg_days_to_target, 1)}</td>
      <td class="num">${fmtNum(r.corr, 2)}</td>
      <td class="num ${adfCls}">${fmtNum(r.adf_p, 3)}</td>
      <td class="num ${coinCls}">${fmtNum(r.coint_p, 3)}</td>
      <td class="num dim">${r.half_life === null ? '∞' : fmtNum(r.half_life, 0)}</td>
      <td><span class="signal-badge ${sigCls}">${r.current_signal}</span></td>
      <td class="num warn">${fmtNum(r.score, 4)}</td>
      <td>${canWatch ? `<button class="btn-row" data-idx="${i}">${btnTxt}</button>` : '<span class="dim">—</span>'}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.btn-row').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      const row = rows[idx];
      addToWatchlist({
        ...row,
        window_days:   parseInt(document.getElementById('sc-window').value, 10),
        target_return: parseFloat(document.getElementById('sc-target').value),
      });
      btn.textContent = '✓ ADDED'; btn.classList.add('added'); btn.disabled = true;
    });
  });
}

document.getElementById('run-screener').addEventListener('click', runScreener);
document.getElementById('sc-signal').addEventListener('change', renderScreener);

// ============================================================
// WATCHLIST
// ============================================================

function addToWatchlist(s) {
  const list = loadWatch();
  const opened = new Date().toISOString();
  const item = {
    id: `${s.pair}@${opened}`,
    pair: s.pair,
    ticker1: s.ticker1, ticker2: s.ticker2,
    side:  s.current_signal.startsWith('LONG') ? 'LONG' : 'SHORT',
    level: s.current_signal.replace(/(LONG|SHORT)\s+/, ''),
    opened,
    entry_p1:    s.p1_now,
    entry_p2:    s.p2_now,
    entry_ratio: s.ratio_now,
    target_return: s.target_return ?? 0.05,
    window_days:   s.window_days   ?? 30,
    max_pnl: 0, hit_target: false, closed: false,
    median: s.median,
  };
  if (list.find(w => w.pair === item.pair && Math.abs(new Date(w.opened) - new Date(item.opened)) < 60000)) return;
  list.push(item);
  saveWatch(list);
  renderWatchlist();
}

function removeFromWatchlist(id) {
  saveWatch(loadWatch().filter(w => w.id !== id));
  renderWatchlist();
}

function computePnL(item, p1Now, p2Now) {
  if (p1Now == null || p2Now == null || !item.entry_p1 || !item.entry_p2) return null;
  const r1 = p1Now / item.entry_p1 - 1;
  const r2 = p2Now / item.entry_p2 - 1;
  return item.side === 'LONG' ? (r1 - r2) : (-r1 + r2);
}

function daysSince(iso) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function renderWatchlist() {
  const list = loadWatch();
  const tbody = document.querySelector('#watch-table tbody');
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="13" class="empty">— NO SIGNALS WATCHED · ADD FROM SINGLE-PAIR OR SCREENER —</td></tr>';
    return;
  }

  // sort: open first (newest first), then closed
  const sorted = list.slice().sort((a, b) => {
    if (a.closed !== b.closed) return a.closed ? 1 : -1;
    return new Date(b.opened) - new Date(a.opened);
  });

  tbody.innerHTML = sorted.map(item => {
    const lp = livePrices[item.ticker1];
    const rp = livePrices[item.ticker2];
    const p1Now = lp?.c ?? null;
    const p2Now = rp?.c ?? null;
    const pnl = computePnL(item, p1Now, p2Now);
    const ratioNow = (p1Now != null && p2Now != null) ? (p1Now / p2Now) : null;

    const pnlCls = pnl == null ? 'dim' : pnl > 0 ? 'good' : 'bad';
    const sideCls = item.side === 'LONG' ? 'long' : 'short';
    const days = daysSince(item.opened);
    const expired = days >= item.window_days;
    const hit = pnl != null && pnl >= item.target_return;

    let statusCls = 'open', statusTxt = 'OPEN';
    if (item.closed)      { statusCls = 'stale'; statusTxt = 'CLOSED'; }
    else if (hit)         { statusCls = 'target'; statusTxt = `TARGET +${fmtPct(item.target_return)}`; }
    else if (expired)     { statusCls = 'miss';  statusTxt = `EXPIRED ${days}D`; }

    const maxPnl = pnl != null ? Math.max(item.max_pnl || 0, pnl) : item.max_pnl;

    return `<tr data-id="${item.id}">
      <td class="dim">${item.opened.slice(0, 10)}</td>
      <td class="num ${expired ? 'bad' : 'dim'}">${days}/${item.window_days}</td>
      <td><strong>${item.pair}</strong></td>
      <td><span class="signal-badge ${sideCls}">${item.side}</span></td>
      <td class="dim">${item.level}</td>
      <td class="num">
        ${fmtMoney(item.entry_p1)} → <span class="price-cell" data-key="p1-${item.id}">${fmtMoney(p1Now)}</span>
      </td>
      <td class="num">
        ${fmtMoney(item.entry_p2)} → <span class="price-cell" data-key="p2-${item.id}">${fmtMoney(p2Now)}</span>
      </td>
      <td class="num dim">
        ${fmtNum(item.entry_ratio, 4)} → ${fmtNum(ratioNow, 4)}
      </td>
      <td class="num ${pnlCls}"><strong>${fmtPct(pnl)}</strong></td>
      <td class="num ${maxPnl > 0 ? 'good' : 'dim'}">${fmtPct(maxPnl)}</td>
      <td class="num">${fmtPct(item.target_return)}</td>
      <td><span class="signal-badge ${statusCls}">${statusTxt}</span></td>
      <td><button class="btn-row" data-action="remove" data-id="${item.id}">✕</button></td>
    </tr>`;
  }).join('');

  // persist max_pnl and hit flag
  const updated = list.map(it => {
    const lp = livePrices[it.ticker1]; const rp = livePrices[it.ticker2];
    const pnl = computePnL(it, lp?.c, rp?.c);
    if (pnl == null) return it;
    return { ...it,
      max_pnl: Math.max(it.max_pnl || 0, pnl),
      hit_target: it.hit_target || pnl >= it.target_return };
  });
  if (JSON.stringify(updated) !== JSON.stringify(list)) saveWatch(updated);

  tbody.querySelectorAll('button[data-action="remove"]').forEach(b => {
    b.addEventListener('click', () => removeFromWatchlist(b.dataset.id));
  });
}

// ---------- live polling -------------------------------------------------

let livePrices = {};   // { TICKER: { c, pct_change } }
let prevPrices = {};
let pollTimer = null;
let countdownTimer = null;
let secondsLeft = 0;
const POLL_INTERVAL = 25; // seconds

async function refreshLivePrices() {
  const list = loadWatch();
  if (list.length === 0) {
    document.getElementById('last-update').textContent = '—';
    return;
  }
  const symbols = [...new Set(list.flatMap(w => [w.ticker1, w.ticker2]))].join(',');

  try {
    const r = await fetch(`${BACKEND_URL}/api/live-prices?symbols=${encodeURIComponent(symbols)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    prevPrices = livePrices;
    livePrices = data.prices || {};
    document.getElementById('last-update').textContent = new Date().toLocaleTimeString();
    setMsg('watch-msg', `✓ LIVE FEED OK · ${Object.keys(livePrices).length} SYMBOLS`, 'ok');
    renderWatchlist();
    flashChangedPrices();
  } catch (e) {
    setMsg('watch-msg', `✗ LIVE FEED ERROR · ${e.message}`, 'err');
  }
  secondsLeft = POLL_INTERVAL;
}

function flashChangedPrices() {
  // For each watch row, find its ticker and flash if price changed
  loadWatch().forEach(item => {
    [['ticker1', `p1-${item.id}`], ['ticker2', `p2-${item.id}`]].forEach(([tKey, cellKey]) => {
      const sym = item[tKey];
      const prev = prevPrices[sym]?.c;
      const curr = livePrices[sym]?.c;
      if (prev == null || curr == null || prev === curr) return;
      const el = document.querySelector(`[data-key="${cellKey}"]`);
      if (!el) return;
      el.classList.remove('flash-up', 'flash-down');
      void el.offsetWidth; // restart animation
      el.classList.add(curr > prev ? 'flash-up' : 'flash-down');
    });
  });
}

function startPolling() {
  if (pollTimer) return;
  secondsLeft = POLL_INTERVAL;
  refreshLivePrices();
  pollTimer = setInterval(refreshLivePrices, POLL_INTERVAL * 1000);
  countdownTimer = setInterval(() => {
    if (secondsLeft > 0) secondsLeft -= 1;
    const el = document.getElementById('refresh-countdown');
    if (el) el.textContent = secondsLeft;
  }, 1000);
}
function stopPolling() {
  if (pollTimer)      { clearInterval(pollTimer);      pollTimer = null; }
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}

// poll only while watchlist tab is open
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'watchlist') startPolling();
    else stopPolling();
  });
});

document.getElementById('refresh-now').addEventListener('click', refreshLivePrices);
document.getElementById('clear-watch').addEventListener('click', () => {
  if (!confirm('Clear entire watchlist?')) return;
  saveWatch([]); renderWatchlist();
});

document.getElementById('export-watch').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(loadWatch(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ptt-watchlist-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('import-watch').addEventListener('click', () => {
  document.getElementById('import-file').click();
});
document.getElementById('import-file').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!Array.isArray(parsed)) throw new Error('not an array');
      saveWatch(parsed); renderWatchlist();
      setMsg('watch-msg', `✓ IMPORTED ${parsed.length} ITEMS`, 'ok');
    } catch (err) {
      setMsg('watch-msg', `✗ INVALID JSON · ${err.message}`, 'err');
    }
  };
  reader.readAsText(f);
});
