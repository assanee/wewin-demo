import type { CustomGroup, OptionValue, Product, SkuGroup } from './types/catalog.js';
import { type Currency, divRoundHalfUp } from './money.js';

/**
 * Pricing, computed in exact integers.
 *
 * v1 did this arithmetic in `number` and rounded once at the end. It produced the
 * right answers, but only because every input happened to be well behaved — the
 * giveaway was `Math.round(unitPrice * qty) + 0`, where the `+ 0` existed solely to
 * stop a total rendering as "-0". Once quotes carry credits, adjustments and nine
 * currencies, "well behaved" stops being a safe assumption.
 *
 * So every value below is a `bigint`. The chain that makes that possible:
 *
 *   lengths land on 0.1 cm      → hold them as whole millimetres
 *   area = mm × mm              → an exact integer count of millionths of a m²
 *   pricePerSqm and every delta → already integers in the catalogue (verified)
 *
 * Nothing is divided until the very last step, so nothing can drift.
 */

/**
 * Working precision: minor units × 10^6.
 *
 * Chosen so that every intermediate — a percentage of the base, a per-m² charge —
 * stays a whole number. Percentages are the binding constraint: a `percent` delta
 * divides by 100, and this scale leaves the base divisible by 100 with room to spare.
 */
export const PRICE_SCALE = 1_000_000n;
const SCALE = PRICE_SCALE;

/** Millionths of a square metre in one square metre. */
const MICRO_SQM = 1_000_000n;

/** THB presents on the whole baht, so totals round to 100 satang. Policy, not a fact. */
const THB_ROUND_TO_MINOR = 100n;

export interface PriceLine {
  label: string;
  /** Minor units, rounded for display. Plan 4.3(b): these do not sum to the total. */
  amountMinor: bigint;
}

export interface PriceBreakdown {
  areaSqm: number;
  billableSqm: number;
  currency: Currency;
  baseMinor: bigint;
  percentTotalMinor: bigint;
  perSqmTotalMinor: bigint;
  flatTotalMinor: bigint;
  /**
   * Price of one unit, in minor units.
   *
   * **Display only — this does not multiply up to `totalMinor`.** The contract number
   * is the line total; rounding per unit and then multiplying would drift on large
   * quantities, which is why v1 already rounded last. Anything that adds money must
   * read `totalMinor`.
   */
  unitPriceMinor: bigint;
  /**
   * The per-unit price at full working precision (minor units × `PRICE_SCALE`).
   *
   * Kept because a quote line can change quantity long after it was priced, and
   * requantifying from the rounded `unitPriceMinor` would round twice — the same
   * defect that made ฿36,224.496 come out a baht high during this rewrite. Use
   * `totalFromUnitPrice`; do not display this.
   */
  unitPriceScaledMinor: bigint;
  qty: number;
  /** The number on the quote. Rounded exactly once, here. */
  totalMinor: bigint;
  lines: PriceLine[];
}

/**
 * The line total for a quantity, rounded once from full precision.
 *
 * The single place the THB presentation unit is applied, so requantifying an existing
 * line and pricing a fresh one cannot drift apart.
 */
export function totalFromUnitPrice(unitPriceScaledMinor: bigint, qty: number): bigint {
  return (
    divRoundHalfUp(unitPriceScaledMinor * BigInt(qty), SCALE * THB_ROUND_TO_MINOR) *
    THB_ROUND_TO_MINOR
  );
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

/** Centimetres to whole millimetres. Every dimension in the catalogue lands on 0.1 cm. */
const toMillimetres = (cm: number): bigint => BigInt(Math.round(cm * 10));

/**
 * Area as an exact count of millionths of a square metre.
 *
 * mm × mm is µm², and there are exactly 1,000,000 mm² in a m² — so the product of the
 * two millimetre measurements *is* the micro-m² figure, with no division at all.
 */
export function calcAreaMicroSqm(product: Product, measures: Record<string, number>): bigint {
  const [widthCode, heightCode] = AREA_MEASURE_CODES;
  return (
    toMillimetres(measureOf(product, measures, widthCode)) *
    toMillimetres(measureOf(product, measures, heightCode))
  );
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
  const areaMicroSqm = calcAreaMicroSqm(product, measures);
  const minBillableMicroSqm = BigInt(Math.round(product.minBillableSqm * Number(MICRO_SQM)));
  const billableMicroSqm =
    areaMicroSqm > minBillableMicroSqm ? areaMicroSqm : minBillableMicroSqm;

  const pricePerSqm = BigInt(product.pricePerSqm);

  // base [scaled] = billableSqm × pricePerSqm, in minor units × SCALE.
  // billableMicroSqm/1e6 m² × pricePerSqm baht × 100 satang × SCALE / 1  →  × 100 exactly.
  const baseScaled = billableMicroSqm * pricePerSqm * 100n;

  const lines: PriceLine[] = [];
  const pushLine = (label: string, scaled: bigint): void => {
    lines.push({ label, amountMinor: divRoundHalfUp(scaled, SCALE) });
  };

  pushLine('ราคาฐานตามพื้นที่', baseScaled);

  let percentScaled = 0n;
  let perSqmScaled = 0n;
  let flatScaled = 0n;

  for (const { group, value } of selectedValues(product, selections)) {
    let scaled = 0n;

    // `none` carries no `amount` at all, so the conversion has to live inside the
    // cases that have one — hoisting it above the switch reads tidier and throws.
    switch (value.delta.type) {
      case 'percent':
        // baseScaled × amount / 100 — exact, because baseScaled carries a factor of 100.
        scaled = (baseScaled * BigInt(value.delta.amount)) / 100n;
        percentScaled += scaled;
        break;
      case 'per_sqm':
        scaled = billableMicroSqm * BigInt(value.delta.amount) * 100n;
        perSqmScaled += scaled;
        break;
      case 'flat':
        scaled = BigInt(value.delta.amount) * 100n * SCALE;
        flatScaled += scaled;
        break;
      case 'none':
        break;
    }

    // An option that costs nothing extra is already visible in the chip group;
    // repeating it here as a zero row only pads the accordion.
    if (scaled !== 0n) pushLine(`${group.labelTh} · ${value.labelTh}`, scaled);
  }

  const unitPriceScaled = baseScaled + percentScaled + perSqmScaled + flatScaled;

  /*
   * Round ONCE, straight from full precision to the presentation unit.
   *
   * Going via satang first and then to the baht is double rounding, and it is not a
   * theoretical worry: ฿36,224.496 becomes ฿36,224.50 on the way and then ฿36,225 at
   * the end, one baht above what v1.0.0 charged. Plan 4.3(b) says one rounding point
   * per layer; this is that point for the THB layer.
   */
  const totalMinor = totalFromUnitPrice(unitPriceScaled, qty);

  return {
    areaSqm: calcAreaSqm(product, measures),
    billableSqm: Number(billableMicroSqm) / Number(MICRO_SQM),
    currency: 'THB',
    baseMinor: divRoundHalfUp(baseScaled, SCALE),
    percentTotalMinor: divRoundHalfUp(percentScaled, SCALE),
    perSqmTotalMinor: divRoundHalfUp(perSqmScaled, SCALE),
    flatTotalMinor: divRoundHalfUp(flatScaled, SCALE),
    unitPriceMinor: divRoundHalfUp(unitPriceScaled, SCALE),
    unitPriceScaledMinor: unitPriceScaled,
    qty,
    totalMinor,
    lines,
  };
}
