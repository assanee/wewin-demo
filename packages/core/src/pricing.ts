import type { CustomGroup, OptionValue, Product, SkuGroup } from './types/catalog.js';
import { areaParam, groupLabel, type Message, optionLabel } from './message.js';
import { type Currency, divRoundHalfUp } from './money.js';
import { resolveSelections } from './selection.js';
import { SQ_UM_PER_SQM } from './units.js';

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
 *   lengths are canonical micrometres → already whole (src/units.ts)
 *   area = µm × µm                    → an exact integer count of square micrometres
 *   pricePerSqm and every delta       → already integers in the catalogue (verified)
 *
 * Nothing is divided until the very last step, so nothing can drift.
 */

/**
 * Working precision: minor units × `SQ_UM_PER_SQM`.
 *
 * Tied to the area unit rather than picked: `baseScaled` is `areaSqUm × price × 100`,
 * so the scale it carries *is* the number of area units in one m². When area moved
 * from mm² to µm² this had to move with it by the same factor of 10^6, or every
 * total would have come out a million times high. The two are written as one
 * constant for that reason.
 *
 * The property that made 10^6 a deliberate choice still holds at 10^12: a `percent`
 * delta divides by 100, and the base stays divisible by 100 with room to spare.
 */
export const PRICE_SCALE = SQ_UM_PER_SQM;
const SCALE = PRICE_SCALE;

/** THB presents on the whole baht, so totals round to 100 satang. Policy, not a fact. */
const THB_ROUND_TO_MINOR = 100n;

export interface PriceLine {
  /**
   * What the row is called, as a key and its values (plan 5).
   *
   * Was `` `${group.labelTh} · ${value.labelTh}` `` — a row naming two catalogue
   * strings, joined by a separator this file chose. Both labels are content a
   * translator owns and the separator is a typographic decision the locale owns, so
   * none of the three belonged here. See `message.ts`.
   */
  label: Message;
  /** Minor units, rounded for display. Plan 4.3(b): these do not sum to the total. */
  amountMinor: bigint;
}

export interface PriceBreakdown {
  /**
   * Square metres, for the screen only.
   *
   * The price is computed entirely in `areaSqUm`; these two are the last step of
   * that arithmetic divided out for a person to read, and nothing may multiply them
   * back up. They stay `number` so a stored snapshot survives JSON unchanged — a
   * quote line's own record of how big the window was is the last witness left if
   * `measures` is ever lost, and it should not depend on a revive path to exist.
   *
   * ⚠️ **Do not format these for display.** Use the two `bigint` fields below and
   * `formatSqmExact`. Phase 6a found the reason the hard way: `sqUmToSqm(21255000000000n)`
   * is 21.254999999999999449… as a `double`, so `toFixed(2)` writes `21.25` while the
   * exact half-up of the same area writes `21.26`. Both numbers were on one screen at
   * once — `PriceSummary` from here, the base row's label from `billableSqUm` — and they
   * disagreed for 11.8% of the catalogue's reachable configurations.
   */
  areaSqm: number;
  billableSqm: number;
  /**
   * The same two areas, exact — an integer count of square micrometres.
   *
   * These are the values the price was actually computed from, carried out rather than
   * recomputed by a reader. `billableSqUm` is the ordered area or the product's floor,
   * whichever is larger, and is the identical value the `price.line.base` label carries;
   * a screen that renders one of them from here and the other from the label is
   * guaranteed to agree with itself.
   */
  areaSqUm: bigint;
  billableSqUm: bigint;
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

const customGroups = (product: Product): CustomGroup[] =>
  product.groups.filter((group): group is CustomGroup => group.kind === 'custom');

/**
 * Resolve the OptionValue each sku group is currently set to.
 *
 * One line, and it used to be five. The five said "an unknown code resolves to nothing at
 * all — better a missing surcharge than a crash", which was a reasonable thing to want in a
 * configurator and a hole in a contract: `skuCode.ts` kept the unknown string, so the order
 * was priced without the upgrade and stamped with the SKU of the upgrade. `resolveSelections`
 * is now the only answer either of them gets. See selection.ts.
 */
const selectedValues = (
  product: Product,
  selections: Record<string, string>,
): { group: SkuGroup; value: OptionValue }[] => resolveSelections(product, selections);

/**
 * Read a measurement in canonical micrometres, falling back to the group default.
 *
 * The `bigint` check is not ceremony: `measures` arrives from localStorage and from
 * share links, and a value that survived as a string would otherwise concatenate
 * rather than multiply.
 */
export function measureOf(
  product: Product,
  measures: Record<string, bigint>,
  code: string,
): bigint {
  const raw = measures[code];
  if (typeof raw === 'bigint') return raw;

  const group = customGroups(product).find((candidate) => candidate.code === code);
  return group?.defaultUm ?? 0n;
}

/**
 * The custom groups the derived area is computed from.
 *
 * Exported because anything reasoning about `area` has to agree on this: a rule that
 * fails on area is really a complaint about these two fields, and the UI needs to
 * know which inputs to mark. schema.ts requires every product to define both.
 */
export const AREA_MEASURE_CODES = ['width', 'height'] as const;

/**
 * Area as an exact count of square micrometres.
 *
 * µm × µm is µm², so the product of the two canonical measurements *is* the answer.
 * The earlier version divided by 10^6 on the way, which was a second rounding point
 * inside a layer that is supposed to have one — the same class of defect that made
 * ฿36,224.496 come out a baht high. There is no division here at all.
 */
export function calcAreaSqUm(product: Product, measures: Record<string, bigint>): bigint {
  const [widthCode, heightCode] = AREA_MEASURE_CODES;
  return (
    measureOf(product, measures, widthCode) * measureOf(product, measures, heightCode)
  );
}

/**
 * Square micrometres to square metres. **Display only** — never on the way to a price.
 *
 * Exported so that the one division out of canonical area lives in one place. The
 * largest area in the catalogue is 8 m × 3 m = 2.4 × 10^13 µm², comfortably inside
 * the exactly-representable integers, so this loses nothing it is asked to show.
 */
export const sqUmToSqm = (sqUm: bigint): number => Number(sqUm) / Number(SQ_UM_PER_SQM);

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
  measures: Record<string, bigint>,
  qty: number,
): PriceBreakdown {
  const areaSqUm = calcAreaSqUm(product, measures);
  const billableSqUm =
    areaSqUm > product.minBillableSqUm ? areaSqUm : product.minBillableSqUm;

  const pricePerSqm = BigInt(product.pricePerSqm);

  // base [scaled] = billableSqm × pricePerSqm, in minor units × SCALE.
  // billableSqUm/SCALE m² × pricePerSqm baht × 100 satang × SCALE / 1  →  × 100 exactly.
  const baseScaled = billableSqUm * pricePerSqm * 100n;

  const lines: PriceLine[] = [];
  const pushLine = (label: Message, scaled: bigint): void => {
    lines.push({ label, amountMinor: divRoundHalfUp(scaled, SCALE) });
  };

  // The base row now says which area it charged for. `billableSqUm` is the ordered area
  // or the product's floor, whichever is larger — so on a small window this param is the
  // floor, and the row can finally explain a base price that does not match the size on
  // the screen. It is the exact `bigint` the price was computed from; nothing divides it
  // on the way out, and `sqUmToSqm` stays a display-only step the renderer takes.
  pushLine(
    { key: 'price.line.base', params: { billableArea: areaParam(billableSqUm) } },
    baseScaled,
  );

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
        scaled = billableSqUm * BigInt(value.delta.amount) * 100n;
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
    if (scaled !== 0n) {
      pushLine(
        {
          key: 'price.line.option',
          params: {
            group: groupLabel(product, group),
            option: optionLabel(product, group, value),
          },
        },
        scaled,
      );
    }
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
    areaSqm: sqUmToSqm(areaSqUm),
    billableSqm: sqUmToSqm(billableSqUm),
    areaSqUm,
    billableSqUm,
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
