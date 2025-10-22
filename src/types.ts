import BigNumber from "bignumber.js";

/* -------------------------------------------------------
   Tipos base e comuns
---------------------------------------------------------*/

// As pools da GalaSwap usam tiers fixos, mas deixamos aberto a outros
export type FeeTier = 500 | 3000 | 10000 | number;

/* -------------------------------------------------------
   Opportunity (uma rota de arbitragem possível)
---------------------------------------------------------*/
export interface Opportunity {
  /** Caminho legível, ex.: "GALA->FILM->GALA" */
  path: string;

  /** Tokens na ordem da rota, no formato PIPE: "Symbol|Unit|Sub|Network" */
  tokens: string[];

  /** Fee tiers correspondentes aos hops (mesmo tamanho de tokens - 1) */
  fees: FeeTier[];

  /** Número de hops (2, 3, 4 ou 5) */
  hops: number;

  /** Lucro estimado em percentual (ex.: 0.85 = 0.85%) */
  pct?: number;

  /** Lucro estimado em basis points (ex.: 85 = 0.85%) */
  profitBps?: number;

  /** Valor de entrada (na moeda base do ciclo) */
  inAmt?: BigNumber;

  /** Valor de saída estimado (na mesma moeda base) */
  outAmt?: BigNumber;
}
