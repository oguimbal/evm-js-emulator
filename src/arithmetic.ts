export const BIGINT_NEG1 = BigInt(-1)

export const BIGINT_0 = BigInt(0)
export const BIGINT_1 = BigInt(1)
export const BIGINT_2 = BigInt(2)
export const BIGINT_3 = BigInt(3)
export const BIGINT_7 = BigInt(7)
export const BIGINT_8 = BigInt(8)

export const BIGINT_27 = BigInt(27)
export const BIGINT_28 = BigInt(28)
export const BIGINT_31 = BigInt(31)
export const BIGINT_32 = BigInt(32)
export const BIGINT_64 = BigInt(64)

export const BIGINT_128 = BigInt(128)
export const BIGINT_255 = BigInt(255)
export const BIGINT_256 = BigInt(256)

export const BIGINT_96 = BigInt(96)
export const BIGINT_100 = BigInt(100)
export const BIGINT_160 = BigInt(160)
export const BIGINT_224 = BigInt(224)
export const BIGINT_2EXP96 = BigInt(79228162514264337593543950336)
export const BIGINT_2EXP160 = BigInt(1461501637330902918203684832716283019655932542976)
export const BIGINT_2EXP224 =
  BigInt(26959946667150639794667015087019630673637144422540572481103610249216)
export const BIGINT_2EXP256 = BIGINT_2 ** BIGINT_256

export const TWO_POW256 = BigInt('0x10000000000000000000000000000000000000000000000000000000000000000');


/**
 * The max integer that the evm can handle (2^256-1) as a bigint
 * 2^256-1 equals to 340282366920938463463374607431768211455
 * We use literal value instead of calculated value for compatibility issue.
 */
export const MAX_INTEGER_BIGINT = BigInt(
    '115792089237316195423570985008687907853269984665640564039457584007913129639935'
  )

export function mod(a: bigint, b: bigint) {
    let r = a % b;
    if (r < BIGINT_0) {
        r = b + r;
    }
    return r;
}

export function fromTwos(a: bigint) {
    return BigInt.asIntN(256, a);
}

export function toTwos(a: bigint) {
    return BigInt.asUintN(256, a);
}

export const MAX_NUM = BigInt(Number.MAX_SAFE_INTEGER);

const N = BigInt(115792089237316195423570985008687907853269984665640564039457584007913129639936)
export function exponentiation(bas: bigint, exp: bigint) {
  let t = BIGINT_1
  while (exp > BIGINT_0) {
    if (exp % BIGINT_2 !== BIGINT_0) {
      t = (t * bas) % N
    }
    bas = (bas * bas) % N
    exp = exp / BIGINT_2
  }
  return t
}
