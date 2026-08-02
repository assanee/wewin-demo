/**
 * Dedupe key for quote lines.
 *
 * Spec section 3 says sha1(skuCode + measures). We use a synchronous 64-bit FNV-1a
 * instead, for two reasons:
 *
 *   1. In the browser, sha1 means `crypto.subtle.digest`, which is async-only and
 *      unavailable outside a secure context. This key is computed inside the quote
 *      reducer while building a QuoteLine — making that path async to hash a short
 *      string is a large complication for no gain.
 *   2. Nothing here is a security boundary. The key answers "is this the same
 *      configuration the customer already added?" — collision resistance against an
 *      adversary is irrelevant; stability and speed are what matter.
 *
 * Swapping in sha1 later only touches this file: the return contract is a hex string.
 */

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

function fnv1a64(input: string): bigint {
  let hash = FNV_OFFSET_BASIS;

  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK_64;
  }

  return hash;
}

/**
 * Serialise a configuration into a canonical string.
 * Keys are sorted so `{width, height}` and `{height, width}` hash identically,
 * and each pair is delimited so 320/160 cannot serialise the same as 32/0160.
 */
function canonicalise(skuCode: string, measures: Record<string, number>): string {
  const pairs = Object.keys(measures)
    .sort()
    .map((key) => `${key}=${measures[key] ?? 0}`)
    .join(';');

  return `${skuCode}|${pairs}`;
}

export function configHash(skuCode: string, measures: Record<string, number>): string {
  return fnv1a64(canonicalise(skuCode, measures)).toString(16).padStart(16, '0');
}
