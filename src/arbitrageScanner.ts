import BigNumber from 'bignumber.js';
import { GSwap } from '@gala-chain/gswap-sdk';
import { FeeTier, Opportunity } from './types.js';

/* ---------- Normalizador igual ao do executor ---------- */
function toPipeId(input: string): string {
  const trimmed = (input || '').trim();
  if (trimmed.includes('|')) return trimmed;
  const toDollar = (s: string) => {
    if (/\$/.test(s)) return s;
    if (s.startsWith('$')) return `${s}$Unit$none$none`;
    return `${s}$Unit$none$none`;
  };
  const dollar = toDollar(trimmed);
  const m = dollar.match(/^(\$?[A-Za-z0-9:_-]+)\$(Unit)\$([A-Za-z0-9:_-]+)\$([A-Za-z0-9:_-]+)$/);
  if (!m) throw new Error(`Token id inválido: "${input}"`);
  const symbol = m[1].startsWith('$') ? m[1].slice(1) : m[1];
  return `${symbol}|${m[2]}|${m[3]}|${m[4]}`;
}

type ScanCfg = {
  baseSymbols: string[];     // pode conter friendly, $, $, pipe...
  tokens: string[];          // universo
  feeTiers: FeeTier[];
  probeAmount: BigNumber;    // quantidade para simular
  maxHops: 2 | 3 | 4 | 5;
  logPairs: boolean;
  logPairsMax: number;
  log: (level: 'info'|'debug'|'warn'|'error', msg: string) => void;
};

export class ArbitrageScanner {
  constructor(private gswap: GSwap, private cfg: ScanCfg) {}

  async scanOnce(): Promise<Opportunity[]> {
    const { baseSymbols, tokens, feeTiers, probeAmount, maxHops, logPairs, logPairsMax, log } = this.cfg;

    // normaliza todo mundo
    const bases = baseSymbols.map(toPipeId);
    const universe = Array.from(new Set(tokens.map(toPipeId)));

    const searched: string[] = [];
    const opps: Opportunity[] = [];

    // Exemplo simples: procura 2 e 3 hops (amplie conforme seu projeto)
    for (const A of bases) {
      for (const B of universe) {
        if (B === A) continue;
        for (const fAB of feeTiers) {
          // 2 hops: A->B->A
          for (const fBA of feeTiers) {
            searched.push(`${A.split('|')[0]}→${B.split('|')[0]}`);
            try {
              const q1: any = await (this.gswap as any).quoting.quoteExactInput(A, B, probeAmount.toString(), fAB);
              const out1 = new BigNumber(q1.outTokenAmount?.toString?.() ?? q1.outTokenAmount);
              if (out1.isZero()) continue;
              const q2: any = await (this.gswap as any).quoting.quoteExactInput(B, A, out1.toString(), fBA);
              const out2 = new BigNumber(q2.outTokenAmount?.toString?.() ?? q2.outTokenAmount);
              const profitBps = out2.minus(probeAmount).div(probeAmount).multipliedBy(10_000).toNumber();
              opps.push({
                hops: 2,
                tokens: [A,B,A],
                fees: [fAB,fBA],
                profitBps,
                path: `${A.split('|')[0]}->${B.split('|')[0]}->${A.split('|')[0]}`
              });
            } catch {/* ignora par inexistente */}
          }
        }
        if (maxHops < 3) continue;

        // 3 hops: A->B->C->A
        for (const C of universe) {
          if (C === A || C === B) continue;
          for (const fAB of feeTiers) for (const fBC of feeTiers) for (const fCA of feeTiers) {
            searched.push(`${A.split('|')[0]}→${B.split('|')[0]}→${C.split('|')[0]}`);
            try {
              const q1: any = await (this.gswap as any).quoting.quoteExactInput(A, B, probeAmount.toString(), fAB);
              const out1 = new BigNumber(q1.outTokenAmount?.toString?.() ?? q1.outTokenAmount);
              if (out1.isZero()) continue;
              const q2: any = await (this.gswap as any).quoting.quoteExactInput(B, C, out1.toString(), fBC);
              const out2 = new BigNumber(q2.outTokenAmount?.toString?.() ?? q2.outTokenAmount);
              if (out2.isZero()) continue;
              const q3: any = await (this.gswap as any).quoting.quoteExactInput(C, A, out2.toString(), fCA);
              const out3 = new BigNumber(q3.outTokenAmount?.toString?.() ?? q3.outTokenAmount);
              const profitBps = out3.minus(probeAmount).div(probeAmount).multipliedBy(10_000).toNumber();
              opps.push({
                hops: 3,
                tokens: [A,B,C,A],
                fees: [fAB,fBC,fCA],
                profitBps,
                path: `${A.split('|')[0]}->${B.split('|')[0]}->${C.split('|')[0]}->${A.split('|')[0]}`
              });
            } catch {/* ignora rotas inexistentes */}
          }
        }
      }
    }

    if (logPairs) {
      const max = Math.min(logPairsMax, searched.length);
      log('info', `[ARB:searched] pares pesquisados (${max}/${searched.length})`);
      for (let i=0; i<max; i++) log('info', `  - ${searched[i]}`);
    }
    return opps;
  }
}
