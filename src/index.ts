import 'dotenv/config';
import BigNumber from 'bignumber.js';
import { GSwap, PrivateKeySigner, GSwapSDKError } from '@gala-chain/gswap-sdk';
import { ArbitrageScanner } from './arbitrageScanner.js';

// ===== ENV helpers =====
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase() as 'debug'|'info'|'warn'|'error';
function log(level: 'debug'|'info'|'warn'|'error', msg: string) {
  const order = ['debug','info','warn','error'] as const;
  if (order.indexOf(level) < order.indexOf(LOG_LEVEL)) return;
  console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`);
}
function mustEnv(name: string) { const v = process.env[name]; if (!v) throw new Error(`Missing env: ${name}`); return v; }
function toNum(v: string | undefined, def: number) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : def; }

// ===== Wallet / SDK =====
const WALLET_ADDRESS = mustEnv('WALLET_ADDRESS');
const PRIVATE_KEY   = mustEnv('PRIVATE_KEY');

const gswap = new GSwap({
  signer: new PrivateKeySigner(PRIVATE_KEY),
  walletAddress: WALLET_ADDRESS
});

// ===== Arbitrage Scanner Config =====
const ARB_SCAN_ENABLED       = (process.env.ARB_SCAN_ENABLED || 'YES').toUpperCase() === 'YES';
const ARB_SCAN_INTERVAL_MS   = toNum(process.env.ARB_SCAN_INTERVAL_MS, 60000);
const ARB_PROBE_USD          = new BigNumber(process.env.ARB_PROBE_USD || '10');
const ARB_MAX_HOPS           = Math.max(2, Math.min(3, Number(process.env.ARB_MAX_HOPS || '3'))) as 2|3;
const ARB_FEE_TIERS          = (process.env.ARB_FEE_TIERS || '500,3000,10000').split(',').map(s => Number(s.trim())) as Array<500|3000|10000>;
const ARB_MIN_PROFIT_BPS     = Number(process.env.ARB_MIN_PROFIT_BPS || '10');
const ARB_SLIPPAGE_PCT       = Number(process.env.ARB_SLIPPAGE_PCT || '0.5');
const ARB_TOKENS_ALLOWLIST   = (process.env.ARB_TOKENS_ALLOWLIST || 'GUSDC,GALA,GWETH,GWBTC').split(',').map(s => s.trim()).filter(Boolean);

// NOVOS controles de log
const ARB_LOG_SEARCHED_PAIRS = (process.env.ARB_LOG_SEARCHED_PAIRS || 'YES').toUpperCase() === 'YES';
const ARB_LOG_SEARCHED_MAX   = toNum(process.env.ARB_LOG_SEARCHED_MAX, 50);

// Momentum (mantido, mas desligado por padrão aqui)
const MOMENTUM_ENABLED = (process.env.MOMENTUM_ENABLED || 'NO').toUpperCase() === 'YES';

// Apenas para compatibilidade/registro
const BASE_SYMBOL   = process.env.BASE_SYMBOL   || 'GUSDC';
const TARGET_SYMBOL = process.env.TARGET_SYMBOL || 'GALA';
const TRADE_SIZE    = new BigNumber(process.env.TRADE_SIZE || '100');

// ===== BTC histórico (se usar momentum futuramente) =====
const CHECK_INTERVAL_MS  = toNum(process.env.CHECK_INTERVAL_MS, 60000);
const MOVE_THRESHOLD_PCT = new BigNumber(process.env.MOVE_THRESHOLD_PCT || '2');
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
  const cutoff = now - 60*60*1000; // 1h
  while (buf.length && buf[0].t < cutoff) buf.shift();
}
function pctChange1h(): BigNumber | null {
  if (buf.length < 2) return null;
  const first = buf[0].p, last = buf[buf.length - 1].p;
  if (first.isZero()) return null;
  return last.minus(first).div(first).multipliedBy(100);
}

// ===== Arbitrage scanner instance =====
const scanner = new ArbitrageScanner(gswap, {
  enabled: ARB_SCAN_ENABLED,
  intervalMs: ARB_SCAN_INTERVAL_MS,
  probeUsd: ARB_PROBE_USD,
  maxHops: ARB_MAX_HOPS,
  feeTiers: ARB_FEE_TIERS,
  minProfitBps: ARB_MIN_PROFIT_BPS,
  slippagePct: ARB_SLIPPAGE_PCT,
  tokens: ARB_TOKENS_ALLOWLIST,
  baseSymbol: BASE_SYMBOL,
  logLevel: LOG_LEVEL,
  logSearchedPairs: ARB_LOG_SEARCHED_PAIRS,
  logSearchedMax: ARB_LOG_SEARCHED_MAX
});

async function main() {
  log('info', `Bot iniciado | Scanner=${ARB_SCAN_ENABLED ? 'ON' : 'OFF'} | Interval=${ARB_SCAN_INTERVAL_MS}ms | Probe=${ARB_PROBE_USD.toFixed()} ${BASE_SYMBOL} | MaxHops=${ARB_MAX_HOPS} | Fees=[${ARB_FEE_TIERS.join(',')}]`);
  log('info', `Tokens: ${ARB_TOKENS_ALLOWLIST.join(', ')}`);
  if (!MOMENTUM_ENABLED) log('info', `Momentum: OFF (MOMENTUM_ENABLED=NO)`);

  let nextArbAt = Date.now();

  while (true) {
    try {
      // Momentum (opcional/desligado por padrão)
      if (MOMENTUM_ENABLED) {
        const p = await fetchBtcUsd();
        pushPrice(p);
        const ch = pctChange1h();
        if (ch !== null) {
          log('info', `BTC $${p.toFixed(2)} | Δ1h=${ch.toFixed(2)}% | buffer=${buf.length}`);
        } else {
          log('debug', `BTC $${p.toFixed(2)} | coletando histórico... (${buf.length}/~60)`);
        }
      }

      // Arbitrage scan
      if (ARB_SCAN_ENABLED && Date.now() >= nextArbAt) {
        await scanner.scanOnce();
        nextArbAt = Date.now() + ARB_SCAN_INTERVAL_MS;
      }

    } catch (err: any) {
      if (err?.code || err instanceof GSwapSDKError) {
        log('error', `[sdk] ${err.code || 'GSWAP_SDK_ERROR'}: ${err.message} ${err.details ? JSON.stringify(err.details) : ''}`);
      } else {
        log('error', `[loop] ${err?.message || err}`);
      }
    }

    await sleep(Math.min(CHECK_INTERVAL_MS, 5000));
  }
}

main().catch(e => { log('error', `Fatal: ${e?.message || e}`); process.exit(1); });
