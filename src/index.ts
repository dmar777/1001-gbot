import 'dotenv/config';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import BigNumber from 'bignumber.js';
import { signObject } from './sign.js';

// ===== ENV / CONFIG =====
const DEX_BASE_URL = process.env.DEX_BASE_URL || 'https://dex-backend-prod1.defi.gala.com';
const WALLET_ADDRESS = mustEnv('WALLET_ADDRESS');
const PRIVATE_KEY = mustEnv('PRIVATE_KEY');

const BASE_SYMBOL = process.env.BASE_SYMBOL || 'GUSDC';
const TARGET_SYMBOL = process.env.TARGET_SYMBOL || 'GALA';
const TRADE_SIZE = new BigNumber(process.env.TRADE_SIZE || '50');

const CHECK_INTERVAL_MS = toNum(process.env.CHECK_INTERVAL_MS, 60000);
const MOVE_THRESHOLD_PCT = new BigNumber(process.env.MOVE_THRESHOLD_PCT || '2');
const BTC_PRICE_SOURCE = (process.env.BTC_PRICE_SOURCE || 'coingecko').toLowerCase() as 'coingecko'|'coinmarketcap';
const CMC_API_KEY = process.env.CMC_API_KEY || '';

const TEST_FIRE = (process.env.TEST_FIRE || 'NO').toUpperCase() === 'YES';
const TEST_INTERVAL_MS = toNum(process.env.TEST_INTERVAL_MS, 300000);
const TEST_AMOUNT_GALA = new BigNumber(process.env.TEST_AMOUNT_GALA || '10');

const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

// ===== UTILS =====
function log(level: 'debug'|'info'|'warn'|'error', msg: string) {
  const levels = ['debug', 'info', 'warn', 'error'];
  if (levels.indexOf(level) < levels.indexOf(LOG_LEVEL)) return;
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level.toUpperCase()}] ${msg}`);
}
function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}
function toNum(v: string | undefined, def: number) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const compKey = (sym: string) => `${sym}$Unit$none$none`; // chave composta usada nos endpoints GalaSwap V3
const feeTiers = [500, 3000, 10000] as const;

function short(s: string, max = 800) { return s.length > max ? s.slice(0, max) + '…' : s; }

async function fetchJsonVerbose(url: string, init: RequestInit, ctx: string) {
  const res = await fetch(url, init);
  const bodyText = await res.text(); // sempre captura texto para log
  if (!res.ok) {
    log('error', `[http:${ctx}] ${res.status} ${res.statusText} | url=${url}`);
    log('error', `[http:${ctx}] response=${short(bodyText)}`);
    let parsed: any; try { parsed = JSON.parse(bodyText); } catch {}
    const errMsg = parsed?.message || parsed?.error || bodyText || `HTTP ${res.status}`;
    throw new Error(`${ctx} ${res.status}: ${errMsg}`);
  }
  try { return JSON.parse(bodyText); }
  catch {
    log('error', `[http:${ctx}] JSON parse error, body=${short(bodyText)}`);
    throw new Error(`${ctx}: invalid JSON`);
  }
}

// ===== Types =====
type QuoteResp = {
  status: number; error: boolean; message: string;
  data?: { currentSqrtPrice: string; newSqrtPrice: string; fee: number; amountIn?: string; amountOut?: string; }
};
type SwapPayloadResp = { status: number; error: boolean; message: string; data?: any; };
type BundleResp = { status: number; error: boolean; message: string; data?: { data: string; message: string; error: boolean; } };

// ===== BTC 1h buffer =====
const buf: Array<{ t: number; p: BigNumber }> = [];
function pushPrice(p: BigNumber) {
  const now = Date.now();
  buf.push({ t: now, p });
  const oneHourAgo = now - 60 * 60 * 1000;
  while (buf.length && buf[0].t < oneHourAgo) buf.shift();
}
function pctChange1h(): BigNumber | null {
  if (buf.length < 2) return null;
  const first = buf[0].p, last = buf[buf.length - 1].p;
  if (first.isZero()) return null;
  return last.minus(first).div(first).multipliedBy(100);
}

// ===== BTC price =====
async function fetchBtcUsd(): Promise<BigNumber> {
  if (BTC_PRICE_SOURCE === 'coinmarketcap') {
    if (!CMC_API_KEY) throw new Error('Defina CMC_API_KEY para usar CoinMarketCap');
    const r = await fetch('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=BTC&convert=USD', {
      headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY }
    });
    if (!r.ok) throw new Error(`CoinMarketCap ${r.status}`);
    const j = (await r.json()) as any;
    return new BigNumber(j.data.BTC.quote.USD.price);
  } else {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
    if (!r.ok) throw new Error(`CoinGecko ${r.status}`);
    const j = (await r.json()) as any;
    return new BigNumber(j.bitcoin.usd);
  }
}

// ===== GalaSwap V3 =====
async function bestQuoteForAmountIn(tokenIn: string, tokenOut: string, amountIn: BigNumber) {
  let best: { fee: number; amountOut: BigNumber; amountIn: BigNumber } | null = null;

  for (const fee of feeTiers) {
    const url = new URL(`${DEX_BASE_URL}/v1/trade/quote`);
    url.searchParams.set('tokenIn', tokenIn);
    url.searchParams.set('tokenOut', tokenOut);
    url.searchParams.set('amountIn', amountIn.toString());
    url.searchParams.set('fee', String(fee));

    const ctx = `quote fee=${fee}`;
    try {
      const q = await fetchJsonVerbose(url.toString(), { method: 'GET' }, ctx) as QuoteResp;
      const out = q?.data?.amountOut ? new BigNumber(q.data.amountOut) : null;
      log('debug', `[${ctx}] amountOut=${out?.toString() ?? 'null'} tokenIn=${tokenIn} tokenOut=${tokenOut} amountIn=${amountIn.toString()}`);
      if (out && (!best || out.gt(best.amountOut))) best = { fee, amountOut: out, amountIn };
    } catch (e: any) {
      log('warn', `[${ctx}] erro: ${e?.message || e}`);
    }
  }

  if (!best) {
    log('error', `[quote] nenhuma fee retornou quote válida para amountIn=${amountIn.toString()} tokenIn=${tokenIn} tokenOut=${tokenOut}`);
  }
  return best;
}

async function createSwapPayload(params: {
  tokenIn: string; tokenOut: string; amountIn: string; fee: number;
  sqrtPriceLimit?: string; amountInMaximum?: string; amountOutMinimum?: string;
}) {
  const ctx = `swap payload tokenIn=${params.tokenIn} tokenOut=${params.tokenOut} fee=${params.fee} amountIn=${params.amountIn} minOut=${params.amountOutMinimum ?? 'n/a'}`;
  log('info', `[${ctx}] preparando payload`);
  const j = await fetchJsonVerbose(
    `${DEX_BASE_URL}/v1/trade/swap`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) },
    ctx
  ) as SwapPayloadResp;

  if (j.error || !j.data) throw new Error(`${ctx}: ${j.message || 'erro desconhecido'}`);
  log('debug', `[${ctx}] payload ok`);
  return j.data;
}

async function submitBundle(payload: any, type: 'swap'|'addLiquidity'|'removeLiquidity'|'collect'|'createPool' = 'swap') {
  const uniqueKey = `galaswap-operation-${uuidv4()}`;
  const signed = signObject({ ...payload, uniqueKey }, PRIVATE_KEY);
  const body = { payload: signed, type, signature: signed.signature, user: WALLET_ADDRESS };
  const ctx = `bundle type=${type} uniqueKey=${uniqueKey.slice(0,18)}…`;

  const j = await fetchJsonVerbose(
    `${DEX_BASE_URL}/v1/trade/bundle`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    ctx
  ) as BundleResp;

  if (j.error) throw new Error(`${ctx}: ${j.message}`);
  log('info', `[${ctx}] enviado com sucesso txId=${j.data?.data ?? 'n/a'}`);
  return j.data?.data;
}

// ===== Estratégia: BTC momentum → buy/sell GALA =====
async function maybeTrade(changePct: BigNumber) {
  const base = compKey(BASE_SYMBOL);
  const gala = compKey(TARGET_SYMBOL);

  if (changePct.gte(MOVE_THRESHOLD_PCT)) {
    log('info', `[signal] BTC +${changePct.toFixed(2)}% em 1h → BUY ${TARGET_SYMBOL}`);
    const best = await bestQuoteForAmountIn(base, gala, TRADE_SIZE);
    if (!best) return;
    const minOut = best.amountOut.multipliedBy(0.98);
    const payload = await createSwapPayload({
      tokenIn: base, tokenOut: gala, amountIn: TRADE_SIZE.toString(), fee: best.fee,
      amountOutMinimum: minOut.toString()
    });
    const txId = await submitBundle(payload, 'swap');
    log('info', `Swap enviado (BUY) → txId: ${txId}`);
  } else if (changePct.lte(MOVE_THRESHOLD_PCT.negated())) {
    log('info', `[signal] BTC ${changePct.toFixed(2)}% em 1h → SELL ${TARGET_SYMBOL}`);
    const best = await bestQuoteForAmountIn(gala, base, TRADE_SIZE);
    if (!best) return;
    const minOut = best.amountOut.multipliedBy(0.98);
    const payload = await createSwapPayload({
      tokenIn: gala, tokenOut: base, amountIn: TRADE_SIZE.toString(), fee: best.fee,
      amountOutMinimum: minOut.toString()
    });
    const txId = await submitBundle(payload, 'swap');
    log('info', `Swap enviado (SELL) → txId: ${txId}`);
  }
}

// ===== Test mode: periodic GALA sell =====
async function fireTestSell() {
  const gala = compKey(TARGET_SYMBOL);
  const base = compKey(BASE_SYMBOL);

  log('info', `[test] vendendo ${TEST_AMOUNT_GALA.toString()} ${TARGET_SYMBOL} -> ${BASE_SYMBOL} (keys: in=${gala} out=${base})`);

  const best = await bestQuoteForAmountIn(gala, base, TEST_AMOUNT_GALA);
  if (!best) { log('warn', '[test] sem quote válida em nenhuma fee'); return; }

  const minOut = best.amountOut.multipliedBy(0.98);
  log('info', `[test] melhor fee=${best.fee} quoteOut=${best.amountOut.toString()} minOut=${minOut.toString()}`);

  const payload = await createSwapPayload({
    tokenIn: gala,
    tokenOut: base,
    amountIn: TEST_AMOUNT_GALA.toString(),
    fee: best.fee,
    amountOutMinimum: minOut.toString()
  });

  const txId = await submitBundle(payload, 'swap');
  log('info', `[test] swap enviado → txId=${txId}`);
}

// ===== MAIN =====
async function main() {
  log('info', 'GalaSwap V3 Momentum Bot iniciado');
  log('info', `Base=${BASE_SYMBOL} | Target=${TARGET_SYMBOL} | TradeSize=${TRADE_SIZE.toString()} | Threshold=${MOVE_THRESHOLD_PCT.toString()}%`);
  if (TEST_FIRE) log('info', `[test] ATIVO: vender ${TEST_AMOUNT_GALA.toString()} ${TARGET_SYMBOL} a cada ${Math.round(TEST_INTERVAL_MS/60000)} min`);

  let nextTestAt = Date.now() + TEST_INTERVAL_MS;

  while (true) {
    try {
      const price = await fetchBtcUsd();
      pushPrice(price);
      const change = pctChange1h();

      if (change !== null) {
        log('info', `BTC $${price.toFixed(2)} | Δ1h=${change.toFixed(2)}% | buffer=${buf.length}`);
        await maybeTrade(change);
      } else {
        log('info', `BTC $${price.toFixed(2)} | coletando histórico... (${buf.length}/~60)`);
      }

      if (TEST_FIRE && Date.now() >= nextTestAt) {
        await fireTestSell();
        nextTestAt = Date.now() + TEST_INTERVAL_MS;
      }
    } catch (e: any) {
      log('error', `[loop] ${e?.message || e}`);
    }
    await sleep(CHECK_INTERVAL_MS);
  }
}

main().catch(err => {
  log('error', `Fatal: ${err?.message || err}`);
  process.exit(1);
});
