/**
 * Catalog domain types.
 *
 * Core distinction the whole system is built on (spec section 0):
 *   - `sku`    options are countable, stocked variants -> they compose the sku_code
 *   - `custom` options are continuous measurements     -> they are inputs to the price formula
 */

/**
 * The unit a size profile was written in.
 *
 * Not the unit anything is *held* in — every length below is canonical micrometres.
 * This records what a human wrote in `products.ts`, so a message about a range can
 * fall back to the catalogue's own idiom when the customer has not typed anything
 * yet. Deliberately narrower than `LengthUnit`: the table is authored in metric.
 */
export type AuthoredUnit = 'cm' | 'mm';
export type OptionKind = 'sku' | 'custom';
export type InputStyle = 'swatch' | 'chip' | 'toggle' | 'number';

export type PriceDelta =
  | { type: 'none' }
  | { type: 'flat'; amount: number } // THB per unit
  | { type: 'per_sqm'; amount: number } // THB per billable sqm
  | { type: 'percent'; amount: number }; // % of base only

export interface OptionValue {
  code: string; // composes sku_code
  labelTh: string;
  swatchHex?: string; // for input 'swatch'
  delta: PriceDelta;
  available: boolean;
}

export interface SkuGroup {
  kind: 'sku';
  code: string; // e.g. 'profile_color'
  labelTh: string;
  input: Extract<InputStyle, 'swatch' | 'chip' | 'toggle'>;
  required: true;
  includeInSkuCode: boolean;
  values: OptionValue[];
  defaultValue: string;
}

/**
 * A continuous measurement.
 *
 * Every bound is an integer count of micrometres, because the alternative is a
 * catalogue authored on the 5 mm grid and a customer typing on the 1/8 in grid with
 * no common lattice between them — see `src/units.ts` for the gcd this rests on.
 * `unit` says how the row was written; it never says how the value is stored.
 */
export interface CustomGroup {
  kind: 'custom';
  code: string; // e.g. 'width'
  labelTh: string;
  input: 'number';
  unit: AuthoredUnit;
  minUm: bigint;
  maxUm: bigint;
  stepUm: bigint;
  defaultUm: bigint;
  helperTh?: string;
}

export type OptionGroup = SkuGroup | CustomGroup;

/* ------------------------------------------------------------------ *
 * Rule predicates — see src/types/rule.ts
 * ------------------------------------------------------------------ */

export type Rule = {
  id: string;
  messageTh: string;
  severity: 'error' | 'warning';
  when: RuleExpr;
};

export interface Product {
  id: string;
  slug: string;
  nameTh: string;
  categoryId: string;
  summaryTh: string;
  /**
   * How to draw this product's front elevation. Data, not artwork: the panel count
   * and opening symbol come from here so one renderer serves all 81 products and a
   * new one is drawn correctly the moment it is added to the table.
   */
  elevation: Elevation;
  heroImage: string;
  leadTimeDays: [number, number];
  pricePerSqm: number;
  /**
   * The price floor, in the same unit the area is computed in (µm²).
   *
   * Named for its unit rather than left as `minBillableSqm`, because it is compared
   * directly against `calcAreaSqUm` — the two figures being a million-fold apart and
   * still both called "sqm" is how a price floor stops applying without a test failing.
   */
  minBillableSqUm: bigint;
  groups: OptionGroup[];
  rules: Rule[];
  skuPrefix: string; // e.g. 'AWN4T'
}

export interface Category {
  id: string;
  labelTh: string;
  summaryTh: string;
}

import type { RuleExpr } from './rule.js';
import type { Elevation } from '../elevation.js';
export type { RuleExpr, Elevation };
