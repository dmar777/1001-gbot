import stringify from 'json-stringify-deterministic';
import elliptic from 'elliptic';              // CJS → default import
import jsSha3 from 'js-sha3';                 // CJS → default import
import BN from 'bn.js';

const { ec: EC } = elliptic as unknown as { ec: new (curve: string) => any };
const { keccak256 } = jsSha3 as unknown as { keccak256: { digest: (msg: Uint8Array) => Uint8Array } };

const ecSecp256k1 = new EC('secp256k1');

export function signObject<T extends object>(obj: T, privateKey: string): T & { signature: string } {
  const toSign: any = { ...obj };
  if ('signature' in toSign) delete toSign.signature;

  const message = stringify(toSign);

  // js-sha3 (CJS) → usar o método digest e converter para Buffer
  const hashArr = keccak256.digest(Buffer.from(message));
  const hash = Buffer.from(hashArr);

  const pk = Buffer.from(privateKey.replace(/^0x/, ''), 'hex');
  const signature = ecSecp256k1.sign(hash, pk);

  // normalizar s para low-s
  if (signature.s.cmp(ecSecp256k1.curve.n.shrn(1)) > 0) {
    const n = ecSecp256k1.curve.n;
    (signature as any).s = new BN(n).sub(signature.s);
    if (signature.recoveryParam != null) (signature as any).recoveryParam = 1 - signature.recoveryParam;
  }

  const der = Buffer.from(signature.toDER()).toString('base64');
  return { ...toSign, signature: der };
}
