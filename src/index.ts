import 'dotenv/config';
import BigNumber from 'bignumber.js';
import { GSwap, PrivateKeySigner, GSwapSDKError } from '@gala-chain/gswap-sdk';
import { ArbitrageScanner } from './arbitrageScanner.js';
import { ArbitrageExecutor } from './arbitrageExecutor.js';
import { Opportunity } from './types.js';

const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase() as 'debug'|'info'|'warn'|'error';
function log(level: 'debug'|'info'|'warn'|'error', msg: string) {
  const order = ['debug','info','warn','error'] as const;
  if (order.indexOf(level) < order.indexOf(LOG_LEVEL)) return;
  console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`);
}
function mustEnv(name: string) { const v = process.env[name]; if (!v) throw new Error(`Missing env: ${name}`); return v; }
function toNum(v: string | undefined, def: number) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : def; }

const WALLET_ADDRESS = mustEnv('WALLET_ADDRESS');
const PRIVATE_KEY   = mustEnv('PRIVATE_KEY');
const gswap = new GSwap({ signer: new PrivateKeySigner(PRIVATE_KEY), walletAddress: WALLET_ADDRESS });

// Scanner
const ARB_SCAN_ENABLED       = (process.env.ARB_SCAN_ENABLED || 'YES').toUpperCase() === 'YES';
const ARB_SCAN_INTERVAL_MS   = toNum(process.env.ARB_SCAN_INTERVAL_MS, 60000);
const ARB_PROBE_USD          = new BigNumber(process.env.ARB_PROBE_USD || '10');
const ARB_MAX_HOPS           = Math.max(2, Math.min(3, Number(process.env.ARB_MAX_HOPS || '3'))) as 2|3;
const ARB_FEE_TIERS          = (process.env.ARB_FEE_TIERS || '500,3000,10000').split(',').map(s => Number(s.trim())) as Array<500|3000|10000>;
const ARB_MIN_PROFIT_BPS     = Number(process.env.ARB_MIN_PROFIT_BPS || '0'); // default: 0 bps
const ARB_SLIPPAGE_PCT       = Number(process.env.ARB_SLIPPAGE_PCT || '0.5');
const ARB_TOKENS_ALLOWLIST   = (process.env.ARB_TOKENS_ALLOWLIST || 'GUSDC,GALA,GMUSIC,FILM,GWETH,GWBTC,USDT').split(',').map(s => s.trim()).filter(Boolean);
const ARB_BASES              = (process.env.ARB_BASES || 'GUSDC').split(',').map(s => s.trim()).filter(Boolean);
const ARB_LOG_SEARCHED_PAIRS = (process.env.ARB_LOG_SEARCHED_PAIRS || 'YES').toUpperCase() === 'YES';
const ARB_LOG_SEARCHED_MAX   = toNum(process.env.ARB_LOG_SEARCHED_MAX, 50);

// Executor
const ARB_EXECUTE            = (process.env.ARB_EXECUTE || 'NO').toUpperCase() === 'YES';
const ARB_TRADE_USD          = new BigNumber(process.env.ARB_TRADE_USD || '10'); // quantidade na moeda base do ciclo
const ARB_MAX_HOPS_EXEC      = Math.max(2, Math.min(3, Number(process.env.ARB_MAX_HOPS_EXEC || '3'))) as 2|3;
const ARB_MAX_SLIPPAGE_BPS   = Number(process.env.ARB_MAX_SLIPPAGE_BPS || '50');
const ARB_COOLDOWN_MS        = toNum(process.env.ARB_COOLDOWN_MS, 30000);
const ARB_DEDUPE_WINDOW_MS   = toNum(process.env.ARB_DEDUPE_WINDOW_MS, 180000);

const scanner = new ArbitrageScanner(gswap, {
  enabled: ARB_SCAN_ENABLED,
  intervalMs: ARB_SCAN_INTERVAL_MS,
  probeUsd: ARB_PROBE_USD,
  maxHops: ARB_MAX_HOPS,
  feeTiers: ARB_FEE_TIERS,
  minProfitBps: ARB_MIN_PROFIT_BPS,
  slippagePct: ARB_SLIPPAGE_PCT,
  tokens: ARB_TOKENS_ALLOWLIST,
  baseSymbols: ARB_BASES,         // <<< NOVO
  logLevel: LOG_LEVEL,
  logSearchedPairs: ARB_LOG_SEARCHED_PAIRS,
  logSearchedMax: ARB_LOG_SEARCHED_MAX
});

const executor = new ArbitrageExecutor(gswap, {
  enabled: ARB_EXECUTE,
  tradeUsd: ARB_TRADE_USD,
  maxHopsExec: ARB_MAX_HOPS_EXEC,
  maxSlippageBps: ARB_MAX_SLIPPAGE_BPS,
  cooldownMs: ARB_COOLDOWN_MS,
  dedupeWindowMs: ARB_DEDUPE_WINDOW_MS,
  baseSymbol: '—',
  logLevel: LOG_LEVEL
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  log('info', `Bot iniciado | Scanner=${ARB_SCAN_ENABLED ? 'ON' : 'OFF'} | Execute=${ARB_EXECUTE ? 'ON' : 'OFF'} | Probe=${ARB_PROBE_USD.toFixed()} | Trade=${ARB_TRADE_USD.toFixed()}`);
  log('info', `Bases: ${ARB_BASES.join(', ')} | Tokens: ${ARB_TOKENS_ALLOWLIST.join(', ')} | Fees=[${ARB_FEE_TIERS.join(',')}] | MinProfit=${ARB_MIN_PROFIT_BPS}bps`);

  let nextScanAt = Date.now();

  while (true) {
    try {
      if (ARB_SCAN_ENABLED && Date.now() >= nextScanAt) {
        const opps: Opportunity[] = await scanner.scanOnce();
        nextScanAt = Date.now() + ARB_SCAN_INTERVAL_MS;

        if (ARB_EXECUTE) {
          // preferir 3 hops quando permitido; senão 2 hops
          let candidate: Opportunity | undefined;
          if (ARB_MAX_HOPS_EXEC === 3) {
            candidate = opps.find(o => o.hops === 3) ?? opps.find(o => o.hops === 2);
          } else {
            candidate = opps.find(o => o.hops === 2);
          }

          if (candidate) {
            log('info', `[EXEC] tentando: ${candidate.path} | lucro≈${candidate.pct.toFixed(3)}%`);
            await executor.tryExecute(candidate);
          } else {
            log('info', `[EXEC] nenhuma oportunidade elegível nesta rodada`);
          }
        }
      }
    } catch (err: any) {
      if (err?.code || err instanceof GSwapSDKError) {
        log('error', `[sdk] ${err.code || 'GSWAP_SDK_ERROR'}: ${err.message} ${err.details ? JSON.stringify(err.details) : ''}`);
      } else {
        log('error', `[loop] ${err?.message || err}`);
      }
    }
    await sleep(1000);
  }
}

main().catch(e => { log('error', `Fatal: ${e?.message || e}`); process.exit(1); });
