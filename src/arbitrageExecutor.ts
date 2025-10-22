import BigNumber from 'bignumber.js';
import { GSwap, GSwapSDKError } from '@gala-chain/gswap-sdk';
import { Opportunity, FeeTier } from './types.js';

/* -------------------------------------------------------
   TOKEN ID NORMALIZER
   Aceita:
   - Friendly:          "GALA", "GMUSIC"
   - Especial com $:    "$GMUSIC"          -> $GMUSIC$Unit$none$none
   - Canônico $:        "GALA$Unit$none$none", "$GMUSIC$Unit$none$none",
                        "Token$Unit$WEN$client:604161f025e6931a676ccf37"
   - Pipe |:            "GALA|Unit|none|none", "Token|Unit|WEN|client:..."
   Retorna SEMPRE o formato PIPE: "Symbol|Class|Sub|Network"
------------------------------------------------------- */
function toPipeId(input: string): string {
  const trimmed = (input || '').trim();

  // Já está em pipe?
  if (trimmed.includes('|')) return trimmed;

  // Helper para montar canônico $
  const toDollar = (s: string) => {
    if (/\$/.test(s)) {
      // já parece canônico $, ex: GALA$Unit$none$none ou $GMUSIC$Unit$none$none ou Token$Unit$WEN$client:...
      return s;
    }
    // friendly: "GALA" -> GALA$Unit$none$none
    // friendly especial: "$GMUSIC" -> $GMUSIC$Unit$none$none
    if (s.startsWith('$')) return `${s}$Unit$none$none`;
    return `${s}$Unit$none$none`;
  };

  const dollar = toDollar(trimmed);

  // Parse canônico $  ->  PIPE
  // Captura símbolo (com ou sem $ na frente), classe, subclasse, network (pode ter ':')
  const m = dollar.match(/^(\$?[A-Za-z0-9:_-]+)\$(Unit)\$([A-Za-z0-9:_-]+)\$([A-Za-z0-9:_-]+)$/);
  if (!m) {
    throw new Error(`Token id inválido: "${input}". Esperado algo como GALA$Unit$none$none, $GMUSIC$Unit$none$none ou Token$Unit$WEN$client:...`);
  }
  const symbol = m[1].startsWith('$') ? m[1].slice(1) : m[1]; // tira cifrão da frente se existir
  const cls = m[2];
  const sub = m[3];
  const net = m[4];

  return `${symbol}|${cls}|${sub}|${net}`;
}

type ExecConfig = {
  enabled: boolean;
  tradeUsd: BigNumber;             // quantidade na moeda base do ciclo
  maxHopsExec: 2 | 3 | 4 | 5;      // suporta até 5 hops
  maxSlippageBps: number;          // 50 = 0.50% por hop
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

// FIRE-AND-FORGET entre hops (sem esperar confirmação)
const WAIT_AFTER_SEND_MS = Number(process.env.WAIT_AFTER_SEND_MS || '2000');

function minOut(out: BigNumber, bps: number): string {
  const factor = new BigNumber(1).minus(new BigNumber(bps).div(10_000));
  return out.multipliedBy(factor).toFixed();
}
function pathHash(tokens: string[], fees: FeeTier[]) {
  return `${tokens.join('>')}|${fees.join(',')}`;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class ArbitrageExecutor {
  private gswap: GSwap;
  private cfg: ExecConfig;
  private lastExecAt = 0;
  private recentPaths = new Map<string, number>(); // pathHash -> timestamp

  constructor(gswap: GSwap, cfg: ExecConfig) {
    this.gswap = gswap;
    this.cfg = cfg;
  }

  /** Executa UMA oportunidade (2..5 hops) no modo fire-and-forget. */
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
      // Execução genérica N hops
      let amount = this.cfg.tradeUsd;
      for (let i = 0; i < opp.hops; i++) {
        const tokenIn  = opp.tokens[i];
        const tokenOut = opp.tokens[i+1];
        const fee      = opp.fees[i] as FeeTier;
        amount = await this.executeHop(tokenIn, tokenOut, fee, amount);
      }

      const first = this.cfg.tradeUsd;
      const pct = amount.minus(first).div(first).multipliedBy(100).toNumber();
      log('info', `[EXEC] ciclo ${opp.path} | lucro≈${pct.toFixed(3)}% (estimado por quotes; sem confirmar tx)`, this.cfg.logLevel);

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
    const Akey = toPipeId(tokenIn);
    const Bkey = toPipeId(tokenOut);

    // 1) quote
    const q: any = await (this.gswap as any).quoting.quoteExactInput(Akey, Bkey, exactIn.toString(), fee);
    const out = new BigNumber(q.outTokenAmount?.toString?.() ?? q.outTokenAmount);
    const min = minOut(out, this.cfg.maxSlippageBps);
    log('info', `[EXEC] ${Akey.split('|')[0]}->${Bkey.split('|')[0]} fee=${fee} | in=${exactIn.toFixed()} | qOut≈${out.toFixed()} | minOut=${min}`, this.cfg.logLevel);

    // 2) swap — FIRE-AND-FORGET
    const pending: any = await (this.gswap as any).swaps.swap(
      Akey, Bkey, fee,
      { exactIn: exactIn.toString(), amountOutMinimum: min },
      undefined
    );

    const txId: string = pending?.txId || pending?.transactionId || pending?.id || 'unknown';
    log('info', `[EXEC] enviado ${Akey.split('|')[0]}->${Bkey.split('|')[0]} | txId=${txId} | aguardando ${WAIT_AFTER_SEND_MS}ms`, this.cfg.logLevel);
    await sleep(WAIT_AFTER_SEND_MS);

    return out; // retorno estimado do quote
  }
}
