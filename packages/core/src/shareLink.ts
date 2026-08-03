import type { CustomGroup, Product, SkuGroup } from './types/catalog.js';
import { MAX_QTY, MIN_QTY } from './constants.js';
import { isLengthUnit, type LengthUnit } from './units.js';

/**
 * Encoding a configuration into the URL so a link can be shared.
 *
 * Group codes go into the query string as-is — `?profile_color=BK&width=2500000` — in
 * preference to a packed blob. A shared link ends up in a chat window where someone
 * will read it, and a salesperson who can see the width in the URL can spot a wrong
 * one without opening it. It also means an old link degrades gracefully instead of
 * failing to decode.
 *
 * Measurements travel as raw integer micrometres in both directions, so this file
 * converts nothing. The previous version routed them through `formatCm`, which meant
 * a link built from 250.34 cm carried "250.3" — the link lost resolution before
 * imperial entry ever existed to complicate it.
 *
 * Everything read back is untrusted: it has been through a chat client, possibly a
 * URL shortener, and possibly someone's own edits.
 */

/**
 * The representation the numbers in a link are written in.
 *
 * Shares the quote's version because they turned over together. A link without it is
 * from before micrometres and its `width=250` means centimetres.
 */
export const SHARE_SCHEMA_VERSION = '3';

/** Query keys the app already uses for routing; never treated as group codes. */
export const SHARE_RESERVED_KEYS = ['v', 'line', 'category', 'qty'] as const;

/** Suffix for the companion key that records what unit a measurement was typed in. */
const UNIT_SUFFIX = '_u';

export interface SharedConfig {
  selections: Record<string, string>;
  measures: Record<string, bigint>;
  enteredUnits: Record<string, LengthUnit>;
  qty: number;
}

const skuGroups = (product: Product): SkuGroup[] =>
  product.groups.filter((group): group is SkuGroup => group.kind === 'sku');

const customGroups = (product: Product): CustomGroup[] =>
  product.groups.filter((group): group is CustomGroup => group.kind === 'custom');

export function buildShareParams(
  product: Product,
  selections: Record<string, string>,
  measures: Record<string, bigint>,
  enteredUnits: Record<string, LengthUnit>,
  qty: number,
): URLSearchParams {
  const search = new URLSearchParams();

  search.set('v', SHARE_SCHEMA_VERSION);

  for (const group of skuGroups(product)) {
    const value = selections[group.code];
    if (value) search.set(group.code, value);
  }

  for (const group of customGroups(product)) {
    const value = measures[group.code];
    if (typeof value !== 'bigint') continue;

    search.set(group.code, value.toString());

    // Per group, not one unit per link: a customer may well have the sill width off
    // a tape in inches and the head height off a drawing in centimetres.
    const unit = enteredUnits[group.code];
    if (unit) search.set(`${group.code}${UNIT_SUFFIX}`, unit);
  }

  // One is the default, and the common link is better off short.
  if (qty > 1) search.set('qty', String(Math.min(qty, MAX_QTY)));

  return search;
}

/** Accepts only a string of digits — `BigInt("")` is 0n and `BigInt(" 1 ")` is 1n. */
function readUm(value: string): bigint | null {
  return /^\d+$/.test(value) ? BigInt(value) : null;
}

/**
 * Read a configuration out of a query string, or null if it carries none.
 *
 * Null rather than an empty config so the caller can tell "no configuration in this
 * link" apart from "a configuration that happens to match the defaults" — only the
 * first should leave the configurator on its own defaults.
 *
 * Every rejection below returns null for the *whole* link rather than dropping one
 * key, and nothing is clamped into range. Clamping was the real hazard here: a
 * pre-micrometre `?width=250` clamps up to the 60 cm minimum and opens a configurator
 * showing a perfectly ordinary window that is not the one that was shared. A link
 * that fails to parse is a link the recipient asks about; a link that parses into the
 * wrong window is one they quote from.
 */
export function readSharedConfig(product: Product, search: URLSearchParams): SharedConfig | null {
  if (search.get('v') !== SHARE_SCHEMA_VERSION) return null;

  const selections: Record<string, string> = {};
  const measures: Record<string, bigint> = {};
  const enteredUnits: Record<string, LengthUnit> = {};
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

    const um = readUm(raw);
    if (um === null || um < group.minUm || um > group.maxUm) return null;

    measures[group.code] = um;
    found = true;

    const unit = search.get(`${group.code}${UNIT_SUFFIX}`);
    if (unit !== null) {
      if (!isLengthUnit(unit)) return null;
      enteredUnits[group.code] = unit;
    }
  }

  if (!found) return null;

  const rawQty = Number.parseInt(search.get('qty') ?? '', 10);
  const qty = Number.isFinite(rawQty)
    ? Math.min(Math.max(rawQty, MIN_QTY), MAX_QTY)
    : MIN_QTY;

  return { selections, measures, enteredUnits, qty };
}

/** The absolute URL to share for a configuration. */
export function buildShareUrl(
  origin: string,
  product: Product,
  selections: Record<string, string>,
  measures: Record<string, bigint>,
  enteredUnits: Record<string, LengthUnit>,
  qty: number,
): string {
  const search = buildShareParams(product, selections, measures, enteredUnits, qty);
  return `${origin}/products/${product.slug}?${search.toString()}`;
}
