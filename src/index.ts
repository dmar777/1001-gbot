import "dotenv/config";
import BigNumber from "bignumber.js";
import { GSwap, PrivateKeySigner } from "@gala-chain/gswap-sdk";
import { ArbitrageScanner, ScanCfg } from "./arbitrageScanner.js";
import { Opportunity, FeeTier } from "./types.js";

/* ----------------- helpers ----------------- */
const env = (k: string, d = "") => (process.env[k] ?? d).trim();
const parseList = (v: string) =>
  v.split(",").map(s => s.trim()).filter(Boolean);

function bpsToPct(bps: number) {
  return bps / 100;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

/* ----------------- env ----------------- */
const DEX_BASE_URL = env("DEX_BASE_URL", "https://dex-backend-prod1.defi.gala.com");
const WALLET_ADDRESS = env("WALLET_ADDRESS"); // e.g. "eth|0x...."
const PRIVATE_KEY = env("PRIVATE_KEY");

const ARB_BASES = parseList(env("ARB_BASES", "GUSDC,GALA"));
const ARB_TOKENS = parseList(env("ARB_TOKENS_ALLOWLIST", "GUSDC,GALA,GMUSIC,FILM,GWETH,GWBTC,SOL,OSMI"));
const ARB_FEE_TIERS = parseList(env("ARB_FEE_TIERS", "500,3000,10000")).map(n => Number(n) as FeeTier);
const ARB_MAX_HOPS = Number(env("ARB_MAX_HOPS", "3")) as 2|3|4|5;
const ARB_PROBE_USD = new BigNumber(env("ARB_PROBE_USD", "50"));
const ARB_MIN_PROFIT_BPS = Number(env("ARB_MIN_PROFIT_BPS", "0"));
const INTERVAL_MS = Number(env("ARB_SCAN_INTERVAL_MS", "5000"));

const ARB_EXECUTE = env("ARB_EXECUTE", "NO").toUpperCase() === "YES";
const ARB_TRADE_USD = new BigNumber(env("ARB_TRADE_USD", "50"));

/* ----------------- logger ----------------- */
type Lvl = "debug"|"info"|"warn"|"error";
const levelOrder: Lvl[] = ["debug","info","warn","error"];
const LOG_LEVEL: Lvl = (env("LOG_LEVEL","info") as Lvl);
function log(l: Lvl, m: string) {
  if (levelOrder.indexOf(l) < levelOrder.indexOf(LOG_LEVEL)) return;
  console.log(`[${new Date().toISOString()}] [${l.toUpperCase()}] ${m}`);
}

/* ----------------- gswap client ----------------- */
const gswap = new GSwap({
  baseUrl: DEX_BASE_URL,
  signer: new PrivateKeySigner(PRIVATE_KEY),
  walletAddress: WALLET_ADDRESS,
});

/* ----------------- scanner ----------------- */
const scanCfg: ScanCfg = {
  baseSymbols: ARB_BASES,
  tokens: ARB_TOKENS,
  feeTiers: ARB_FEE_TIERS,
  probeAmount: ARB_PROBE_USD,
  maxHops: ARB_MAX_HOPS,
  logPairs: env("ARB_LOG_SEARCHED_PAIRS","YES").toUpperCase() === "YES",
  logPairsMax: Number(env("ARB_LOG_SEARCHED_MAX","200")),
  log: (lvl, msg) => log(lvl, msg),
  enabled: env("ARB_SCAN_ENABLED","YES").toUpperCase() === "YES",
  intervalMs: INTERVAL_MS, // now allowed by ScanCfg
};

const scanner = new ArbitrageScanner(gswap, scanCfg);

/* ----------------- main loop ----------------- */
async function main() {
  log("info", `Bot started | Scanner=${scanCfg.enabled} | Execute=${ARB_EXECUTE} | Probe=${ARB_PROBE_USD} | Trade=${ARB_TRADE_USD}`);

  while (true) {
    try {
      if (!scanCfg.enabled) {
        await sleep(INTERVAL_MS);
        continue;
      }

      const opps = await scanner.scanOnce();

      // compute pct if missing, filter by min bps
      const enriched: Opportunity[] = opps.map(o => ({
        ...o,
        pct: o.pct ?? bpsToPct(o.profitBps ?? 0),
      }));

      const eligible = enriched
        .filter(o => (o.profitBps ?? 0) >= ARB_MIN_PROFIT_BPS)
        .sort((a,b) => (b.profitBps ?? 0) - (a.profitBps ?? 0));

      if (eligible.length === 0) {
        log("info", "[EXEC] no eligible opportunity in this round");
        await sleep(INTERVAL_MS);
        continue;
      }

      const candidate = eligible[0];
      log("info", `[CANDIDATE] ${candidate.path} | profit≈${(candidate.pct ?? bpsToPct(candidate.profitBps ?? 0)).toFixed(2)}% | hops=${candidate.hops}`);

      // If you wire an executor, call it here. For now we just loop.
      await sleep(INTERVAL_MS);
    } catch (err: any) {
      log("error", `loop error: ${err?.message || String(err)}`);
      await sleep(INTERVAL_MS);
    }
  }
}

main().catch(err => {
  log("error", `fatal: ${err?.message || String(err)}`);
});
