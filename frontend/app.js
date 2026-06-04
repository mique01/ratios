/* ============================================================
   PAIR TRADING TERMINAL — frontend logic
   ============================================================ */

// ---------- backend URL --------------------------------------------------
const DEFAULT_BACKEND = 'https://pair-trading-api.onrender.com';
const BACKEND_URL = (
  (typeof window !== 'undefined' && window.BACKEND_URL) ||
  localStorage.getItem('BACKEND_URL') ||
  DEFAULT_BACKEND
).replace(/\/$/, '');

document.getElementById('backend-host').textContent = BACKEND_URL;

// ---------- watchlist storage --------------------------------------------
const WATCH_KEY = 'ptt.watchlist.v1';
const MONITOR_KEY = 'ptt.monitors.v1';
function loadWatch()  { try { return JSON.parse(localStorage.getItem(WATCH_KEY)) || []; } catch { return []; } }
function saveWatch(w) { localStorage.setItem(WATCH_KEY, JSON.stringify(w)); updateWatchCount(); }
function loadMonitors()  { try { return JSON.parse(localStorage.getItem(MONITOR_KEY)) || []; } catch { return []; } }
function saveMonitors(w) { localStorage.setItem(MONITOR_KEY, JSON.stringify(w)); updateWatchCount(); }
function updateWatchCount() { document.getElementById('watchlist-count').textContent = loadWatch().length + loadMonitors().length; }
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
      renderMonitors();
      renderWatchlist();
      refreshSavedPairs(false);
      refreshLivePrices();
    }
  });
});

// ---------- helpers ------------------------------------------------------
const fmtPct = v => (v === null || v === undefined || isNaN(v)) ? '—' : (v * 100).toFixed(2) + '%';
const fmtNum = (v, d = 3) => (v === null || v === undefined || isNaN(v)) ? '—' : Number(v).toFixed(d);
const fmtMoney = v => (v === null || v === undefined || isNaN(v)) ? '—' : '$' + Number(v).toFixed(2);
const parseDecimal = value => parseFloat(String(value).replace(',', '.'));
const isNoSignal = value => !value || String(value).toUpperCase().startsWith('SIN SE');
const hasActiveSignal = value => !isNoSignal(value);
const modelLabel = value => value === 'ROBUST_OLS' ? 'ROBUST OLS' : 'RATIO';

function setMsg(id, text, cls = '') {
  const el = document.getElementById(id);
  el.textContent = text; el.className = 'msg ' + cls;
}
function setFooter(text) { document.getElementById('footer-mid').textContent = text; }

function makeZoomOptions(resetButtonId) {
  const setResetEnabled = enabled => {
    const btn = document.getElementById(resetButtonId);
    if (btn) btn.disabled = !enabled;
  };

  return {
    pan: {
      enabled: true,
      mode: 'xy',
      onPanStart: () => setResetEnabled(true),
    },
    zoom: {
      wheel: { enabled: true, speed: 0.08 },
      pinch: { enabled: true },
      mode: 'xy',
      onZoomStart: () => setResetEnabled(true),
    },
    limits: {
      x: { min: 'original', max: 'original' },
      y: { min: 'original', max: 'original' },
    },
  };
}

function bindResetZoom(buttonId, getChart) {
  const btn = document.getElementById(buttonId);
  if (!btn) return;
  btn.addEventListener('click', () => {
    resetChartZoom(btn, getChart());
  });
}

function resetChartZoom(button, chart) {
  if (!chart || typeof chart.resetZoom !== 'function') return;
  chart.resetZoom();
  button.disabled = true;
}

function bindCanvasDoubleClick(canvasId, resetButtonId, getChart) {
  const canvas = document.getElementById(canvasId);
  const btn = document.getElementById(resetButtonId);
  if (!canvas || !btn) return;
  canvas.ondblclick = () => resetChartZoom(btn, getChart());
}

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
  const targetRet   = parseDecimal(document.getElementById('target-return').value);

  if (!t1 || !t2 || t1 === t2) {
    setMsg('single-msg', 'TICKERS MUST BE DIFFERENT & NON-EMPTY', 'err');
    return;
  }

  const btn = document.getElementById('run-single');
  const addBtn = document.getElementById('add-watch-single');
  const saveBtn = document.getElementById('save-monitor-single');
  btn.disabled = true; btn.textContent = '⏳ RUNNING…';
  addBtn.disabled = true;
  saveBtn.disabled = true;
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
    addBtn.disabled = !hasActiveSignal(lastSingleSummary.current_signal);
    saveBtn.disabled = false;
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
          titleFont: { family: 'JetBrains Mono', size: 11 }, bodyFont:  { family: 'JetBrains Mono', size: 11 } },
        zoom: makeZoomOptions('reset-ratio-zoom')
      },
      scales: {
        x: { ticks: { color: '#5a5a5a', font: { family: 'JetBrains Mono', size: 9 }, maxTicksLimit: 12 }, grid: { color: '#1c1c1f' } },
        y: { ticks: { color: '#5a5a5a', font: { family: 'JetBrains Mono', size: 9 } },                    grid: { color: '#1c1c1f' } }
      }
    }
  });
  document.getElementById('reset-ratio-zoom').disabled = true;
  bindCanvasDoubleClick('ratio-chart', 'reset-ratio-zoom', () => ratioChart);
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

document.getElementById('save-monitor-single').addEventListener('click', () => {
  if (!lastSingleSummary) return;
  addMonitorPair({
    ...lastSingleSummary,
    model_type: 'RATIO',
    start_year: parseInt(document.getElementById('start-year').value, 10),
    window_days: parseInt(document.getElementById('window-days').value, 10),
    target_return: parseDecimal(document.getElementById('target-return').value),
  });
  setMsg('single-msg', `SAVED ${lastSingleSummary.pair} FOR SIGNAL MONITOR`, 'ok');
});

// ============================================================
// BOLLINGER PAIR
// ============================================================

let bollingerChart = null;

async function runBollinger() {
  const t1 = document.getElementById('b-t1').value.toUpperCase().trim();
  const t2 = document.getElementById('b-t2').value.toUpperCase().trim();
  const startYear = parseInt(document.getElementById('b-start-year').value, 10);

  if (!t1 || !t2 || t1 === t2) {
    setMsg('bollinger-msg', 'TICKERS MUST BE DIFFERENT & NON-EMPTY', 'err');
    return;
  }

  const btn = document.getElementById('run-bollinger');
  btn.disabled = true; btn.textContent = '⏳ RUNNING…';
  setMsg('bollinger-msg', `ANALYZING BOLLINGER ${t1}/${t2} FROM ${startYear}…`);
  setFooter(`BOLLINGER: ${t1}/${t2}`);

  try {
    const r = await fetch(`${BACKEND_URL}/api/bollinger-pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker1: t1, ticker2: t2, start_year: startYear })
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${r.status}`);
    }
    const data = await r.json();
    renderBollinger(data, t1, t2);
    setMsg('bollinger-msg', `✓ ${t1}/${t2} BOLLINGER ANALYZED · ${data.signals.length} TOUCHES`, 'ok');
  } catch (e) {
    setMsg('bollinger-msg', `✕ ERROR · ${e.message}`, 'err');
  } finally {
    btn.disabled = false; btn.textContent = '▶ RUN BOLLINGER';
    setFooter('IDLE');
  }
}

function renderBollinger(data, t1, t2) {
  const s = data.summary;
  const setVal = (id, v, cls = '') => {
    const el = document.getElementById(id); el.textContent = v; el.className = 'val ' + cls;
  };

  setVal('b-corr',    fmtNum(s.corr, 3),  s.corr > 0.7 ? 'good' : s.corr > 0.4 ? 'warn' : 'bad');
  setVal('b-adf',     fmtNum(s.adf_p, 4), s.adf_p < 0.05 ? 'good' : s.adf_p < 0.10 ? 'warn' : 'bad');
  setVal('b-coint',   fmtNum(s.coint_p, 4), s.coint_p < 0.05 ? 'good' : s.coint_p < 0.10 ? 'warn' : 'bad');
  setVal('b-hl',      s.half_life === null ? '∞' : fmtNum(s.half_life, 1) + 'd',
                       s.half_life && s.half_life < 30 ? 'good' : 'warn');
  setVal('b-ratio',   fmtNum(s.ratio_now, 4));
  setVal('b-mean',    fmtNum(s.mean20, 4));
  setVal('b-winrate', fmtPct(s.winrate_5pct_7d),
                       s.winrate_5pct_7d > 0.7 ? 'good' : s.winrate_5pct_7d > 0.5 ? 'warn' : 'bad');
  setVal('b-avgmove', fmtPct(s.avg_move_7d),
                       s.avg_move_7d > 0.05 ? 'good' : s.avg_move_7d > 0 ? 'warn' : 'bad');

  const cs = document.getElementById('b-current-signal');
  cs.textContent = `▍ CURRENT: ${s.current_signal}`;
  cs.className = 'current-signal';
  if (s.current_signal.startsWith('LONG'))       cs.classList.add('long');
  else if (s.current_signal.startsWith('SHORT')) cs.classList.add('short');

  const lines = [];
  if (s.signals === 0)                  lines.push({ cls: 'warn', txt: 'NO BOLLINGER TOUCHES IN SELECTED HISTORY' });
  else if (s.winrate_5pct_7d > 0.7)     lines.push({ cls: 'good', txt: 'STRONG FAST-REGRESSION PROFILE' });
  else if (s.winrate_5pct_7d > 0.5)     lines.push({ cls: 'warn', txt: 'MODERATE FAST-REGRESSION PROFILE' });
  else                                  lines.push({ cls: 'bad',  txt: 'LOW 7D FOLLOW-THROUGH CONSISTENCY' });
  lines.push({ cls: 'warn', txt: 'RULE: -2STD COUNTS 5% RATIO RISE; +2STD COUNTS 5% RATIO DROP' });
  if (s.half_life && s.half_life < 30)  lines.push({ cls: 'good', txt: `HALF-LIFE: ${fmtNum(s.half_life,1)}d` });

  document.getElementById('b-interpret').innerHTML =
    lines.map(l => `<div class="line ${l.cls}"><strong>›</strong> ${l.txt}</div>`).join('');

  renderBollingerChart(data.chart, t1, t2);
  renderBollingerTable(data.signals);
}

function renderBollingerChart(chart, t1, t2) {
  const ctx = document.getElementById('bollinger-chart').getContext('2d');
  if (bollingerChart) bollingerChart.destroy();
  bollingerChart = new Chart(ctx, {
    type: 'line',
    data: { labels: chart.dates, datasets: [
      { label: `${t1}/${t2}`, data: chart.ratio,  borderColor: '#ffb000', borderWidth: 1.5, pointRadius: 0, tension: 0.05 },
      { label: 'SMA20',       data: chart.mean20, borderColor: '#8a8a8a', borderWidth: 1, borderDash: [6, 4], pointRadius: 0 },
      { label: '+2STD',       data: chart.upper2, borderColor: '#ff3b3b', borderWidth: 1, borderDash: [6, 2], pointRadius: 0 },
      { label: '-2STD',       data: chart.lower2, borderColor: '#00d166', borderWidth: 1, borderDash: [6, 2], pointRadius: 0 },
    ]},
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { labels: { color: '#8a8a8a', font: { family: 'JetBrains Mono', size: 10 }, boxWidth: 18 } },
        tooltip: { backgroundColor: '#0a0a0a', borderColor: '#ffb000', borderWidth: 1,
          titleColor: '#ffb000', bodyColor: '#e8e6e1',
          titleFont: { family: 'JetBrains Mono', size: 11 }, bodyFont:  { family: 'JetBrains Mono', size: 11 } },
        zoom: makeZoomOptions('reset-bollinger-zoom')
      },
      scales: {
        x: { ticks: { color: '#5a5a5a', font: { family: 'JetBrains Mono', size: 9 }, maxTicksLimit: 12 }, grid: { color: '#1c1c1f' } },
        y: { ticks: { color: '#5a5a5a', font: { family: 'JetBrains Mono', size: 9 } },                    grid: { color: '#1c1c1f' } }
      }
    }
  });
  document.getElementById('reset-bollinger-zoom').disabled = true;
  bindCanvasDoubleClick('bollinger-chart', 'reset-bollinger-zoom', () => bollingerChart);
}

function renderBollingerTable(signals) {
  const tbody = document.querySelector('#bollinger-table tbody');
  if (!signals || signals.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">— NO BOLLINGER TOUCHES —</td></tr>'; return;
  }
  tbody.innerHTML = signals.slice().reverse().map(s => {
    const sideCls = s.signal === 'LONG' ? 'long' : 'short';
    const moveCls = s.max_move_7d >= 0.05 ? 'good' : s.max_move_7d >= 0 ? 'warn' : 'bad';
    return `<tr>
      <td>${s.entry}</td>
      <td><span class="signal-badge ${sideCls}">${s.signal}</span></td>
      <td class="dim">${s.level}</td>
      <td class="num dim">${fmtNum(s.entry_ratio, 4)}</td>
      <td class="num ${moveCls}">${fmtPct(s.max_move_7d)}</td>
      <td class="num dim">${s.days_to_target ?? '—'}</td>
      <td><span class="signal-badge ${s.success ? 'hit' : 'miss'}">${s.success ? 'HIT' : 'MISS'}</span></td>
    </tr>`;
  }).join('');
}

document.getElementById('run-bollinger').addEventListener('click', runBollinger);
bindResetZoom('reset-ratio-zoom', () => ratioChart);
bindResetZoom('reset-bollinger-zoom', () => bollingerChart);

// ============================================================
// ROBUST PAIR
// ============================================================

let robustSpreadChart = null;
let robustZChart = null;
let robustEquityChart = null;
let lastRobustSummary = null;

async function runRobust() {
  const t1 = document.getElementById('r-t1').value.toUpperCase().trim();
  const t2 = document.getElementById('r-t2').value.toUpperCase().trim();
  const startYear = parseInt(document.getElementById('r-start-year').value, 10);
  const targetRet = parseDecimal(document.getElementById('r-target').value);
  const cost = parseDecimal(document.getElementById('r-cost').value);
  const minSignals = parseInt(document.getElementById('r-minsig').value, 10);
  const useTargetExit = document.getElementById('r-use-target').checked;

  if (!t1 || !t2 || t1 === t2) {
    setMsg('robust-msg', 'TICKERS MUST BE DIFFERENT & NON-EMPTY', 'err');
    return;
  }

  const btn = document.getElementById('run-robust');
  const addBtn = document.getElementById('add-watch-robust');
  const saveBtn = document.getElementById('save-monitor-robust');
  btn.disabled = true; btn.textContent = 'RUNNING...';
  addBtn.disabled = true;
  saveBtn.disabled = true;
  setMsg('robust-msg', `RUNNING ROBUST OLS BACKTEST ${t1}/${t2} FROM ${startYear}...`);
  setFooter(`ROBUST: ${t1}/${t2}`);

  try {
    const r = await fetch(`${BACKEND_URL}/api/robust-pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticker1: t1,
        ticker2: t2,
        start_year: startYear,
        target_return: targetRet,
        use_target_exit: useTargetExit,
        transaction_cost: cost,
        min_signals: minSignals
      })
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${r.status}`);
    }
    const data = await r.json();
    lastRobustSummary = data.summary;
    renderRobust(data, t1, t2);
    addBtn.disabled = !hasActiveSignal(lastRobustSummary.current_signal);
    saveBtn.disabled = false;
    setMsg('robust-msg', `OK ${t1}/${t2} ROBUST ANALYZED · ${data.trades.length} TRADES · BEST W${data.summary.best_window}/Z${data.summary.best_entry_z}`, 'ok');
  } catch (e) {
    setMsg('robust-msg', `ERROR · ${e.message}`, 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'RUN ROBUST';
    setFooter('IDLE');
  }
}

function renderRobust(data, t1, t2) {
  const s = data.summary;
  const setVal = (id, v, cls = '') => {
    const el = document.getElementById(id); el.textContent = v; el.className = 'val ' + cls;
  };

  setVal('r-beta', fmtNum(s.hedge_ratio, 4));
  setVal('r-adf', fmtNum(s.adf_p, 4), s.adf_p < 0.05 ? 'good' : s.adf_p < 0.10 ? 'warn' : 'bad');
  setVal('r-coint', fmtNum(s.coint_p, 4), s.coint_p < 0.05 ? 'good' : s.coint_p < 0.10 ? 'warn' : 'bad');
  setVal('r-hl', s.half_life === null ? 'inf' : fmtNum(s.half_life, 1) + 'd', s.half_life && s.half_life < 60 ? 'good' : 'warn');
  setVal('r-best', `${s.best_window}/${fmtNum(s.best_entry_z, 2)}`);
  setVal('r-znow', fmtNum(s.zscore_now, 2), Math.abs(s.zscore_now || 0) >= s.best_entry_z ? 'warn' : '');
  setVal('r-winrate', fmtPct(s.winrate), s.winrate > 0.65 ? 'good' : s.winrate > 0.5 ? 'warn' : 'bad');
  setVal('r-totalret', fmtPct(s.total_return), s.total_return > 0 ? 'good' : 'bad');

  const cs = document.getElementById('r-current-signal');
  cs.textContent = `CURRENT: ${s.current_signal}`;
  cs.className = 'current-signal';
  if (s.current_signal.startsWith('LONG')) cs.classList.add('long');
  else if (s.current_signal.startsWith('SHORT')) cs.classList.add('short');

  document.getElementById('r-interpret').innerHTML =
    data.diagnostic.map(l => `<div class="line ${l.type}"><strong>›</strong> ${l.text}</div>`).join('');

  renderRobustSpreadChart(data.chart, t1, t2);
  renderRobustZChart(data.chart, s.best_entry_z, t1, t2);
  renderRobustEquityChart(data.chart, t1, t2);
  renderRobustOptimization(data.optimization);
  renderRobustTrades(data.trades);
}

function renderRobustSpreadChart(chart, t1, t2) {
  const ctx = document.getElementById('robust-spread-chart').getContext('2d');
  if (robustSpreadChart) robustSpreadChart.destroy();
  robustSpreadChart = new Chart(ctx, {
    type: 'line',
    data: { labels: chart.dates, datasets: [
      { label: `OLS SPREAD ${t1}/${t2}`, data: chart.spread, borderColor: '#ffb000', borderWidth: 1.5, pointRadius: 0, tension: 0.05 },
      { label: 'MEAN', data: chart.mean, borderColor: '#8a8a8a', borderWidth: 1, borderDash: [6, 4], pointRadius: 0 },
      { label: 'UPPER', data: chart.upper, borderColor: '#ff3b3b', borderWidth: 1, borderDash: [6, 2], pointRadius: 0 },
      { label: 'LOWER', data: chart.lower, borderColor: '#00d166', borderWidth: 1, borderDash: [6, 2], pointRadius: 0 },
    ]},
    options: chartOptions('reset-robust-spread-zoom')
  });
  document.getElementById('reset-robust-spread-zoom').disabled = true;
  bindCanvasDoubleClick('robust-spread-chart', 'reset-robust-spread-zoom', () => robustSpreadChart);
}

function renderRobustZChart(chart, entryZ, t1, t2) {
  const ctx = document.getElementById('robust-z-chart').getContext('2d');
  if (robustZChart) robustZChart.destroy();
  const len = chart.dates.length;
  const flat = v => Array(len).fill(v);
  robustZChart = new Chart(ctx, {
    type: 'line',
    data: { labels: chart.dates, datasets: [
      { label: `Z ${t1}/${t2}`, data: chart.zscore, borderColor: '#4ea1ff', borderWidth: 1.5, pointRadius: 0, tension: 0.05 },
      { label: `+${entryZ}`, data: flat(entryZ), borderColor: '#ff3b3b', borderWidth: 1, borderDash: [6, 2], pointRadius: 0 },
      { label: `-${entryZ}`, data: flat(-entryZ), borderColor: '#00d166', borderWidth: 1, borderDash: [6, 2], pointRadius: 0 },
      { label: 'ZERO', data: flat(0), borderColor: '#8a8a8a', borderWidth: 1, borderDash: [3, 3], pointRadius: 0 },
    ]},
    options: chartOptions('reset-robust-z-zoom')
  });
  document.getElementById('reset-robust-z-zoom').disabled = true;
  bindCanvasDoubleClick('robust-z-chart', 'reset-robust-z-zoom', () => robustZChart);
}

function renderRobustEquityChart(chart, t1, t2) {
  const ctx = document.getElementById('robust-equity-chart').getContext('2d');
  if (robustEquityChart) robustEquityChart.destroy();
  const labels = chart.equity.map(p => p.date);
  const values = chart.equity.map(p => p.equity);
  robustEquityChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [
      { label: `EQUITY ${t1}/${t2}`, data: values, borderColor: '#00d166', borderWidth: 2, pointRadius: 2, tension: 0.12 },
    ]},
    options: chartOptions('reset-robust-equity-zoom')
  });
  document.getElementById('reset-robust-equity-zoom').disabled = true;
  bindCanvasDoubleClick('robust-equity-chart', 'reset-robust-equity-zoom', () => robustEquityChart);
}

function chartOptions(resetButtonId) {
  return {
    responsive: true, maintainAspectRatio: false,
    interaction: { intersect: false, mode: 'index' },
    plugins: {
      legend: { labels: { color: '#8a8a8a', font: { family: 'JetBrains Mono', size: 10 }, boxWidth: 18 } },
      tooltip: { backgroundColor: '#0a0a0a', borderColor: '#ffb000', borderWidth: 1,
        titleColor: '#ffb000', bodyColor: '#e8e6e1',
        titleFont: { family: 'JetBrains Mono', size: 11 }, bodyFont: { family: 'JetBrains Mono', size: 11 } },
      zoom: makeZoomOptions(resetButtonId)
    },
    scales: {
      x: { ticks: { color: '#5a5a5a', font: { family: 'JetBrains Mono', size: 9 }, maxTicksLimit: 12 }, grid: { color: '#1c1c1f' } },
      y: { ticks: { color: '#5a5a5a', font: { family: 'JetBrains Mono', size: 9 } }, grid: { color: '#1c1c1f' } }
    }
  };
}

function renderRobustOptimization(rows) {
  const tbody = document.querySelector('#robust-opt-table tbody');
  if (!rows || rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">- NO OPTIMIZATION RESULTS -</td></tr>'; return;
  }
  tbody.innerHTML = rows.map(r => `<tr>
    <td class="num">${r.bb_window}</td>
    <td class="num">${fmtNum(r.entry_z, 2)}</td>
    <td class="num dim">${r.signals}</td>
    <td class="num">${fmtPct(r.winrate)}</td>
    <td class="num">${fmtPct(r.avg_return)}</td>
    <td class="num">${fmtPct(r.total_return)}</td>
    <td class="num">${fmtNum(r.sharpe, 2)}</td>
    <td class="num ${r.max_drawdown < -0.10 ? 'bad' : 'dim'}">${fmtPct(r.max_drawdown)}</td>
    <td class="num dim">${fmtNum(r.avg_days, 1)}</td>
    <td class="num warn">${fmtNum(r.score, 2)}</td>
  </tr>`).join('');
}

function renderRobustTrades(trades) {
  const tbody = document.querySelector('#robust-trades-table tbody');
  if (!trades || trades.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">- NO TRADES WITH BEST CONFIG -</td></tr>'; return;
  }
  tbody.innerHTML = trades.slice(-15).reverse().map(t => {
    const sideCls = t.signal.startsWith('LONG') ? 'long' : 'short';
    return `<tr>
      <td>${t.entry_date}</td>
      <td>${t.exit_date}</td>
      <td><span class="signal-badge ${sideCls}">${t.signal.replace('_SPREAD', '')}</span></td>
      <td class="num">${fmtNum(t.entry_z, 2)}</td>
      <td class="num dim">${fmtNum(t.exit_z, 2)}</td>
      <td class="num dim">${t.days}</td>
      <td class="num ${t.net_return > 0 ? 'good' : 'bad'}">${fmtPct(t.net_return)}</td>
      <td class="num good">${fmtPct(t.best_return)}</td>
      <td class="num bad">${fmtPct(t.worst_return)}</td>
      <td class="dim">${t.exit_reason}</td>
    </tr>`;
  }).join('');
}

document.getElementById('run-robust').addEventListener('click', runRobust);
document.getElementById('add-watch-robust').addEventListener('click', () => {
  if (!lastRobustSummary) return;
  addToWatchlist({ ...lastRobustSummary, model_type: 'ROBUST_OLS' });
  setMsg('robust-msg', `OK ADDED ${lastRobustSummary.pair} TO WATCHLIST`, 'ok');
});
document.getElementById('save-monitor-robust').addEventListener('click', () => {
  if (!lastRobustSummary) return;
  addMonitorPair({
    ...lastRobustSummary,
    model_type: 'ROBUST_OLS',
    start_year: parseInt(document.getElementById('r-start-year').value, 10),
    target_return: parseDecimal(document.getElementById('r-target').value),
    transaction_cost: parseDecimal(document.getElementById('r-cost').value),
    min_signals: parseInt(document.getElementById('r-minsig').value, 10),
    use_target_exit: document.getElementById('r-use-target').checked,
  });
  setMsg('robust-msg', `OK SAVED ${lastRobustSummary.pair} FOR SIGNAL MONITOR`, 'ok');
});
bindResetZoom('reset-robust-spread-zoom', () => robustSpreadChart);
bindResetZoom('reset-robust-z-zoom', () => robustZChart);
bindResetZoom('reset-robust-equity-zoom', () => robustEquityChart);

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
        target_return: parseDecimal(document.getElementById('sc-target').value),
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
  if (sig === 'ACTIVE')     rows = rows.filter(r => hasActiveSignal(r.current_signal));
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

    const canWatch = hasActiveSignal(r.current_signal);
    const btnTxt = canWatch ? '＋ WATCH' : 'SAVE';

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
      <td><button class="btn-row" data-idx="${i}" data-action="${canWatch ? 'watch' : 'monitor'}">${btnTxt}</button></td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.btn-row').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      const row = rows[idx];
      const payload = {
        ...row,
        model_type: 'RATIO',
        start_year: parseInt(document.getElementById('sc-start-year').value, 10),
        window_days: parseInt(document.getElementById('sc-window').value, 10),
        target_return: parseDecimal(document.getElementById('sc-target').value),
      };
      if (btn.dataset.action === 'watch') addToWatchlist(payload);
      else addMonitorPair(payload);
      btn.textContent = 'ADDED'; btn.classList.add('added'); btn.disabled = true;
    });
  });
}

document.getElementById('run-screener').addEventListener('click', runScreener);
document.getElementById('sc-signal').addEventListener('change', renderScreener);

// ============================================================
// SAVED PAIR MONITOR
// ============================================================

function monitorId(ticker1, ticker2, modelType) {
  return `${modelType || 'RATIO'}:${ticker1}/${ticker2}`;
}

function addMonitorPair(s) {
  const ticker1 = (s.ticker1 || '').toUpperCase().trim();
  const ticker2 = (s.ticker2 || '').toUpperCase().trim();
  if (!ticker1 || !ticker2 || ticker1 === ticker2) return false;

  const modelType = s.model_type || 'RATIO';
  const pair = `${ticker1}/${ticker2}`;
  const id = monitorId(ticker1, ticker2, modelType);
  const list = loadMonitors();
  const existingIdx = list.findIndex(item => item.id === id);
  const item = {
    id,
    pair,
    ticker1,
    ticker2,
    model_type: modelType,
    start_year: s.start_year ?? 2022,
    window_days: s.window_days ?? s.best_window ?? 30,
    target_return: s.target_return ?? 0.05,
    transaction_cost: s.transaction_cost ?? 0.002,
    min_signals: s.min_signals ?? 5,
    use_target_exit: s.use_target_exit ?? false,
    saved_at: list[existingIdx]?.saved_at || new Date().toISOString(),
    last_scan: s.last_scan || null,
    last_error: null,
    last_summary: s.current_signal ? { ...s, model_type: modelType } : list[existingIdx]?.last_summary || null,
  };

  if (existingIdx >= 0) list[existingIdx] = { ...list[existingIdx], ...item };
  else list.push(item);

  saveMonitors(list);
  renderMonitors();
  return true;
}

function removeMonitor(id) {
  saveMonitors(loadMonitors().filter(item => item.id !== id));
  renderMonitors();
}

function monitorSummary(item) {
  return item.last_summary || {};
}

function monitorCurrentSignal(item) {
  return monitorSummary(item).current_signal || 'SIN SEÑAL';
}

function monitorHasSignal(item) {
  return hasActiveSignal(monitorCurrentSignal(item));
}

async function scanMonitor(item) {
  const endpoint = item.model_type === 'ROBUST_OLS' ? '/api/robust-pair' : '/api/single-pair';
  const payload = item.model_type === 'ROBUST_OLS'
    ? {
        ticker1: item.ticker1,
        ticker2: item.ticker2,
        start_year: item.start_year,
        target_return: item.target_return,
        transaction_cost: item.transaction_cost,
        min_signals: item.min_signals,
        use_target_exit: item.use_target_exit,
      }
    : {
        ticker1: item.ticker1,
        ticker2: item.ticker2,
        start_year: item.start_year,
        window_days: item.window_days,
        target_return: item.target_return,
      };

  const r = await fetch(`${BACKEND_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${r.status}`);
  }

  const data = await r.json();
  return {
    ...item,
    last_scan: new Date().toISOString(),
    last_error: null,
    last_summary: { ...data.summary, model_type: item.model_type },
  };
}

async function refreshSavedPairs(force = true) {
  const list = loadMonitors();
  if (list.length === 0) {
    renderMonitors();
    return;
  }

  const btn = document.getElementById('refresh-monitors');
  if (btn) { btn.disabled = true; btn.textContent = 'SCANNING...'; }
  setMsg('watch-msg', `SCANNING ${list.length} SAVED PAIRS...`);
  setFooter(`MONITOR: ${list.length} PAIRS`);

  const now = Date.now();
  const minAgeMs = 15 * 60 * 1000;
  const updated = [];
  let scanned = 0;
  let signals = 0;

  for (const item of list) {
    const last = item.last_scan ? new Date(item.last_scan).getTime() : 0;
    if (!force && last && now - last < minAgeMs) {
      updated.push(item);
      if (monitorHasSignal(item)) signals += 1;
      continue;
    }

    try {
      const next = await scanMonitor(item);
      scanned += 1;
      if (monitorHasSignal(next)) signals += 1;
      updated.push(next);
    } catch (e) {
      updated.push({ ...item, last_scan: new Date().toISOString(), last_error: e.message });
    }
  }

  saveMonitors(updated);
  renderMonitors();
  setMsg('watch-msg', `OK SCANNED ${scanned} SAVED PAIRS · ${signals} ACTIVE SIGNALS`, signals ? 'ok' : '');
  setFooter('IDLE');
  if (btn) { btn.disabled = false; btn.textContent = 'SCAN SAVED PAIRS'; }
}

function renderMonitors() {
  const tbody = document.querySelector('#monitor-table tbody');
  if (!tbody) return;

  const list = loadMonitors().slice().sort((a, b) => {
    const aSig = monitorHasSignal(a) ? 1 : 0;
    const bSig = monitorHasSignal(b) ? 1 : 0;
    if (aSig !== bSig) return bSig - aSig;
    return new Date(b.last_scan || b.saved_at) - new Date(a.last_scan || a.saved_at);
  });

  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="13" class="empty">— NO PAIRS SAVED · SAVE FROM ANALYSIS OR ADD HERE —</td></tr>';
    return;
  }

  tbody.innerHTML = list.map(item => {
    const s = monitorSummary(item);
    const current = monitorCurrentSignal(item);
    const sigCls = current.startsWith('LONG') ? 'long' : current.startsWith('SHORT') ? 'short' : 'none';
    const ratioOrZ = item.model_type === 'ROBUST_OLS' ? fmtNum(s.zscore_now, 2) : fmtNum(s.ratio_now, 4);
    const win = item.model_type === 'ROBUST_OLS' ? s.winrate : s.winrate_5pct_30d;
    const avg = item.model_type === 'ROBUST_OLS' ? s.total_return : s.avg_return_30d;
    const action = monitorHasSignal(item)
      ? `<button class="btn-row" data-action="open-monitor" data-id="${item.id}">OPEN</button>`
      : '<span class="dim">WAIT</span>';
    const error = item.last_error ? `<span class="signal-badge miss" title="${item.last_error}">ERROR</span>` : '';

    return `<tr>
      <td class="dim">${item.saved_at.slice(0, 10)}</td>
      <td><strong>${item.pair}</strong></td>
      <td class="dim">${modelLabel(item.model_type)}</td>
      <td class="dim">${item.last_scan ? new Date(item.last_scan).toLocaleString() : '—'} ${error}</td>
      <td><span class="signal-badge ${sigCls}">${current}</span></td>
      <td class="num">${ratioOrZ}</td>
      <td class="num ${s.adf_p < 0.05 ? 'good' : s.adf_p < 0.10 ? 'warn' : 'bad'}">${fmtNum(s.adf_p, 3)}</td>
      <td class="num ${s.coint_p < 0.05 ? 'good' : s.coint_p < 0.10 ? 'warn' : 'bad'}">${fmtNum(s.coint_p, 3)}</td>
      <td class="num dim">${s.half_life === null ? '∞' : fmtNum(s.half_life, 0)}</td>
      <td class="num">${fmtPct(win)}</td>
      <td class="num">${fmtPct(avg)}</td>
      <td>${action}</td>
      <td><button class="btn-row" data-action="remove-monitor" data-id="${item.id}">✕</button></td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('button[data-action="remove-monitor"]').forEach(btn => {
    btn.addEventListener('click', () => removeMonitor(btn.dataset.id));
  });

  tbody.querySelectorAll('button[data-action="open-monitor"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = loadMonitors().find(m => m.id === btn.dataset.id);
      if (!item?.last_summary) return;
      addToWatchlist({
        ...item.last_summary,
        model_type: item.model_type,
        target_return: item.target_return,
        window_days: item.window_days,
      });
      btn.textContent = 'ADDED';
      btn.disabled = true;
      btn.classList.add('added');
      setMsg('watch-msg', `OK OPENED ${item.pair} FROM SAVED PAIRS`, 'ok');
    });
  });
}

function addManualMonitor() {
  const ticker1 = document.getElementById('mon-t1').value.toUpperCase().trim();
  const ticker2 = document.getElementById('mon-t2').value.toUpperCase().trim();
  if (!ticker1 || !ticker2 || ticker1 === ticker2) {
    setMsg('watch-msg', 'TICKERS MUST BE DIFFERENT & NON-EMPTY', 'err');
    return;
  }

  addMonitorPair({
    ticker1,
    ticker2,
    model_type: document.getElementById('mon-model').value,
    start_year: parseInt(document.getElementById('mon-start-year').value, 10),
    target_return: 0.05,
    window_days: 30,
  });
  setMsg('watch-msg', `OK SAVED ${ticker1}/${ticker2}`, 'ok');
}

// ============================================================
// WATCHLIST
// ============================================================

function addToWatchlist(s) {
  const list = loadWatch();
  const opened = new Date().toISOString();
  const signalText = s.current_signal || '';
  const item = {
    id: `${s.pair}@${opened}`,
    pair: s.pair,
    ticker1: s.ticker1, ticker2: s.ticker2,
    side:  signalText.startsWith('LONG') ? 'LONG' : 'SHORT',
    level: signalText.replace(/(LONG|SHORT)[\s_]+/, '').replace('_SPREAD', ' SPREAD'),
    model_type: s.model_type || 'RATIO',
    hedge_ratio: s.hedge_ratio ?? 1,
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
  const hedgeRatio = item.hedge_ratio ?? 1;
  const r1 = p1Now / item.entry_p1 - 1;
  const r2 = p2Now / item.entry_p2 - 1;
  return item.side === 'LONG' ? (r1 - hedgeRatio * r2) : (-r1 + hedgeRatio * r2);
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
let monitorTimer = null;
let secondsLeft = 0;
const POLL_INTERVAL = 25; // seconds
const MONITOR_INTERVAL = 15 * 60; // seconds

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
  renderMonitors();
  refreshSavedPairs(false);
  pollTimer = setInterval(refreshLivePrices, POLL_INTERVAL * 1000);
  monitorTimer = setInterval(() => refreshSavedPairs(false), MONITOR_INTERVAL * 1000);
  countdownTimer = setInterval(() => {
    if (secondsLeft > 0) secondsLeft -= 1;
    const el = document.getElementById('refresh-countdown');
    if (el) el.textContent = secondsLeft;
  }, 1000);
}
function stopPolling() {
  if (pollTimer)      { clearInterval(pollTimer);      pollTimer = null; }
  if (monitorTimer)   { clearInterval(monitorTimer);   monitorTimer = null; }
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
document.getElementById('refresh-monitors').addEventListener('click', () => refreshSavedPairs(true));
document.getElementById('save-monitor-manual').addEventListener('click', addManualMonitor);
document.getElementById('clear-watch').addEventListener('click', () => {
  if (!confirm('Clear entire watchlist?')) return;
  saveWatch([]);
  saveMonitors([]);
  renderMonitors();
  renderWatchlist();
});

document.getElementById('export-watch').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({
    active_signals: loadWatch(),
    saved_pairs: loadMonitors(),
  }, null, 2)], { type: 'application/json' });
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
      if (Array.isArray(parsed)) {
        saveWatch(parsed);
        setMsg('watch-msg', `IMPORTED ${parsed.length} ACTIVE SIGNALS`, 'ok');
      } else {
        if (!Array.isArray(parsed.active_signals) || !Array.isArray(parsed.saved_pairs)) throw new Error('invalid export format');
        saveWatch(parsed.active_signals);
        saveMonitors(parsed.saved_pairs);
        setMsg('watch-msg', `IMPORTED ${parsed.active_signals.length} SIGNALS · ${parsed.saved_pairs.length} SAVED PAIRS`, 'ok');
      }
      renderMonitors();
      renderWatchlist();
    } catch (err) {
      setMsg('watch-msg', `✗ INVALID JSON · ${err.message}`, 'err');
    }
  };
  reader.readAsText(f);
});
