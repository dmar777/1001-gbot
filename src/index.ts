import 'dotenv/config';
import { v4 as uuidv4 } from 'uuid';
import BigNumber from 'bignumber.js';
import {
  GSwap,
  PrivateKeySigner,
  GSwapSDKError,
} from '@gala-chain/gswap-sdk';

// ===== ENV / CONFIG =====
const WALLET_ADDRESS = mustEnv('WALLET_ADDRESS');          // ex: "eth|0x...."
const PRIVATE_KEY = mustEnv('PRIVATE_KEY');                // ex: "0xabc..."

// Atenção: com o SDK os tokens são "collection|category|type|additionalKey"
const BASE_SYMBOL   = process.env.BASE_SYMBOL  || 'GUSDC';
const TARGET_SYMBOL = process.env.TARGET_SYMBOL|| 'GALA';

const TRADE_SIZE = new BigNumber(process.env.TRADE_SIZE || '100');

const CHECK_INTERVAL_MS   = toNum(process.env.CHECK_INTERVAL_MS, 60000);
const MOVE_THRESHOLD_PCT  = new BigNumber(process.env.MOVE_THRESHOLD_PCT || '2');

const TEST_FIRE        = (process.env.TEST_FIRE || 'NO').toUpperCase() === 'YES';
const TEST_INTERVAL_MS = toNum(process.env.TEST_INTERVAL_MS, 300000);
const TEST_AMOUNT_GALA = new BigNumber(process.env.TEST_AMOUNT_GALA || '10');

const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}
function toNum(v: string | undefined, def: number) {
  const n = Number(v); return Number.isFinite(n) && n > 0 ? n : def;
}
function log(level: 'debug'|'info'|'warn'|'error', msg: string) {
  const order = ['debug','info','warn','error'];
  if (order.indexOf(level) < order.indexOf(LOG_LEVEL)) return;
  console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`);
}

// ===== Helpers (histórico BTC 1h) =====
const buf: Array<{ t: number; p: BigNumber }> = [];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchBtcUsd(): Promise<BigNumber> {
  const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
  if (!r.ok) throw new Error(`CoinGecko ${r.status}`);
  const j: any = await r.json();
  return new BigNumber(j.bitcoin.usd);
}
function pushPrice(p: BigNumber) {
  const now = Date.now();
  buf.push({ t: now, p });
  const cutoff = now - 60*60*1000;
  while (buf.length && buf[0].t < cutoff) buf.shift();
}
function pctChange1h(): BigNumber | null {
  if (buf.length < 2) return null;
  const first = buf[0].p, last = buf[buf.length - 1].p;
  if (first.isZero()) return null;
  return last.minus(first).div(first).multipliedBy(100);
}

// ===== SDK setup =====
// O SDK já sabe assinar via PrivateKeySigner e orquestra quote → swap → wait.
// Tokens devem ser passados como "GALA|Unit|none|none" (pipe), vide utilitário do SDK. :contentReference[oaicite:3]{index=3}
const toKey = (sym: string) => `${sym}|Unit|none|none`;
const inKey  = toKey(BASE_SYMBOL);
const outKey = toKey(TARGET_SYMBOL);

const gswap = new GSwap({
  signer: new PrivateKeySigner(PRIVATE_KEY),
  walletAddress: WALLET_ADDRESS
}); // você pode customizar endpoints se quiser, mas o padrão já funciona. :contentReference[oaicite:4]{index=4}

async function swapExactIn(tokenIn: string, tokenOut: string, exactIn: BigNumber, slippage = 0.02) {
  // 1) Quote (o SDK acha a melhor fee tier se você não especificar) :contentReference[oaicite:5]{index=5}
  const q = await gswap.quoting.quoteExactInput(tokenIn, tokenOut, exactIn.toString());
  const minOut = q.outTokenAmount.multipliedBy(1 - slippage); // proteção de slippage

  log('info', `[swap] quote fee=${q.feeTier} out≈${q.outTokenAmount.toString()} minOut=${minOut.toString()}`);

  // 2) Swap (assinatura + envio encapsulados no SDK) :contentReference[oaicite:6]{index=6}
  const pending = await gswap.swaps.swap(
    tokenIn,
    tokenOut,
    q.feeTier,
    { exactIn: exactIn.toString(), amountOutMinimum: minOut.toFixed() },
    WALLET_ADDRESS
  );

  // 3) (Opcional) aguardar conclusão via socket
  // Conecte uma vez no início da app para poder usar wait(): :contentReference[oaicite:7]{index=7}
  try {
    await GSwap.events.connectEventSocket();
  } catch { /* já conectado */ }

  const done = await pending.wait();  // bloqueia até completar
  log('info', `[swap] concluído txHash=${done.transactionHash}`);
}

// ===== Sinal de momentum → compra/venda GALA =====
async function maybeTrade(changePct: BigNumber) {
  if (changePct.gte(MOVE_THRESHOLD_PCT)) {
    // BUY GALA (gasto BASE) → BASE -> GALA
    log('info', `[signal] BTC +${changePct.toFixed(2)}% em 1h → BUY ${TARGET_SYMBOL}`);
    await swapExactIn(inKey, outKey, TRADE_SIZE);
  } else if (changePct.lte(MOVE_THRESHOLD_PCT.negated())) {
    // SELL GALA → GALA -> BASE
    log('info', `[signal] BTC ${changePct.toFixed(2)}% em 1h → SELL ${TARGET_SYMBOL}`);
    await swapExactIn(outKey, inKey, TRADE_SIZE);
  }
}

// ===== Modo de teste: vender X GALA a cada Y min =====
async function fireTestSell() {
  log('info', `[test] vendendo ${TEST_AMOUNT_GALA.toString()} ${TARGET_SYMBOL} → ${BASE_SYMBOL}`);
  await swapExactIn(outKey, inKey, TEST_AMOUNT_GALA);
}

// ===== MAIN LOOP =====
async function main() {
  log('info', `Bot iniciado | Base=${BASE_SYMBOL} | Target=${TARGET_SYMBOL} | TradeSize=${TRADE_SIZE.toString()} | Threshold=${MOVE_THRESHOLD_PCT.toString()}%`);
  if (TEST_FIRE) log('info', `[test] ATIVO: vender ${TEST_AMOUNT_GALA.toString()} ${TARGET_SYMBOL} a cada ${Math.round(TEST_INTERVAL_MS/60000)} min`);

  let nextTestAt = Date.now() + TEST_INTERVAL_MS;

  while (true) {
    try {
      const p = await fetchBtcUsd();
      pushPrice(p);
      const change = pctChange1h();

      if (change !== null) {
        log('info', `BTC $${p.toFixed(2)} | Δ1h=${change.toFixed(2)}% | buffer=${buf.length}`);
        await maybeTrade(change);
      } else {
        log('info', `BTC $${p.toFixed(2)} | coletando histórico... (${buf.length}/~60)`);
      }

      if (TEST_FIRE && Date.now() >= nextTestAt) {
        await fireTestSell();
        nextTestAt = Date.now() + TEST_INTERVAL_MS;
      }

    } catch (err: any) {
      if (err?.code || err instanceof GSwapSDKError) {
        log('error', `[sdk] ${err.code || 'GSWAP_SDK_ERROR'}: ${err.message} ${err.details ? JSON.stringify(err.details) : ''}`);
      } else {
        log('error', `[loop] ${err?.message || err}`);
      }
    }
    await sleep(CHECK_INTERVAL_MS);
  }
}
main().catch(e => { log('error', `Fatal: ${e?.message || e}`); process.exit(1); });
