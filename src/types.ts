import BigNumber from 'bignumber.js';
export type FeeTier = 500 | 3000 | 10000;

export type Opportunity = {
  path: string;
  tokens: string[];     // ex.: ['GMUSIC','GALA','FILM','GMUSIC']
  fees: FeeTier[];      // ex.: [10000,10000,10000]
  hops: number;         // 2 ou 3
  pct: number;          // lucro estimado (%)
  inAmt: BigNumber;     // valor de entrada (na moeda base do ciclo)
  outAmt: BigNumber;    // valor estimado de saída (na mesma base)
};
