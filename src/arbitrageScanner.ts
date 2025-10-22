import BigNumber from "bignumber.js";
import { GSwap } from "@gala-chain/gswap-sdk";
import { FeeTier, Opportunity } from "./types.js";

/* -------------------------------------------------------
   UNIVERSAL TOKEN NORMALIZER
   Accepts: friendly (GALA), $friendly ($GMUSIC),
   canonical with $, or PIPE. Returns PIPE.
---------------------------------------------------------*/
function toPipeId(input: string): string {
  const trimmed = (input || "").trim();
  if (trimmed.includes("|")) return trimmed;

  const toDollar = (s: string) => {
    if (/\$/.test(s)) return s;              // already canonical $
    if (s.startsWith("$")) return `${s}$Unit$none$none`;
    return `${s}$Unit$none$none`;            // friendly -> $
  };

  const dollar = toDollar(trimmed);
  const m = dollar.match(
    /^(\$?[A-Za-z0-9:_-]+)\$(Unit)\$([A-Za-z0-9:_-]+)\$([A-Za-z0-9:_-]+)$/
  );
  if (!m) {
    throw new Error(
      `Invalid token id: "${input}". Expected GALA$Unit$none$none, $GMUSIC$Unit$none$none or Token$Unit$WEN$client:...`
    );
  }

  const symbol = m[1].startsWith("$") ? m[1].slice(1) : m[1];
  const cls = m[2];
  const sub = m[3];
  const net = m[4];
  return `${symbol}|${cls}|${sub}|${net}`;
}

/* -------------------------------------------------------
   SCANNER CONFIG (note: intervalMs is optional)
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
  intervalMs?: number; // <—— added so index.ts can pass it
};

export class ArbitrageScanner {
  constructor(private gswap: GSwap, private cfg: ScanCfg) {}

  async scanOnce(): Promise<Opportunity[]> {
    const {
      baseSymbols,
      tokens,
      feeTiers,
      probeAmount,
      maxHops,
      logPairs,
      logPairsMax,
      log,
    } = this.cfg;

    const bases = baseSymbols.map(toPipeId);
    const universe = Array.from(new Set(tokens.map(toPipeId)));

    const searched: string[] = [];
    const opps: Opportunity[] = [];

    for (const A of bases) {
      for (const B of universe) {
        if (B === A) continue;

        // ---------- 2 HOPS ----------
        for (const fAB of feeTiers) {
          for (const fBA of feeTiers) {
            searched.push(`${A.split("|")[0]}→${B.split("|")[0]}`);
            try {
              const q1: any = await (this.gswap as any).quoting.quoteExactInput(
                A, B, probeAmount.toString(), fAB
              );
              const out1 = new BigNumber(q1?.outTokenAmount?.toString?.() ?? q1?.outTokenAmount ?? "0");
              if (out1.isZero()) continue;

              const q2: any = await (this.gswap as any).quoting.quoteExactInput(
                B, A, out1.toString(), fBA
              );
              const out2 = new BigNumber(q2?.outTokenAmount?.toString?.() ?? q2?.outTokenAmount ?? "0");

              const profitBps = out2.minus(probeAmount).div(probeAmount).multipliedBy(10_000).toNumber();

              opps.push({
                hops: 2,
                tokens: [A, B, A],
                fees: [fAB, fBA],
                path: `${A.split("|")[0]}->${B.split("|")[0]}->${A.split("|")[0]}`,
                profitBps,
              });
            } catch { /* no pool / ignore */ }
          }
        }

        if (maxHops < 3) continue;

        // ---------- 3 HOPS ----------
        for (const C of universe) {
          if (C === A || C === B) continue;

          for (const fAB of feeTiers)
            for (const fBC of feeTiers)
              for (const fCA of feeTiers) {
                searched.push(`${A.split("|")[0]}→${B.split("|")[0]}→${C.split("|")[0]}`);
                try {
                  const q1: any = await (this.gswap as any).quoting.quoteExactInput(
                    A, B, probeAmount.toString(), fAB
                  );
                  const out1 = new BigNumber(q1?.outTokenAmount?.toString?.() ?? q1?.outTokenAmount ?? "0");
                  if (out1.isZero()) continue;

                  const q2: any = await (this.gswap as any).quoting.quoteExactInput(
                    B, C, out1.toString(), fBC
                  );
                  const out2 = new BigNumber(q2?.outTokenAmount?.toString?.() ?? q2?.outTokenAmount ?? "0");
                  if (out2.isZero()) continue;

                  const q3: any = await (this.gswap as any).quoting.quoteExactInput(
                    C, A, out2.toString(), fCA
                  );
                  const out3 = new BigNumber(q3?.outTokenAmount?.toString?.() ?? q3?.outTokenAmount ?? "0");

                  const profitBps = out3.minus(probeAmount).div(probeAmount).multipliedBy(10_000).toNumber();

                  opps.push({
                    hops: 3,
                    tokens: [A, B, C, A],
                    fees: [fAB, fBC, fCA],
                    path: `${A.split("|")[0]}->${B.split("|")[0]}->${C.split("|")[0]}->${A.split("|")[0]}`,
                    profitBps,
                  });
                } catch { /* no route / ignore */ }
              }
        }
      }
    }

    if (logPairs) {
      const max = Math.min(logPairsMax, searched.length);
      log("info", `[ARB:searched] pairs checked (${max}/${searched.length})`);
      for (let i = 0; i < max; i++) log("info", `  - ${searched[i]}`);
    }

    return opps;
  }
}
