import BigNumber from "bignumber.js";
import { GSwap } from "@gala-chain/gswap-sdk";
import { FeeTier, Opportunity } from "./types.js";

/* -------------------------------------------------------
   Normalizador universal de tokens -> sempre PIPE
---------------------------------------------------------*/
function toPipeId(input: string): string {
  const trimmed = (input || "").trim();
  if (trimmed.includes("|")) return trimmed;

  const toDollar = (s: string) => {
    if (/\$/.test(s)) return s;              // já canônico
    if (s.startsWith("$")) return `${s}$Unit$none$none`;
    return `${s}$Unit$none$none`;
  };

  const dollar = toDollar(trimmed);
  const m = dollar.match(
    /^(\$?[A-Za-z0-9:_-]+)\$(Unit)\$([A-Za-z0-9:_-]+)\$([A-Za-z0-9:_-]+)$/
  );
  if (!m) {
    throw new Error(
      `Token id inválido: "${input}". Ex.: GALA$Unit$none$none, $GMUSIC$Unit$none$none ou Token$Unit$WEN$client:...`
    );
  }
  const symbol = m[1].startsWith("$") ? m[1].slice(1) : m[1];
  return `${symbol}|${m[2]}|${m[3]}|${m[4]}`;
}

/* -------------------------------------------------------
   Config / Status
---------------------------------------------------------*/
export type ScanCfg = {
  baseSymbols: string[];
  tokens: string[];
  feeTiers: FeeTier[];
  probeAmount: BigNumber;
  maxHops: 2 | 3 | 4 | 5;
  logPairs: boolean;
  logPairsMax: number;
  log: (level: "info" | "debug" | "warn" | "error", msg: string) => void;
  enabled?: boolean;
  intervalMs?: number;
};

export type ScanProgress = {
  startedAt: number | null;
  lastUpdateAt: number | null;
  elapsedMs: number;
  pairsTried: number;
  quotesRequested: number;
  quotesOk: number;
  quotesErr: number;
  totalQuotesPlanned: number;         // AGORA: dinâmico (2 por 2-hop, 3 por 3-hop)
  perBaseCounts: Record<string, number>;
};

export class ArbitrageScanner {
  private progress: ScanProgress = {
    startedAt: null,
    lastUpdateAt: null,
    elapsedMs: 0,
    pairsTried: 0,
    quotesRequested: 0,
    quotesOk: 0,
    quotesErr: 0,
    totalQuotesPlanned: 0,
    perBaseCounts: {},
  };

  private lastReport: {
    startedAt: number;
    finishedAt: number;
    durationMs: number;
    pairsTried: number;
    quotesRequested: number;
    quotesOk: number;
    quotesErr: number;
  } | null = null;

  constructor(private gswap: GSwap, private cfg: ScanCfg) {}

  getProgress(): ScanProgress {
    if (this.progress.startedAt) {
      this.progress.elapsedMs = Date.now() - this.progress.startedAt;
    }
    return { ...this.progress, perBaseCounts: { ...this.progress.perBaseCounts } };
  }

  getLastReport() {
    return this.lastReport;
  }

  async scanOnce(): Promise<Opportunity[]> {
    const {
      baseSymbols, tokens, feeTiers, probeAmount,
      maxHops, logPairs, logPairsMax, log
    } = this.cfg;

    const bases = baseSymbols.map(toPipeId);
    const universe = Array.from(new Set(tokens.map(toPipeId)));

    // Zera progresso e PASSA A CONTAR O TOTAL PLANEJADO DINAMICAMENTE
    this.progress = {
      startedAt: Date.now(),
      lastUpdateAt: Date.now(),
      elapsedMs: 0,
      pairsTried: 0,
      quotesRequested: 0,
      quotesOk: 0,
      quotesErr: 0,
      totalQuotesPlanned: 0, // será incrementado "on the fly"
      perBaseCounts: {},
    };

    const startedAt = this.progress.startedAt!;
    const searched: string[] = [];
    const opps: Opportunity[] = [];

    for (const A of bases) {
      const baseSym = A.split("|")[0];
      if (!this.progress.perBaseCounts[baseSym]) this.progress.perBaseCounts[baseSym] = 0;

      for (const B of universe) {
        if (B === A) continue;

        // ---------- 2 hops ----------
        for (const fAB of feeTiers) {
          for (const fBA of feeTiers) {
            this.progress.pairsTried++;
            this.progress.perBaseCounts[baseSym]++;
            this.progress.lastUpdateAt = Date.now();

            // PLANEJADO: +2 quotes
            this.progress.totalQuotesPlanned += 2;

            if (logPairs && searched.length < logPairsMax) {
              searched.push(`${A.split("|")[0]}→${B.split("|")[0]}`);
            }

            try {
              this.progress.quotesRequested++;
              const q1: any = await (this.gswap as any).quoting.quoteExactInput(
                A, B, probeAmount.toString(), fAB
              );
              const out1 = new BigNumber(q1?.outTokenAmount?.toString?.() ?? q1?.outTokenAmount ?? "0");
              this.progress.quotesOk++;
              if (out1.isZero()) continue;

              this.progress.quotesRequested++;
              const q2: any = await (this.gswap as any).quoting.quoteExactInput(
                B, A, out1.toString(), fBA
              );
              const out2 = new BigNumber(q2?.outTokenAmount?.toString?.() ?? q2?.outTokenAmount ?? "0");
              this.progress.quotesOk++;

              const profitBps = out2.minus(probeAmount).div(probeAmount).multipliedBy(10_000).toNumber();
              opps.push({
                hops: 2,
                tokens: [A, B, A],
                fees: [fAB, fBA],
                path: `${A.split("|")[0]}->${B.split("|")[0]}->${A.split("|")[0]}`,
                profitBps,
              });
            } catch {
              this.progress.quotesErr++;
            }
          }
        }

        if (maxHops < 3) continue;

        // ---------- 3 hops ----------
        for (const C of universe) {
          if (C === A || C === B) continue;

          for (const fAB of feeTiers)
            for (const fBC of feeTiers)
              for (const fCA of feeTiers) {
                this.progress.pairsTried++;
                this.progress.perBaseCounts[baseSym]++;
                this.progress.lastUpdateAt = Date.now();

                // PLANEJADO: +3 quotes
                this.progress.totalQuotesPlanned += 3;

                if (logPairs && searched.length < logPairsMax) {
                  searched.push(`${A.split("|")[0]}→${B.split("|")[0]}→${C.split("|")[0]}`);
                }

                try {
                  this.progress.quotesRequested++;
                  const q1: any = await (this.gswap as any).quoting.quoteExactInput(
                    A, B, probeAmount.toString(), fAB
                  );
                  const out1 = new BigNumber(q1?.outTokenAmount?.toString?.() ?? q1?.outTokenAmount ?? "0");
                  this.progress.quotesOk++;
                  if (out1.isZero()) continue;

                  this.progress.quotesRequested++;
                  const q2: any = await (this.gswap as any).quoting.quoteExactInput(
                    B, C, out1.toString(), fBC
                  );
                  const out2 = new BigNumber(q2?.outTokenAmount?.toString?.() ?? q2?.outTokenAmount ?? "0");
                  this.progress.quotesOk++;
                  if (out2.isZero()) continue;

                  this.progress.quotesRequested++;
                  const q3: any = await (this.gswap as any).quoting.quoteExactInput(
                    C, A, out2.toString(), fCA
                  );
                  const out3 = new BigNumber(q3?.outTokenAmount?.toString?.() ?? q3?.outTokenAmount ?? "0");
                  this.progress.quotesOk++;

                  const profitBps = out3.minus(probeAmount).div(probeAmount).multipliedBy(10_000).toNumber();
                  opps.push({
                    hops: 3,
                    tokens: [A, B, C, A],
                    fees: [fAB, fBC, fCA],
                    path: `${A.split("|")[0]}->${B.split("|")[0]}->${C.split("|")[0]}->${A.split("|")[0]}`,
                    profitBps,
                  });
                } catch {
                  this.progress.quotesErr++;
                }
              }
        }
      }
    }

    if (logPairs && searched.length) {
      const max = Math.min(logPairsMax, searched.length);
      log("info", `[ARB:searched] ${max}/${searched.length} exemplos (listagem limitada)`);
      for (let i = 0; i < max; i++) log("info", `  - ${searched[i]}`);
    }

    const finishedAt = Date.now();
    this.lastReport = {
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      pairsTried: this.progress.pairsTried,
      quotesRequested: this.progress.quotesRequested,
      quotesOk: this.progress.quotesOk,
      quotesErr: this.progress.quotesErr,
    };

    return opps;
  }
}
