import { createHash } from 'node:crypto';
import type { CatalogDocumentV1 } from './document.js';

/**
 * The hash the configurator carries back with every price request (plan 5, point 5).
 *
 * It has to be computed from a *canonical* form, and the reason is specific to the
 * column it describes: `jsonb` does not store a document, it stores a parsed value —
 * it drops insertion order, discards duplicate keys and reformats numbers. Hashing
 * `JSON.stringify(rowFromPostgres)` would therefore give a different digest from
 * hashing the same document before it was written, and the mismatch would look exactly
 * like the concurrent-publish case the check exists to catch. Sorting keys makes the
 * two agree by construction.
 *
 * Not core's `configHash`: that one identifies a customer's configuration and is tuned
 * for a short, readable key. This identifies a published document, where a collision
 * would mean serving a price from the wrong version, so it is SHA-256.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` has no JSON representation, and a key whose value vanishes must not
    // leave an empty slot behind or the digest depends on how the object was built.
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(',')}}`;
}

export const documentHash = (document: CatalogDocumentV1): string =>
  createHash('sha256').update(canonicalJson(document)).digest('hex');
