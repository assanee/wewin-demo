/**
 * The catalogue as v1.0.0's `calcPrice` reads it, frozen beside it.
 *
 * `pricing-v1.0.0.ts` is vendored to be an independent witness of what v1.0.0 charged,
 * but it was importing its types from `src/types/catalog.ts` — so the "frozen" baseline
 * silently tracked whatever the live types became. The micrometre flip renamed two of
 * the fields it reads (`minBillableSqm` → `minBillableSqUm`, a custom group's
 * `defaultValue` → `defaultUm`) and the baseline stopped compiling. A baseline that
 * moves with the code it exists to outlive is not a baseline; these declarations are
 * the fix, and the import in `pricing-v1.0.0.ts` is the only line of it that changed.
 *
 * Declared here is exactly the surface v1's pricing function reads, and no more. That
 * is narrower than v1's `Product` on purpose:
 *
 *   - v1's `CustomGroup` carried `min`/`max`/`step`/`unit` in the authored unit. None
 *     of them is a pricing input, and naming them would make today's catalogue — which
 *     holds those bounds in micrometres — unpassable, which would end the comparison
 *     rather than sharpen it.
 *   - `rules` and `elevation` are likewise absent. Pinning v1's `RuleExpr` here would
 *     freeze a shape the rule AST has deliberately moved on from, for a field the
 *     price never consults.
 *
 * Structural typing does the rest: `pricing-parity.test.ts` hands over the live
 * catalogue with the two renamed figures converted back, and TypeScript checks that it
 * still satisfies everything v1 knew how to ask for.
 */

export type PriceDelta =
  | { type: 'none' }
  | { type: 'flat'; amount: number } // THB per unit
  | { type: 'per_sqm'; amount: number } // THB per billable sqm
  | { type: 'percent'; amount: number }; // % of base only

export interface OptionValue {
  code: string;
  labelTh: string;
  delta: PriceDelta;
}

export interface SkuGroup {
  kind: 'sku';
  code: string;
  labelTh: string;
  values: OptionValue[];
  defaultValue: string;
}

export interface CustomGroup {
  kind: 'custom';
  code: string;
  /** The fallback for an absent measurement, in the centimetres v1 priced in. */
  defaultValue: number;
}

export interface Product {
  pricePerSqm: number;
  /** The price floor in m², which is the only area unit v1 had. */
  minBillableSqm: number;
  groups: (SkuGroup | CustomGroup)[];
}
