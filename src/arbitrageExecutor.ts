import BigNumber from 'bignumber.js';
import { GSwap, GSwapSDKError } from '@gala-chain/gswap-sdk';
import { Opportunity, FeeTier } from './types.js';

type ExecConfig = {
  enabled: boolean;
  tradeUsd: BigNumber;
  maxHopsExec: 2 | 3;             // 3 = triangular
  maxSlippageBps: number;         // ex.: 50 = 0.50%
  cooldownMs: number;
  dedupeWindowMs: number;
  baseSymbol: string;
  logLevel: 'debug'|'info'|'warn'|'error';
};

const order = ['debug','info','warn','error'] as const;
function log(level: 'debug'|'info'|'warn'|'error', msg: string, current: 'debug'|'info'|'warn'|'error') {
  if (order.indexOf(level) < order.indexOf(current)) return;
  console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`);
}

const toKey = (sym: string) => `${sym}|Unit|none|none`;

function minOut(out: BigNumber, bps: number): string {
  const factor = new BigNumber(1).minus(new BigNumber(bps).div(10_000));
  return out.multipliedBy(factor).toFixed();
}

function pathHash(tokens: string[], fees: FeeTier[]) {
  return `${tokens.join('>')}|${fees.join(',')}`;
}

export class ArbitrageExecutor {
  private gswap: GSwap;
  private cfg: ExecConfig;
  private lastExecAt = 0;
  private recentPaths = new Map<string, number>(); // pathHash -> timestamp

  constructor(gswap: GSwap, cfg: ExecConfig) {
    this.gswap = gswap;
    this.cfg = cfg;
  }

  /** Tenta executar UMA oportunidade (2 ou 3 hops). */
  async tryExecute(opp: Opportunity): Promise<boolean> {
    if (!this.cfg.enabled) return false;
    if (opp.hops > this.cfg.maxHopsExec) {
      log('warn', `[EXEC] ignorado: hops=${opp.hops} > ARB_MAX_HOPS_EXEC=${this.cfg.maxHopsExec}`, this.cfg.logLevel);
      return false;
    }

    // cooldown
    const now = Date.now();
    if (now - this.lastExecAt < this.cfg.cooldownMs) {
      log('warn', `[EXEC] cooldown ativo (${this.cfg.cooldownMs}ms)`, this.cfg.logLevel);
      return false;
    }

    // dedupe
    const ph = pathHash(opp.tokens, opp.fees);
    const lastSeen = this.recentPaths.get(ph);
    if (lastSeen && (now - lastSeen) < this.cfg.dedupeWindowMs) {
      log('warn', `[EXEC] caminho repetido recentemente, pulando | ${opp.path}`, this.cfg.logLevel);
      return false;
    }

    try {
      if (opp.hops === 2) {
        await this.exec2Hops(opp);
      } else if (opp.hops === 3) {
        await this.exec3Hops(opp);
      } else {
        log('warn', `[EXEC] hops não suportados: ${opp.hops}`, this.cfg.logLevel);
        return false;
      }

      this.lastExecAt = Date.now();
      this.recentPaths.set(ph, this.lastExecAt);
      return true;

    } catch (err: any) {
      if (err?.code || err instanceof GSwapSDKError) {
        log('error', `[EXEC][sdk] ${err.code || 'GSWAP_SDK_ERROR'}: ${err.message} ${err.details ? JSON.stringify(err.details) : ''}`, this.cfg.logLevel);
      } else {
        log('error', `[EXEC] erro: ${err?.message || String(err)}`, this.cfg.logLevel);
      }
      return false;
    }
  }

  // ---------- helpers ----------
  private async executeHop(tokenIn: string, tokenOut: string, fee: FeeTier, exactIn: BigNumber) {
    const Akey = toKey(tokenIn), Bkey = toKey(tokenOut);

    // 1) quote
    const q: any = await (this.gswap as any).quoting.quoteExactInput(Akey, Bkey, exactIn.toString(), fee);
    const out = new BigNumber(q.outTokenAmount?.toString?.() ?? q.outTokenAmount);
    const min = minOut(out, this.cfg.maxSlippageBps);
    log('info', `[EXEC] ${tokenIn}->${tokenOut} fee=${fee} | in=${exactIn.toFixed()} ${tokenIn} | qOut≈${out.toFixed()} ${tokenOut} | minOut=${min}`, this.cfg.logLevel);

    // 2) swap (assinatura+envio já dentro do SDK)
    const pending = await (this.gswap as any).swaps.swap(
      Akey, Bkey, fee,
      { exactIn: exactIn.toString(), amountOutMinimum: min },
      undefined
    );

    // 3) aguarda confirmação
    try { await (GSwap as any).events.connectEventSocket(); } catch {}
    const receipt = await pending.wait();
    log('info', `[EXEC] concluído ${tokenIn}->${tokenOut} | txHash=${receipt.transactionHash}`, this.cfg.logLevel);

    return out; // retorno baseado no quote (não é o balanço on-chain real)
  }

  private async exec2Hops(opp: Opportunity) {
    const [A,B,_A] = opp.tokens;
    const [feeAB, feeBA] = opp.fees as [FeeTier, FeeTier];

    // hop1
    const out1 = await this.executeHop(A, B, feeAB, this.cfg.tradeUsd);
    // hop2 (usa out1 cotado como referência de exactIn)
    const out2 = await this.executeHop(B, A, feeBA, out1);

    const pct = out2.minus(this.cfg.tradeUsd).div(this.cfg.tradeUsd).multipliedBy(100).toNumber();
    log('info', `[EXEC] ciclo 2-hops ${A}->${B}->${A} | lucro≈${pct.toFixed(3)}% (estimado por quotes)`, this.cfg.logLevel);
  }

  private async exec3Hops(opp: Opportunity) {
    const [A,B,C,_A] = opp.tokens;
    const [feeAB, feeBC, feeCA] = opp.fees as [FeeTier, FeeTier, FeeTier];

    // hop1 A->B
    const out1 = await this.executeHop(A, B, feeAB, this.cfg.tradeUsd);
    // hop2 B->C
    const out2 = await this.executeHop(B, C, feeBC, out1);
    // hop3 C->A
    const out3 = await this.executeHop(C, A, feeCA, out2);

    const pct = out3.minus(this.cfg.tradeUsd).div(this.cfg.tradeUsd).multipliedBy(100).toNumber();
    log('info', `[EXEC] ciclo 3-hops ${A}->${B}->${C}->${A} | lucro≈${pct.toFixed(3)}% (estimado por quotes)`, this.cfg.logLevel);
  }
}
