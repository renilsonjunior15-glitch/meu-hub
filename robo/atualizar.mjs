// Robô diário do Meu Hub (roda no GitHub Actions, Node 20, sem dependências).
// 1. Abre a carteira (apps/carteira.bin) com a chave do hub (secret HUB_KEY).
// 2. Busca cotações (Yahoo Finance), Ibovespa, CDI e IPCA (Banco Central).
// 3. Se houver credenciais do Meu Pluggy, busca contas, lançamentos, faturas e investimentos (Open Finance).
// 4. Calcula custo médio, resultado e comparação com CDI, Ibovespa e IPCA.
// 5. Grava apps/dados.bin criptografado (só o hub, com o seu PIN, consegue ler).
import { readFile, writeFile } from 'node:fs/promises';

const subtle = globalThis.crypto.subtle;
const env = process.env;
const avisos = [];
const hoje = new Date();
const iso = (d) => new Date(d.getTime() - 3 * 3600e3).toISOString().slice(0, 10); // data em Brasília
const HOJE = iso(hoje);
const addDias = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const r2 = (x) => x == null || !isFinite(x) ? null : Math.round(x * 100) / 100;
const r4 = (x) => x == null || !isFinite(x) ? null : Math.round(x * 10000) / 10000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Erros viram anotações do GitHub (aparecem no resumo da execução, sem precisar abrir o log)
const falha = (msg) => { console.log('::error::' + String(msg).replace(/\r?\n/g, '%0A')); process.exit(1); };
process.on('unhandledRejection', (e) => falha('Erro: ' + (e && e.stack || e)));
process.on('uncaughtException', (e) => falha('Erro: ' + (e && e.stack || e)));

/* ---------------- cripto (mesmo formato do hub: sal|iv|hmac|aes-cbc) ---------------- */
const KEY = Buffer.from(env.HUB_KEY || '', 'base64');
if (KEY.length !== 64) falha('HUB_KEY ausente ou inválida (precisa ter 64 bytes em base64).');
async function decrypt(u8) {
  const iv = u8.subarray(16, 32), mac = u8.subarray(32, 64), ct = u8.subarray(64);
  const mk = await subtle.importKey('raw', KEY.subarray(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const ok = await subtle.verify('HMAC', mk, mac, Buffer.concat([iv, ct]));
  if (!ok) throw new Error('HUB_KEY não abre a carteira (PIN diferente?)');
  const ek = await subtle.importKey('raw', KEY.subarray(0, 32), 'AES-CBC', false, ['decrypt']);
  return Buffer.from(await subtle.decrypt({ name: 'AES-CBC', iv }, ek, ct)).toString('utf8');
}
async function encrypt(text, salt) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const ek = await subtle.importKey('raw', KEY.subarray(0, 32), 'AES-CBC', false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, ek, Buffer.from(text, 'utf8')));
  const mk = await subtle.importKey('raw', KEY.subarray(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await subtle.sign('HMAC', mk, Buffer.concat([iv, ct])));
  return Buffer.concat([salt, iv, mac, ct]);
}

/* ---------------- HTTP ---------------- */
async function getJSON(url, opts = {}, tentativas = 3) {
  let ultimo;
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(url, { ...opts, headers: { 'user-agent': 'Mozilla/5.0 (meu-hub)', accept: 'application/json', ...(opts.headers || {}) } });
      if (r.ok) return await r.json();
      ultimo = new Error(`HTTP ${r.status} em ${url.split('?')[0]}`);
      if (r.status < 500 && r.status !== 429) break;
    } catch (e) { ultimo = e; }
    await sleep(1500 * (i + 1));
  }
  throw ultimo;
}

/* ---------------- mercado ---------------- */
async function historico(simbolo, desde) {
  const p1 = Math.floor(new Date(desde + 'T00:00:00Z').getTime() / 1000);
  const p2 = Math.floor(Date.now() / 1000) + 86400;
  const path = `/v8/finance/chart/${encodeURIComponent(simbolo)}?period1=${p1}&period2=${p2}&interval=1d&events=div`;
  let j;
  try { j = await getJSON('https://query1.finance.yahoo.com' + path); }
  catch { j = await getJSON('https://query2.finance.yahoo.com' + path); }
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('sem dados para ' + simbolo);
  const ts = res.timestamp || [], cl = (res.indicators.quote[0] || {}).close || [];
  const fech = [];
  ts.forEach((t, i) => { if (cl[i] != null) fech.push([iso(new Date(t * 1000)), cl[i]]); });
  // remove duplicatas de data (fica a última)
  const m = new Map(fech); const serie = [...m.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
  const divs = res.events && res.events.dividends ? Object.values(res.events.dividends).map((d) => [iso(new Date(d.date * 1000)), d.amount]) : [];
  return { serie, preco: res.meta.regularMarketPrice, nome: res.meta.longName || res.meta.shortName || simbolo, max52: res.meta.fiftyTwoWeekHigh, divs };
}
function precoEm(serie, data) { // último fechamento até a data
  let v = null; for (const [d, p] of serie) { if (d <= data) v = p; else break; } return v;
}
const brData = (s) => { const [d, m, a] = s.split('/'); return `${a}-${m}-${d}`; };
const fmtBr = (s) => s.split('-').reverse().join('/');
async function sgs(serie, desde) {
  const j = await getJSON(`https://api.bcb.gov.br/dados/serie/bcdata.sgs.${serie}/dados?formato=json&dataInicial=${fmtBr(desde)}&dataFinal=${fmtBr(HOJE)}`);
  return j.map((x) => [brData(x.data), parseFloat(x.valor)]);
}
function cdiFator(cdi, de, ate, mult = 1) { // rende nos dias úteis com de <= dia < ate
  let f = 1; for (const [d, v] of cdi) { if (d >= de && d < ate) f *= 1 + (v / 100) * mult; } return f;
}
function ipcaFator(ipca, de, ate) { // proporcional aos dias de cada mês; meses ainda não divulgados contam 0
  let f = 1;
  for (const [d, v] of ipca) {
    const ini = d, fim = nextMonth(d);
    const a = ini > de ? ini : de, b = fim < ate ? fim : ate;
    if (b <= a) continue;
    const diasMes = (Date.parse(fim) - Date.parse(ini)) / 864e5, dias = (Date.parse(b) - Date.parse(a)) / 864e5;
    f *= Math.pow(1 + v / 100, dias / diasMes);
  }
  return f;
}
function nextMonth(d) { const [a, m] = d.split('-').map(Number); return m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, '0')}-01`; }

/* ---------------- Open Finance (Meu Pluggy) ---------------- */
const CATEG = {
  'Groceries': 'Mercado', 'Supermarket': 'Mercado', 'Restaurants': 'Restaurantes', 'Eating out': 'Restaurantes', 'Food delivery': 'Delivery',
  'Transfers': 'Transferências', 'Transfer - PIX': 'Pix', 'Same person transfer': 'Transferência entre contas', 'Transfer - TED': 'TED', 'Transfer - Bank slip': 'Boleto',
  'Credit card payment': 'Pagamento de fatura', 'Salary': 'Salário', 'Income': 'Renda', 'Retirement': 'Aposentadoria', 'Investments': 'Investimentos',
  'Fixed income': 'Renda fixa', 'Variable income': 'Renda variável', 'Proceeds interests and dividends': 'Proventos', 'Interests charged': 'Juros',
  'Shopping': 'Compras', 'Online shopping': 'Compras online', 'Clothing': 'Roupas', 'Electronics': 'Eletrônicos', 'Gas stations': 'Combustível',
  'Taxi and ride-hailing': 'Transporte (app)', 'Public transportation': 'Transporte público', 'Transportation': 'Transporte', 'Parking': 'Estacionamento',
  'Pharmacy': 'Farmácia', 'Health': 'Saúde', 'Hospital clinics and labs': 'Saúde', 'Dentist': 'Dentista', 'Telecommunications': 'Telefone e internet',
  'Internet': 'Internet', 'Mobile': 'Celular', 'Electricity': 'Energia', 'Water': 'Água', 'Rent': 'Aluguel', 'Housing': 'Moradia', 'Utilities': 'Contas da casa',
  'Education': 'Educação', 'School': 'Escola', 'Leisure': 'Lazer', 'Entertainment': 'Lazer', 'Streaming': 'Streaming', 'Digital services': 'Serviços digitais',
  'Bank fees': 'Tarifas bancárias', 'Taxes': 'Impostos', 'Tax on financial operations': 'IOF', 'Insurance': 'Seguros', 'Loans': 'Empréstimos',
  'Travel': 'Viagem', 'Gym and fitness centers': 'Academia', 'Pets': 'Pets', 'Donations': 'Doações', 'Services': 'Serviços', 'Withdrawal': 'Saque', 'Bets': 'Apostas'
};
async function openFinance() {
  const id = env.PLUGGY_CLIENT_ID, sec = env.PLUGGY_CLIENT_SECRET;
  const items = (env.PLUGGY_ITEMS || '').split(/[\s,;]+/).filter(Boolean);
  if (!id || !sec || !items.length) return null;
  const BASE = 'https://api.pluggy.ai';
  const auth = await getJSON(BASE + '/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: id, clientSecret: sec }) }, 2);
  const H = { headers: { 'X-API-KEY': auth.apiKey } };
  const out = { bancos: [], contas: [], transacoes: [], faturas: [], investimentos: [] };
  const de = addDias(HOJE, -90);
  for (const itemId of items) {
    let banco = 'Banco';
    try {
      const it = await getJSON(`${BASE}/items/${itemId}`, H, 2);
      banco = (it.connector && it.connector.name) || banco;
      out.bancos.push({ banco, status: it.status, execucao: it.executionStatus, atualizado_em: it.lastUpdatedAt || it.updatedAt || null });
      if (it.status && !['UPDATED', 'UPDATING'].includes(it.status)) avisos.push(`Open Finance: ${banco} está "${it.status}". Pode ser preciso renovar a autorização no Meu Pluggy.`);
      const contas = (await getJSON(`${BASE}/accounts?itemId=${itemId}`, H, 2)).results || [];
      for (const c of contas) {
        const cartao = c.type === 'CREDIT';
        out.contas.push({
          banco, id: c.id, nome: c.marketingName || c.name, tipo: cartao ? 'Cartão de crédito' : (c.subtype === 'SAVINGS_ACCOUNT' ? 'Poupança' : 'Conta corrente'),
          saldo: r2(c.balance), limite: c.creditData ? r2(c.creditData.creditLimit) : null, disponivel: c.creditData ? r2(c.creditData.availableCreditLimit) : null,
          vencimento: c.creditData ? c.creditData.balanceDueDate || null : null, fechamento: c.creditData ? c.creditData.balanceCloseDate || null : null
        });
        let url = `${BASE}/v2/transactions?accountId=${c.id}&dateFrom=${de}&dateTo=${HOJE}`;
        for (let p = 0; url && p < 60; p++) {
          const pg = await getJSON(url, H, 2);
          for (const t of pg.results || []) {
            const cm = t.creditCardMetadata || {};
            // conta: negativo = saída; cartão: positivo = compra. Aqui: negativo = saída sempre.
            const valor = cartao ? -t.amount : t.amount;
            out.transacoes.push({
              data: (t.date || '').slice(0, 10), descricao: t.description, valor: r2(valor), categoria: CATEG[t.category] || t.category || 'Outros',
              categoria_original: t.category || null, banco, conta: c.marketingName || c.name, cartao, pendente: t.status === 'PENDING',
              parcelas: cm.totalInstallments || null, parcela: cm.installmentNumber || null
            });
          }
          url = pg.next ? `${BASE}/v2/transactions${pg.next.startsWith('?') ? '' : '?'}${pg.next}&dateFrom=${de}&dateTo=${HOJE}` : null;
        }
        if (cartao) {
          try {
            const bills = (await getJSON(`${BASE}/bills?accountId=${c.id}`, H, 2)).results || [];
            bills.slice(-6).forEach((b) => out.faturas.push({ banco, conta: c.marketingName || c.name, fechamento: (b.billClosingDate || '').slice(0, 10) || null, vencimento: (b.dueDate || '').slice(0, 10), total: r2(b.totalAmount) }));
          } catch (e) { avisos.push(`Faturas de ${banco}: ${e.message}`); }
        }
      }
      try {
        const inv = (await getJSON(`${BASE}/investments?itemId=${itemId}`, H, 2)).results || [];
        inv.forEach((v) => out.investimentos.push({ banco, nome: v.name, codigo: v.code || null, tipo: v.type, subtipo: v.subtype || null, qtd: v.quantity ?? null, valor: r2(v.balance ?? v.value ?? v.amount), valor_original: r2(v.amountOriginal ?? null), rendimento: r2(v.amountProfit ?? null) }));
      } catch (e) { avisos.push(`Investimentos de ${banco}: ${e.message}`); }
    } catch (e) { avisos.push(`Open Finance (${banco}): ${e.message}`); }
  }
  out.transacoes.sort((a, b) => (a.data < b.data ? 1 : -1));
  return out;
}

/* ---------------- principal ---------------- */
const cartBin = await readFile('apps/carteira.bin');
const salt = cartBin.subarray(0, 16);
const cart = JSON.parse(await decrypt(cartBin));
const lotes = [...cart.lotes].sort((a, b) => (a.data < b.data ? -1 : 1));
const rf = cart.renda_fixa || [];
const inicio = [...lotes.map((l) => l.data), ...rf.map((r) => r.data)].sort()[0];
const desde12m = addDias(HOJE, -372);
const desde = inicio < desde12m ? inicio : desde12m;

const tickers = [...new Set(lotes.map((l) => l.ativo))];
const hist = {};
for (const t of tickers) {
  try { hist[t] = await historico(t + '.SA', addDias(desde, -7)); }
  catch (e) { avisos.push(`Cotação de ${t}: ${e.message}`); }
  await sleep(300);
}
let ibov = null; try { ibov = await historico('^BVSP', addDias(desde, -7)); } catch (e) { avisos.push('Ibovespa: ' + e.message); }
let cdi = []; try { cdi = await sgs(12, desde); } catch (e) { avisos.push('CDI: ' + e.message); }
let ipca = []; try { ipca = await sgs(433, addDias(desde, -40)); } catch (e) { avisos.push('IPCA: ' + e.message); }
let ipca12 = null; try { const x = await sgs(13522, addDias(HOJE, -70)); ipca12 = x.length ? x[x.length - 1] : null; } catch (e) { avisos.push('IPCA 12 meses: ' + e.message); }
let selic = null; try { const x = await sgs(432, addDias(HOJE, -10)); selic = x.length ? x[x.length - 1][1] : null; } catch {}

if (!Object.keys(hist).length || !ibov) falha('Sem cotações; dados antigos mantidos. ' + avisos.join(' | '));

const dataRef = ibov.serie[ibov.serie.length - 1][0]; // último pregão
const bench = (tipo, valor, de, ate) => {
  if (tipo === 'cdi') return valor * cdiFator(cdi, de, ate);
  if (tipo === 'ibov') { const a = precoEm(ibov.serie, de), b = precoEm(ibov.serie, ate); return a && b ? valor * b / a : null; }
  if (tipo === 'ipca') return valor * ipcaFator(ipca, de, ate);
};

// posições, custo médio (vendas não mudam o custo médio)
const pos = {};
for (const l of lotes) {
  const p = pos[l.ativo] || (pos[l.ativo] = { ativo: l.ativo, tipo: l.tipo, qtd: 0, custo: 0, realizado: 0, primeira: l.data, lotes: [] });
  if (l.qtd >= 0) { p.qtd += l.qtd; p.custo += l.qtd * l.preco; }
  else { const pm = p.qtd ? p.custo / p.qtd : 0, q = -l.qtd; p.realizado += (l.preco - pm) * q; p.custo -= pm * q; p.qtd -= q; }
  p.lotes.push(l);
}
const varPct = (serie, dias) => {
  if (!serie || serie.length < 2) return null;
  const ult = serie[serie.length - 1];
  const ref = dias === 1 ? serie[serie.length - 2][1] : precoEm(serie, addDias(ult[0], -dias));
  return ref ? r2((ult[1] / ref - 1) * 100) : null;
};
const ativos = Object.values(pos).filter((p) => p.qtd > 0.000001).map((p) => {
  const h = hist[p.ativo];
  const cot = h ? h.serie[h.serie.length - 1][1] : null;
  const valor = cot != null ? cot * p.qtd : null;
  const fluxos = p.lotes.map((l) => [l.data, l.qtd * l.preco]);
  const comp = (tipo) => { const v = fluxos.reduce((s, [d, a]) => s + (bench(tipo, a, d, HOJE) ?? a), 0); return r2((v / p.custo - 1) * 100); };
  const provs = h ? h.divs.filter(([d]) => d >= p.primeira).reduce((s, [, a]) => s + a * p.qtd, 0) : 0;
  return {
    ativo: p.ativo, nome: h ? h.nome : p.ativo, tipo: p.tipo, qtd: p.qtd, custo_medio: r4(p.custo / p.qtd), investido: r2(p.custo),
    cotacao: r2(cot), data_cotacao: h ? h.serie[h.serie.length - 1][0] : null,
    var_dia_pct: varPct(h && h.serie, 1), var_7d_pct: varPct(h && h.serie, 7), var_30d_pct: varPct(h && h.serie, 30),
    valor: r2(valor), resultado: r2(valor - p.custo), resultado_pct: r2((valor / p.custo - 1) * 100),
    proventos_estimados: r2(provs), resultado_com_proventos_pct: r2(((valor + provs) / p.custo - 1) * 100),
    cdi_mesmo_periodo_pct: comp('cdi'), ibov_mesmo_periodo_pct: comp('ibov'), ipca_mesmo_periodo_pct: comp('ipca'),
    primeira_compra: p.primeira, realizado: r2(p.realizado),
    historico: h ? h.serie.filter(([d]) => d >= addDias(p.primeira, -5)).map(([d, v]) => [d, r2(v)]) : []
  };
}).sort((a, b) => (b.valor || 0) - (a.valor || 0));

const rendaFixa = rf.map((r) => {
  const f = cdiFator(cdi, r.data, HOJE, (r.pct_cdi || 100) / 100);
  return { nome: r.nome, data: r.data, vencimento: r.vencimento || null, aplicado: r2(r.aplicado), pct_cdi: r.pct_cdi, valor_bruto: r2(r.aplicado * f), rendimento: r2(r.aplicado * (f - 1)), rendimento_pct: r2((f - 1) * 100) };
});

// série diária: quanto valeria hoje o mesmo dinheiro em cada alternativa
const fluxosTodos = [...lotes.map((l) => [l.data, l.qtd * l.preco]), ...rf.map((r) => [r.data, r.aplicado])].sort((a, b) => (a[0] < b[0] ? -1 : 1));
const datas = ibov.serie.map(([d]) => d).filter((d) => d >= inicio);
if (datas[datas.length - 1] !== HOJE && HOJE > datas[datas.length - 1]) { /* antes do pregão: o último ponto é o fechamento anterior */ }
const serie = datas.map((d) => {
  const fl = fluxosTodos.filter(([fd]) => fd <= d);
  const investido = fl.reduce((s, [, a]) => s + a, 0);
  let carteira = 0;
  for (const p of Object.values(pos)) {
    const q = p.lotes.filter((l) => l.data <= d).reduce((s, l) => s + l.qtd, 0);
    const h = hist[p.ativo]; const pr = h ? precoEm(h.serie, d) : null;
    carteira += q * (pr ?? 0);
  }
  for (const r of rf) if (r.data <= d) carteira += r.aplicado * cdiFator(cdi, r.data, addDias(d, 1), (r.pct_cdi || 100) / 100);
  const b = (t) => fl.reduce((s, [fd, a]) => s + (bench(t, a, fd, addDias(d, 1)) ?? a), 0);
  return { data: d, investido: r2(investido), carteira: r2(carteira), cdi: r2(b('cdi')), ibov: r2(b('ibov')), ipca: r2(b('ipca')) };
});

const tot = serie[serie.length - 1];
const pct = (v) => r2((v / tot.investido - 1) * 100);
const cdi12 = r2((cdiFator(cdi, addDias(HOJE, -365), HOJE) - 1) * 100);
const ib12a = precoEm(ibov.serie, addDias(dataRef, -365)), ibUlt = ibov.serie[ibov.serie.length - 1][1];

let of = null;
try { of = await openFinance(); } catch (e) { avisos.push('Open Finance: ' + e.message); }

const dados = {
  gerado_em: new Date().toISOString(),
  data_referencia: dataRef,
  mercado: {
    ibov: r2(ibUlt), ibov_var_dia_pct: varPct(ibov.serie, 1), ibov_12m_pct: ib12a ? r2((ibUlt / ib12a - 1) * 100) : null,
    cdi_dia_pct: cdi.length ? cdi[cdi.length - 1][1] : null, cdi_12m_pct: cdi12, selic_meta: selic,
    ipca_ultimo: ipca.length ? { mes: ipca[ipca.length - 1][0].slice(0, 7), pct: ipca[ipca.length - 1][1] } : null,
    ipca_12m_pct: ipca12 ? ipca12[1] : null
  },
  carteira: {
    inicio, investido: tot.investido, valor: tot.carteira, resultado: r2(tot.carteira - tot.investido), resultado_pct: pct(tot.carteira),
    cdi_pct: pct(tot.cdi), ibov_pct: pct(tot.ibov), ipca_pct: pct(tot.ipca),
    cdi_valor: tot.cdi, ibov_valor: tot.ibov, ipca_valor: tot.ipca,
    variacao_dia: r2(ativos.reduce((s, a) => s + (a.var_dia_pct != null && a.valor != null ? a.valor - a.valor / (1 + a.var_dia_pct / 100) : 0), 0)),
    ativos, renda_fixa: rendaFixa, serie
  },
  openfinance: of,
  avisos
};

await writeFile('apps/dados.bin', await encrypt(JSON.stringify(dados), salt));
console.log(`OK ${dados.gerado_em} · ref ${dataRef} · ${ativos.length} ativos · carteira ${tot.carteira} (${pct(tot.carteira)}%) · CDI ${pct(tot.cdi)}% · IBOV ${pct(tot.ibov)}% · IPCA ${pct(tot.ipca)}% · Open Finance: ${of ? of.contas.length + ' contas, ' + of.transacoes.length + ' lançamentos' : 'não configurado'}`);
if (avisos.length) console.log('::warning::' + avisos.join(' | '));
