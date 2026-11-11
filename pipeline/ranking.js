#!/usr/bin/env node
'use strict';
/* =========================================================
   Ranking do Termômetro
   Calcula as notas de compra e venda de todas as ações com dados
   da CVM, usando o MESMO código do app (www/thermo.js) e o preço de
   fechamento do Yahoo Finance. Gera data/ranking.json, que a aba
   Termômetro lê para mostrar as melhores notas.

   Uso: node pipeline/ranking.js [--data data/fundamentos] [--out data/ranking.json]
   ========================================================= */
const fs = require('fs');
const path = require('path');
const Thermo = require('../www/thermo.js');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const DATA = arg('--data', 'data/fundamentos');
const OUT = arg('--out', 'data/ranking.json');
const LIMIT = +arg('--limit', 0); // só para testes
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// série semanal de 5 anos (a mesma do app) + preço atual + volume
async function yahoo(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}.SA?range=5y&interval=1wk&includePrePost=false`;
  for (let tent = 0; tent < 4; tent++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (res.status === 429 || res.status >= 500) { await sleep(2000 * (tent + 1)); continue; }
      if (!res.ok) return null;
      const j = await res.json();
      const r = j && j.chart && j.chart.result && j.chart.result[0];
      if (!r || !r.meta || !r.meta.regularMarketPrice) return null;
      const q = (r.indicators.quote[0]) || {};
      const pts = [], vols = [];
      (r.timestamp || []).forEach((t, i) => {
        if (q.close && q.close[i] != null) {
          pts.push({ t: t * 1000, v: q.close[i] });
          vols.push((q.volume && q.volume[i]) || 0);
        }
      });
      // volume financeiro médio por dia nas últimas 13 semanas
      const n = Math.min(13, pts.length);
      let fin = 0;
      for (let i = pts.length - n; i < pts.length; i++) fin += vols[i] * pts[i].v;
      return { price: r.meta.regularMarketPrice, time: r.meta.regularMarketTime, history: pts, liq: n ? fin / (n * 5) : 0 };
    } catch { await sleep(1500 * (tent + 1)); }
  }
  return null;
}

// último fechamento de cada ano (é só isso que o termômetro usa do histórico)
function yearEnd(history) {
  const last = {};
  for (const pt of history) {
    const yr = new Date(pt.t).getUTCFullYear();
    if (!last[yr] || pt.t > last[yr].t) last[yr] = pt;
  }
  return Object.fromEntries(Object.entries(last).map(([yr, pt]) => [yr, +pt.v.toFixed(2)]));
}
// mesma função no app: reconstrói a "série" a partir dos fechamentos anuais
const yeHistory = (ye) => Object.entries(ye || {}).map(([yr, v]) => ({ t: Date.UTC(+yr, 11, 15), v }));

async function main() {
  let index = JSON.parse(fs.readFileSync(path.join(DATA, 'index.json'), 'utf8')).tickers || [];
  if (LIMIT) index = index.slice(0, LIMIT);
  const rows = [];
  let lastTime = 0, falhas = 0, i = 0;

  // 4 consultas por vez, com uma pausa curta, para não sobrecarregar o Yahoo
  async function worker() {
    while (i < index.length) {
      const it = index[i++];
      if (i % 50 === 0) console.log(`  ${i}/${index.length}…`);
      let doc;
      try { doc = JSON.parse(fs.readFileSync(path.join(DATA, it.t + '.json'), 'utf8')); } catch { continue; }
      if (!doc.anos || !doc.anos.length) continue;
      const y = await yahoo(it.t);
      await sleep(150);
      if (!y) { falhas++; continue; }
      try {
        // o app refaz a análise com exatamente estes valores publicados (p e ye),
        // então a nota calculada aqui é a mesma que aparece ao abrir a ação
        const p = +y.price.toFixed(2);
        const ye = yearEnd(y.history);
        const a = Thermo.analyzeData(it.t, doc, p, yeHistory(ye));
        if (a.buy.score == null && a.sell.score == null) continue;
        lastTime = Math.max(lastTime, y.time || 0);
        rows.push({
          t: it.t, n: it.n, s: it.s, cnpj: doc.cnpj,
          p, ye, liq: Math.round(y.liq),
          b: a.buy.score, bc: a.buy.coverage, v: a.sell.score, vc: a.sell.coverage,
          r: a.verdict.key, pf: a.profileLabel,
        });
      } catch (e) { falhas++; }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);

  // uma ação por empresa: fica a mais negociada (ex.: PETR4 em vez de PETR3)
  const byCompany = {};
  for (const r of rows) {
    const k = r.cnpj || r.t;
    if (!byCompany[k] || r.liq > byCompany[k].liq) byCompany[k] = r;
  }
  const list = Object.values(byCompany).map(({ cnpj, ...r }) => r).sort((a, b) => a.t.localeCompare(b.t));

  const out = {
    precos: lastTime ? new Date((lastTime - 3 * 3600) * 1000).toISOString().slice(0, 10) : null,
    fonte: 'CVM (demonstrações) e Yahoo Finance (preço de fechamento)',
    acoes: list,
  };
  console.log(`Ranking: ${list.length} empresas (${rows.length} tickers analisados, ${falhas} sem preço). Preços de ${out.precos}.`);
  // se o Yahoo falhar, mantém o ranking anterior em vez de gravar um arquivo vazio
  if (list.length < 50 && !LIMIT) { console.error('Poucas ações analisadas — ranking anterior mantido.'); return; }
  fs.writeFileSync(OUT, JSON.stringify(out));
}

main();
