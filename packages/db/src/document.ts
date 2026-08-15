import type { AuthoredUnit, Elevation, InputStyle } from '@wewin/core';

/**
 * The frozen catalogue document — the shape stored in `product_versions.document`.
 *
 * This is a *storage* shape, not the domain shape. It differs from `@wewin/core`'s
 * `Product` in exactly three ways, and each one is a decision rather than an accident:
 *
 * 1. **Every exact number is a decimal string.** JSON has one numeric type and it is a
 *    double. A µm² area of 2.4 × 10^13 survives that; a satang total on a large order
 *    eventually does not, and the failure is a silent low-digit change rather than an
 *    error. `bigint` in, string out, `BigInt()` back on the way in — one conversion
 *    point, in `compile.ts`, instead of a `JSON.parse` reviver nobody remembers to use.
 *
 * 2. **Money is minor units with the currency named**, and a percent surcharge is basis
 *    points with no currency at all, because 8% is 8% in every market (plan 4.2). The
 *    domain's `pricePerSqm: number` in whole baht is a convenience the storage layer
 *    does not inherit.
 *
 * 3. **`available` is absent.** Stock changes without a publish, and plan 5's second
 *    warning is that a frozen row cannot carry a value that has to keep moving. It
 *    stays on `option_values`, and `fromDocument` overlays it when the api materialises
 *    a `Product`. A document that embedded it would be wrong within the hour and wrong
 *    silently — the option would still be offered, just from a stale snapshot.
 *
 * `schemaVersion` is here because plan 4.5 is a list of stored payloads that had no
 * version field and were reinterpreted under new rules without anyone noticing.
 */

export const CATALOG_DOCUMENT_SCHEMA_VERSION = 1;

/** A `bigint` rendered in base 10. See note 1 above. */
export type ExactString = string;

export type DocPriceDelta =
  | { type: 'none' }
  /** Per configured unit. */
  | { type: 'flat'; currency: 'THB'; minor: ExactString }
  /** Per billable square metre. */
  | { type: 'per_sqm'; currency: 'THB'; minor: ExactString }
  /** Markup on the aluminium base only, in basis points. */
  | { type: 'percent'; bp: number };

export interface DocOptionValue {
  code: string;
  labelTh: string;
  swatchHex?: string;
  delta: DocPriceDelta;
}

export interface DocSkuGroup {
  kind: 'sku';
  code: string;
  labelTh: string;
  input: Extract<InputStyle, 'swatch' | 'chip' | 'toggle'>;
  includeInSkuCode: boolean;
  values: DocOptionValue[];
  defaultValue: string;
}

export interface DocCustomGroup {
  kind: 'custom';
  code: string;
  labelTh: string;
  input: 'number';
  /** How the bounds were written for a human. Storage is always micrometres. */
  unit: AuthoredUnit;
  minUm: ExactString;
  maxUm: ExactString;
  stepUm: ExactString;
  defaultUm: ExactString;
  helperTh?: string;
}

export type DocOptionGroup = DocSkuGroup | DocCustomGroup;

/**
 * The rule AST, mirrored with `const.value` as a string.
 *
 * Written out rather than derived from `NumExpr` with a mapped type: the recursion runs
 * through `mul`, and a conditional type that rewrites one leaf of a recursive union is
 * a puzzle for the next reader to solve every time they open the file.
 */
export type DocNumExpr =
  | { n: 'const'; value: ExactString; dim: 'length' | 'area' | 'scalar' }
  | { n: 'measure'; group: string }
  | { n: 'area' }
  | { n: 'mul'; left: DocNumExpr; right: DocNumExpr };

export type DocRuleExpr =
  | { op: 'gt'; left: DocNumExpr; right: DocNumExpr }
  | { op: 'lt'; left: DocNumExpr; right: DocNumExpr }
  | { op: 'gte'; left: DocNumExpr; right: DocNumExpr }
  | { op: 'lte'; left: DocNumExpr; right: DocNumExpr }
  | { op: 'selected'; group: string; value: string }
  | { op: 'and'; all: DocRuleExpr[] }
  | { op: 'or'; any: DocRuleExpr[] }
  | { op: 'not'; expr: DocRuleExpr };

export interface DocRule {
  id: string;
  messageTh: string;
  severity: 'error' | 'warning';
  when: DocRuleExpr;
}

export interface CatalogDocumentV1 {
  schemaVersion: typeof CATALOG_DOCUMENT_SCHEMA_VERSION;
  id: string;
  slug: string;
  nameTh: string;
  categoryId: string;
  summaryTh: string;
  /** Pure geometry, all small integers and ratios — the one blob that needs no rewriting. */
  elevation: Elevation;
  heroImage: string;
  leadTimeDays: [number, number];
  currency: 'THB';
  pricePerSqmMinor: ExactString;
  minBillableSqUm: ExactString;
  groups: DocOptionGroup[];
  rules: DocRule[];
  skuPrefix: string;
  /**
   * ⭐ 0052. The gallery and the video link, both optional.
   *
   * ⚠️ **Optional is what keeps `schemaVersion` at 1.** Eighty-three documents were frozen
   * before these existed, and `product_versions_document_schema_version_matches` ties the
   * blob's own `schemaVersion` to the column beside it — so making these required would
   * either break every decode or force a V2 and a rewrite of every row. An additive optional
   * field is readable by a V1 reader, which is the whole reason it is spelled this way.
   *
   * They are inside the freeze, like every other editable product column, because changing
   * how a product is *described* is a new version of the description. `option_values.available`
   * is the one catalogue fact deliberately kept out, with its own CHECK, because stock is not
   * a description.
   */
  images?: string[];
  videoUrl?: string | null;
}
