import BigNumber from 'bignumber.js';
import { GSwap } from '@gala-chain/gswap-sdk';
import { FeeTier, Opportunity } from './types.js';

type QuoteResult = { ok: true; fee: FeeTier; out: BigNumber } | { ok: false; error: string };

export type ArbScannerConfig = {
  enabled: boolean;
  intervalMs: number;
  probeUsd: BigNumber;          // valor de entrada em unidades da base do ciclo
  maxHops: 2 | 3;
  feeTiers: FeeTier[];
  minProfitBps: number;         // p.ex. 0 para aceitar lucro zero
  slippagePct: number;          // apenas para logs
  tokens: string[];             // universo
  baseSymbols: string[];        // <<< NOVO: bases de partida (ex.: ['GUSDC','GMUSIC'])
  logLevel: 'debug'|'info'|'warn'|'error';
  logSearchedPairs: boolean;
  logSearchedMax: number;
};

const order = ['debug','info','warn','error'] as const;
function log(level: 'debug'|'info'|'warn'|'error', msg: string, current: 'debug'|'info'|'warn'|'error') {
  if (order.indexOf(level) < order.indexOf(current)) return;
  console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`);
}

const toKey = (sym: string) => `${sym}|Unit|none|none`;

type PairStats = { attempted: Set<FeeTier>; okFees: Set<FeeTier>; errors: number; };
function pairKey(a: string, b: string) { return `${a}->${b}`; }

async function quoteExactIn(
  gswap: GSwap,
  tokenInKey: string,
  tokenOutKey: string,
  amountIn: BigNumber,
  pairStatsMap: Map<string, PairStats>,
  fee?: FeeTier
): Promise<QuoteResult> {
  const pkey = pairKey(tokenInKey, tokenOutKey);
  if (!pairStatsMap.has(pkey)) pairStatsMap.set(pkey, { attempted: new Set(), okFees: new Set(), errors: 0 });

  try {
    const anyQ = (gswap as any).quoting;
    let q: any;
    if (fee) {
      (pairStatsMap.get(pkey) as PairStats).attempted.add(fee);
      q = await anyQ.quoteExactInput(tokenInKey, tokenOutKey, amountIn.toString(), fee);
      (pairStatsMap.get(pkey) as PairStats).okFees.add(fee);
      const out = new BigNumber(q.outTokenAmount?.toString?.() ?? q.outTokenAmount);
      return { ok: true, fee, out };
    } else {
      q = await anyQ.quoteExactInput(tokenInKey, tokenOutKey, amountIn.toString());
      const out = new BigNumber(q.outTokenAmount?.toString?.() ?? q.outTokenAmount);
      const feeTier: FeeTier | undefined = q.feeTier ?? undefined;
      if (feeTier) {
        (pairStatsMap.get(pkey) as PairStats).attempted.add(feeTier);
        (pairStatsMap.get(pkey) as PairStats).okFees.add(feeTier);
      }
      return { ok: true, fee: (feeTier ?? 500) as FeeTier, out };
    }
  } catch (e: any) {
    if (fee) (pairStatsMap.get(pkey) as PairStats).attempted.add(fee);
    (pairStatsMap.get(pkey) as PairStats).errors += 1;
    return { ok: false, error: e?.message || String(e) };
  }
}

export class ArbitrageScanner {
  private gswap: GSwap;
  private cfg: ArbScannerConfig;

  constructor(gswap: GSwap, cfg: ArbScannerConfig) {
    this.gswap = gswap;
    this.cfg = cfg;
  }

  async scanOnce(): Promise<Opportunity[]> {
    const opps: Opportunity[] = [];
    if (!this.cfg.enabled) {
      log('info', '[ARB] scanner desligado (ARB_SCAN_ENABLED=NO)', this.cfg.logLevel);
      return opps;
    }

    const { tokens, feeTiers, probeUsd, maxHops } = this.cfg;
    const start = Date.now();
    let checked = 0;
    const searchedPairs = new Map<string, PairStats>();

    for (const baseSymbol of this.cfg.baseSymbols) {
      // 2 hops (round-trip A->B->A)
      for (const B of tokens) {
        if (B === baseSymbol) continue;
        const Akey = toKey(baseSymbol), Bkey = toKey(B);

        for (const feeAB of feeTiers) {
          const q1 = await quoteExactIn(this.gswap, Akey, Bkey, probeUsd, searchedPairs, feeAB);
          checked++;
          if (!q1.ok) continue;

          for (const feeBA of feeTiers) {
            const q2 = await quoteExactIn(this.gswap, Bkey, Akey, q1.out, searchedPairs, feeBA);
            checked++;
            if (!q2.ok) continue;

            const pct = q2.out.minus(probeUsd).div(probeUsd).multipliedBy(100).toNumber();
            if (this.isProfitable(pct)) {
              opps.push({
                path: `${baseSymbol} (fee=${feeAB}) → ${B} (fee=${feeBA}) → ${baseSymbol}`,
                tokens: [baseSymbol, B, baseSymbol],
                fees: [feeAB, feeBA],
                hops: 2, pct, inAmt: probeUsd, outAmt: q2.out
              });
            }
          }
        }
      }

      // 3 hops (triangular): melhor fee por hop
      if (maxHops >= 3) {
        for (const B of tokens) {
          if (B === baseSymbol) continue;
          for (const C of tokens) {
            if (C === baseSymbol || C === B) continue;
            const Akey = toKey(baseSymbol), Bkey = toKey(B), Ckey = toKey(C);

            const q1best = await this.bestFeeOut(Akey, Bkey, probeUsd, searchedPairs);
            checked += this.cfg.feeTiers.length; if (!q1best) continue;

            const q2best = await this.bestFeeOut(Bkey, Ckey, q1best.out, searchedPairs);
            checked += this.cfg.feeTiers.length; if (!q2best) continue;

            const q3best = await this.bestFeeOut(Ckey, Akey, q2best.out, searchedPairs);
            checked += this.cfg.feeTiers.length; if (!q3best) continue;

            const pct = q3best.out.minus(probeUsd).div(probeUsd).multipliedBy(100).toNumber();
            if (this.isProfitable(pct)) {
              opps.push({
                path: `${baseSymbol} (fee=${q1best.fee}) → ${B} (fee=${q2best.fee}) → ${C} (fee=${q3best.fee}) → ${baseSymbol}`,
                tokens: [baseSymbol, B, C, baseSymbol],
                fees: [q1best.fee, q2best.fee, q3best.fee],
                hops: 3, pct, inAmt: probeUsd, outAmt: q3best.out
              });
            }
          }
        }
      }
    }

    opps.sort((a, b) => b.pct - a.pct);

    const elapsed = Date.now() - start;
    log('info', `[ARB] scan em ${elapsed}ms | rotas≈${checked} | oportunidades=${opps.length}`, this.cfg.logLevel);
    for (const o of opps.slice(0, 5)) {
      const s = o.pct >= 0 ? '+' : '';
      log('info', `[ARB] ${s}${o.pct.toFixed(3)}% | in=${o.inAmt.toFixed(6)} out=${o.outAmt.toFixed(6)} | ${o.path}`, this.cfg.logLevel);
    }
    if (opps.length === 0) log('info', `[ARB] nada ≥ ${this.cfg.minProfitBps} bps`, this.cfg.logLevel);

    if (this.cfg.logSearchedPairs) {
      const pretty = (k: string) => { const [a,b]=k.split('->'); const sym=(s:string)=>s.split('|')[0]; return `${sym(a)}→${sym(b)}`; };
      const lines:string[]=[];
      for (const [k,st] of searchedPairs.entries()) {
        const attempted=[...st.attempted].sort((x,y)=>x-y).join(',');
        const ok=[...st.okFees].sort((x,y)=>x-y).join(',');
        lines.push(`${pretty(k)} | tried=[${attempted}] ok=[${ok||'-'}] errors=${st.errors}`);
      }
      lines.sort(); const limited=lines.slice(0,this.cfg.logSearchedMax);
      log('info', `[ARB:searched] pares pesquisados (${lines.length}):`, this.cfg.logLevel);
      for (const ln of limited) log('info', `  - ${ln}`, this.cfg.logLevel);
      if (lines.length>limited.length) log('info', `  … +${lines.length-limited.length} pares`, this.cfg.logLevel);
    }

    return opps;
  }

  private async bestFeeOut(
    tokenInKey: string,
    tokenOutKey: string,
    amountIn: BigNumber,
    searchedPairs: Map<string, PairStats>
  ): Promise<{ fee: FeeTier; out: BigNumber } | null> {
    let best: { fee: FeeTier; out: BigNumber } | null = null;
    for (const fee of this.cfg.feeTiers) {
      const q = await quoteExactIn(this.gswap, tokenInKey, tokenOutKey, amountIn, searchedPairs, fee);
      if (!q.ok) continue;
      if (!best || q.out.gt(best.out)) best = { fee, out: q.out };
    }
    return best;
  }

  private isProfitable(pct: number): boolean {
    // aceita zero (ou até negativo, se você setar bps negativos)
    const minPct = this.cfg.minProfitBps / 100; // bps → %
    return pct >= minPct;
  }
}
