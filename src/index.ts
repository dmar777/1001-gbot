import "dotenv/config";
import BigNumber from "bignumber.js";
import { GSwap, PrivateKeySigner } from "@gala-chain/gswap-sdk";
import { ArbitrageScanner, ScanCfg } from "./arbitrageScanner.js";
import { Opportunity, FeeTier } from "./types.js";

/* ------------ util -------------- */
const env = (k: string, d = "") => (process.env[k] ?? d).trim();
const parseList = (v: string) => v.split(",").map(s => s.trim()).filter(Boolean);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const bpsToPct = (bps: number) => bps / 100;

/* ------------ env -------------- */
const DEX_BASE_URL = env("DEX_BASE_URL", "https://dex-backend-prod1.defi.gala.com");
const PRIVATE_KEY = env("PRIVATE_KEY");

const ARB_BASES = parseList(env("ARB_BASES", "GUSDC,GALA"));
const ARB_TOKENS = parseList(env("ARB_TOKENS_ALLOWLIST", "GUSDC,GALA,GMUSIC,FILM,GWETH,GWBTC,SOL,OSMI"));
const ARB_FEE_TIERS = parseList(env("ARB_FEE_TIERS", "500,3000,10000")).map(n => Number(n) as FeeTier);
const ARB_MAX_HOPS = Number(env("ARB_MAX_HOPS", "3")) as 2|3|4|5;
const ARB_PROBE_USD = new BigNumber(env("ARB_PROBE_USD", "50"));
const ARB_MIN_PROFIT_BPS = Number(env("ARB_MIN_PROFIT_BPS", "0"));
const INTERVAL_MS = Number(env("ARB_SCAN_INTERVAL_MS", "5000"));
const STATUS_INTERVAL_MS = Number(env("STATUS_INTERVAL_MS", "2000"));
const STATUS_BREAKDOWN_PER_BASE = env("STATUS_BREAKDOWN_PER_BASE", "YES").toUpperCase() === "YES";
const STATUS_BREAKDOWN_TOP = Number(env("STATUS_BREAKDOWN_TOP", "4"));

const ARB_EXECUTE = env("ARB_EXECUTE", "NO").toUpperCase() === "YES";
const ARB_TRADE_USD = new BigNumber(env("ARB_TRADE_USD", "50"));

/* ------------ logger -------------- */
type Lvl = "debug"|"info"|"warn"|"error";
const ORDER: Lvl[] = ["debug","info","warn","error"];
const LOG_LEVEL = (env("LOG_LEVEL","info") as Lvl);
function log(l: Lvl, m: string) {
  if (ORDER.indexOf(l) < ORDER.indexOf(LOG_LEVEL)) return;
  console.log(`[${new Date().toISOString()}] [${l.toUpperCase()}] ${m}`);
}

/* ------------ gswap client -------------- */
const gswap = new GSwap({
  signer: new PrivateKeySigner(PRIVATE_KEY),
  gatewayBaseUrl: DEX_BASE_URL,
});

/* ------------ scanner cfg -------------- */
const scanCfg: ScanCfg = {
  baseSymbols: ARB_BASES,
  tokens: ARB_TOKENS,
  feeTiers: ARB_FEE_TIERS,
  probeAmount: ARB_PROBE_USD,
  maxHops: ARB_MAX_HOPS,
  logPairs: env("ARB_LOG_SEARCHED_PAIRS","NO").toUpperCase() === "YES",
  logPairsMax: Number(env("ARB_LOG_SEARCHED_MAX","0")),
  log: (lvl, msg) => log(lvl, msg),
  enabled: env("ARB_SCAN_ENABLED","YES").toUpperCase() === "YES",
  intervalMs: INTERVAL_MS,
};

const scanner = new ArbitrageScanner(gswap, scanCfg);

/* ------------ heartbeat em tempo real -------------- */
/** FIX: usar NodeJS.Timeout (não NodeJS.Timer) */
let hbTimer: NodeJS.Timeout | null = null;

function startHeartbeat() {
  stopHeartbeat();
  hbTimer = setInterval(() => {
    const p = scanner.getProgress();
    if (!p.startedAt) return;

    const pct = p.totalQuotesPlanned
      ? (p.quotesRequested / p.totalQuotesPlanned) * 100
      : 0;

    const head = `[HB] scan=${(p.elapsedMs/1000).toFixed(2)}s | progress=${p.quotesRequested.toLocaleString()} / ${p.totalQuotesPlanned.toLocaleString()} quotes (${pct.toFixed(1)}%) | pairsTried=${p.pairsTried.toLocaleString()}`;
    log("info", head);

    if (STATUS_BREAKDOWN_PER_BASE) {
      const entries = Object.entries(p.perBaseCounts);
      entries.sort((a,b) => b[1]-a[1]);
      const top = entries.slice(0, Math.max(1, STATUS_BREAKDOWN_TOP))
        .map(([k,v]) => `${k}=${v}`)
        .join(" | ");
      log("info", `      bases: ${top}`);
    }
  }, STATUS_INTERVAL_MS);
}

function stopHeartbeat() {
  if (hbTimer) {
    clearInterval(hbTimer);
    hbTimer = null;
  }
}

/* ------------ main loop -------------- */
async function main() {
  log("info", `Bot iniciado | Scanner=${scanCfg.enabled} | Execute=${ARB_EXECUTE} | Probe=${ARB_PROBE_USD} | Trade=${ARB_TRADE_USD}`);
  log("info", `Bases: ${ARB_BASES.join(", ")} | Tokens: ${ARB_TOKENS.join(", ")} | Fees=[${ARB_FEE_TIERS.join(",")}] | MinProfit=${ARB_MIN_PROFIT_BPS}bps`);

  while (true) {
    try {
      if (!scanCfg.enabled) { await sleep(INTERVAL_MS); continue; }

      startHeartbeat();
      const opps = await scanner.scanOnce();
      stopHeartbeat();

      const enriched: Opportunity[] = opps.map(o => ({
        ...o,
        pct: o.pct ?? bpsToPct(o.profitBps ?? 0),
      }));

      const eligible = enriched
        .filter(o => (o.profitBps ?? 0) >= ARB_MIN_PROFIT_BPS)
        .sort((a,b) => (b.profitBps ?? 0) - (a.profitBps ?? 0));

      if (eligible.length) {
        const best = eligible[0];
        log("info", `[CANDIDATE] ${best.path} | profit≈${(best.pct ?? 0).toFixed(2)}% | hops=${best.hops}`);
        // executor opcional aqui
      } else {
        log("info", "[EXEC] nenhuma oportunidade elegível nesta rodada");
      }

      await sleep(INTERVAL_MS);
    } catch (err: any) {
      stopHeartbeat();
      log("error", `loop error: ${err?.message || String(err)}`);
      await sleep(INTERVAL_MS);
    }
  }
}

main().catch(err => {
  stopHeartbeat();
  log("error", `fatal: ${err?.message || String(err)}`);
});
