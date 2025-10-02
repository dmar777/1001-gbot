import BigNumber from 'bignumber.js';
import { GSwap } from '@gala-chain/gswap-sdk';

type FeeTier = 500 | 3000 | 10000;
type QuoteResult = { ok: true; fee: FeeTier; out: BigNumber } | { ok: false; error: string };

export type ArbScannerConfig = {
  enabled: boolean;
  intervalMs: number;
  probeUsd: BigNumber;           // valor de entrada em "moeda base" (p.ex. GUSDC ~ USD)
  maxHops: 2 | 3;
  feeTiers: FeeTier[];
  minProfitBps: number;          // lucro mínimo p/ logar (em bps)
  slippagePct: number;           // apenas para report (proteção conceitual)
  tokens: string[];              // símbolos como "GUSDC","GALA","GWETH"
  baseSymbol: string;            // ex.: "GUSDC"
  logLevel: 'debug'|'info'|'warn'|'error';
};

const order = ['debug','info','warn','error'] as const;
function log(level: 'debug'|'info'|'warn'|'error', msg: string, current: 'debug'|'info'|'warn'|'error') {
  if (order.indexOf(level) < order.indexOf(current)) return;
  console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`);
}

const toKey = (sym: string) => `${sym}|Unit|none|none`;

/**
 * Quota amountIn exato e tenta em uma fee específica.
 * Caso a API do SDK não aceite fee fixo, tentamos "sem fee" e aceitamos a melhor, marcando como 0.
 */
async function quoteExactIn(
  gswap: GSwap,
  tokenInKey: string,
  tokenOutKey: string,
  amountIn: BigNumber,
  fee?: FeeTier
): Promise<QuoteResult> {
  try {
    // Algumas versões do SDK aceitam fee diretamente no quoting; se der erro, caímos no fallback.
    const anyQ = (gswap as any).quoting;
    let q: any;
    if (fee) {
      q = await anyQ.quoteExactInput(tokenInKey, tokenOutKey, amountIn.toString(), fee);
      return { ok: true, fee, out: new BigNumber(q.outTokenAmount?.toString?.() ?? q.outTokenAmount) };
    } else {
      q = await anyQ.quoteExactInput(tokenInKey, tokenOutKey, amountIn.toString());
      const out = new BigNumber(q.outTokenAmount?.toString?.() ?? q.outTokenAmount);
      // se o SDK retornar feeTier na quote, utilizamos; senão marcamos 0 e tratamos adiante
      const feeTier: FeeTier | undefined = q.feeTier ?? undefined;
      return { ok: true, fee: (feeTier ?? 500) as FeeTier, out };
    }
  } catch (e: any) {
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

  /**
   * Executa um ciclo de varredura e LOGA as melhores oportunidades.
   * Não envia transações.
   */
  async scanOnce(): Promise<void> {
    if (!this.cfg.enabled) {
      log('info', '[ARB] scanner desligado (ARB_SCAN_ENABLED=NO)', this.cfg.logLevel);
      return;
    }

    const { tokens, feeTiers, baseSymbol, probeUsd, maxHops } = this.cfg;
    const baseKey = toKey(baseSymbol);

    const start = Date.now();
    let checked = 0;
    const opps: Array<{ path: string; hops: number; pct: number; inAmt: BigNumber; outAmt: BigNumber; detail: string }> = [];

    // Rotas de 2 hops (intrapool round-trip) — A -> B -> A com combinação de fees
    for (const A of tokens) {
      for (const B of tokens) {
        if (A === B) continue;
        if (A !== baseSymbol) continue; // por simplicidade, começamos e terminamos na base (GUSDC)
        const Akey = toKey(A);
        const Bkey = toKey(B);

        for (const feeAB of feeTiers) {
          // hop1: A -> B
          const q1 = await quoteExactIn(this.gswap, Akey, Bkey, probeUsd, feeAB);
          checked++;
          if (!q1.ok) continue;

          for (const feeBA of feeTiers) {
            // hop2: B -> A
            const q2 = await quoteExactIn(this.gswap, Bkey, Akey, q1.out, feeBA);
            checked++;
            if (!q2.ok) continue;

            const pct = q2.out.minus(probeUsd).div(probeUsd).multipliedBy(100).toNumber();
            if (this.isProfitable(pct)) {
              opps.push({
                path: `${A} (fee=${feeAB}) → ${B} (fee=${feeBA}) → ${A}`,
                hops: 2,
                pct,
                inAmt: probeUsd,
                outAmt: q2.out,
                detail: `in=${probeUsd.toFixed(6)} ${A} out=${q2.out.toFixed(6)} ${A}`
              });
            }
          }
        }
      }
    }

    if (maxHops >= 3) {
      // Rotas triangulares A -> B -> C -> A, com melhor fee por hop (limitamos a combinatória)
      for (const A of tokens) {
        if (A !== baseSymbol) continue;
        for (const B of tokens) {
          if (B === A) continue;
          for (const C of tokens) {
            if (C === A || C === B) continue;

            const Akey = toKey(A), Bkey = toKey(B), Ckey = toKey(C);

            // Hop1: A->B (pegar melhor fee entre feeTiers)
            const q1best = await this.bestFeeOut(Akey, Bkey, probeUsd);
            checked += this.cfg.feeTiers.length;
            if (!q1best) continue;

            // Hop2: B->C
            const q2best = await this.bestFeeOut(Bkey, Ckey, q1best.out);
            checked += this.cfg.feeTiers.length;
            if (!q2best) continue;

            // Hop3: C->A
            const q3best = await this.bestFeeOut(Ckey, Akey, q2best.out);
            checked += this.cfg.feeTiers.length;
            if (!q3best) continue;

            const pct = q3best.out.minus(probeUsd).div(probeUsd).multipliedBy(100).toNumber();
            if (this.isProfitable(pct)) {
              opps.push({
                path: `${A} (fee=${q1best.fee}) → ${B} (fee=${q2best.fee}) → ${C} (fee=${q3best.fee}) → ${A}`,
                hops: 3,
                pct,
                inAmt: probeUsd,
                outAmt: q3best.out,
                detail: `in=${probeUsd.toFixed(6)} ${A} out=${q3best.out.toFixed(6)} ${A}`
              });
            }
          }
        }
      }
    }

    // Ordena e loga top 5
    opps.sort((a, b) => b.pct - a.pct);
    const top = opps.slice(0, 5);
    const elapsed = Date.now() - start;

    log('info', `[ARB] scan concluído em ${elapsed}ms | rotas testadas ~${checked} | oportunidades=${opps.length}`, this.cfg.logLevel);
    for (const o of top) {
      const sign = o.pct >= 0 ? '+' : '';
      log('info', `[ARB] ${sign}${o.pct.toFixed(3)}% | ${o.detail} | path: ${o.path} | hops=${o.hops}`, this.cfg.logLevel);
    }

    if (top.length === 0) {
      log('info', `[ARB] nada acima de ${this.cfg.minProfitBps} bps nesta rodada`, this.cfg.logLevel);
    }
  }

  private async bestFeeOut(tokenInKey: string, tokenOutKey: string, amountIn: BigNumber): Promise<{ fee: FeeTier; out: BigNumber } | null> {
    let best: { fee: FeeTier; out: BigNumber } | null = null;
    for (const fee of this.cfg.feeTiers) {
      const q = await quoteExactIn(this.gswap, tokenInKey, tokenOutKey, amountIn, fee);
      if (!q.ok) continue;
      if (!best || q.out.gt(best.out)) best = { fee, out: q.out };
    }
    return best;
    // se nenhuma fee retornar, devolve null (sem pool/rota disponível)
  }

  private isProfitable(pct: number): boolean {
    const minPct = this.cfg.minProfitBps / 100; // bps → %
    return pct >= minPct;
  }
}
