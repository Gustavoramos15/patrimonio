'use strict';
/* =========================================================
   Termômetro — motor de análise fundamentalista
   Dados: demonstrações oficiais da CVM (DFP/ITR, processadas diariamente
   no GitHub em data/fundamentos/<TICKER>.json) + cotação do Yahoo.
   Os indicadores são calculados aqui a partir das contas oficiais e do
   preço atual. Critério sem dado fica indisponível e sai da conta — nada
   é estimado "de cabeça". Funciona no app e no Node (para testes).
   ========================================================= */
(function (root) {

  const DATA_URL = 'https://raw.githubusercontent.com/Gustavoramos15/patrimonio/main/data/fundamentos/';

  /* ---------- utilidades ---------- */
  // interpolação linear por pontos [[x, nota], ...] (x crescente), com limites nas pontas
  function interp(x, pts) {
    if (x == null || !isFinite(x)) return null;
    if (x <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
    return pts[pts.length - 1][1];
  }
  const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  const median = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y), m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const ok = (v) => v != null && isFinite(v);
  const div = (a, b) => (ok(a) && ok(b) && b !== 0 ? a / b : null);
  const f = (v, d = 1) => (v == null ? '—' : v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const pct = (v, d = 1) => (v == null ? '—' : f(v, d) + '%');
  const money = (v) => (v == null ? '—' : 'R$ ' + f(v, 2));
  const bi = (v) => (v == null ? '—' : 'R$ ' + f(v / 1e9, 2) + ' bi');
  const signed = (v, d = 1, suf = '%') => (v == null ? '—' : (v > 0 ? '+' : '') + f(v, d) + suf);

  /* ---------- perfis por setor ----------
     Cada perfil define faixas (valor -> nota de compra) e pesos.
     Peso 0 = critério não se aplica ao setor.                          */
  const BASE = {
    pl: [[0, 0], [0.01, 100], [6, 100], [10, 75], [15, 50], [25, 15], [35, 0]],
    pvp: [[0, 0], [0.01, 100], [1, 100], [1.5, 75], [3, 40], [5, 10], [8, 0]],
    evebitda: [[0, 0], [0.01, 100], [4, 100], [6, 75], [9, 45], [13, 15], [18, 0]],
    roe: [[0, 0], [5, 20], [10, 50], [15, 80], [20, 100]],
    roic: [[0, 0], [2, 10], [6, 40], [10, 70], [15, 100]],
    margem: [[0, 0], [5, 40], [10, 75], [15, 100]],
    cagrRec: [[-5, 0], [0, 30], [5, 55], [10, 80], [15, 100]],
    cagrLuc: [[-10, 0], [0, 30], [5, 55], [10, 80], [15, 100]],
    divida: [[0, 100], [1, 85], [2, 60], [3, 30], [4, 0]],
    fcfYield: [[-1, 0], [0, 20], [3, 45], [6, 75], [10, 100]],
    dy: [[0, 0], [2, 25], [4, 55], [6, 80], [8, 100]],
    payout: [[50, 10], [60, 40], [80, 70], [100, 100]],
  };
  const PROFILES = {
    geral: {
      label: 'Empresas em geral', fair: ['graham', 'bazin', 'hist'],
      w: { pl: 1, pvp: 1, evebitda: 1, roe: 1, roic: 1, margem: 1, cagrRec: 1, cagrLuc: 1, divida: 1, fcf: 1, dy: 1, divHist: 0.7, fair: 1.5, hist: 1 },
    },
    banco: {
      label: 'Bancos e financeiras', fair: ['graham', 'bazin', 'hist'],
      note: 'Para bancos não se usa EV/EBITDA, ROIC, dívida/EBITDA nem fluxo de caixa livre: o "produto" do banco é o próprio dinheiro.',
      bands: {
        pl: [[0, 0], [0.01, 100], [6, 100], [9, 70], [12, 40], [16, 10], [20, 0]],
        pvp: [[0, 0], [0.01, 100], [0.8, 100], [1.2, 75], [2, 40], [3, 10], [4, 0]],
        roe: [[0, 0], [8, 20], [12, 50], [15, 75], [20, 100]],
        payout: [[60, 10], [75, 40], [90, 70], [110, 100]],
      },
      w: { pl: 1.5, pvp: 1.5, evebitda: 0, roe: 2, roic: 0, margem: 0, cagrRec: 0.5, cagrLuc: 1, divida: 0, fcf: 0, dy: 1.5, divHist: 1, fair: 1.5, hist: 1 },
    },
    seguradora: {
      label: 'Seguradoras', fair: ['graham', 'bazin', 'hist'],
      note: 'Seguradoras são avaliadas como financeiras: P/L, P/VP, ROE e dividendos pesam mais.',
      bands: {
        pl: [[0, 0], [0.01, 100], [7, 100], [10, 70], [14, 40], [18, 10], [22, 0]],
        pvp: [[0, 0], [0.01, 100], [1.5, 100], [2.5, 70], [4, 40], [6, 10]],
        roe: [[0, 0], [10, 20], [15, 50], [20, 75], [30, 100]],
        payout: [[70, 10], [85, 40], [100, 70], [120, 100]],
      },
      w: { pl: 1.5, pvp: 1, evebitda: 0, roe: 2, roic: 0, margem: 0.5, cagrRec: 0.5, cagrLuc: 1, divida: 0, fcf: 0, dy: 1.5, divHist: 1, fair: 1.5, hist: 1 },
    },
    utilidade: {
      label: 'Energia, saneamento e telecom', fair: ['graham', 'bazin', 'hist'],
      note: 'Empresas de serviços públicos têm receita previsível: toleram mais dívida, crescem pouco e dividendos pesam mais.',
      bands: {
        pl: [[0, 0], [0.01, 100], [8, 100], [12, 70], [16, 40], [22, 10], [28, 0]],
        pvp: [[0, 0], [0.01, 100], [1, 100], [1.5, 70], [2.5, 35], [4, 0]],
        evebitda: [[0, 0], [0.01, 100], [5, 100], [7, 70], [10, 35], [14, 0]],
        margem: [[0, 0], [6, 35], [12, 70], [20, 100]],
        divida: [[0, 100], [2, 100], [3, 70], [4, 35], [5, 0]],
        cagrRec: [[-5, 0], [0, 40], [4, 70], [8, 100]],
        cagrLuc: [[-10, 0], [0, 40], [5, 70], [10, 100]],
        payout: [[70, 10], [90, 40], [110, 70], [130, 100]],
      },
      w: { pl: 1, pvp: 1, evebitda: 1, roe: 1, roic: 0.7, margem: 1, cagrRec: 0.5, cagrLuc: 0.7, divida: 1.5, fcf: 0.7, dy: 2, divHist: 1.5, fair: 1.5, hist: 1 },
    },
    tecnologia: {
      label: 'Tecnologia', fair: ['graham', 'hist'],
      note: 'Em tecnologia, crescimento e retorno sobre o capital pesam mais; múltiplos altos são mais tolerados e dividendos pesam pouco.',
      bands: {
        pl: [[0, 0], [0.01, 100], [12, 100], [20, 70], [30, 40], [45, 10], [60, 0]],
        pvp: [[0, 0], [0.01, 100], [2, 100], [4, 60], [8, 20], [12, 0]],
        evebitda: [[0, 0], [0.01, 100], [8, 100], [14, 60], [22, 20], [30, 0]],
        margem: [[0, 0], [5, 30], [10, 60], [20, 100]],
        cagrRec: [[-5, 0], [0, 15], [8, 50], [15, 80], [25, 100]],
        cagrLuc: [[-10, 0], [0, 15], [8, 50], [15, 80], [25, 100]],
      },
      w: { pl: 1, pvp: 0.5, evebitda: 1, roe: 1, roic: 1.5, margem: 1, cagrRec: 2, cagrLuc: 1.5, divida: 1, fcf: 1, dy: 0.3, divHist: 0.3, fair: 1, hist: 1 },
    },
    ciclica: {
      label: 'Commodities (petróleo, mineração, siderurgia, papel)', fair: ['graham', 'bazin', 'hist'],
      note: 'Em commodities o lucro oscila com os preços internacionais: P/L baixo pode ser pico de ciclo, então dívida, EV/EBITDA e caixa pesam mais.',
      w: { pl: 0.7, pvp: 1, evebitda: 1.5, roe: 1, roic: 1, margem: 0.7, cagrRec: 0.7, cagrLuc: 0.7, divida: 1.5, fcf: 1.5, dy: 1, divHist: 0.7, fair: 1.5, hist: 1.2 },
    },
  };

  // setor de atividade da CVM -> perfil
  function profileFor(setor) {
    const s = (setor || '').toLowerCase();
    if (/seguradora/.test(s)) return 'seguradora';
    if (/banco|intermedia..o financeira|arrendamento mercantil|cr.dito imobili/.test(s)) return 'banco';
    if (/energia el.trica|saneamento|telecomunica/.test(s)) return 'utilidade';
    if (/comunica..o e inform.tica/.test(s)) return 'tecnologia';
    if (/petr.leo|extra..o mineral|metalurgia|siderurgia|papel e celulose|petroqu.mic/.test(s)) return 'ciclica';
    return 'geral';
  }
  const bandsOf = (profile, key) => (PROFILES[profile].bands && PROFILES[profile].bands[key]) || BASE[key];

  /* ---------- dados ---------- */
  async function fetchDoc(ticker, io) {
    return io.getJSON(DATA_URL + encodeURIComponent(ticker.toUpperCase()) + '.json');
  }

  // preço de fechamento no último pregão de cada ano, a partir da série semanal (ajustada a desdobramentos)
  function yearEndPrices(history) {
    const out = {};
    for (const p of history || []) {
      const y = new Date(p.t).getFullYear();
      if (!out[y] || p.t > out[y].t) out[y] = p;
    }
    return Object.fromEntries(Object.entries(out).map(([y, p]) => [y, p.v]));
  }

  /* Indicadores calculados a partir das contas da CVM.
     O preço do Yahoo é ajustado a desdobramentos/bonificações; por isso o
     histórico usa a quantidade de ações atual (mesma base do preço ajustado). */
  function computeIndicators(doc, price, history) {
    const unit = doc.unit || 1;                 // units valem N ações
    const t = doc.ttm || {};
    const S = t.acoes;                           // ações em circulação
    const p = price / unit;                      // preço por ação
    const mcap = ok(S) ? p * S : null;
    const netDebt = ok(t.divida) ? t.divida - (t.caixa || 0) : null;

    const metrics = (rec, mc) => {
      const nd = ok(rec.divida) ? rec.divida - (rec.caixa || 0) : null;
      const invested = ok(rec.pl) && ok(nd) ? rec.pl + nd : null;
      return {
        p_l: rec.lucro > 0 ? div(mc, rec.lucro) : rec.lucro != null ? -1 : null,
        p_vp: rec.pl > 0 ? div(mc, rec.pl) : rec.pl != null ? -1 : null,
        ev_ebitda: ok(nd) && rec.ebitda > 0 && mc ? (mc + nd) / rec.ebitda : null,
        roe: rec.pl > 0 && ok(rec.lucro) ? (rec.lucro / rec.pl) * 100 : null,
        roic: invested > 0 && ok(rec.ebit) ? ((rec.ebit * 0.66) / invested) * 100 : null, // EBIT após 34% de IR/CSLL
        margem: rec.receita > 0 && ok(rec.lucro) ? (rec.lucro / rec.receita) * 100 : null,
        dl_ebitda: ok(nd) && rec.ebitda > 0 ? nd / rec.ebitda : null,
        dy: mc && ok(rec.dividendos) ? (rec.dividendos / mc) * 100 : null,
      };
    };

    const actual = metrics(t, mcap);
    const prices = yearEndPrices(history);
    const years = {};
    for (const a of doc.anos || []) {
      const py = prices[a.ano];
      years[a.ano] = metrics(a, ok(py) && ok(S) ? (py / unit) * S : null);
    }

    // crescimento anual composto (até 5 anos)
    const anos = [...(doc.anos || [])].sort((a, b) => a.ano - b.ano);
    const last = anos[anos.length - 1];
    const cagr = (key) => {
      if (!last || !(last[key] > 0)) return { v: null };
      const first = anos.filter((a) => a.ano >= last.ano - 5 && a[key] > 0)[0];
      const n = first ? last.ano - first.ano : 0;
      if (n < 3) return { v: null };
      return { v: (Math.pow(last[key] / first[key], 1 / n) - 1) * 100, n };
    };

    return {
      S, unit, mcap, netDebt, actual, years, prices,
      lpa: ok(S) && ok(t.lucro) ? t.lucro / S : null,
      vpa: ok(S) && ok(t.pl) ? t.pl / S : null,
      cagrRec: cagr('receita'), cagrLuc: cagr('lucro'),
      fcfYield: mcap && ok(t.fcf) ? (t.fcf / mcap) * 100 : null,
      anos, last,
    };
  }

  /* ---------- análise ---------- */
  function analyzeData(ticker, doc, price, history) {
    const X = computeIndicators(doc, price, history);
    const A = X.actual, t = doc.ttm || {};
    const thisYear = new Date().getFullYear();
    const profile = profileFor(doc.setor);
    const P = PROFILES[profile];
    const W = P.w;
    const band = (k) => bandsOf(profile, k);
    const S = (k, v) => interp(v, band(k));
    const buy = [], sell = [];
    const add = (list, c) => list.push(Object.assign({ weight: 1, score: null }, c));
    // série de anos completos (mais recente primeiro), só com valores válidos
    const yearsOf = (k, n = 5) => Object.keys(X.years).map(Number).filter((y) => y < thisYear && ok(X.years[y][k]))
      .sort((a, b) => b - a).slice(0, n).map((y) => ({ yr: y, v: X.years[y][k] }));

    const pl = A.p_l, pvp = A.p_vp, ev = A.ev_ebitda, roe = A.roe, roic = A.roic, mrg = A.margem,
      dl = A.dl_ebitda, dy = A.dy, lpa = X.lpa, vpa = X.vpa;
    const cRec = X.cagrRec.v, cLuc = X.cagrLuc.v;

    // ----- valor justo (mediana dos métodos aplicáveis ao setor)
    const fairMethods = {};
    if (lpa > 0 && vpa > 0) fairMethods.graham = Math.sqrt(22.5 * lpa * vpa) * X.unit;
    const divs = X.anos.slice(-3).map((a) => (ok(a.dividendos) && X.S ? a.dividendos / X.S : null));
    if (divs.length === 3 && divs.every(ok) && avg(divs) > 0) fairMethods.bazin = (avg(divs) / 0.06) * X.unit;
    const plHist = median(yearsOf('p_l').map((x) => x.v).filter((v) => v > 0 && v < 100));
    if (lpa > 0 && plHist) fairMethods.hist = lpa * plHist * X.unit;
    const used = P.fair.filter((k) => fairMethods[k] != null);
    const fair = used.length ? median(used.map((k) => fairMethods[k])) : null;
    const mos = fair ? ((fair - price) / fair) * 100 : null;
    const METHOD = { graham: 'Graham', bazin: 'Bazin', hist: 'P/L histórico' };
    const fairText = used.map((k) => `${METHOD[k]} ${money(fairMethods[k])}`).join(' · ');

    // ----- múltiplos vs. o próprio histórico (mediana dos últimos 5 anos)
    const histRatios = [];
    for (const [k, label] of [['p_l', 'P/L'], ['p_vp', 'P/VP'], ['ev_ebitda', 'EV/EBITDA']]) {
      if (k === 'ev_ebitda' && !W.evebitda) continue;
      const cur = A[k], med = median(yearsOf(k).map((x) => x.v).filter((v) => v > 0));
      if (cur > 0 && med > 0) histRatios.push({ label, r: cur / med, cur, med });
    }
    const histR = histRatios.length ? avg(histRatios.map((h) => h.r)) : null;
    const histText = histRatios.map((h) => `${h.label} ${f(h.cur)} vs ${f(h.med)}`).join(' · ');

    // ===================== TERMÔMETRO DE COMPRA =====================
    add(buy, { id: 'pl', name: 'P/L', value: pl == null ? '—' : pl < 0 ? 'prejuízo' : f(pl), weight: W.pl, score: pl == null ? null : pl < 0 ? 0 : S('pl', pl),
      note: pl == null ? 'Sem dado.' : pl < 0 ? 'Empresa com prejuízo nos últimos 12 meses.' : `Paga-se ${f(pl)} anos de lucro pela ação.` });
    add(buy, { id: 'pvp', name: 'P/VP', value: pvp == null ? '—' : pvp < 0 ? 'PL negativo' : f(pvp, 2), weight: W.pvp, score: pvp == null ? null : pvp < 0 ? 0 : S('pvp', pvp),
      note: pvp == null ? 'Sem dado.' : pvp < 0 ? 'Patrimônio líquido negativo.' : `Preço ${f(pvp, 2)}× o valor patrimonial.` });
    add(buy, { id: 'evebitda', name: 'EV/EBITDA', value: ev == null ? '—' : f(ev), weight: W.evebitda, score: S('evebitda', ev),
      note: !W.evebitda ? 'Não se aplica a este setor.' : ev == null ? 'Sem dado.' : `Valor da firma = ${f(ev)}× a geração de caixa operacional (EBITDA).` });
    add(buy, { id: 'roe', name: 'ROE', value: pct(roe), weight: W.roe, score: S('roe', roe), note: roe == null ? 'Sem dado.' : `Retorno de ${pct(roe)} sobre o patrimônio.` });
    add(buy, { id: 'roic', name: 'ROIC', value: pct(roic), weight: W.roic, score: S('roic', roic),
      note: !W.roic ? 'Não se aplica a este setor.' : roic == null ? 'Sem dado.' : `Retorno de ${pct(roic)} sobre o capital investido (patrimônio + dívida líquida).` });
    add(buy, { id: 'margem', name: 'Margem líquida', value: pct(mrg), weight: W.margem, score: S('margem', mrg),
      note: !W.margem ? 'Não se aplica a este setor.' : mrg == null ? 'Sem dado.' : `Sobram ${pct(mrg)} da receita como lucro.` });
    const nTxt = (c) => (c.n && c.n !== 5 ? ` (${c.n} anos)` : '');
    add(buy, { id: 'cagrRec', name: 'Receita · 5 anos', value: cRec == null ? '—' : signed(cRec) + ' a.a.' + nTxt(X.cagrRec), weight: W.cagrRec, score: S('cagrRec', cRec),
      note: cRec == null ? 'Sem histórico suficiente.' : `Receita cresceu ${signed(cRec)} ao ano${nTxt(X.cagrRec)}.` });
    add(buy, { id: 'cagrLuc', name: 'Lucro · 5 anos', value: cLuc == null ? '—' : signed(cLuc) + ' a.a.' + nTxt(X.cagrLuc), weight: W.cagrLuc, score: S('cagrLuc', cLuc),
      note: cLuc == null ? 'Sem histórico suficiente (ou prejuízo em uma das pontas).' : `Lucro cresceu ${signed(cLuc)} ao ano${nTxt(X.cagrLuc)}.` });
    add(buy, { id: 'divida', name: 'Dív. líquida/EBITDA', value: dl == null ? '—' : f(dl, 2), weight: W.divida, score: S('divida', dl),
      note: !W.divida ? 'Não se aplica a este setor.' : dl == null ? 'Sem dado.' : dl <= 0 ? 'Tem mais caixa do que dívida.' : `A dívida líquida equivale a ${f(dl, 2)} anos de EBITDA.` });
    add(buy, { id: 'fcf', name: 'Fluxo de caixa livre', value: X.fcfYield == null ? '—' : pct(X.fcfYield) + ' do valor', weight: W.fcf, score: interp(X.fcfYield, BASE.fcfYield),
      note: !W.fcf ? 'Não se aplica a este setor.' : X.fcfYield == null ? 'Sem dado.' : `Gerou ${bi(t.fcf)} de caixa livre em 12 meses (${pct(X.fcfYield)} do valor de mercado).` });
    add(buy, { id: 'dy', name: 'Dividend yield', value: pct(dy), weight: W.dy, score: S('dy', dy), note: dy == null ? 'Sem dado.' : `Pagou ${pct(dy)} do valor de mercado em dividendos e JCP nos últimos 12 meses.` });
    const last5 = X.anos.slice(-5);
    const paidYears = last5.filter((a) => a.dividendos > 0).length;
    add(buy, { id: 'divHist', name: 'Histórico de dividendos', value: last5.length ? `${paidYears}/${last5.length} anos` : '—', weight: W.divHist,
      score: last5.length >= 3 ? interp(paidYears / last5.length, [[0.2, 0], [0.6, 50], [0.8, 75], [1, 100]]) : null,
      note: last5.length ? `Pagou dividendos/JCP em ${paidYears} dos últimos ${last5.length} anos.` : 'Sem dado.' });
    add(buy, { id: 'fair', name: 'Valor justo e margem de segurança', value: fair == null ? '—' : `${money(fair)} · ${signed(mos, 0)}`, weight: W.fair,
      score: interp(mos, [[-40, 0], [-20, 10], [0, 35], [10, 55], [25, 80], [40, 100]]),
      note: fair == null ? 'Sem dados para calcular o valor justo.' : `Preço ${money(price)}; valor justo ${money(fair)} (${fairText}). Margem de segurança de ${signed(mos, 0)}.` });
    add(buy, { id: 'hist', name: 'Valuation vs. histórico', value: histR == null ? '—' : `${f(histR * 100, 0)}% da média`, weight: W.hist,
      score: interp(histR, [[0.7, 100], [0.85, 75], [1, 50], [1.2, 25], [1.5, 0]]),
      note: histR == null ? 'Sem histórico suficiente.' : `Múltiplos atuais vs. mediana de 5 anos: ${histText}.` });

    // ===================== TERMÔMETRO DE VENDA =====================
    add(sell, { id: 'sobre', name: 'Sobrevalorização', value: histR == null ? '—' : `${f(histR * 100, 0)}% da média`, weight: 1.2,
      score: interp(histR, [[0.8, 10], [1, 40], [1.2, 70], [1.5, 100]]),
      note: histR == null ? 'Sem histórico suficiente.' : histR > 1 ? `Negociando acima dos próprios múltiplos históricos (${histText}).` : `Negociando abaixo dos próprios múltiplos históricos (${histText}).` });
    add(sell, { id: 'acimaJusto', name: 'Preço vs valor justo', value: fair == null ? '—' : `${f((price / fair) * 100, 0)}% do justo`, weight: 1.5,
      score: fair ? interp(price / fair, [[0.8, 0], [1, 30], [1.1, 50], [1.3, 75], [1.6, 100]]) : null,
      note: fair == null ? 'Sem dados para calcular o valor justo.' : `Preço ${money(price)} contra valor justo de ${money(fair)}.` });
    const multScores = buy.filter((c) => ['pl', 'pvp', 'evebitda'].includes(c.id) && c.weight && c.score != null).map((c) => c.score);
    add(sell, { id: 'multiplos', name: 'Múltiplos elevados', value: [pl > 0 && `P/L ${f(pl)}`, pvp > 0 && `P/VP ${f(pvp, 2)}`].filter(Boolean).join(' · ') || '—', weight: 1,
      score: multScores.length ? 100 - avg(multScores) : null,
      note: multScores.length ? `Comparados às faixas típicas de ${P.label.toLowerCase()}.` : 'Sem dado.' });

    // deterioração: indicador atual vs média dos 3 anos anteriores (pontos percentuais)
    const deltas = [];
    for (const [k, label] of [['roe', 'ROE'], ['margem', 'margem'], ['roic', 'ROIC']]) {
      if ((k === 'roic' && !W.roic) || (k === 'margem' && !W.margem)) continue;
      const prev = avg(yearsOf(k, 3).map((x) => x.v));
      if (ok(A[k]) && ok(prev)) deltas.push({ label, d: A[k] - prev });
    }
    add(sell, { id: 'fund', name: 'Deterioração dos fundamentos', value: deltas.length ? deltas.map((x) => `${x.label} ${signed(x.d, 1, ' p.p.')}`).join(' · ') : '—', weight: 1.2,
      score: deltas.length ? avg(deltas.map((x) => interp(x.d, [[-10, 100], [-5, 70], [0, 35], [5, 0]]))) : null,
      note: deltas.length ? 'Rentabilidade dos últimos 12 meses comparada à média dos 3 anos anteriores.' : 'Sem histórico suficiente.' });

    // lucro e receita: último ano completo vs anterior
    const [y1, y0] = X.anos.slice(-2).reverse();
    const g = (a, b) => (ok(a) && b ? ((a - b) / Math.abs(b)) * 100 : null);
    const gRec = y1 && y0 ? g(y1.receita, y0.receita) : null;
    const gLuc = y1 && y0 ? g(y1.lucro, y0.lucro) : null;
    const growthScores = [interp(gRec, [[-15, 100], [-5, 70], [0, 45], [5, 20], [10, 0]]), interp(gLuc, [[-30, 100], [-10, 70], [0, 45], [10, 15], [20, 0]])].filter((v) => v != null);
    add(sell, { id: 'queda', name: 'Lucro e receita em queda', value: y1 && y0 ? `Rec. ${signed(gRec, 0)} · Lucro ${signed(gLuc, 0)}` : '—', weight: 1.2,
      score: growthScores.length ? avg(growthScores) : null,
      note: y1 && y0 ? `${y1.ano} contra ${y0.ano}: receita ${signed(gRec)} e lucro ${signed(gLuc)}.` : 'Sem histórico anual.' });

    // endividamento: dív. líquida/EBITDA atual vs 2 anos atrás
    const dlPast = yearsOf('dl_ebitda', 5).find((x) => x.yr <= thisYear - 2);
    const dlDiff = ok(dl) && dlPast ? dl - dlPast.v : null;
    add(sell, { id: 'divida', name: 'Endividamento aumentando', value: dlDiff == null ? '—' : `${f(dlPast.v, 2)} → ${f(dl, 2)}`, weight: W.divida ? 1 : 0,
      score: interp(dlDiff, [[-0.5, 0], [0, 20], [0.25, 40], [0.75, 70], [1.5, 100]]),
      note: !W.divida ? 'Não se aplica a este setor.' : dlDiff == null ? 'Sem histórico suficiente.' : `Dívida líquida/EBITDA foi de ${f(dlPast.v, 2)} (${dlPast.yr}) para ${f(dl, 2)} hoje.` });

    // fluxo de caixa: 12 meses vs média dos 3 anos anteriores
    const fcfPrev = avg(X.anos.slice(-3).map((a) => a.fcf).filter(ok));
    let fcfScore = null, fcfNote = 'Sem dado.';
    if (ok(t.fcf) && fcfPrev) {
      fcfScore = t.fcf < 0 ? 90 : fcfPrev < 0 ? 10 : interp(t.fcf / fcfPrev, [[0.5, 80], [0.8, 55], [1, 30], [1.2, 0]]);
      fcfNote = `Caixa livre de ${bi(t.fcf)} nos últimos 12 meses, contra média de ${bi(fcfPrev)} nos 3 anos anteriores.`;
    }
    add(sell, { id: 'caixa', name: 'Fluxo de caixa piorando', value: ok(t.fcf) && fcfPrev ? signed(((t.fcf - fcfPrev) / Math.abs(fcfPrev)) * 100, 0) : '—', weight: W.fcf ? 1 : 0,
      score: fcfScore, note: !W.fcf ? 'Não se aplica a este setor.' : fcfNote });

    // sustentabilidade dos dividendos: payout = dividendos pagos / lucro (12 meses)
    const payout = t.dividendos > 0 && t.lucro > 0 ? (t.dividendos / t.lucro) * 100 : null;
    add(sell, { id: 'payout', name: 'Dividendos insustentáveis', value: payout == null ? '—' : payout > 300 ? 'payout > 300%' : `payout ${pct(payout, 0)}`, weight: payout == null ? 0 : 1,
      score: payout == null ? null : Math.min(100, interp(payout, band('payout')) + (gLuc != null && gLuc < -10 && payout > 70 ? 15 : 0)),
      note: payout == null ? 'Sem dividendos ou sem lucro para comparar.' : `Pagou ${pct(payout, 0)} do lucro em dividendos/JCP nos últimos 12 meses${payout > 100 ? ', mais do que lucrou' : ''}.` });

    // perspectivas: sem projeções públicas -> tendência mais recente (12 meses vs último ano completo)
    const hasRecent = t.ref && X.last && t.ref > `${X.last.ano}-12-31`;
    const gRecT = hasRecent ? g(t.receita, X.last.receita) : null;
    const gLucT = hasRecent ? g(t.lucro, X.last.lucro) : null;
    const trendScores = [interp(gRecT, [[-10, 100], [-3, 70], [0, 45], [5, 15], [10, 0]]), interp(gLucT, [[-25, 100], [-8, 70], [0, 45], [8, 15], [15, 0]])].filter((v) => v != null);
    add(sell, { id: 'persp', name: 'Tendência recente', value: trendScores.length ? `Rec. ${signed(gRecT, 0)} · Lucro ${signed(gLucT, 0)}` : '—', weight: 1,
      score: trendScores.length ? avg(trendScores) : null,
      note: trendScores.length ? `12 meses até ${fmtRef(t.ref)} contra ${X.last.ano}. Não há projeções de analistas em fonte pública gratuita; usamos a tendência mais recente dos resultados.` : 'Ainda não há balanço trimestral posterior ao último ano fechado.' });

    // ----- notas finais (média ponderada só do que existe)
    const total = (list) => {
      const valid = list.filter((c) => c.weight > 0 && c.score != null);
      const all = list.filter((c) => c.weight > 0);
      const w = valid.reduce((s, c) => s + c.weight, 0);
      const wAll = all.reduce((s, c) => s + c.weight, 0);
      return {
        score: w ? Math.round(valid.reduce((s, c) => s + c.score * c.weight, 0) / w) : null,
        coverage: wAll ? Math.round((w / wAll) * 100) : 0,
      };
    };
    const tb = total(buy), ts = total(sell);

    return {
      ticker: ticker.toUpperCase(), nome: doc.nome, price, profile, profileLabel: P.label, profileNote: P.note || '',
      setor: doc.setor, fair, fairMethods, mos,
      buy: { ...tb, criteria: buy, reasons: reasons(buy, false) },
      sell: { ...ts, criteria: sell, reasons: reasons(sell, true) },
      verdict: verdict(tb, ts),
      ref: t.ref, fonte: doc.fonte,
    };
  }

  const fmtRef = (iso) => (iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : '—');

  // principais motivos: os critérios que mais puxaram a nota para cima e para baixo
  function reasons(list, isSell) {
    const valid = list.filter((c) => c.weight > 0 && c.score != null);
    const impact = (c) => (c.score - 50) * c.weight;
    const pos = valid.filter((c) => c.score >= 60).sort((a, b) => impact(b) - impact(a)).slice(0, 3);
    const neg = valid.filter((c) => c.score <= 40).sort((a, b) => impact(a) - impact(b)).slice(0, 3);
    return {
      favor: pos.map((c) => ({ name: c.name, text: c.note })),
      contra: neg.map((c) => ({ name: c.name, text: c.note })),
      favorTitle: isSell ? 'Sinais de venda' : 'A favor da compra',
      contraTitle: isSell ? 'Contra a venda' : 'Contra a compra',
    };
  }

  function verdict(b, s) {
    if (b.score == null || s.score == null || b.coverage < 50 || s.coverage < 50) return { key: 'dados', label: 'Dados insuficientes' };
    if (s.score >= 60 && s.score > b.score) return { key: 'vender', label: 'Vender' };
    if (b.score >= 65 && s.score < 45) return { key: 'comprar', label: 'Comprar' };
    return { key: 'manter', label: 'Manter' };
  }

  // faixas de cor pedidas: vermelho, laranja, amarelo, verde, verde forte
  function band(score) {
    if (score == null) return { key: 'na', label: 'Sem dados', color: '#5a5a58' };
    if (score < 20) return { key: 'ruim', label: 'Momento ruim', color: '#f2545b' };
    if (score < 40) return { key: 'desfav', label: 'Desfavorável', color: '#f2884b' };
    if (score < 60) return { key: 'neutro', label: 'Neutro', color: '#f2c94c' };
    if (score < 80) return { key: 'bom', label: 'Bom momento', color: '#3ecf8e' };
    return { key: 'excelente', label: 'Excelente momento', color: '#16a864' };
  }

  async function analyze(ticker, io) {
    let doc;
    try { doc = await fetchDoc(ticker, io); } catch { doc = null; }
    if (!doc || !doc.anos) throw new Error(`Sem demonstrações na CVM para ${ticker.toUpperCase()}. O termômetro funciona com ações de empresas brasileiras listadas na B3.`);
    const [price, history] = await Promise.all([io.price(ticker), io.history(ticker).catch(() => [])]);
    if (!price) throw new Error('Não foi possível obter a cotação atual.');
    return analyzeData(ticker, doc, price, history);
  }

  const api = { analyze, analyzeData, computeIndicators, profileFor, band, interp, PROFILES, DATA_URL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Thermo = api;
})(typeof window !== 'undefined' ? window : globalThis);
