import type { CustomGroup, OptionValue, Product, SkuGroup } from './catalog-v1.0.0.js';

export interface PriceBreakdown {
  areaSqm: number;
  billableSqm: number;
  base: number;
  percentTotal: number;
  perSqmTotal: number;
  flatTotal: number;
  unitPrice: number;
  qty: number;
  total: number;
  /** One row per real charge, rendered by the price accordion. Appendable — see spec 13.1. */
  lines: { label: string; amount: number }[];
}

const skuGroups = (product: Product): SkuGroup[] =>
  product.groups.filter((group): group is SkuGroup => group.kind === 'sku');

const customGroups = (product: Product): CustomGroup[] =>
  product.groups.filter((group): group is CustomGroup => group.kind === 'custom');

/**
 * Resolve the OptionValue each sku group is currently set to.
 * A missing selection resolves to the group default, because that is what the UI shows.
 * An unknown code resolves to nothing at all — better a missing surcharge than a crash.
 */
function selectedValues(product: Product, selections: Record<string, string>): {
  group: SkuGroup;
  value: OptionValue;
}[] {
  const resolved: { group: SkuGroup; value: OptionValue }[] = [];

  for (const group of skuGroups(product)) {
    const code = selections[group.code] ?? group.defaultValue;
    const value = group.values.find((candidate) => candidate.code === code);
    if (value) resolved.push({ group, value });
  }

  return resolved;
}

/** Read a measurement in cm, falling back to the group default so area is never NaN. */
export function measureOf(
  product: Product,
  measures: Record<string, number>,
  code: string,
): number {
  const raw = measures[code];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;

  const group = customGroups(product).find((candidate) => candidate.code === code);
  return group?.defaultValue ?? 0;
}

/**
 * The custom groups the derived area is computed from.
 *
 * Exported because anything reasoning about `area` has to agree on this: a rule that
 * fails on area is really a complaint about these two fields, and the UI needs to
 * know which inputs to mark. schema.ts requires every product to define both.
 */
export const AREA_MEASURE_CODES = ['width', 'height'] as const;

/** Area in square metres from the width and height custom groups. */
export function calcAreaSqm(product: Product, measures: Record<string, number>): number {
  const [widthCode, heightCode] = AREA_MEASURE_CODES;
  return (measureOf(product, measures, widthCode) * measureOf(product, measures, heightCode)) / 10000;
}

/**
 * Price a configuration. Pure — no React, no clock, no randomness (spec section 5).
 *
 * The order below is fixed by the spec and must not be reshuffled: `percent` deltas
 * are a markup on the aluminium base only, so they are taken before per-sqm glass
 * charges and flat hardware charges are added.
 */
export function calcPrice(
  product: Product,
  selections: Record<string, string>,
  measures: Record<string, number>,
  qty: number,
): PriceBreakdown {
  const areaSqm = calcAreaSqm(product, measures);
  const billableSqm = Math.max(areaSqm, product.minBillableSqm);
  const base = billableSqm * product.pricePerSqm;

  const lines: { label: string; amount: number }[] = [
    { label: 'ราคาฐานตามพื้นที่', amount: base },
  ];

  let percentTotal = 0;
  let perSqmTotal = 0;
  let flatTotal = 0;

  for (const { group, value } of selectedValues(product, selections)) {
    let amount = 0;

    switch (value.delta.type) {
      case 'percent':
        amount = (base * value.delta.amount) / 100;
        percentTotal += amount;
        break;
      case 'per_sqm':
        amount = billableSqm * value.delta.amount;
        perSqmTotal += amount;
        break;
      case 'flat':
        amount = value.delta.amount;
        flatTotal += amount;
        break;
      case 'none':
        break;
    }

    // An option that costs nothing extra is already visible in the chip group;
    // repeating it here as a zero row only pads the accordion.
    if (amount !== 0) {
      lines.push({ label: `${group.labelTh} · ${value.labelTh}`, amount });
    }
  }

  const unitPrice = base + percentTotal + perSqmTotal + flatTotal;
  // Round once, at the very end — rounding per unit would drift on large quantities.
  // `+ 0` normalises -0, which would otherwise render as "-0" in the summary.
  const total = Math.round(unitPrice * qty) + 0;

  return {
    areaSqm,
    billableSqm,
    base,
    percentTotal,
    perSqmTotal,
    flatTotal,
    unitPrice,
    qty,
    total,
    lines,
  };
}
