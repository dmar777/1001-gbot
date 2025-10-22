import BigNumber from "bignumber.js";
import { GSwap } from "@gala-chain/gswap-sdk";
import { FeeTier, Opportunity } from "./types.js";

/* -------------------------------------------------------
   Normalizador universal de tokens
   Entrada aceita:
     - "GALA", "GMUSIC"
     - "$GMUSIC"  -> $GMUSIC$Unit$none$none
     - "GALA$Unit$none$none", "$GMUSIC$Unit$none$none"
     - "Token$Unit$WEN$client:...."
     - PIPE "GALA|Unit|none|none", "Token|Unit|WEN|client:..."
   Saída: sempre PIPE "Symbol|Unit|Sub|Network"
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
   Tipos públicos de status/progresso
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
  startedAt: number | null;           // epoch ms da varredura em andamento
  lastUpdateAt: number | null;        // epoch ms do último incremento
  elapsedMs: number;                  // agora - startedAt
  pairsTried: number;                 // pares/rotas tentados
  quotesRequested: number;            // chamadas de quote feitas
  quotesOk: number;                   // respostas com sucesso
  quotesErr: number;                  // respostas com erro
  totalQuotesPlanned: number;         // estimativa total para a rodada (2h+3h)
  perBaseCounts: Record<string, number>; // quantos pares/rotas por base
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

  /** snapshot do progresso atual (para heartbeat externo) */
  getProgress(): ScanProgress {
    if (this.progress.startedAt) {
      this.progress.elapsedMs = Date.now() - this.progress.startedAt;
    }
    return { ...this.progress, perBaseCounts: { ...this.progress.perBaseCounts } };
  }

  /** relatório final da última rodada concluída */
  getLastReport() {
    return this.lastReport;
  }

  /* -------- estimativa de workload (quotes) para a rodada --------
     Para 2 hops (A->B->A):  pares = B*(U-1)*F^2, quotes = pares*2
     Para 3 hops (A->B->C->A): rotas = B*(U-1)*(U-2)*F^3, quotes = rotas*3
     Obs: se maxHops > 3, estimamos apenas até 3 para manter custo finito.
  -----------------------------------------------------------------*/
  private estimateTotalQuotes(bases: number, tokens: number, fees: number, maxHops: number) {
    const twoHopPairs = bases * Math.max(0, tokens - 1) * Math.pow(fees, 2);
    const twoHopQuotes = twoHopPairs * 2;

    const threeHopRoutes = maxHops >= 3
      ? bases * Math.max(0, tokens - 1) * Math.max(0, tokens - 2) * Math.pow(fees, 3)
      : 0;
    const threeHopQuotes = threeHopRoutes * 3;

    return twoHopQuotes + threeHopQuotes;
  }

  async scanOnce(): Promise<Opportunity[]> {
    const {
      baseSymbols, tokens, feeTiers, probeAmount,
      maxHops, logPairs, logPairsMax, log
    } = this.cfg;

    const bases = baseSymbols.map(toPipeId);
    const universe = Array.from(new Set(tokens.map(toPipeId)));

    // zera progresso
    this.progress = {
      startedAt: Date.now(),
      lastUpdateAt: Date.now(),
      elapsedMs: 0,
      pairsTried: 0,
      quotesRequested: 0,
      quotesOk: 0,
      quotesErr: 0,
      totalQuotesPlanned: this.estimateTotalQuotes(
        bases.length, universe.length, feeTiers.length, maxHops
      ),
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
