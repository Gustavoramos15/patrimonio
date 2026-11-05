"""
Gera os dados fundamentalistas usados pela aba Termômetro do app Patrimônio.

Fonte: Portal de Dados Abertos da CVM (licença ODbL)
  - DFP: demonstrações financeiras anuais
  - ITR: informações trimestrais (para os últimos 12 meses e o balanço mais recente)
  - FCA: cadastro (tickers, setor de atividade)

Saída (em data/fundamentos/):
  - <TICKER>.json  um arquivo por ticker negociado na B3
  - index.json     lista de tickers com nome e setor

Uso:  python pipeline/cvm_fundamentos.py [--out data/fundamentos] [--cache pipeline/.cache]
Todos os valores monetários saem em reais (a escala "MIL" da CVM é convertida).
"""
import argparse
import csv
import io
import json
import os
import re
import sys
import urllib.request
import zipfile
from collections import defaultdict
from datetime import date

BASE = "https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC"
csv.field_size_limit(10_000_000)

TICKER_RE = re.compile(r"^[A-Z]{4}\d{1,2}$")
SHARE_KINDS = ("Ações Ordinárias", "Ações Preferenciais", "Units")


# ----------------------------------------------------------------- download

def fetch(kind, year, cache):
    """Baixa (com cache) o zip de um tipo de documento/ano. Retorna o caminho ou None."""
    name = f"{kind.lower()}_cia_aberta_{year}.zip"
    path = os.path.join(cache, name)
    if not os.path.exists(path):
        url = f"{BASE}/{kind}/DADOS/{name}"
        try:
            with urllib.request.urlopen(url, timeout=300) as r, open(path + ".part", "wb") as f:
                while chunk := r.read(1 << 20):
                    f.write(chunk)
            os.replace(path + ".part", path)
            print(f"  baixado {name}", file=sys.stderr)
        except Exception as e:  # ano ainda não publicado, por exemplo
            print(f"  sem {name}: {e}", file=sys.stderr)
            return None
    return path


def rows(zpath, member):
    """Itera as linhas de um CSV dentro do zip (CVM usa latin-1 e ';')."""
    with zipfile.ZipFile(zpath) as z:
        names = [n for n in z.namelist() if n.lower() == member.lower()]
        if not names:
            return
        with z.open(names[0]) as raw:
            yield from csv.DictReader(io.TextIOWrapper(raw, encoding="latin-1"), delimiter=";")


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def scale(r):
    return 1000.0 if (r.get("ESCALA_MOEDA") or "").upper() == "MIL" else 1.0


# ----------------------------------------------------------------- cadastro (FCA)

def load_registry(fca_paths):
    """Tickers ativos na B3 por CNPJ, nome e setor (versão mais recente de cada documento)."""
    tickers = {}  # ticker -> {cnpj, nome, tipo, unit}
    geral = {}    # cnpj -> {setor, atividade, nome, ref}
    for p in fca_paths:
        year = re.search(r"(\d{4})", os.path.basename(p)).group(1)
        for r in rows(p, f"fca_cia_aberta_valor_mobiliario_{year}.csv"):
            t = (r.get("Codigo_Negociacao") or "").strip().upper()
            if not TICKER_RE.match(t) or r.get("Mercado") != "Bolsa" or (r.get("Data_Fim_Negociacao") or "").strip():
                continue
            if r.get("Valor_Mobiliario") not in SHARE_KINDS:
                continue
            ref = r.get("Data_Referencia", "")
            if t in tickers and tickers[t]["ref"] >= ref:
                continue
            unit = None
            if r.get("Valor_Mobiliario") == "Units":
                n = [int(x) for x in re.findall(r"(\d+)\s*(?:ON|PN)", r.get("Composicao_BDR_Unit") or "")]
                unit = sum(n) if n else None
            tickers[t] = {"cnpj": r["CNPJ_Companhia"], "nome": r["Nome_Empresarial"], "tipo": r["Valor_Mobiliario"], "unit": unit, "ref": ref}
        for r in rows(p, f"fca_cia_aberta_geral_{year}.csv"):
            c, ref = r["CNPJ_Companhia"], r.get("Data_Referencia", "")
            if c in geral and geral[c]["ref"] >= ref:
                continue
            setor = re.sub(r"^Emp\. Adm\. Part\. - ", "", (r.get("Setor_Atividade") or "").strip())
            geral[c] = {"setor": setor, "atividade": (r.get("Descricao_Atividade") or "").strip(),
                        "nome": r.get("Nome_Empresarial"), "situacao": r.get("Situacao_Registro_CVM"), "ref": ref}
    return tickers, geral


# ----------------------------------------------------------------- demonstrativos

LUCRO_CONTROLADORA = re.compile(r"atribu[íi]do a s[óo]cios da (empresa )?controladora", re.I)
LUCRO_CONSOLIDADO = re.compile(r"lucro.{0,20}(consolidado|l[íi]quido).{0,20}per[íi]odo", re.I)
EBIT = re.compile(r"resultado antes do resultado financeiro e dos tributos", re.I)
DEPREC = re.compile(r"deprecia|amortiza|exaust|deple", re.I)
DIVIDENDOS = re.compile(r"dividend|juros sobre (o )?capital", re.I)
NAO_DIVIDENDOS = re.compile(r"recebid|n[ãa]o controlador|minorit", re.I)


class Store:
    """Acumula valores por (cnpj, data_ini, data_fim, campo), mantendo só a versão mais nova do documento."""

    def __init__(self, cnpjs):
        self.cnpjs = cnpjs
        self.version = {}   # (cnpj, dt_refer, kind) -> versão
        self.data = defaultdict(dict)  # (cnpj, ini, fim, consol) -> {campo: valor}

    def keep(self, r, kind):
        k = (r["CNPJ_CIA"], r["DT_REFER"], kind)
        v = int(r.get("VERSAO") or 0)
        cur = self.version.get(k)
        if cur is None or v > cur:
            self.version[k] = v
            return True
        return v == cur

    def put(self, r, consol, field, value, add=False):
        # O mesmo período aparece em vários documentos (o balanço de dezembro volta como
        # comparativo em cada ITR seguinte); por isso os valores ficam separados por
        # documento (DT_REFER) e pick() escolhe um só.
        key = (r["CNPJ_CIA"], r.get("DT_INI_EXERC") or "", r["DT_FIM_EXERC"], consol, r["DT_REFER"])
        d = self.data[key]
        if add:
            d[field] = d.get(field, 0.0) + value
        elif field not in d:
            d[field] = value

    def index(self):
        """(cnpj, ini, fim, consol) -> {dt_refer: valores}"""
        idx = defaultdict(dict)
        for (cnpj, ini, fim, consol, refer), d in self.data.items():
            idx[(cnpj, ini, fim, consol)][refer] = d
        return idx


def read_statements(zpath, prefix, year, store):
    """Lê DRE, DFC, BPA e BPP (consolidado e individual) de um zip DFP/ITR."""
    for consol in ("con", "ind"):
        # ----- DRE
        for r in rows(zpath, f"{prefix}_cia_aberta_DRE_{consol}_{year}.csv"):
            if r["CNPJ_CIA"] not in store.cnpjs or not store.keep(r, "DRE" + consol):
                continue
            code, ds, v = r["CD_CONTA"], r["DS_CONTA"], num(r["VL_CONTA"])
            if v is None:
                continue
            v *= scale(r)
            if code == "3.01":
                store.put(r, consol, "receita", v)
            elif EBIT.search(ds) and code.count(".") == 1:
                store.put(r, consol, "ebit", v)
            elif LUCRO_CONTROLADORA.search(ds) and code.count(".") == 2:
                store.put(r, consol, "lucro", v)
            elif LUCRO_CONSOLIDADO.search(ds) and code.count(".") == 1:
                store.put(r, consol, "lucro_consolidado", v)
            elif code.startswith("3.99.01.") and code.count(".") == 3 and v:
                store.put(r, consol, "lpa_basico", v / scale(r))  # LPA vem em reais, sem escala
        # ----- DFC (método indireto e direto)
        for metodo in ("MI", "MD"):
            for r in rows(zpath, f"{prefix}_cia_aberta_DFC_{metodo}_{consol}_{year}.csv"):
                if r["CNPJ_CIA"] not in store.cnpjs or not store.keep(r, "DFC" + metodo + consol):
                    continue
                code, ds, v = r["CD_CONTA"], r["DS_CONTA"], num(r["VL_CONTA"])
                if v is None:
                    continue
                v *= scale(r)
                if code == "6.01":
                    store.put(r, consol, "fco", v)
                elif code == "6.02":
                    store.put(r, consol, "fci", v)
                elif code.startswith("6.01.") and code.count(".") >= 3 and DEPREC.search(ds) and v > 0:
                    store.put(r, consol, "da", v, add=True)
                elif code.startswith("6.03.") and DIVIDENDOS.search(ds) and not NAO_DIVIDENDOS.search(ds) and v < 0:
                    store.put(r, consol, "dividendos", -v, add=True)
        # ----- Balanço: ativo
        for r in rows(zpath, f"{prefix}_cia_aberta_BPA_{consol}_{year}.csv"):
            if r["CNPJ_CIA"] not in store.cnpjs or not store.keep(r, "BPA" + consol):
                continue
            code, ds, v = r["CD_CONTA"], r["DS_CONTA"].lower(), num(r["VL_CONTA"])
            if v is None:
                continue
            v *= scale(r)
            if code == "1":
                store.put(r, consol, "ativo", v)
            elif code in ("1.01.01", "1.01.02") and ("caixa" in ds or "aplica" in ds):
                store.put(r, consol, "caixa", v, add=True)
        # ----- Balanço: passivo
        for r in rows(zpath, f"{prefix}_cia_aberta_BPP_{consol}_{year}.csv"):
            if r["CNPJ_CIA"] not in store.cnpjs or not store.keep(r, "BPP" + consol):
                continue
            code, ds, v = r["CD_CONTA"], r["DS_CONTA"].lower(), num(r["VL_CONTA"])
            if v is None:
                continue
            v *= scale(r)
            if code.count(".") == 1 and "patrim" in ds and "quido" in ds:
                store.put(r, consol, "pl_total", v)
            elif code.count(".") == 2 and "não controlador" in ds.replace("nao", "não"):
                store.put(r, consol, "nao_controladores", v)
            # dívida financeira (empresas não financeiras): empréstimos + debêntures, sem arrendamentos
            elif code in ("2.01.04", "2.02.01") and "empr" in ds:
                store.put(r, consol, "divida", v, add=True)
            elif re.fullmatch(r"2\.0[12]\.0[41]\.\d\d", code) and code[:7] in ("2.01.04", "2.02.01") and "arrendamento" in ds:
                store.put(r, consol, "arrendamento", v, add=True)


def read_shares(zpath, prefix, year, cnpjs):
    """Ações em circulação (total integralizado - tesouraria) por (cnpj, dt_refer)."""
    out = {}
    for r in rows(zpath, f"{prefix}_cia_aberta_composicao_capital_{year}.csv"):
        if r["CNPJ_CIA"] not in cnpjs:
            continue
        total, tes = num(r.get("QT_ACAO_TOTAL_CAP_INTEGR")), num(r.get("QT_ACAO_TOTAL_TESOURO")) or 0
        if total:
            out[(r["CNPJ_CIA"], r["DT_REFER"])] = total - tes
    return out


# ----------------------------------------------------------------- montagem

FIELDS = ("receita", "ebit", "da", "lucro", "fco", "fci", "dividendos")
STOCK = ("ativo", "caixa", "pl_total", "nao_controladores", "divida", "arrendamento")


def pick(idx, cnpj, ini, fim):
    """Valores de um período: consolidado se houver, senão individual.
    Entre os documentos que trazem o período, usa o próprio (DT_REFER == fim) ou o mais recente."""
    for consol in ("con", "ind"):
        docs = idx.get((cnpj, ini, fim, consol))
        if docs:
            return dict(docs.get(fim) or docs[max(docs)])
    return {}


def finalize(flow, bal):
    """Combina fluxo (DRE/DFC) e balanço em um registro com campos derivados."""
    d = {}
    for k in FIELDS:
        if flow.get(k) is not None:
            d[k] = flow[k]
    if "lucro" not in d and flow.get("lucro_consolidado") is not None:
        d["lucro"] = flow["lucro_consolidado"]
    if d.get("ebit") is not None:
        d["ebitda"] = d["ebit"] + (d.get("da") or 0)
    if d.get("fco") is not None and d.get("fci") is not None:
        d["fcf"] = d["fco"] + d["fci"]
    if bal:
        if bal.get("pl_total") is not None:
            d["pl"] = bal["pl_total"] - (bal.get("nao_controladores") or 0)
        if bal.get("divida") is not None:
            d["divida"] = bal["divida"] - (bal.get("arrendamento") or 0)
            d["caixa"] = bal.get("caixa") or 0
        if bal.get("ativo") is not None:
            d["ativo"] = bal["ativo"]
    d.pop("da", None)
    return {k: round(v) for k, v in d.items() if v is not None}


def build(years, cache):
    this_year = date.today().year
    dfp_years = list(range(this_year - years, this_year + 1))
    fca = [p for y in (this_year - 1, this_year) if (p := fetch("FCA", y, cache))]
    tickers, geral = load_registry(fca)
    cnpjs = {t["cnpj"] for t in tickers.values()}
    print(f"{len(tickers)} tickers de {len(cnpjs)} empresas", file=sys.stderr)

    store = Store(cnpjs)
    shares = {}
    for y in dfp_years:
        if p := fetch("DFP", y, cache):
            read_statements(p, "dfp", y, store)
            shares.update(read_shares(p, "dfp", y, cnpjs))
    for y in (this_year - 1, this_year):
        if p := fetch("ITR", y, cache):
            read_statements(p, "itr", y, store)
            shares.update(read_shares(p, "itr", y, cnpjs))

    # índice de períodos por empresa
    periods = defaultdict(set)
    idx = store.index()
    for (cnpj, ini, fim, _c) in idx:
        periods[cnpj].add((ini, fim))
    bal_dates = defaultdict(set)
    for (cnpj, ini, fim, _c) in idx:
        if not ini:
            bal_dates[cnpj].add(fim)

    companies = {}
    for cnpj in cnpjs:
        anos, flows = [], {}
        for y in dfp_years:
            fim = f"{y}-12-31"
            flow = pick(idx, cnpj, f"{y}-01-01", fim)
            if not flow.get("receita") and not flow.get("lucro"):
                continue
            flows[y] = flow
            rec = finalize(flow, pick(idx, cnpj, "", fim))
            rec["ano"] = y
            sh = shares.get((cnpj, fim))
            if sh:
                rec["acoes"] = round(sh)
            anos.append(rec)
        if not anos:
            continue
        # Algumas empresas informam a quantidade de ações em milhares, sem indicar a escala.
        # O lucro por ação (DRE) entrega a quantidade implícita: lucro / LPA.
        votes = []
        for a in anos:
            eps, luc = flows[a["ano"]].get("lpa_basico"), a.get("lucro")
            if a.get("acoes") and eps and luc and luc > 0 and eps > 0:
                votes.append((luc / eps) / a["acoes"])
        share_mult = 1000 if votes and sorted(votes)[len(votes) // 2] > 300 else 1
        if share_mult != 1:
            for a in anos:
                if a.get("acoes"):
                    a["acoes"] *= share_mult

        # últimos 12 meses = último ano fechado + acumulado do ano atual - mesmo acumulado do ano anterior
        last_fy = anos[-1]["ano"]
        ttm = {k: v for k, v in anos[-1].items() if k != "ano"}
        ttm_ref = f"{last_fy}-12-31"
        ytd = sorted(f for (i, f) in periods[cnpj]
                     if i == f[:4] + "-01-01" and int(f[:4]) == last_fy + 1 and not f.endswith("-12-31"))
        if ytd:
            fim = ytd[-1]
            prev_fim = str(last_fy) + fim[4:]
            cur = pick(idx, cnpj, fim[:4] + "-01-01", fim)
            prev = pick(idx, cnpj, prev_fim[:4] + "-01-01", prev_fim)
            fy = flows[last_fy]
            flow = {}
            for k in ("receita", "ebit", "da", "lucro", "lucro_consolidado", "fco", "fci", "dividendos"):
                if k == "dividendos" or k == "da":  # linhas que podem simplesmente não existir no período
                    if fy.get(k) is not None or cur.get(k) is not None:
                        flow[k] = (fy.get(k) or 0) + (cur.get(k) or 0) - (prev.get(k) or 0)
                elif None not in (fy.get(k), cur.get(k), prev.get(k)):
                    flow[k] = fy[k] + cur[k] - prev[k]
            if flow.get("receita") is not None or flow.get("lucro") is not None:
                ttm = finalize(flow, pick(idx, cnpj, "", fim))
                ttm_ref = fim
        # balanço e ações mais recentes
        latest_bal = max(bal_dates[cnpj]) if bal_dates[cnpj] else None
        if latest_bal and latest_bal > ttm_ref:
            ttm.update({k: v for k, v in finalize({}, pick(idx, cnpj, "", latest_bal)).items()})
        sh_dates = sorted(d for (c, d) in shares if c == cnpj)
        if sh_dates:
            ttm["acoes"] = round(shares[(cnpj, sh_dates[-1])] * share_mult)
        ttm.pop("ano", None)
        ttm["ref"] = ttm_ref
        companies[cnpj] = {"anos": anos, "ttm": ttm}
    return tickers, geral, companies


def write(out, tickers, geral, companies):
    os.makedirs(out, exist_ok=True)
    # sem carimbo de horário: os arquivos só mudam quando a CVM publica dados novos
    index = []
    by_cnpj = defaultdict(list)
    for t, info in tickers.items():
        by_cnpj[info["cnpj"]].append(t)
    written = set()
    for t, info in sorted(tickers.items()):
        comp = companies.get(info["cnpj"])
        if not comp:
            continue
        g = geral.get(info["cnpj"], {})
        doc = {
            "ticker": t,
            "nome": info["nome"],
            "cnpj": info["cnpj"],
            "setor": g.get("setor") or "",
            "atividade": g.get("atividade") or "",
            "tipo": info["tipo"],
            "unit": info["unit"],
            "outros_tickers": sorted(x for x in by_cnpj[info["cnpj"]] if x != t),
            "anos": comp["anos"],
            "ttm": comp["ttm"],
            "fonte": "CVM — Portal de Dados Abertos (DFP, ITR e FCA), licença ODbL",
        }
        with open(os.path.join(out, f"{t}.json"), "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
        written.add(t)
        index.append({"t": t, "n": info["nome"], "s": doc["setor"]})
    # remove arquivos de tickers que saíram da bolsa
    for name in os.listdir(out):
        if name.endswith(".json") and name != "index.json" and name[:-5] not in written:
            os.remove(os.path.join(out, name))
    with open(os.path.join(out, "index.json"), "w", encoding="utf-8") as f:
        json.dump({"tickers": index}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(written)} arquivos em {out}", file=sys.stderr)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/fundamentos")
    ap.add_argument("--cache", default="pipeline/.cache")
    ap.add_argument("--years", type=int, default=7, help="anos de DFP a ler (além do corrente)")
    a = ap.parse_args()
    os.makedirs(a.cache, exist_ok=True)
    write(a.out, *build(a.years, a.cache))
