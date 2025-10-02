import BigNumber from 'bignumber.js';

export type FeeTier = 500 | 3000 | 10000;

export type Opportunity = {
  path: string;        // ex.: "GUSDC (500) → GALA (3000) → GUSDC"
  tokens: string[];    // ex.: ['GUSDC','GALA','GUSDC'] ou ['GUSDC','GALA','FILM','GUSDC']
  fees: FeeTier[];     // ex.: [500,3000] ou [500,3000,10000]
  hops: number;        // 2 ou 3
  pct: number;         // lucro % estimado (com base em quotes)
  inAmt: BigNumber;    // valor de entrada da simulação (probe)
  outAmt: BigNumber;   // valor estimado de saída
};
