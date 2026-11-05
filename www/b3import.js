'use strict';
/* =========================================================
   Importação da carteira pelos relatórios da Área do Investidor (B3)
   - Posição: quantidade de cada ativo (todas as corretoras)
   - Negociação: compras e vendas com preço -> preço médio
   - Movimentação: liquidações e eventos (desdobro, grupamento,
     bonificação) -> preço médio
   As abas são reconhecidas pelos nomes das colunas, não pela posição.
   ========================================================= */
(function (root) {

  const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const TICKER = /^[A-Z]{4}\d{1,2}$/;

  function toTicker(v) {
    const m = /^\s*([A-Za-z]{4}\d{1,2})F?\b/.exec(String(v ?? '')); // "PETR4", "PETR4F", "PETR4 - PETROBRAS"
    const t = m ? m[1].toUpperCase() : null;
    return t && TICKER.test(t) ? t : null;
  }

  function toNum(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    let s = String(v ?? '').replace(/R\$|\s/g, '');
    if (!s || s === '-') return null;
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(s);
    return isFinite(n) ? n : null;
  }

  // "05/11/2026" ou número de série do Excel -> timestamp
  function toDate(v) {
    if (typeof v === 'number') return Math.round((v - 25569) * 864e5);
    const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(v ?? ''));
    return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : null;
  }

  // encontra a linha de cabeçalho e devolve { header: {nome: índice}, start }
  function findHeader(rows) {
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const cells = (rows[i] || []).map(norm);
      if (cells.some((c) => c.startsWith('quantidade')) && cells.some((c) => /codigo de negociacao|^produto$|^ativo$/.test(c))) {
        const header = {};
        cells.forEach((c, j) => { if (c && !(c in header)) header[c] = j; });
        return { header, start: i + 1 };
      }
    }
    return null;
  }
  const col = (header, ...names) => { for (const n of names) if (n in header) return header[n]; return -1; };

  function kindOf(header) {
    if ('tipo de movimentacao' in header && 'preco' in header) return 'negociacao';
    if ('entrada/saida' in header && 'movimentacao' in header) return 'movimentacao';
    if ('quantidade' in header) return 'posicao';
    return null;
  }

  /** workbooks: [{ file, sheets: {aba: linhas} }] */
  function parse(workbooks) {
    const positions = {};   // ticker -> { qty, close, sheet }
    const events = [];      // { t, ticker, kind, qty, price }
    const found = [];       // relatórios reconhecidos
    for (const { file, sheets } of workbooks) {
      for (const [sheet, rows] of Object.entries(sheets)) {
        const h = findHeader(rows);
        if (!h) continue;
        const kind = kindOf(h.header);
        if (!kind) continue;
        const H = h.header;
        const cTicker = col(H, 'codigo de negociacao', 'produto', 'ativo');
        const cProduto = col(H, 'produto');
        const cQty = col(H, 'quantidade');
        let n = 0;
        for (const row of rows.slice(h.start)) {
          if (!row) continue;
          const ticker = toTicker(row[cTicker]) || (cProduto >= 0 ? toTicker(row[cProduto]) : null);
          const qty = toNum(row[cQty]);
          if (!ticker || !qty) continue;
          if (kind === 'posicao') {
            const p = positions[ticker] || (positions[ticker] = { qty: 0, close: null, sheet });
            p.qty += qty;
            p.close = toNum(row[col(H, 'preco de fechamento')]) ?? p.close;
          } else if (kind === 'negociacao') {
            const side = norm(row[col(H, 'tipo de movimentacao')]);
            const kindEv = side.startsWith('compra') ? 'buy' : side.startsWith('venda') ? 'sell' : null;
            if (!kindEv) continue;
            events.push({ t: toDate(row[col(H, 'data do negocio', 'data')]), ticker, kind: kindEv, qty, price: toNum(row[col(H, 'preco')]), src: 'negociacao' });
          } else {
            const io = norm(row[col(H, 'entrada/saida')]);
            const mov = norm(row[col(H, 'movimentacao')]);
            const credit = io.startsWith('credito');
            const price = toNum(row[col(H, 'preco unitario')]);
            let kindEv = null;
            if (/transferencia - liquidacao/.test(mov)) kindEv = credit ? 'buy' : 'sell';
            else if (/desdobro/.test(mov)) kindEv = 'split';
            else if (/grupamento/.test(mov)) kindEv = credit ? 'reverse-in' : 'reverse-out';
            else if (/bonificacao em ativos/.test(mov)) kindEv = 'bonus';
            else if (/leilao de fracao|fracao em ativos/.test(mov) && !credit) kindEv = 'sell';
            if (!kindEv) continue;
            events.push({ t: toDate(row[col(H, 'data')]), ticker, kind: kindEv, qty, price, src: 'movimentacao' });
          }
          n++;
        }
        if (n) found.push({ file, sheet, kind, rows: n });
      }
    }

    // preço médio pelos eventos, em ordem cronológica.
    // Se houver os dois extratos, usa só a negociação (evita contar a mesma compra duas vezes).
    const hasNeg = events.some((e) => e.src === 'negociacao');
    const evs = events.filter((e) => !hasNeg || e.src === 'negociacao').sort((a, b) => (a.t || 0) - (b.t || 0));
    const book = {}; // ticker -> { qty, cost }
    for (const e of evs) {
      const b = book[e.ticker] || (book[e.ticker] = { qty: 0, cost: 0 });
      if (e.kind === 'buy' && e.price != null) { b.qty += e.qty; b.cost += e.qty * e.price; }
      else if (e.kind === 'sell') {
        const avg = b.qty ? b.cost / b.qty : 0;
        b.qty = Math.max(0, b.qty - e.qty); b.cost = avg * b.qty;
      } else if (e.kind === 'split' || e.kind === 'reverse-in') b.qty += e.qty;      // custo total igual
      else if (e.kind === 'reverse-out') b.qty = Math.max(0, b.qty - e.qty);
      else if (e.kind === 'bonus') { b.qty += e.qty; b.cost += e.qty * (e.price || 0); } // custo atribuído, se informado
    }
    const avgs = {};
    for (const [t, b] of Object.entries(book)) {
      if (b.qty > 0) avgs[t] = { avg: b.cost / b.qty, qty: b.qty };
    }
    return { positions, avgs, found, hasTrades: evs.length > 0 };
  }

  /**
   * Monta o plano de importação comparando com a carteira atual.
   * O preço médio do extrato só é usado quando a quantidade que ele explica
   * bate com a posição (senão o extrato cobre só parte do histórico).
   */
  function plan(parsed, holdings, { removeMissing = false } = {}) {
    const bySym = Object.fromEntries(holdings.map((h) => [h.symbol, h]));
    const items = [];
    for (const [t, p] of Object.entries(parsed.positions)) {
      const sym = t + '.SA', cur = bySym[sym], a = parsed.avgs[t];
      const consistent = a && Math.abs(a.qty - p.qty) < 1e-6;
      let avg = cur ? cur.avg : null, avgSrc = cur && cur.avg != null ? 'atual' : 'sem';
      if (consistent) { avg = a.avg; avgSrc = 'extrato'; }
      const partial = !!a && !consistent;
      const action = !cur ? 'novo' : Math.abs(cur.qty - p.qty) > 1e-6 || (consistent && Math.abs((cur.avg ?? -1) - a.avg) > 0.005) ? 'atualizar' : 'igual';
      items.push({ ticker: t, symbol: sym, qty: p.qty, oldQty: cur ? cur.qty : null, avg, oldAvg: cur ? cur.avg : null, avgSrc, partial, action, sheet: p.sheet });
    }
    for (const h of holdings) {
      if (!/\.SA$/.test(h.symbol)) continue; // ativos de fora da B3 nunca são tocados
      const t = h.symbol.replace(/\.SA$/, '');
      if (!parsed.positions[t]) items.push({ ticker: t, symbol: h.symbol, qty: 0, oldQty: h.qty, avg: h.avg, oldAvg: h.avg, action: removeMissing ? 'remover' : 'manter' });
    }
    const order = { novo: 0, atualizar: 1, remover: 2, igual: 3, manter: 4 };
    items.sort((a, b) => order[a.action] - order[b.action] || a.ticker.localeCompare(b.ticker));
    return items;
  }

  const api = { parse, plan, toTicker, toNum, toDate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.B3Import = api;
})(typeof window !== 'undefined' ? window : globalThis);
