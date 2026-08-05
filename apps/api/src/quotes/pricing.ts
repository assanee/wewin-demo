import { calcPrice } from '@wewin/core/pricing';
import { buildSkuCode } from '@wewin/core/sku';
import { configHash } from '@wewin/core/hash';
import { hasBlockingError, validate } from '@wewin/core/validation';
import type { Product } from '@wewin/core';
import { encodeUm } from '@wewin/contract/measure';
import type { PriceRequest } from '@wewin/contract/pricing';

import { AppError, type JsonValue } from '../common/errors/app-error';
import { encodeCoreMessage, message } from '../i18n';

/**
 * `calcPrice`, called from the quote editor — and **`calcPrice` is not touched**.
 *
 * Plan 7.9(ก) is explicit that folding overrides into pricing would end 219 tests as a safety
 * net, notably the one at `tests/pricing.test.ts:214` asserting that the breakdown lines sum
 * to the unit price. So the override layer is `overrides.ts`, entirely beside this, and this
 * file is nothing but the machine layer: the same four inputs, the same function, the same
 * answer the configurator and `POST /orders` already get.
 *
 * ── Why this is not `priceOrderDocument` ─────────────────────────────────────────
 *
 * That function prices a whole cart into a frozen document with a hash, a VAT block and a
 * revision. A quote line is priced one at a time, dozens of times, while somebody types, and
 * VAT is taken once over the *effective* subtotal after overrides — which is a figure
 * `priceOrderDocument` cannot see. The two share `calcPrice`, `buildSkuCode`, `configHash`
 * and `validate`, which is to say they share everything that decides a number; what differs
 * is what is done with it afterwards.
 */

export interface PricedLine {
  /** As `buildSkuCode` produced it. The works order renders from this, never from prose. */
  readonly skuCode: string;
  readonly configHash: string;
  /** `calcPrice(...).totalMinor` — the contract number for the whole line at this quantity. */
  readonly totalThbMinor: bigint;
  /** Canonical micrometres as decimal strings, ready for the `measures` column. */
  readonly measures: Record<string, string>;
  readonly selections: Record<string, string>;
}

/**
 * Price one configured line, refusing one that cannot be made.
 *
 * Plan 4.7 found a rule that was silently false across a whole range: a window that cannot be
 * manufactured must not become a promise to manufacture it. Warnings are carried rather than
 * refused — they travel with the quote so the sales team sees them.
 *
 * The catalogue-staleness check is deliberately *not* here. It belongs to the caller, which
 * holds the request's own `CatalogRef` and can answer with the fresh document; a pricer that
 * threw a 409 would be a pricer that had to know about HTTP.
 */
export function priceLine(product: Product, request: PriceRequest, lineLabel: string): PricedLine {
  const issues = validate(product, request.selections, request.measures, request.enteredUnits);

  if (hasBlockingError(issues)) {
    throw AppError.validationFailed(message('error.line.cannot_be_made'), {
      line: lineLabel,
      /*
       * `message` and not `messageTh`. Core stopped building Thai sentences this round
       * (plan section 5), so an issue now carries a key and its params, and this encodes
       * them the way every other `bigint` crosses this wire: micrometres as digit strings.
       * A client renders them with `reviveMessage` from `@wewin/core/message` — the same
       * reviver the storefront reads its own localStorage with.
       */
      issues: issues.map((issue) => ({
        ruleId: issue.ruleId,
        severity: issue.severity,
        message: encodeCoreMessage(issue.message) as unknown as JsonValue,
      })),
    });
  }

  const price = calcPrice(product, request.selections, request.measures, request.qty);
  const skuCode = buildSkuCode(product, request.selections);

  return {
    skuCode,
    /*
     * core's own answer, stored as core produces it. It was `sha256(configHash(…))` for one
     * round because `quote_lines.config_hash` was `char(64)` — the shape of a SHA-256, copied
     * from `order_documents.document_hash` — while `configHash` is a 64-*bit* FNV-1a and
     * sixteen characters wide. `0017_quote_promise_freeze.sql` narrowed the column; the
     * workaround is gone, and this value is now comparable with the `configHash` inside a
     * frozen `order_documents` line, which the widened one never was.
     */
    configHash: configHash(skuCode, request.measures),
    totalThbMinor: price.totalMinor,
    measures: encodeMeasures(request.measures),
    selections: { ...request.selections },
  };
}

/**
 * Re-price a stored line from the columns it kept.
 *
 * Used only by the re-verification pass, where the question is "what does this same
 * configuration cost under what is published now?" and the answer may be *nothing*, because
 * the configuration names an option code the new version does not have. `resolveSelections`
 * throws on an unknown code — which is right for a write and wrong for a comparison — so this
 * returns `null` rather than propagating, and the caller reports the line as one that cannot
 * be carried forward.
 *
 * Validation is deliberately skipped: a rule that has tightened since the line was quoted is
 * a real and different problem, and reporting it as "this price moved" would be a lie. The
 * question here is only about the money.
 */
export function repriceStoredLine(
  product: Product,
  selections: Record<string, string>,
  measures: Record<string, bigint>,
  qty: number,
): bigint | null {
  try {
    return calcPrice(product, selections, measures, qty).totalMinor;
  } catch {
    return null;
  }
}

/** Canonical micrometres to the decimal strings the `measures` column holds (plan 4.1). */
export function encodeMeasures(measures: Record<string, bigint>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [code, um] of Object.entries(measures)) out[code] = um.toString();
  return out;
}

/**
 * …and back, for a stored line.
 *
 * `bigint` and not `number`, because a value that survived as a string would concatenate
 * rather than multiply inside `calcAreaSqUm` — the exact hazard `measureOf` guards against,
 * one layer further out. A value that is not a canonical integer is dropped rather than
 * coerced: it cannot have been written by this module, and guessing what it meant is how a
 * 3.2 m opening becomes 32 µm.
 */
export function decodeStoredMeasures(stored: unknown): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  if (typeof stored !== 'object' || stored === null) return out;

  for (const [code, value] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof value === 'string' && /^-?(?:0|[1-9][0-9]*)$/.test(value)) out[code] = BigInt(value);
  }
  return out;
}

/** The same treatment for `selections`, which is `{ groupCode: valueCode }` and nothing else. */
export function decodeStoredSelections(stored: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof stored !== 'object' || stored === null) return out;

  for (const [code, value] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof value === 'string') out[code] = value;
  }
  return out;
}

/** The wire shape of a stored measure map, for the response encoder. */
export const encodeStoredMeasures = (stored: unknown): Record<string, ReturnType<typeof encodeUm>> => {
  const out: Record<string, ReturnType<typeof encodeUm>> = {};
  for (const [code, um] of Object.entries(decodeStoredMeasures(stored))) out[code] = encodeUm(um);
  return out;
};
