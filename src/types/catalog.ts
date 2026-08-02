/**
 * Catalog domain types.
 *
 * Core distinction the whole system is built on (spec section 0):
 *   - `sku`    options are countable, stocked variants -> they compose the sku_code
 *   - `custom` options are continuous measurements     -> they are inputs to the price formula
 */

export type Unit = 'cm' | 'mm';
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

export interface CustomGroup {
  kind: 'custom';
  code: string; // e.g. 'width'
  labelTh: string;
  input: 'number';
  unit: Unit;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
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
  minBillableSqm: number;
  groups: OptionGroup[];
  rules: Rule[];
  skuPrefix: string; // e.g. 'AWN4T'
}

export interface Category {
  id: string;
  labelTh: string;
  summaryTh: string;
}

import type { RuleExpr } from './rule';
import type { Elevation } from '../lib/elevation';
export type { RuleExpr, Elevation };
