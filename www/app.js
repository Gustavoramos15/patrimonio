'use strict';

/* =========================================================
   Storage
   ========================================================= */
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('pt.' + key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('pt.' + key, JSON.stringify(value)); } catch {}
  },
};

const state = {
  holdings: store.get('holdings', []),
  cards: store.get('cards', []),
  settings: Object.assign({ usd: 5.50, usdAuto: true, range: '6M' }, store.get('settings', {})),
  quotes: {},          // symbol -> { price, prev, currency, name, spark: [] }
  updatedAt: null,
};
const save = {
  holdings: () => { store.set('holdings', state.holdings); syncAlerts(); },
  cards: () => store.set('cards', state.cards),
  settings: () => store.set('settings', state.settings),
};

/* =========================================================
   Helpers
   ========================================================= */
const $ = (s, el = document) => el.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => { const n = parseFloat(String(v).replace(/\./g, '').replace(',', '.')); return isFinite(n) ? n : NaN; };
const numLoose = (v) => { // aceita "5.50", "5,50" e "1.234,56"
  const s = String(v).trim();
  if (s.includes(',')) return num(s);
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) return parseFloat(s.replace(/\./g, '')); // 2.500 → 2500
  return parseFloat(s);
};
const fmtMoney = (v, cur = 'BRL') =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v || 0);
const fmtNum = (v, d = 0) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }).format(v || 0);
const fmtPct = (v) => (v >= 0 ? '+' : '') + fmtNum(v, 2) + '%';
const arrow = (v) => (v >= 0 ? '▲' : '▼');
const tone = (v) => (v >= 0 ? 'up' : 'down');
const TREND = {
  up: { line: '#3ecf8e', rgb: '62,207,142' },
  down: { line: '#f2545b', rgb: '242,84,91' },
};
const fmtDate = (t, opts = { day: '2-digit', month: 'short', year: 'numeric' }) =>
  new Date(t).toLocaleDateString('pt-BR', opts).replace('.', '');
const fmtTime = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const display = (sym) => sym.replace(/\.SA$/, '');
const normalizeSymbol = (raw) => {
  const s = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (/^[A-Z]{4}\d{1,2}F?$/.test(s)) return s.replace(/F$/, '') + '.SA'; // padrão B3
  return s;
};
const toBRL = (v, cur) => (cur === 'USD' ? v * state.settings.usd : v);

const skeleton = (n) => '<div class="skel"><i></i><i></i></div>'.repeat(n);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

/* =========================================================
   Market data (Yahoo Finance chart API via native HTTP)
   ========================================================= */
const RANGES = {
  '1D': { range: '1d', interval: '5m' },
  '1M': { range: '1mo', interval: '1d' },
  '3M': { range: '3mo', interval: '1d' },
  '6M': { range: '6mo', interval: '1d' },
  '1A': { range: '1y', interval: '1d' },
  '5A': { range: '5y', interval: '1wk' },
};

async function httpGetJSON(url) {
  const Cap = window.Capacitor;
  if (Cap && Cap.isNativePlatform && Cap.isNativePlatform() && Cap.Plugins.CapacitorHttp) {
    const res = await Cap.Plugins.CapacitorHttp.get({
      url,
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36', Accept: 'application/json' },
      connectTimeout: 12000, readTimeout: 12000,
    });
    if (res.status >= 400) throw new Error('HTTP ' + res.status);
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function httpGetText(url) {
  const Cap = window.Capacitor;
  if (Cap && Cap.isNativePlatform && Cap.isNativePlatform() && Cap.Plugins.CapacitorHttp) {
    const res = await Cap.Plugins.CapacitorHttp.get({
      url, responseType: 'text',
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36' },
      connectTimeout: 12000, readTimeout: 12000,
    });
    if (res.status >= 400) throw new Error('HTTP ' + res.status);
    return typeof res.data === 'string' ? res.data : String(res.data);
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

const memCache = {};
async function fetchSeries(symbol, rangeKey) {
  const key = symbol + '|' + rangeKey;
  const hit = memCache[key];
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.data;
  const { range, interval } = RANGES[rangeKey];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  try {
    const json = await httpGetJSON(url);
    const r = json && json.chart && json.chart.result && json.chart.result[0];
    if (!r) throw new Error((json && json.chart && json.chart.error && json.chart.error.description) || 'Ativo não encontrado');
    const closes = (r.indicators.quote[0] || {}).close || [];
    const pts = [];
    (r.timestamp || []).forEach((t, i) => { if (closes[i] != null) pts.push({ t: t * 1000, v: closes[i] }); });
    const m = r.meta || {};
    if (m.regularMarketPrice != null && pts.length) pts[pts.length - 1].v = m.regularMarketPrice;
    const data = {
      points: pts,
      price: m.regularMarketPrice ?? (pts.length ? pts[pts.length - 1].v : 0),
      currency: m.currency || 'BRL',
      name: m.longName || m.shortName || '',
      prevClose: m.previousClose ?? m.chartPreviousClose ?? null,
      dayHigh: m.regularMarketDayHigh ?? null,
      dayLow: m.regularMarketDayLow ?? null,
      high52: m.fiftyTwoWeekHigh ?? null,
      low52: m.fiftyTwoWeekLow ?? null,
    };
    memCache[key] = { at: Date.now(), data };
    store.set('series.' + key, data); // cópia offline
    return data;
  } catch (e) {
    const offline = store.get('series.' + key, null);
    if (offline) return Object.assign({ offline: true }, offline);
    throw e;
  }
}

async function refreshQuotes() {
  if (!state.holdings.length) { renderStocks(); return; }
  $('#stock-updated').innerHTML = '<span class="spin"></span>Atualizando cotações…';
  let offline = false;
  await Promise.all(state.holdings.map(async (h) => {
    try {
      const d = await fetchSeries(h.symbol, '1M');
      const p = d.points;
      const prev = p.length > 1 ? p[p.length - 2].v : d.price;
      state.quotes[h.symbol] = { price: d.price, prev, currency: d.currency, name: d.name, spark: p };
      if (d.name && !h.name) { h.name = d.name; save.holdings(); }
      if (d.offline) offline = true;
    } catch { offline = true; }
  }));
  state.updatedAt = new Date();
  renderStocks();
  $('#stock-updated').textContent = (offline ? 'Sem conexão em parte dos ativos — exibindo últimos dados salvos. ' : '') +
    'Atualizado às ' + state.updatedAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + ' · Cotações com atraso (Yahoo Finance)';
  renderPortfolioChart();
  refreshProvents();
}


/* =========================================================
   Proventos (dividendos / JCP)
   ========================================================= */
const parseBR = (d) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d || ''); return m ? Date.parse(`${m[3]}-${m[2]}-${m[1]}T12:00:00`) : null; };
const PROV_TTL = 6 * 60 * 60 * 1000;

async function fetchProvents(symbol) {
  const key = 'prov.' + symbol;
  const cached = store.get(key, null);
  if (cached && Date.now() - cached.at < PROV_TTL) return cached.list;
  try {
    let list = [];
    if (/\.SA$/.test(symbol)) {
      const t = display(symbol);
      for (const kind of ['acao', 'fii', 'bdr']) {
        const j = await httpGetJSON(`https://statusinvest.com.br/${kind}/companytickerprovents?ticker=${encodeURIComponent(t)}&chartProventsType=2`);
        const models = (j && j.assetEarningsModels) || [];
        if (models.length) {
          list = models.map((m) => ({ type: m.et || 'Provento', ex: parseBR(m.ed), pay: parseBR(m.pd), value: +m.v || 0, currency: 'BRL' }));
          break;
        }
      }
    } else {
      const j = await httpGetJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1mo&events=div`);
      const r = j && j.chart && j.chart.result && j.chart.result[0];
      const divs = (r && r.events && r.events.dividends) || {};
      const cur = (r && r.meta && r.meta.currency) || 'USD';
      list = Object.values(divs).map((d) => ({ type: 'Dividendo', ex: d.date * 1000, pay: null, value: d.amount, currency: cur }));
    }
    list = list.filter((x) => x.ex || x.pay);
    store.set(key, { at: Date.now(), list });
    return list;
  } catch (e) {
    if (cached) return cached.list;
    throw e;
  }
}

const shortType = (t) => (/juros|jcp/i.test(t) ? 'JCP' : /rend/i.test(t) ? 'Rendimento' : /divid/i.test(t) ? 'Dividendo' : t);
const fmtShort = (t) => (t ? new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' }) : 'a definir');
const fmtUnit = (v, cur) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(v);

function provRow(h, p, showTicker = true) {
  const type = shortType(p.type);
  return `<div class="entry">
    <div class="e-l"><div class="e-t">${showTicker ? esc(display(h.symbol)) : ''}<span class="badge ${type === 'JCP' ? 'solid' : ''} ${showTicker ? '' : 'flush'}">${esc(type)}</span></div>
      <div class="e-s">Data com ${fmtShort(p.ex)} · Pgto ${fmtShort(p.pay)}</div></div>
    <div class="e-r"><div class="e-p">${fmtMoney(h.qty * p.value, p.currency)}</div><div class="x">${fmtUnit(p.value, p.currency)}/ação</div></div>
  </div>`;
}

let provData = [];
async function refreshProvents() {
  const sec = $('#prov-section');
  if (!state.holdings.length) { sec.hidden = true; return; }
  sec.hidden = false;
  $('#prov-status').innerHTML = '<span class="spin"></span>';
  const res = await Promise.all(state.holdings.map((h) =>
    fetchProvents(h.symbol).then((list) => ({ h, list })).catch(() => ({ h, list: null }))));
  provData = res;
  const failed = res.filter((r) => !r.list).length;
  $('#prov-status').textContent = failed ? `${failed} sem dados` : '';
  renderProvents();
}

function renderProvents() {
  if (!provData.length) return;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const t0 = today.getTime(), yearAgo = t0 - 365 * 864e5;
  const next = [], past = [];
  let toReceive = 0, received = 0;
  for (const { h, list } of provData) {
    if (!list || !state.holdings.includes(h)) continue;
    for (const p of list) {
      const v = toBRL(h.qty * p.value, p.currency);
      const upcoming = p.pay ? p.pay >= t0 : p.ex >= t0 - 45 * 864e5;
      if (upcoming) { next.push({ h, p }); toReceive += v; }
      else if ((p.pay || p.ex) >= yearAgo) { past.push({ h, p }); received += v; }
    }
  }
  next.sort((a, b) => (a.p.pay || 9e15) - (b.p.pay || 9e15) || a.p.ex - b.p.ex);
  past.sort((a, b) => (b.p.pay || b.p.ex) - (a.p.pay || a.p.ex));
  const value = portfolioTotals().value;
  const first = next.find((x) => x.p.pay);
  $('#prov-stats').innerHTML = `
    <div class="stat"><div class="k">A receber</div><div class="v">${fmtMoney(toReceive)}</div></div>
    <div class="stat"><div class="k">Recebido 12m</div><div class="v">${fmtMoney(received)}</div></div>
    <div class="stat"><div class="k">Próximo pgto</div><div class="v">${first ? esc(display(first.h.symbol)) + ' · ' + fmtShort(first.p.pay).slice(0, 5) : '—'}</div></div>
    <div class="stat"><div class="k">Yield 12m</div><div class="v">${value ? fmtNum((received / value) * 100, 2) + '%' : '—'}</div></div>`;
  $('#prov-next').innerHTML = next.length ? next.map(({ h, p }) => provRow(h, p)).join('') : '<div class="empty">Nenhum provento anunciado para suas ações.</div>';
  $('#prov-past').innerHTML = past.length ? past.slice(0, 8).map(({ h, p }) => provRow(h, p)).join('') : '<div class="empty">Nenhum pagamento nos últimos 12 meses.</div>';
}

function renderAlloc() {
  const sec = $('#alloc-section');
  if (!state.holdings.length) { sec.hidden = true; return; }
  sec.hidden = false;
  const items = state.holdings.map((h) => {
    const q = state.quotes[h.symbol];
    return { label: display(h.symbol), v: toBRL(h.qty * (q ? q.price : h.avg), q ? q.currency : h.currency) };
  });
  renderDonut($('#alloc'), items, items.length > 1 ? 'ativos' : 'ativo', (v) => fmtMoney(v));
}

async function refreshUsd() {
  if (!state.settings.usdAuto) return;
  try {
    const d = await fetchSeries('BRL=X', '1M');
    if (d.price > 1) { state.settings.usd = +d.price.toFixed(4); save.settings(); }
  } catch {}
}

/* =========================================================
   Charts (canvas, monocromático)
   ========================================================= */
function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawLine(canvas, points, opts = {}) {
  canvas._chart = { points, opts };
  const { ctx, w, h } = setupCanvas(canvas);
  if (!points || points.length < 2) return;
  const padT = opts.spark ? 2 : 16, padB = opts.spark ? 2 : 22, padX = opts.spark ? 1 : 0;
  const vals = points.map((p) => p.v);
  const baseV = opts.base ?? vals[0];
  let min = Math.min(...vals, baseV), max = Math.max(...vals, baseV);
  if (min === max) { min -= 1; max += 1; }
  const x = (i) => padX + (i / (points.length - 1)) * (w - padX * 2);
  const y = (v) => padT + (1 - (v - min) / (max - min)) * (h - padT - padB);
  const trend = TREND[vals[vals.length - 1] >= baseV ? 'up' : 'down'];
  const stroke = trend.line;

  // baseline (valor inicial)
  if (!opts.spark) {
    ctx.strokeStyle = '#2a2a2a'; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.moveTo(0, y(baseV)); ctx.lineTo(w, y(baseV)); ctx.stroke(); ctx.setLineDash([]);
  }

  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.v)) : ctx.moveTo(x(i), y(p.v))));
  ctx.strokeStyle = stroke; ctx.lineWidth = opts.spark ? 1.25 : 1.75; ctx.lineJoin = 'round'; ctx.stroke();

  if (!opts.spark) {
    const g = ctx.createLinearGradient(0, padT, 0, h);
    g.addColorStop(0, `rgba(${trend.rgb},0.24)`); g.addColorStop(0.65, `rgba(${trend.rgb},0.05)`); g.addColorStop(1, `rgba(${trend.rgb},0)`);
    ctx.lineTo(x(points.length - 1), h); ctx.lineTo(x(0), h); ctx.closePath();
    ctx.fillStyle = g; ctx.fill();

    // rótulos min/max
    ctx.font = '500 10px Inter, sans-serif'; ctx.fillStyle = '#5a5a58';
    const fmt = opts.format || ((v) => fmtNum(v, 2));
    ctx.textAlign = 'right';
    ctx.fillText(fmt(max), w - 8, padT - 4);
    ctx.fillText(fmt(min), w - 8, h - 6);
    ctx.textAlign = 'left';
    ctx.fillText(opts.intraday ? fmtTime(points[0].t) : fmtDate(points[0].t, { day: '2-digit', month: 'short' }), 8, h - 6);

    // marcador de scrub
    const si = canvas._scrub;
    if (si != null && points[si]) {
      const sx = x(si), sy = y(points[si].v);
      ctx.strokeStyle = 'rgba(244,244,242,.35)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, h); ctx.stroke();
      ctx.fillStyle = '#0a0a0a'; ctx.strokeStyle = trend.line; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    } else {
      const lx = x(points.length - 1), ly = y(vals[vals.length - 1]);
      ctx.fillStyle = `rgba(${trend.rgb},0.25)`; ctx.beginPath(); ctx.arc(lx - 1, ly, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = trend.line; ctx.beginPath(); ctx.arc(lx - 1, ly, 3, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function makeScrubbable(canvas, onScrub, onEnd) {
  if (canvas._scrubBound) { canvas._onScrub = onScrub; canvas._onEnd = onEnd; return; }
  canvas._scrubBound = true; canvas._onScrub = onScrub; canvas._onEnd = onEnd;
  const pick = (clientX) => {
    const c = canvas._chart; if (!c || !c.points || c.points.length < 2) return;
    const r = canvas.getBoundingClientRect();
    const i = Math.max(0, Math.min(c.points.length - 1, Math.round(((clientX - r.left) / r.width) * (c.points.length - 1))));
    if (canvas._scrub !== i) {
      canvas._scrub = i; drawLine(canvas, c.points, c.opts);
      canvas._onScrub && canvas._onScrub(c.points[i], c.points);
    }
  };
  const end = () => {
    if (canvas._scrub == null) return;
    canvas._scrub = null; const c = canvas._chart;
    if (c) drawLine(canvas, c.points, c.opts);
    canvas._onEnd && canvas._onEnd();
  };
  canvas.addEventListener('touchstart', (e) => pick(e.touches[0].clientX), { passive: true });
  canvas.addEventListener('touchmove', (e) => pick(e.touches[0].clientX), { passive: true });
  canvas.addEventListener('touchend', end); canvas.addEventListener('touchcancel', end);
  canvas.addEventListener('mousemove', (e) => e.buttons && pick(e.clientX));
  canvas.addEventListener('mousedown', (e) => pick(e.clientX));
  canvas.addEventListener('mouseup', end); canvas.addEventListener('mouseleave', end);
}

function drawBars(canvas, items) { // items: [{label, v}]
  const { ctx, w, h } = setupCanvas(canvas);
  const max = Math.max(1, ...items.map((i) => i.v));
  const gap = 10, bw = (w - gap * (items.length - 1)) / items.length, base = h - 18;
  ctx.font = '500 10px Inter, sans-serif'; ctx.textAlign = 'center';
  items.forEach((it, i) => {
    const bh = Math.max(2, (it.v / max) * (base - 16));
    const bx = i * (bw + gap);
    ctx.fillStyle = it.v > 0 && it.v === max ? '#f4f4f2' : '#3a3a38';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, base - bh, bw, bh, 4); else ctx.rect(bx, base - bh, bw, bh);
    ctx.fill();
    ctx.fillStyle = '#8b8b88'; ctx.fillText(it.label, bx + bw / 2, h - 4);
    if (it.v > 0) { ctx.fillStyle = '#5a5a58'; ctx.fillText(fmtNum(it.v), bx + bw / 2, base - bh - 4); }
  });
}


const SHADES = ['#f4f4f2', '#b8b8b4', '#86868a', '#5c5c5a', '#3e3e3c', '#2c2c2a'];
function drawDonut(canvas, items, active) {
  const { ctx, w, h } = setupCanvas(canvas);
  const total = items.reduce((s, i) => s + i.v, 0);
  if (!total) return;
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 12, thick = 18;
  let a = -Math.PI / 2;
  items.forEach((it, i) => {
    const sweep = (it.v / total) * Math.PI * 2;
    const gap = items.length > 1 ? Math.min(0.035, sweep / 3) : 0;
    ctx.beginPath();
    ctx.arc(cx, cy, active === i ? r + 3 : r, a + gap / 2, a + sweep - gap / 2);
    ctx.strokeStyle = it.color; ctx.lineWidth = active === i ? thick + 4 : thick;
    ctx.globalAlpha = active == null || active === i ? 1 : 0.3;
    ctx.stroke();
    a += sweep;
  });
  ctx.globalAlpha = 1;
}

// items: [{label, v}] — agrupa o excedente em "Outros"
function renderDonut(el, rawItems, centerSub, fmtV) {
  const sorted = rawItems.filter((i) => i.v > 0).sort((a, b) => b.v - a.v);
  const items = sorted.length > 6
    ? [...sorted.slice(0, 5), { label: 'Outros', v: sorted.slice(5).reduce((s, i) => s + i.v, 0) }]
    : sorted;
  items.forEach((it, i) => (it.color = SHADES[i % SHADES.length]));
  const total = items.reduce((s, i) => s + i.v, 0);
  el.innerHTML = `<div class="donut"><canvas></canvas><div class="center"></div></div>
    <div class="legend">${items.map((it, i) => `<button data-i="${i}"><i style="background:${it.color}"></i><span class="n">${esc(it.label)}</span><span class="p">${fmtNum((it.v / total) * 100, 1)}%</span></button>`).join('')}</div>`;
  const canvas = $('canvas', el), center = $('.center', el), legend = $('.legend', el);
  let active = null;
  const paint = () => {
    drawDonut(canvas, items, active);
    legend.querySelectorAll('button').forEach((b) => b.classList.toggle('dim', active != null && +b.dataset.i !== active));
    center.innerHTML = active == null
      ? `<div><b>${items.length}</b><span>${esc(centerSub)}</span></div>`
      : `<div><b>${fmtNum((items[active].v / total) * 100, 1)}%</b><span>${esc(fmtV(items[active].v))}</span></div>`;
  };
  legend.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; active = active === +b.dataset.i ? null : +b.dataset.i; paint(); };
  canvas.onclick = (e) => { // toque na fatia
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left - r.width / 2, y = e.clientY - r.top - r.height / 2;
    let ang = Math.atan2(y, x) + Math.PI / 2; if (ang < 0) ang += Math.PI * 2;
    let acc = 0, hit = null;
    items.forEach((it, i) => { const sw = (it.v / total) * Math.PI * 2; if (hit == null && ang <= acc + sw) hit = i; acc += sw; });
    active = active === hit ? null : hit; paint();
  };
  requestAnimationFrame(paint);
}

/* =========================================================
   Ações — render
   ========================================================= */
function portfolioTotals() {
  let value = 0, invested = 0, dayPrev = 0, priced = 0;
  for (const h of state.holdings) {
    const q = state.quotes[h.symbol];
    const cur = q ? q.currency : (h.currency || 'BRL');
    invested += toBRL(h.qty * h.avg, cur);
    if (q) { value += toBRL(h.qty * q.price, cur); dayPrev += toBRL(h.qty * q.prev, cur); priced++; }
    else value += toBRL(h.qty * h.avg, cur);
  }
  return { value, invested, dayPrev, priced };
}

function setHero(value, sub) {
  const s = fmtMoney(value);
  $('#hero-value').innerHTML = `<small>R$</small>${esc(s.replace(/^R\$\s?/, ''))}`;
  $('#hero-delta').innerHTML = sub;
}

function heroDefault() {
  const t = portfolioTotals();
  $('#hero-label').textContent = 'Patrimônio em ações';
  if (!state.holdings.length) { setHero(0, 'Nenhuma posição cadastrada'); return; }
  const day = t.value - t.dayPrev, dayPct = t.dayPrev ? (day / t.dayPrev) * 100 : 0;
  setHero(t.value, t.priced
    ? `<b class="${tone(day)}">${arrow(day)} ${fmtMoney(Math.abs(day))} · ${fmtPct(dayPct)}</b> hoje`
    : 'Aguardando cotações…');
}

function renderStocks() {
  heroDefault();
  renderAlloc();
  renderProvents();
  const t = portfolioTotals();
  const res = t.value - t.invested, resPct = t.invested ? (res / t.invested) * 100 : 0;
  $('#portfolio-stats').innerHTML = state.holdings.length ? `
    <div class="stat"><div class="k">Investido</div><div class="v">${fmtMoney(t.invested)}</div></div>
    <div class="stat"><div class="k">Resultado</div><div class="v ${tone(res)}">${arrow(res)} ${fmtPct(resPct)}</div></div>
    <div class="stat"><div class="k">Lucro / Prejuízo</div><div class="v">${fmtMoney(res)}</div></div>
    <div class="stat"><div class="k">Ativos</div><div class="v">${state.holdings.length}</div></div>` : '';

  const list = $('#stock-list');
  if (!state.holdings.length) {
    list.innerHTML = `<div class="empty-state"><strong>Sua carteira está vazia</strong>Toque em “+ Adicionar” e informe o ticker (ex.: PETR4, ITUB4, AAPL), a quantidade e o preço médio.</div>`;
    list.style.borderTop = '0';
    $('#stock-updated').textContent = '';
    $('#prov-section').hidden = true; provData = [];
    return;
  }
  list.style.borderTop = '';
  const sorted = [...state.holdings].sort((a, b) => {
    const qa = state.quotes[a.symbol], qb = state.quotes[b.symbol];
    return toBRL(b.qty * (qb ? qb.price : b.avg), qb && qb.currency) - toBRL(a.qty * (qa ? qa.price : a.avg), qa && qa.currency);
  });
  list.innerHTML = sorted.map((h) => {
    const q = state.quotes[h.symbol];
    const cur = q ? q.currency : 'BRL';
    const chg = q && q.prev ? ((q.price - q.prev) / q.prev) * 100 : null;
    return `<button class="row" data-id="${h.id}">
      <div><div class="sym">${esc(display(h.symbol))}</div>
        <div class="sub">${fmtNum(h.qty, h.qty % 1 ? 2 : 0)} un · ${q ? fmtMoney(h.qty * q.price, cur) : 'PM ' + fmtMoney(h.avg, cur)}</div></div>
      <canvas data-spark="${esc(h.symbol)}"></canvas>
      <div class="right"><div class="price">${q ? fmtMoney(q.price, cur) : '—'}</div>
        <div class="chg ${chg == null ? '' : tone(chg)}">${chg == null ? '' : arrow(chg) + ' ' + fmtPct(chg)}</div></div>
    </button>`;
  }).join('');
  list.querySelectorAll('canvas[data-spark]').forEach((c) => {
    const q = state.quotes[c.dataset.spark];
    if (q && q.spark) drawLine(c, q.spark, { spark: true });
  });
}

let portfolioReq = 0;
async function renderPortfolioChart() {
  const canvas = $('#portfolio-chart');
  const wrap = canvas.parentElement;
  $('#portfolio-ranges').innerHTML = Object.keys(RANGES).filter((k) => k !== '1D')
    .map((k) => `<button data-range="${k}" class="${k === state.settings.range ? 'on' : ''}">${k}</button>`).join('');
  if (!state.holdings.length) { wrap.classList.add('empty'); drawLine(canvas, []); return; }
  wrap.classList.remove('empty');
  const req = ++portfolioReq;
  const rangeKey = state.settings.range;
  const results = await Promise.all(state.holdings.map((h) =>
    fetchSeries(h.symbol, rangeKey).then((d) => ({ h, d })).catch(() => null)));
  if (req !== portfolioReq) return;
  const ok = results.filter(Boolean).filter((r) => r.d.points.length > 1);
  if (!ok.length) {
    wrap.classList.add('empty');
    $('#portfolio-empty').textContent = 'Não foi possível carregar o histórico. Verifique a conexão.';
    drawLine(canvas, []); return;
  }
  // soma diária: começa quando todos os ativos têm dados, preenchendo lacunas com o último valor
  const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
  const start = Math.max(...ok.map((r) => r.d.points[0].t));
  const dates = [...new Set(ok.flatMap((r) => r.d.points.filter((p) => p.t >= start).map((p) => dayKey(p.t))))].sort();
  const maps = ok.map((r) => {
    const m = new Map(r.d.points.map((p) => [dayKey(p.t), p.v]));
    return { m, qty: r.h.qty, cur: r.d.currency, last: r.d.points[0].v };
  });
  const points = dates.map((dk) => {
    let v = 0;
    for (const s of maps) { if (s.m.has(dk)) s.last = s.m.get(dk); v += toBRL(s.qty * s.last, s.cur); }
    return { t: Date.parse(dk + 'T12:00:00'), v };
  });
  drawLine(canvas, points, { format: (v) => fmtNum(v, 0) });
  makeScrubbable(canvas, (p, all) => {
    const diff = p.v - all[0].v, pct = all[0].v ? (diff / all[0].v) * 100 : 0;
    $('#hero-label').textContent = fmtDate(p.t);
    setHero(p.v, `<b class="${tone(diff)}">${arrow(diff)} ${fmtMoney(Math.abs(diff))} · ${fmtPct(pct)}</b> no período`);
  }, heroDefault);
}

/* =========================================================
   Sheets
   ========================================================= */
function openSheet(html, onMount) {
  $('#sheet-body').innerHTML = html;
  $('#sheet-body').scrollTop = 0;
  if (!$('#sheet').classList.contains('open')) {
    $('#sheet').classList.add('open');
    history.pushState({ sheet: true }, '');
  }
  if (onMount) requestAnimationFrame(() => onMount($('#sheet-body')));
}
function closeSheet(fromPop) {
  if (!$('#sheet').classList.contains('open')) return;
  $('#sheet').classList.remove('open');
  document.activeElement && document.activeElement.blur();
  if (!fromPop && history.state && history.state.sheet) history.back();
}
window.addEventListener('popstate', () => closeSheet(true));
$('.sheet-backdrop').addEventListener('click', () => closeSheet());
$('#sheet-close').addEventListener('click', () => closeSheet());

/* ---------- Adicionar / editar ação ---------- */
function stockForm(h, prefill = '') {
  const editing = !!h;
  openSheet(`
    <h3>${editing ? esc(display(h.symbol)) : 'Nova posição'}</h3>
    <p class="hint">${editing ? 'Atualize a quantidade ou o preço médio.' : 'Ações da B3 (PETR4, VALE3, BOVA11) ou do exterior (AAPL, MSFT).'}</p>
    ${editing ? '' : `<div class="field"><label>Ticker</label><input id="f-sym" placeholder="PETR4" autocapitalize="characters" autocomplete="off" value="${esc(prefill)}"></div>`}
    <div class="grid2">
      <div class="field"><label>Quantidade</label><input id="f-qty" inputmode="decimal" placeholder="100" value="${editing ? String(h.qty).replace('.', ',') : ''}"></div>
      <div class="field"><label>Preço médio</label><input id="f-avg" inputmode="decimal" placeholder="38,50" value="${editing ? String(h.avg).replace('.', ',') : ''}"></div>
    </div>
    <button class="btn" id="f-save">${editing ? 'Salvar' : 'Adicionar à carteira'}</button>
    ${editing ? '<button class="btn danger" id="f-del">Remover posição</button>' : ''}
  `, (el) => {
    const first = $('#f-sym', el) || $('#f-qty', el);
    first && first.focus();
    $('#f-save', el).onclick = async () => {
      const qty = numLoose($('#f-qty', el).value), avg = numLoose($('#f-avg', el).value);
      if (!(qty > 0)) return toast('Informe a quantidade');
      if (!(avg >= 0)) return toast('Informe o preço médio');
      if (editing) {
        Object.assign(h, { qty, avg }); save.holdings();
        closeSheet(); renderStocks(); renderPortfolioChart(); toast('Posição atualizada');
        return;
      }
      const raw = $('#f-sym', el).value;
      if (!raw.trim()) return toast('Informe o ticker');
      const symbol = normalizeSymbol(raw);
      const btn = $('#f-save', el); btn.innerHTML = '<span class="spin"></span>Buscando ativo…'; btn.disabled = true;
      let currency = 'BRL', name = '';
      try { const d = await fetchSeries(symbol, '1M'); currency = d.currency; name = d.name; }
      catch { toast('Não encontrei a cotação agora — salvo mesmo assim'); }
      const existing = state.holdings.find((x) => x.symbol === symbol);
      if (existing) { // consolida preço médio
        const total = existing.qty + qty;
        existing.avg = (existing.qty * existing.avg + qty * avg) / total;
        existing.qty = total;
      } else {
        state.holdings.push({ id: uid(), symbol, qty, avg, currency, name });
      }
      save.holdings(); closeSheet(); toast(display(symbol) + ' adicionada');
      renderStocks(); refreshQuotes();
    };
    if (editing) $('#f-del', el).onclick = () => removeHolding(h);
  });
}

function removeHolding(h) {
  if (!confirm('Remover ' + display(h.symbol) + ' da carteira?')) return;
  state.holdings = state.holdings.filter((x) => x.id !== h.id); save.holdings();
  delete state.quotes[h.symbol];
  provData = provData.filter((r) => r.h.id !== h.id);
  closeSheet(); renderStocks(); renderPortfolioChart(); toast(display(h.symbol) + ' removida');
}

/* ---------- Detalhe da ação ---------- */
function stockDetail(h) {
  let rangeKey = state.settings.range;
  const q = state.quotes[h.symbol];
  const cur = q ? q.currency : (h.currency || 'BRL');
  const price = q ? q.price : h.avg;
  const pos = h.qty * price, inv = h.qty * h.avg, res = pos - inv, resPct = inv ? (res / inv) * 100 : 0;
  openSheet(`
    <div class="eyebrow">${esc(h.name || q?.name || '')}</div>
    <h3>${esc(display(h.symbol))}</h3>
    <div class="label" id="d-label">Preço atual</div>
    <div class="big" id="d-price">${fmtMoney(price, cur)}</div>
    <div class="delta" id="d-delta">&nbsp;</div>
    <div class="chart-wrap"><canvas id="d-chart"></canvas><div class="chart-empty">Carregando…</div></div>
    <div class="ranges" id="d-ranges"></div>
    <div class="stats">
      <div class="stat"><div class="k">Quantidade</div><div class="v">${fmtNum(h.qty, h.qty % 1 ? 2 : 0)}</div></div>
      <div class="stat"><div class="k">Preço médio</div><div class="v">${fmtMoney(h.avg, cur)}</div></div>
      <div class="stat"><div class="k">Posição</div><div class="v">${fmtMoney(pos, cur)}</div></div>
      <div class="stat"><div class="k">Resultado</div><div class="v ${tone(res)}">${arrow(res)} ${fmtMoney(Math.abs(res), cur)} · ${fmtPct(resPct)}</div></div>
    </div>
    <div class="section-head"><h2>Proventos</h2></div>
    <div class="entries" id="d-prov">${skeleton(3)}</div>
    <div class="btn-row"><button class="btn ghost" id="d-edit">Editar</button><button class="btn ghost" id="d-del">Remover ação</button></div>
  `, (el) => {
    fetchProvents(h.symbol).then((list) => {
      const sorted = [...list].sort((a, b) => (b.pay || b.ex) - (a.pay || a.ex)).slice(0, 12);
      $('#d-prov', el).innerHTML = sorted.length ? sorted.map((p) => provRow(h, p, false)).join('') : '<div class="empty">Nenhum provento encontrado.</div>';
    }).catch(() => { $('#d-prov', el).innerHTML = '<div class="empty">Não foi possível buscar os proventos agora.</div>'; });
    const canvas = $('#d-chart', el), wrap = canvas.parentElement;
    const deltaDefault = (pts) => {
      if (!pts || pts.length < 2) return;
      const diff = pts[pts.length - 1].v - pts[0].v, pct = (diff / pts[0].v) * 100;
      $('#d-label', el).textContent = 'Preço atual';
      $('#d-price', el).textContent = fmtMoney(pts[pts.length - 1].v, cur);
      $('#d-delta', el).innerHTML = `<b class="${tone(diff)}">${arrow(diff)} ${fmtMoney(Math.abs(diff), cur)} · ${fmtPct(pct)}</b> em ${rangeKey}`;
    };
    const load = async () => {
      $('#d-ranges', el).innerHTML = Object.keys(RANGES)
        .map((k) => `<button data-r="${k}" class="${k === rangeKey ? 'on' : ''}">${k}</button>`).join('');
      wrap.classList.add('empty');
      try {
        const d = await fetchSeries(h.symbol, rangeKey);
        wrap.classList.remove('empty');
        drawLine(canvas, d.points, { format: (v) => fmtNum(v, 2) });
        deltaDefault(d.points);
        makeScrubbable(canvas, (p, all) => {
          const diff = p.v - all[0].v, pct = (diff / all[0].v) * 100;
          $('#d-label', el).textContent = fmtDate(p.t);
          $('#d-price', el).textContent = fmtMoney(p.v, cur);
          $('#d-delta', el).innerHTML = `<b class="${tone(diff)}">${arrow(diff)} ${fmtMoney(Math.abs(diff), cur)} · ${fmtPct(pct)}</b> desde o início`;
        }, () => deltaDefault(canvas._chart.points));
      } catch {
        $('.chart-empty', wrap).textContent = 'Sem dados de histórico agora.';
      }
    };
    $('#d-ranges', el).onclick = (e) => { const b = e.target.closest('button'); if (b) { rangeKey = b.dataset.r; load(); } };
    $('#d-edit', el).onclick = () => { closeSheet(); setTimeout(() => stockForm(h), 350); };
    $('#d-del', el).onclick = () => removeHolding(h);
    load();
  });
}

/* =========================================================
   Cartões
   ========================================================= */
const PROGRAMS = ['Livelo', 'Esfera', 'Átomos', 'Membership Rewards', 'Itaú Sempre Presente', 'Smiles', 'LATAM Pass', 'Azul Fidelidade', 'Outro'];
const COLORS = ['preto', 'grafite', 'prata', 'branco'];

function entryPoints(card, e) {
  if (e.type === 'bonus') return e.points || 0;
  return (e.amount / (e.usd || state.settings.usd)) * card.ptsPerUsd;
}
function cardTotals(card) {
  let spent = 0, points = 0;
  for (const e of card.entries) { points += entryPoints(card, e); if (e.type !== 'bonus') spent += e.amount; }
  const miles = points * (card.ratio || 1);
  const value = (miles / 1000) * (card.milheiro || 0);
  return { spent, points, miles, value };
}
function monthlyPoints(card, months = 6) {
  const now = new Date(), out = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const v = card.entries.filter((e) => e.date.slice(0, 7) === key).reduce((s, e) => s + entryPoints(card, e), 0);
    out.push({ label: d.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', ''), v: Math.round(v) });
  }
  return out;
}

function renderCards() {
  let pts = 0, miles = 0, value = 0, spent = 0;
  state.cards.forEach((c) => { const t = cardTotals(c); pts += t.points; miles += t.miles; value += t.value; spent += t.spent; });
  $('#cards-points').innerHTML = `${fmtNum(pts)}<small class="suf">pts</small>`;
  $('#cards-sub').innerHTML = state.cards.length
    ? `≈ <b>${fmtNum(miles)} milhas</b> &nbsp;·&nbsp; ${state.cards.length} ${state.cards.length > 1 ? 'cartões' : 'cartão'}`
    : 'Nenhum cartão cadastrado';
  $('#cards-stats').innerHTML = state.cards.length ? `
    <div class="stat"><div class="k">Gasto total</div><div class="v">${fmtMoney(spent)}</div></div>
    <div class="stat"><div class="k">Valor estimado</div><div class="v">${fmtMoney(value)}</div></div>
    <div class="stat"><div class="k">Dólar usado</div><div class="v">${fmtMoney(state.settings.usd)}</div></div>
    <div class="stat"><div class="k">Pts / R$ médio</div><div class="v">${spent ? fmtNum(pts / spent, 2) : '—'}</div></div>` : '';

  const withPts = state.cards.map((c) => ({ label: c.name, v: cardTotals(c).points })).filter((i) => i.v > 0);
  $('#cards-alloc-section').hidden = withPts.length < 2;
  if (withPts.length >= 2) renderDonut($('#cards-alloc'), withPts, 'cartões', (v) => fmtNum(v) + ' pts');

  const list = $('#card-list');
  if (!state.cards.length) {
    list.innerHTML = `<div class="empty-state"><strong>Nenhum cartão ainda</strong>Cadastre seu cartão com quantos pontos ele dá por dólar gasto. Depois lance seus gastos ou faturas e o app calcula pontos e milhas.</div>`;
    return;
  }
  list.innerHTML = state.cards.map((c) => {
    const t = cardTotals(c);
    return `<button class="ccard ${c.color}" data-card="${c.id}">
      <div class="c-top"><div><div class="c-name">${esc(c.name)}</div><div class="c-prog">${esc(c.program)} · ${fmtNum(c.ptsPerUsd, c.ptsPerUsd % 1 ? 1 : 0)} pt/US$</div></div><div class="chip"></div></div>
      <div class="c-pts">${fmtNum(t.points)}<span>pontos</span></div>
      <div class="c-bottom"><span>≈ ${fmtNum(t.miles)} milhas</span><span>${fmtMoney(t.value)}</span></div>
    </button>`;
  }).join('');
}

function cardForm(card) {
  const editing = !!card;
  const c = card || { name: '', program: 'Livelo', ptsPerUsd: 2, ratio: 1, milheiro: 18, color: 'preto' };
  openSheet(`
    <h3>${editing ? 'Editar cartão' : 'Novo cartão'}</h3>
    <p class="hint">Confira no app do seu banco quantos pontos o cartão dá por dólar gasto — essa é a informação principal.</p>
    <div class="field"><label>Nome do cartão</label><input id="c-name" placeholder="Ex.: Black, Platinum, Infinite" value="${esc(c.name)}"></div>
    <div class="field"><label>Programa de pontos</label><select id="c-prog">${PROGRAMS.map((p) => `<option ${p === c.program ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
    <div class="grid2">
      <div class="field"><label>Pontos por US$</label><input id="c-ppu" inputmode="decimal" value="${String(c.ptsPerUsd).replace('.', ',')}"></div>
      <div class="field"><label>Milhas por ponto</label><input id="c-ratio" inputmode="decimal" value="${String(c.ratio).replace('.', ',')}"></div>
    </div>
    <div class="field"><label>Valor do milheiro (R$)</label><input id="c-mil" inputmode="decimal" value="${String(c.milheiro).replace('.', ',')}">
      <div class="help">Quanto valem 1.000 milhas para você (usado só para estimar o valor em reais). Transferência 1:1 → milhas por ponto = 1; com bônus de 100% → 2.</div></div>
    <div class="field"><label>Acabamento</label><div class="swatches">${COLORS.map((k) => `<button class="swatch ${k} ${k === c.color ? 'on' : ''}" data-color="${k}" aria-label="${k}"></button>`).join('')}</div></div>
    <button class="btn" id="c-save">${editing ? 'Salvar' : 'Adicionar cartão'}</button>
    ${editing ? '<button class="btn danger" id="c-del">Excluir cartão</button>' : ''}
  `, (el) => {
    let color = c.color;
    el.querySelectorAll('.swatch').forEach((s) => s.onclick = () => {
      el.querySelectorAll('.swatch').forEach((x) => x.classList.remove('on')); s.classList.add('on'); color = s.dataset.color;
    });
    $('#c-save', el).onclick = () => {
      const name = $('#c-name', el).value.trim();
      const ptsPerUsd = numLoose($('#c-ppu', el).value), ratio = numLoose($('#c-ratio', el).value), milheiro = numLoose($('#c-mil', el).value);
      if (!name) return toast('Dê um nome ao cartão');
      if (!(ptsPerUsd >= 0)) return toast('Pontos por dólar inválido');
      const data = { name, program: $('#c-prog', el).value, ptsPerUsd, ratio: ratio > 0 ? ratio : 1, milheiro: milheiro >= 0 ? milheiro : 0, color };
      if (editing) Object.assign(card, data); else state.cards.push(Object.assign({ id: uid(), entries: [] }, data));
      save.cards(); closeSheet(); renderCards(); toast(editing ? 'Cartão atualizado' : 'Cartão adicionado');
    };
    if (editing) $('#c-del', el).onclick = () => removeCard(card);
  });
}

function removeCard(card) {
  if (!confirm('Remover o cartão ' + card.name + ' e todos os lançamentos?')) return;
  state.cards = state.cards.filter((x) => x.id !== card.id); save.cards();
  closeSheet(); renderCards(); toast('Cartão removido');
}

function cardDetail(card) {
  const t = cardTotals(card);
  const entries = [...card.entries].sort((a, b) => b.date.localeCompare(a.date) || b.created - a.created);
  const months = new Set(card.entries.filter((e) => e.type !== 'bonus').map((e) => e.date.slice(0, 7))).size;
  const pace = months ? card.entries.filter((e) => e.type !== 'bonus').reduce((s, e) => s + entryPoints(card, e), 0) / months : 0;
  openSheet(`
    <div class="ccard ${card.color}">
      <div class="c-top"><div><div class="c-name">${esc(card.name)}</div><div class="c-prog">${esc(card.program)}</div></div><div class="chip"></div></div>
      <div class="c-pts">${fmtNum(t.points)}<span>pontos</span></div>
      <div class="c-bottom"><span>≈ ${fmtNum(t.miles)} milhas</span><span>${fmtMoney(t.value)}</span></div>
    </div>
    <div class="stats">
      <div class="stat"><div class="k">Gasto lançado</div><div class="v">${fmtMoney(t.spent)}</div></div>
      <div class="stat"><div class="k">Ritmo mensal</div><div class="v">${fmtNum(pace)} pts</div></div>
      <div class="stat"><div class="k">Pontos por US$</div><div class="v">${fmtNum(card.ptsPerUsd, 1)}</div></div>
      <div class="stat"><div class="k">Projeção 12m</div><div class="v">${fmtNum(pace * 12)} pts</div></div>
    </div>
    <div class="section-head"><h2>Pontos por mês</h2></div>
    <div class="bars"><canvas id="cd-bars"></canvas></div>
    <div class="btn-row">
      <button class="btn" id="cd-add">+ Lançar gasto</button>
      <button class="btn ghost" id="cd-edit">Editar cartão</button>
    </div>
    <div class="section-head"><h2>Lançamentos</h2></div>
    <div class="entries">${entries.length ? entries.map((e) => `
      <div class="entry">
        <div class="e-l"><div class="e-t">${esc(e.desc || (e.type === 'bonus' ? 'Bônus de pontos' : 'Gasto'))}</div>
          <div class="e-s">${fmtDate(e.date + 'T12:00:00')}${e.type === 'bonus' ? ' · bônus' : ' · ' + fmtMoney(e.amount) + ' · US$ ' + fmtNum(e.usd, 2)}</div></div>
        <div class="e-r"><div class="e-p">+${fmtNum(entryPoints(card, e))} pts</div><button class="x" data-del="${e.id}">remover</button></div>
      </div>`).join('') : '<div class="empty">Nenhum lançamento. Lance o valor de cada fatura ou compra.</div>'}</div>
    <button class="btn danger" id="cd-del">Remover cartão</button>
  `, (el) => {
    drawBars($('#cd-bars', el), monthlyPoints(card));
    $('#cd-add', el).onclick = () => { closeSheet(); setTimeout(() => entryForm(card), 350); };
    $('#cd-edit', el).onclick = () => { closeSheet(); setTimeout(() => cardForm(card), 350); };
    el.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => {
      card.entries = card.entries.filter((e) => e.id !== b.dataset.del); save.cards(); renderCards();
      cardDetail(card);
    });
    $('#cd-del', el).onclick = () => removeCard(card);
  });
}

function entryForm(card) {
  let type = 'spend';
  openSheet(`
    <h3>Novo lançamento</h3>
    <p class="hint">${esc(card.name)} · ${fmtNum(card.ptsPerUsd, 1)} pt por US$ · dólar a ${fmtMoney(state.settings.usd)}</p>
    <div class="seg"><button class="on" data-t="spend">Gasto / fatura</button><button data-t="bonus">Bônus de pontos</button></div>
    <div class="field" id="w-amount"><label>Valor gasto (R$)</label><input id="e-amount" inputmode="decimal" placeholder="2.500,00"></div>
    <div class="field" id="w-points" style="display:none"><label>Pontos recebidos</label><input id="e-points" inputmode="numeric" placeholder="5000"></div>
    <div class="grid2">
      <div class="field"><label>Data</label><input id="e-date" type="date" value="${todayISO()}"></div>
      <div class="field" id="w-usd"><label>Dólar (R$)</label><input id="e-usd" inputmode="decimal" value="${String(state.settings.usd.toFixed(2)).replace('.', ',')}"></div>
    </div>
    <div class="field"><label>Descrição</label><input id="e-desc" placeholder="Fatura de outubro"></div>
    <div class="preview" id="e-preview">&nbsp;</div>
    <button class="btn" id="e-save">Lançar</button>
  `, (el) => {
    const preview = () => {
      if (type === 'bonus') { $('#e-preview', el).innerHTML = '&nbsp;'; return; }
      const a = numLoose($('#e-amount', el).value), u = numLoose($('#e-usd', el).value);
      $('#e-preview', el).innerHTML = a > 0 && u > 0
        ? `Gera <b>${fmtNum((a / u) * card.ptsPerUsd)} pontos</b> ≈ ${fmtNum((a / u) * card.ptsPerUsd * card.ratio)} milhas`
        : '&nbsp;';
    };
    $('#e-amount', el).oninput = preview; $('#e-usd', el).oninput = preview;
    $('#e-amount', el).focus();
    $('.seg', el).onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      type = b.dataset.t;
      el.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
      $('#w-amount', el).style.display = type === 'spend' ? '' : 'none';
      $('#w-usd', el).style.display = type === 'spend' ? '' : 'none';
      $('#w-points', el).style.display = type === 'bonus' ? '' : 'none';
      preview();
    };
    $('#e-save', el).onclick = () => {
      const date = $('#e-date', el).value || todayISO(), desc = $('#e-desc', el).value.trim();
      const entry = { id: uid(), type, date, desc, created: Date.now() };
      if (type === 'spend') {
        entry.amount = numLoose($('#e-amount', el).value); entry.usd = numLoose($('#e-usd', el).value);
        if (!(entry.amount > 0)) return toast('Informe o valor gasto');
        if (!(entry.usd > 0)) return toast('Informe a cotação do dólar');
      } else {
        entry.points = numLoose($('#e-points', el).value);
        if (!(entry.points > 0)) return toast('Informe os pontos');
      }
      card.entries.push(entry); save.cards(); renderCards();
      toast('+' + fmtNum(entryPoints(card, entry)) + ' pontos');
      closeSheet(); setTimeout(() => cardDetail(card), 350);
    };
  });
}

/* =========================================================
   Ajustes
   ========================================================= */
function settingsSheet() {
  const s = state.settings;
  openSheet(`
    <h3>Ajustes</h3>
    <p class="hint">Seus dados ficam salvos apenas neste aparelho.</p>
    <div class="field"><label>Cotação do dólar</label>
      <div class="seg"><button data-a="1" class="${s.usdAuto ? 'on' : ''}">Automática</button><button data-a="0" class="${s.usdAuto ? '' : 'on'}">Manual</button></div>
      <input id="s-usd" inputmode="decimal" value="${String(s.usd.toFixed(4)).replace('.', ',')}" ${s.usdAuto ? 'disabled' : ''}>
      <div class="help">Usada para converter gastos em pontos e ações americanas em reais.</div></div>
    <button class="btn" id="s-save">Salvar</button>
    <div class="section-head"><h2>Backup</h2></div>
    <p class="hint">Copie o texto abaixo para guardar seus dados, ou cole um backup e toque em Restaurar.</p>
    <div class="field"><textarea id="s-backup">${esc(JSON.stringify({ holdings: state.holdings, cards: state.cards }))}</textarea></div>
    <div class="btn-row"><button class="btn ghost" id="s-copy">Copiar</button><button class="btn ghost" id="s-restore">Restaurar</button></div>
  `, (el) => {
    let auto = s.usdAuto;
    $('.seg', el).onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      auto = b.dataset.a === '1';
      el.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
      $('#s-usd', el).disabled = auto;
    };
    $('#s-save', el).onclick = async () => {
      s.usdAuto = auto;
      if (!auto) { const v = numLoose($('#s-usd', el).value); if (!(v > 0)) return toast('Cotação inválida'); s.usd = v; }
      save.settings(); closeSheet();
      if (auto) await refreshUsd();
      renderCards(); renderStocks(); renderPortfolioChart(); toast('Ajustes salvos');
    };
    $('#s-copy', el).onclick = async () => {
      const ta = $('#s-backup', el);
      try { await navigator.clipboard.writeText(ta.value); } catch { ta.select(); document.execCommand('copy'); }
      toast('Backup copiado');
    };
    $('#s-restore', el).onclick = () => {
      try {
        const d = JSON.parse($('#s-backup', el).value);
        if (!Array.isArray(d.holdings) || !Array.isArray(d.cards)) throw 0;
        if (!confirm('Substituir os dados atuais pelo backup?')) return;
        state.holdings = d.holdings; state.cards = d.cards; save.holdings(); save.cards();
        closeSheet(); renderCards(); refreshQuotes(); toast('Backup restaurado');
      } catch { toast('Backup inválido'); }
    };
  });
}

/* =========================================================
   Ibovespa
   ========================================================= */
const IBOV = '^BVSP';
const INDICATORS = [
  { symbol: 'BRL=X', label: 'Dólar', sub: 'USD/BRL' },
  { symbol: 'EURBRL=X', label: 'Euro', sub: 'EUR/BRL' },
  { symbol: '^GSPC', label: 'S&P 500', sub: 'Bolsa dos EUA' },
  { symbol: 'BTC-BRL', label: 'Bitcoin', sub: 'BTC/BRL' },
];
// ações mais negociadas do índice (usadas para altas e baixas do dia)
const IBOV_STOCKS = ['PETR4', 'VALE3', 'ITUB4', 'BBDC4', 'BBAS3', 'B3SA3', 'ABEV3', 'WEGE3', 'ITSA4', 'BPAC11',
  'SUZB3', 'RENT3', 'RADL3', 'EQTL3', 'PRIO3', 'RDOR3', 'GGBR4', 'JBSS3', 'VBBR3', 'RAIL3', 'CSAN3', 'HAPV3',
  'LREN3', 'MGLU3', 'EMBR3', 'CMIG4', 'SBSP3', 'TIMS3', 'VIVT3', 'KLBN11', 'TOTS3', 'CYRE3', 'BBSE3', 'UGPA3'].map((s) => s + '.SA');

const isIndex = (s) => s.startsWith('^');
const isStock = (s) => !isIndex(s) && !s.includes('=') && !s.includes('-');
const fmtQuote = (v, symbol, cur) => (isIndex(symbol) ? fmtNum(v, v > 9999 ? 0 : 2) + ' pts' : fmtMoney(v, cur || 'BRL'));
const dayChange = (d) => {
  const p = d.points, prev = d.prevClose ?? (p.length > 1 ? p[p.length - 2].v : d.price);
  return { diff: d.price - prev, pct: prev ? ((d.price - prev) / prev) * 100 : 0, prev };
};

function quoteRow(symbol, title, sub, d) {
  const c = d ? dailyFromSeries(d) : null;
  return `<button class="row" data-q="${esc(symbol)}" data-title="${esc(title)}">
    <div><div class="sym">${esc(title)}</div><div class="sub">${esc(sub)}</div></div>
    <canvas data-qspark="${esc(symbol)}"></canvas>
    <div class="right"><div class="price">${d ? fmtQuote(d.price, symbol, d.currency) : '—'}</div>
      <div class="chg ${c ? tone(c.pct) : ''}">${c ? arrow(c.pct) + ' ' + fmtPct(c.pct) : ''}</div></div>
  </button>`;
}
// variação do dia a partir da série diária de 1 mês
const dailyFromSeries = (d) => {
  const p = d.points; if (p.length < 2) return null;
  const prev = p[p.length - 2].v; return { pct: ((d.price - prev) / prev) * 100 };
};
function paintSparks(container, series) {
  container.querySelectorAll('canvas[data-qspark]').forEach((c) => {
    const d = series[c.dataset.qspark]; if (d) drawLine(c, d.points, { spark: true });
  });
}

let ibovRange = '1D', ibovReq = 0;
async function renderIbov() {
  $('#ibov-ranges').innerHTML = Object.keys(RANGES).map((k) => `<button data-r="${k}" class="${k === ibovRange ? 'on' : ''}">${k}</button>`).join('');
  const req = ++ibovReq;
  const canvas = $('#ibov-chart'), wrap = canvas.parentElement;
  try {
    const [today, d] = await Promise.all([fetchSeries(IBOV, '1D'), fetchSeries(IBOV, ibovRange)]);
    if (req !== ibovReq) return;
    const ch = dayChange(today);
    const heroDefault = () => {
      $('#ibov-label').textContent = 'Ibovespa · B3' + (today.offline ? ' · offline' : '');
      $('#ibov-value').innerHTML = `${fmtNum(today.price, 0)}<small class="suf">pts</small>`;
      $('#ibov-delta').innerHTML = `<b class="${tone(ch.diff)}">${arrow(ch.diff)} ${fmtNum(Math.abs(ch.diff), 0)} pts · ${fmtPct(ch.pct)}</b> hoje`;
    };
    heroDefault();
    wrap.classList.toggle('empty', d.points.length < 2);
    const intraday = ibovRange === '1D';
    drawLine(canvas, d.points, { format: (v) => fmtNum(v, 0), intraday, base: intraday ? ch.prev : undefined });
    makeScrubbable(canvas, (p, all) => {
      const base = intraday ? ch.prev : all[0].v, diff = p.v - base;
      $('#ibov-label').textContent = intraday ? 'Hoje às ' + fmtTime(p.t) : fmtDate(p.t);
      $('#ibov-value').innerHTML = `${fmtNum(p.v, 0)}<small class="suf">pts</small>`;
      $('#ibov-delta').innerHTML = `<b class="${tone(diff)}">${arrow(diff)} ${fmtNum(Math.abs(diff), 0)} pts · ${fmtPct((diff / base) * 100)}</b> ${intraday ? 'no dia' : 'no período'}`;
    }, heroDefault);
    const pts = d.points.map((p) => p.v);
    const st = (v) => (v == null ? '—' : fmtNum(v, 0));
    $('#ibov-stats').innerHTML = `
      <div class="stat"><div class="k">Máxima do dia</div><div class="v">${st(today.dayHigh)}</div></div>
      <div class="stat"><div class="k">Mínima do dia</div><div class="v">${st(today.dayLow)}</div></div>
      <div class="stat"><div class="k">${intraday ? 'Máx. 52 semanas' : 'Máx. no período'}</div><div class="v">${st(intraday ? today.high52 : Math.max(...pts))}</div></div>
      <div class="stat"><div class="k">${intraday ? 'Mín. 52 semanas' : 'Mín. no período'}</div><div class="v">${st(intraday ? today.low52 : Math.min(...pts))}</div></div>`;
  } catch {
    if (req !== ibovReq) return;
    wrap.classList.add('empty');
    $('#ibov-empty').textContent = 'Não foi possível carregar o Ibovespa. Verifique a conexão.';
  }
  renderIndicators();
  renderMovers();
}

async function renderIndicators() {
  const el = $('#ibov-indicators');
  if (!el.children.length) el.innerHTML = skeleton(INDICATORS.length);
  const series = {};
  await Promise.all(INDICATORS.map((i) => fetchSeries(i.symbol, '1M').then((d) => (series[i.symbol] = d)).catch(() => {})));
  el.innerHTML = INDICATORS.map((i) => quoteRow(i.symbol, i.label, i.sub, series[i.symbol])).join('');
  paintSparks(el, series);
}

async function renderMovers() {
  $('#movers-status').innerHTML = '<span class="spin"></span>';
  if (!$('#ibov-up').children.length) { $('#ibov-up').innerHTML = skeleton(5); $('#ibov-down').innerHTML = skeleton(5); }
  const series = {};
  await Promise.all(IBOV_STOCKS.map((s) => fetchSeries(s, '1M').then((d) => (series[s] = d)).catch(() => {})));
  const ranked = Object.entries(series)
    .map(([s, d]) => ({ s, d, c: dailyFromSeries(d) })).filter((x) => x.c)
    .sort((a, b) => b.c.pct - a.c.pct);
  $('#movers-status').textContent = ranked.length ? '' : 'sem dados';
  const row = (x) => quoteRow(x.s, display(x.s), (x.d.name || '').replace(/\s{2,}.*/, '') || 'B3', x.d);
  $('#ibov-up').innerHTML = ranked.slice(0, 5).map(row).join('') || '<div class="entries"><div class="empty">Sem dados agora.</div></div>';
  $('#ibov-down').innerHTML = ranked.slice(-5).reverse().map(row).join('') || '';
  paintSparks($('#ibov-up'), series); paintSparks($('#ibov-down'), series);
}

/* ---------- Cotação de qualquer ativo (índices, moedas, ações fora da carteira) ---------- */
function quoteSheet(symbol, title) {
  let rangeKey = '1D';
  const held = state.holdings.find((h) => h.symbol === symbol);
  const action = held ? '<button class="btn ghost" id="q-act">Ver minha posição</button>'
    : isStock(symbol) ? '<button class="btn" id="q-act">+ Adicionar à carteira</button>' : '';
  openSheet(`
    <div class="eyebrow" id="q-name">&nbsp;</div>
    <h3>${esc(title || display(symbol))}</h3>
    <div class="label" id="q-label">Agora</div>
    <div class="big" id="q-price">—</div>
    <div class="delta" id="q-delta">&nbsp;</div>
    <div class="chart-wrap empty"><canvas id="q-chart"></canvas><div class="chart-empty">Carregando…</div></div>
    <div class="ranges" id="q-ranges"></div>
    <div class="stats" id="q-stats"></div>
    ${action}
  `, (el) => {
    const canvas = $('#q-chart', el), wrap = canvas.parentElement;
    const load = async () => {
      $('#q-ranges', el).innerHTML = Object.keys(RANGES).map((k) => `<button data-r="${k}" class="${k === rangeKey ? 'on' : ''}">${k}</button>`).join('');
      try {
        const [today, d] = await Promise.all([fetchSeries(symbol, '1D'), fetchSeries(symbol, rangeKey)]);
        const cur = d.currency, ch = dayChange(today), intraday = rangeKey === '1D';
        $('#q-name', el).textContent = today.name || '';
        const def = () => {
          $('#q-label', el).textContent = 'Agora';
          $('#q-price', el).textContent = fmtQuote(today.price, symbol, cur);
          $('#q-delta', el).innerHTML = `<b class="${tone(ch.diff)}">${arrow(ch.diff)} ${fmtQuote(Math.abs(ch.diff), symbol, cur)} · ${fmtPct(ch.pct)}</b> hoje`;
        };
        def();
        wrap.classList.toggle('empty', d.points.length < 2);
        drawLine(canvas, d.points, { format: (v) => fmtNum(v, v > 999 ? 0 : 2), intraday, base: intraday ? ch.prev : undefined });
        makeScrubbable(canvas, (p, all) => {
          const base = intraday ? ch.prev : all[0].v, diff = p.v - base;
          $('#q-label', el).textContent = intraday ? 'Hoje às ' + fmtTime(p.t) : fmtDate(p.t);
          $('#q-price', el).textContent = fmtQuote(p.v, symbol, cur);
          $('#q-delta', el).innerHTML = `<b class="${tone(diff)}">${arrow(diff)} ${fmtQuote(Math.abs(diff), symbol, cur)} · ${fmtPct((diff / base) * 100)}</b>`;
        }, def);
        const st = (v) => (v == null ? '—' : fmtQuote(v, symbol, cur));
        $('#q-stats', el).innerHTML = `
          <div class="stat"><div class="k">Máxima do dia</div><div class="v">${st(today.dayHigh)}</div></div>
          <div class="stat"><div class="k">Mínima do dia</div><div class="v">${st(today.dayLow)}</div></div>
          <div class="stat"><div class="k">Máx. 52 semanas</div><div class="v">${st(today.high52)}</div></div>
          <div class="stat"><div class="k">Mín. 52 semanas</div><div class="v">${st(today.low52)}</div></div>`;
      } catch {
        $('.chart-empty', wrap).textContent = 'Sem dados agora.';
      }
    };
    $('#q-ranges', el).onclick = (e) => { const b = e.target.closest('button'); if (b) { rangeKey = b.dataset.r; load(); } };
    const act = $('#q-act', el);
    if (act) act.onclick = () => {
      closeSheet();
      setTimeout(() => (held ? stockDetail(held) : stockForm(null, display(symbol))), 350);
    };
    load();
  });
}

/* =========================================================
   Notícias
   ========================================================= */
const MARKET_QUERY = 'Ibovespa OR "bolsa brasileira" OR "mercado financeiro"';
let newsFeed = 'mine', newsFilter = 'all';

async function fetchNews(query) {
  const key = 'news.' + query;
  const hit = memCache[key];
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query + ' when:3d')}&hl=pt-BR&gl=BR&ceid=BR:pt-419`;
  try {
    const xml = await httpGetText(url);
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const items = [...doc.querySelectorAll('item')].map((it) => {
      const get = (sel) => (it.querySelector(sel) || {}).textContent || '';
      const source = get('source');
      let title = get('title');
      if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
      return { title, link: get('link'), source, t: Date.parse(get('pubDate')) || 0 };
    }).filter((i) => i.title && i.link);
    memCache[key] = { at: Date.now(), data: items };
    store.set(key, items);
    return items;
  } catch (e) {
    const offline = store.get(key, null);
    if (offline) return offline;
    throw e;
  }
}

function relTime(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'agora';
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `há ${h} h`;
  return h < 48 ? 'ontem' : fmtDate(t, { day: '2-digit', month: 'short' });
}

let newsReq = 0;
async function renderNews() {
  renderAlertCard();
  $('#news-seg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.feed === newsFeed));
  const list = $('#news-list'), chips = $('#news-chips');
  const tickers = state.holdings.map((h) => display(h.symbol));
  chips.innerHTML = newsFeed === 'mine' && tickers.length > 1
    ? ['all', ...tickers].map((t) => `<button data-f="${esc(t)}" class="${t === newsFilter ? 'on' : ''}">${t === 'all' ? 'Todas' : esc(t)}</button>`).join('')
    : '';
  if (newsFeed === 'mine' && !tickers.length) {
    list.innerHTML = `<div class="empty-state"><strong>Sem ações na carteira</strong>Adicione ações na aba Ações para ver as notícias delas aqui.</div>`;
    return;
  }
  const req = ++newsReq;
  if (!list.querySelector('.news-item')) list.innerHTML = skeleton(5);
  let items = [];
  if (newsFeed === 'mine') {
    const wanted = newsFilter === 'all' || !tickers.includes(newsFilter) ? tickers : [newsFilter];
    const res = await Promise.all(wanted.map((t) => fetchNews(t).then((l) => l.map((i) => ({ ...i, tag: t }))).catch(() => [])));
    const seen = new Set();
    items = res.flat().sort((a, b) => b.t - a.t).filter((i) => {
      const k = i.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true;
    }).slice(0, 60);
  } else {
    items = await fetchNews(MARKET_QUERY).catch(() => []);
    items = items.sort((a, b) => b.t - a.t).slice(0, 50);
  }
  if (req !== newsReq) return;
  const lastSeen = state.settings.newsSeenAt || 0;
  list.innerHTML = items.length ? items.map((i) => `
    <a class="news-item ${i.t > lastSeen && lastSeen ? 'fresh' : ''}" href="${esc(i.link)}" target="_blank" rel="noopener">
      <div class="n-meta">${i.tag ? `<span class="badge solid">${esc(i.tag)}</span>` : ''}<span>${esc(i.source)}</span><span>·</span><span>${relTime(i.t)}</span></div>
      <div class="n-title">${esc(i.title)}</div>
    </a>`).join('')
    : '<div class="empty-state"><strong>Nada por aqui</strong>Não encontramos notícias recentes. Verifique a conexão e tente de novo.</div>';
  state.settings.newsSeenAt = Date.now(); save.settings();
}

/* ---------- Alertas no celular (verificação nativa em segundo plano) ---------- */
const alertsPlugin = () => (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NewsAlerts) || null;

async function syncAlerts() {
  const p = alertsPlugin(); if (!p) return;
  try {
    await p.configure({
      news: !!state.settings.alerts,
      provents: !!state.settings.provAlerts,
      holdings: state.holdings.map((h) => ({ ticker: display(h.symbol), qty: h.qty, b3: /\.SA$/.test(h.symbol) })),
    });
  } catch {}
}

function renderAlertCard() {
  const native = !!alertsPlugin();
  document.querySelectorAll('[data-alert]').forEach((b) =>
    b.setAttribute('aria-checked', String(native && !!state.settings[b.dataset.alert])));
  const tickers = state.holdings.map((h) => display(h.symbol));
  const any = state.settings.alerts || state.settings.provAlerts;
  $('#alert-sub').textContent = !native ? 'Disponível no app instalado no celular.'
    : !tickers.length ? 'Adicione ações à carteira para receber alertas.'
    : any ? `Ativo para ${tickers.join(', ')}. O celular confere a cada ~5 min, mesmo com o app fechado.`
    : 'Avisos mesmo com o app fechado.';
}

const ALERT_NAMES = { alerts: 'Alertas de notícias', provAlerts: 'Avisos de proventos' };
async function toggleAlert(key) {
  const p = alertsPlugin();
  if (!p) return toast('Funciona no app instalado no celular');
  if (!state.settings[key]) {
    if (!state.holdings.length) return toast('Adicione ações à carteira primeiro');
    try {
      const r = await p.requestNotifications();
      if (!r || !r.granted) return toast('Permita as notificações do app nas configurações do Android');
    } catch { return toast('Não foi possível pedir permissão'); }
    state.settings[key] = true; save.settings(); await syncAlerts();
    try { await p.checkNow(); } catch {}
    toast(ALERT_NAMES[key] + ' ativados');
  } else {
    state.settings[key] = false; save.settings(); await syncAlerts();
    toast(ALERT_NAMES[key] + ' desativados');
  }
  renderAlertCard();
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-alert]'); if (b) toggleAlert(b.dataset.alert);
});
$('#news-seg').onclick = (e) => {
  const b = e.target.closest('button'); if (!b || b.dataset.feed === newsFeed) return;
  newsFeed = b.dataset.feed; $('#news-list').innerHTML = ''; renderNews();
};
$('#news-chips').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  newsFilter = b.dataset.f; $('#news-list').innerHTML = ''; renderNews();
};

/* =========================================================
   Navegação & eventos
   ========================================================= */
const TITLES = { stocks: 'Carteira', ibov: 'Ibovespa', news: 'Notícias', cards: 'Cartões' };
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  $('#title').textContent = TITLES[name];
  window.scrollTo({ top: 0 });
  if (name === 'stocks') requestAnimationFrame(() => { renderStocks(); renderPortfolioChart(); });
  if (name === 'ibov') requestAnimationFrame(renderIbov);
  if (name === 'news') renderNews();
}
$('#ibov-ranges').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  ibovRange = b.dataset.r; renderIbov();
};
$('#tab-ibov').addEventListener('click', (e) => {
  const r = e.target.closest('.row[data-q]'); if (r) quoteSheet(r.dataset.q, r.dataset.title);
});

document.querySelectorAll('.tab-btn').forEach((b) => b.onclick = () => switchTab(b.dataset.tab));
$('#btn-add-stock').onclick = () => stockForm();
$('#btn-add-card').onclick = () => cardForm();
$('#btn-settings').onclick = settingsSheet;
$('#stock-list').onclick = (e) => {
  const r = e.target.closest('.row'); if (!r) return;
  const h = state.holdings.find((x) => x.id === r.dataset.id); if (h) stockDetail(h);
};
$('#card-list').onclick = (e) => {
  const c = e.target.closest('[data-card]'); if (!c) return;
  const card = state.cards.find((x) => x.id === c.dataset.card); if (card) cardDetail(card);
};
$('#portfolio-ranges').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.settings.range = b.dataset.range; save.settings(); renderPortfolioChart();
};
let resizeT;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => document.querySelectorAll('canvas').forEach((c) => c._chart && drawLine(c, c._chart.points, c._chart.opts)), 150);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshQuotes(); });

function greet() {
  const now = new Date(), h = now.getHours();
  const hello = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
  const day = now.toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '');
  $('#greeting').textContent = `${hello} · ${day}`;
}
window.addEventListener('scroll', () => $('.top').classList.toggle('compact', window.scrollY > 24), { passive: true });

(async function init() {
  greet();
  try {
    const SB = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.StatusBar;
    if (SB) { SB.setStyle({ style: 'DARK' }); SB.setBackgroundColor({ color: '#0a0a0a' }); }
  } catch {}
  renderStocks(); renderCards(); renderPortfolioChart();
  syncAlerts(); renderAlertCard();
  await refreshUsd();
  renderCards();
  refreshQuotes();
})();
