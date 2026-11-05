'use strict';
/* =========================================================
   Leitor mínimo de planilhas .xlsx (e .csv), sem dependências.
   Um .xlsx é um zip com XML dentro: lemos o diretório do zip,
   descompactamos com DecompressionStream e extraímos as células.
   Devolve { nomeDaAba: [[célula, ...], ...] } com textos e números.
   Funciona no app e no Node (para testes).
   ========================================================= */
(function (root) {

  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const utf8 = new TextDecoder('utf-8');

  async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // lê o diretório central do zip -> { nome: Uint8Array descompactado (sob demanda) }
  function zipEntries(buf) {
    const b = new Uint8Array(buf);
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
      if (u32(b, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Arquivo não é uma planilha .xlsx válida.');
    const count = u16(b, eocd + 10);
    let p = u32(b, eocd + 16);
    const entries = {};
    for (let n = 0; n < count; n++) {
      if (u32(b, p) !== 0x02014b50) break;
      const method = u16(b, p + 10), csize = u32(b, p + 20);
      const nlen = u16(b, p + 28), xlen = u16(b, p + 30), clen = u16(b, p + 32), local = u32(b, p + 42);
      const name = utf8.decode(b.subarray(p + 46, p + 46 + nlen));
      const start = local + 30 + u16(b, local + 26) + u16(b, local + 28);
      entries[name] = { method, data: b.subarray(start, start + csize) };
      p += 46 + nlen + xlen + clen;
    }
    return entries;
  }

  async function readEntry(entries, name) {
    const e = entries[name];
    if (!e) return null;
    const bytes = e.method === 0 ? e.data : e.method === 8 ? await inflate(e.data) : null;
    if (!bytes) throw new Error('Compressão não suportada na planilha.');
    return utf8.decode(bytes);
  }

  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const unxml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m);
  const attr = (tag, name) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? unxml(m[1]) : null; };
  // texto de um nó com <t>...</t> (vários pedaços em textos formatados)
  const textOf = (xml) => { let s = ''; xml.replace(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, (_, t) => { s += unxml(t); }); return s; };

  // "AB12" -> índice da coluna (0 = A)
  function colIndex(ref) {
    let n = 0;
    for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  function parseSheet(xml, shared) {
    const rows = [];
    const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
    let m;
    while ((m = rowRe.exec(xml))) {
      const rIdx = +(attr(m[1], 'r') || rows.length + 1) - 1;
      const row = [];
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let c;
      while ((c = cellRe.exec(m[2]))) {
        const ref = attr(c[1], 'r'), type = attr(c[1], 't'), inner = c[2] || '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        let val = null;
        if (type === 's' && v) val = shared[+v[1]] ?? '';
        else if (type === 'inlineStr') val = textOf(inner);
        else if (type === 'str' || type === 'e') val = v ? unxml(v[1]) : '';
        else if (type === 'b') val = v ? v[1] === '1' : null;
        else if (v) val = +v[1];
        row[ref ? colIndex(ref) : row.length] = val;
      }
      rows[rIdx] = row;
    }
    return Array.from(rows, (r) => Array.from(r || [], (x) => (x === undefined ? null : x)));
  }

  async function readXlsx(buf) {
    const entries = zipEntries(buf);
    const sharedXml = await readEntry(entries, 'xl/sharedStrings.xml');
    const shared = [];
    if (sharedXml) sharedXml.replace(/<si>([\s\S]*?)<\/si>/g, (_, si) => { shared.push(textOf(si)); });
    const wb = await readEntry(entries, 'xl/workbook.xml') || '';
    const rels = await readEntry(entries, 'xl/_rels/workbook.xml.rels') || '';
    const target = {};
    rels.replace(/<Relationship\b[^>]*>/g, (tag) => { target[attr(tag, 'Id')] = attr(tag, 'Target'); });
    const out = {};
    const sheetTags = wb.match(/<sheet\b[^>]*>/g) || [];
    for (const tag of sheetTags) {
      const name = attr(tag, 'name');
      let path = target[attr(tag, 'r:id')] || '';
      path = path.startsWith('/') ? path.slice(1) : 'xl/' + path.replace(/^\.\//, '');
      const xml = await readEntry(entries, path);
      if (xml) out[name] = parseSheet(xml, shared);
    }
    return out;
  }

  // CSV com ';' ou ',' (aspas respeitadas)
  function readCsv(text) {
    const first = text.split(/\r?\n/, 1)[0] || '';
    const sep = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : ',';
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === sep) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return { CSV: rows };
  }

  async function readSpreadsheet(name, buf) {
    if (/\.csv$/i.test(name)) return readCsv(new TextDecoder('utf-8').decode(buf));
    return readXlsx(buf);
  }

  const api = { readXlsx, readCsv, readSpreadsheet };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.XlsxLite = api;
})(typeof window !== 'undefined' ? window : globalThis);
