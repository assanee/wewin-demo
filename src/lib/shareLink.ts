import type { CustomGroup, Product, SkuGroup } from '../types/catalog';
import { formatCm } from './format';
import { MAX_QTY, MIN_QTY } from '../state/quoteReducer';

/**
 * Encoding a configuration into the URL so a link can be shared.
 *
 * Group codes go into the query string as-is — `?profile_color=BK&width=250` — in
 * preference to a packed blob. A shared link ends up in a chat window where someone
 * will read it, and a salesperson who can see the width in the URL can spot a wrong
 * one without opening it. It also means an old link degrades gracefully instead of
 * failing to decode.
 *
 * Everything read back is untrusted: it has been through a chat client, possibly a
 * URL shortener, and possibly someone's own edits. Unknown groups, values the
 * product no longer offers and out-of-range numbers are dropped or clamped rather
 * than trusted, so a hand-edited link cannot price a nine-metre window.
 */

/** Query keys the app already uses for routing; never treated as group codes. */
export const SHARE_RESERVED_KEYS = ['line', 'category', 'qty'] as const;

export interface SharedConfig {
  selections: Record<string, string>;
  measures: Record<string, number>;
  qty: number;
}

const skuGroups = (product: Product): SkuGroup[] =>
  product.groups.filter((group): group is SkuGroup => group.kind === 'sku');

const customGroups = (product: Product): CustomGroup[] =>
  product.groups.filter((group): group is CustomGroup => group.kind === 'custom');

export function buildShareParams(
  product: Product,
  selections: Record<string, string>,
  measures: Record<string, number>,
  qty: number,
): URLSearchParams {
  const search = new URLSearchParams();

  for (const group of skuGroups(product)) {
    const value = selections[group.code];
    if (value) search.set(group.code, value);
  }

  for (const group of customGroups(product)) {
    const value = measures[group.code];
    // Through the formatter, or a few stepper presses leak 160.50000000000003
    // into a link someone is going to read.
    if (typeof value === 'number' && Number.isFinite(value)) {
      search.set(group.code, formatCm(value));
    }
  }

  // One is the default, and the common link is better off short.
  if (qty > 1) search.set('qty', String(Math.min(qty, MAX_QTY)));

  return search;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * Read a configuration out of a query string, or null if it carries none.
 *
 * Null rather than an empty config so the caller can tell "no configuration in this
 * link" apart from "a configuration that happens to match the defaults" — only the
 * first should leave the configurator on its own defaults.
 */
export function readSharedConfig(product: Product, search: URLSearchParams): SharedConfig | null {
  const selections: Record<string, string> = {};
  const measures: Record<string, number> = {};
  let found = false;

  for (const group of skuGroups(product)) {
    const raw = search.get(group.code);
    if (raw === null) continue;

    // A link built against an older catalog may name a colour that is gone.
    if (group.values.some((value) => value.code === raw)) {
      selections[group.code] = raw;
      found = true;
    }
  }

  for (const group of customGroups(product)) {
    const raw = search.get(group.code);
    if (raw === null) continue;

    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) continue;

    measures[group.code] = clamp(parsed, group.min, group.max);
    found = true;
  }

  if (!found) return null;

  const rawQty = Number.parseInt(search.get('qty') ?? '', 10);
  const qty = Number.isFinite(rawQty) ? clamp(rawQty, MIN_QTY, MAX_QTY) : MIN_QTY;

  return { selections, measures, qty };
}

/** The absolute URL to share for a configuration. */
export function buildShareUrl(
  origin: string,
  product: Product,
  selections: Record<string, string>,
  measures: Record<string, number>,
  qty: number,
): string {
  const search = buildShareParams(product, selections, measures, qty);
  return `${origin}/products/${product.slug}?${search.toString()}`;
}
