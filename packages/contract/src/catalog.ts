import { z } from 'zod';
import type {
  Category,
  CustomGroup,
  Dimension,
  Elevation,
  NumExpr,
  OptionGroup,
  OptionValue,
  PriceDelta,
  Product,
  Rule,
  RuleExpr,
  SkuGroup,
} from '@wewin/core';
import {
  type MoneyRateWire,
  type MoneyWire,
  encodeMinor,
  encodeMinorPerSqm,
  moneyRateWireSchema,
  moneyWireSchema,
} from './money.js';
import {
  type AreaWire,
  type BasisPointsWire,
  type LengthWire,
  areaWireSchema,
  basisPointsWireSchema,
  decodeBasisPoints,
  decodeSqUm,
  decodeUm,
  encodeBasisPoints,
  encodeSqUm,
  encodeUm,
  lengthWireSchema,
} from './measure.js';
import { type Exact, encodeExact, exactSchema, toBigInt, unitOf } from './exact.js';

/**
 * The published product document.
 *
 * Plan 5 splits the catalogue in two: normalised tables the dashboard edits, and one
 * frozen JSONB document per published version that web and api read and that an order
 * refers to. This is the shape of that document as it leaves the API — the same fields
 * core's `Product` has, under the same names, with every exact quantity wrapped so its
 * unit travels with it.
 *
 * Field names are core's on purpose. The mapping below is then mechanical and a
 * reviewer can check it by reading two columns rather than a rename table, and the one
 * thing that *does* change — baht becoming satang, a percent becoming basis points —
 * is visible in the type of the field rather than hidden in its name.
 */

/* ------------------------------------------------------------------ *
 * The handle every priced request must carry back
 * ------------------------------------------------------------------ */

/**
 * Which document a client was looking at.
 *
 * Plan 5 point 5: this goes out with the resolved product and must come back with
 * every request that prices or orders it, and the server answers 409 with the fresh
 * document when it does not match. Both halves are here rather than the hash alone
 * because the version id is what an order row stores and what a 409 has to name;
 * the hash is what makes a mismatch detectable when a version is republished in place.
 */
export interface CatalogRef {
  readonly productVersionId: string;
  readonly documentHash: string;
}

/**
 * Exported as a shape, not only as a schema, so a request schema can spread it in.
 *
 * Both formats were left as "any non-empty string" while the server side was still being
 * written, and are now pinned to what it actually produces: `product_versions.id` is a
 * Postgres `uuid` and `document_hash` is the hex SHA-256 of the canonicalised document
 * (`@wewin/db`'s hash.ts). Pinning them is not tidiness — a request body is written by a
 * client this repository does not ship, and `productVersionId: "'; drop"` handed to a
 * `uuid` comparison is a 22P02 from the driver, which surfaces as a 500 for what is
 * plainly a bad request. Lowercase only: two spellings of one hash are two hashes.
 */
export const catalogRefShape = {
  productVersionId: z.uuid(),
  documentHash: z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex SHA-256 digest'),
} as const;

export const catalogRefSchema: z.ZodType<CatalogRef> = z.object(catalogRefShape);

/** Whether a client is looking at the document the server would price against. */
export const isCatalogRefFresh = (sent: CatalogRef, current: CatalogRef): boolean =>
  sent.productVersionId === current.productVersionId && sent.documentHash === current.documentHash;

/* ------------------------------------------------------------------ *
 * Leaves
 * ------------------------------------------------------------------ */

/**
 * A price delta, in the units the database stores.
 *
 * `flat` and `per_sqm` are baht in the catalogue table and satang here, because plan
 * 4.3 puts money in Postgres as `bigint` minor units — carrying baht on the wire would
 * mean the API divides by 100 on the way out and multiplies on the way in, which is a
 * rounding decision in the least-tested place. `percent` is basis points for the reason
 * plan 4.2 gives: 8% is 8% in every currency, so it is an integer that is not money.
 *
 * The base price is THB only. That is plan 4.2's decision, not a simplification: one
 * base currency per product with pinned conversion rates, so `calcPrice` never has to
 * know about a currency at all.
 */
export type PriceDeltaWire =
  | { readonly type: 'none' }
  | { readonly type: 'flat'; readonly amount: MoneyWire<'THB'> }
  | { readonly type: 'per_sqm'; readonly amount: MoneyRateWire<'THB'> }
  | { readonly type: 'percent'; readonly amount: BasisPointsWire };

export interface OptionValueWire {
  readonly code: string;
  readonly labelTh: string;
  readonly swatchHex?: string | undefined;
  readonly delta: PriceDeltaWire;
  readonly available: boolean;
}

export interface SkuGroupWire {
  readonly kind: 'sku';
  readonly code: string;
  readonly labelTh: string;
  readonly input: 'swatch' | 'chip' | 'toggle';
  readonly required: true;
  readonly includeInSkuCode: boolean;
  readonly values: readonly OptionValueWire[];
  readonly defaultValue: string;
}

export interface CustomGroupWire {
  readonly kind: 'custom';
  readonly code: string;
  readonly labelTh: string;
  readonly input: 'number';
  /** How the row was authored. Never how the bounds below are held — those are µm. */
  readonly unit: 'cm' | 'mm';
  readonly minUm: LengthWire;
  readonly maxUm: LengthWire;
  readonly stepUm: LengthWire;
  readonly defaultUm: LengthWire;
  readonly helperTh?: string | undefined;
}

export type OptionGroupWire = SkuGroupWire | CustomGroupWire;

/**
 * A rule constant, carrying its own dimension.
 *
 * Core's `NumExpr` writes the dimension in a sibling field (`{ value, dim }`), which
 * leaves `{ value: 200n, dim: 'scalar' }` expressible for a length — the exact mistake
 * rule.ts:20-28 exists to warn about. On the wire the unit tag *is* the dimension:
 * `um` is a length, `um2` an area, `count` a scalar. A constant that disagrees with
 * itself has no encoding.
 */
export type ConstValueWire = Exact<'um' | 'um2' | 'count'>;

export type NumExprWire =
  | { readonly n: 'const'; readonly value: ConstValueWire }
  | { readonly n: 'measure'; readonly group: string }
  | { readonly n: 'area' }
  | { readonly n: 'mul'; readonly left: NumExprWire; readonly right: NumExprWire };

export type RuleExprWire =
  | { readonly op: 'gt'; readonly left: NumExprWire; readonly right: NumExprWire }
  | { readonly op: 'lt'; readonly left: NumExprWire; readonly right: NumExprWire }
  | { readonly op: 'gte'; readonly left: NumExprWire; readonly right: NumExprWire }
  | { readonly op: 'lte'; readonly left: NumExprWire; readonly right: NumExprWire }
  | { readonly op: 'selected'; readonly group: string; readonly value: string }
  | { readonly op: 'and'; readonly all: readonly RuleExprWire[] }
  | { readonly op: 'or'; readonly any: readonly RuleExprWire[] }
  | { readonly op: 'not'; readonly expr: RuleExprWire };

export interface RuleWire {
  readonly id: string;
  readonly messageTh: string;
  readonly severity: 'error' | 'warning';
  readonly when: RuleExprWire;
  /**
   * Every group code `when` reads.
   *
   * Plan 5 keeps the rule AST inside the JSONB and puts `referenced_group_codes` in a
   * column beside it as the handle an integrity check can grip. It travels on the wire
   * for the same reason: a client can mark the right controls without walking the AST,
   * and a server can check the handle against the document it just compiled without
   * parsing it. Derived, never authored — `encodeRule` computes it.
   */
  readonly referencedGroupCodes: readonly string[];
}

export interface ElevationWire {
  readonly panels: number;
  readonly operation: 'fixed' | 'casement' | 'awning' | 'slide' | 'fold' | 'hang' | 'vertical';
  readonly infill: 'glass' | 'louvre' | 'mesh';
  readonly panelWidths?: readonly number[] | undefined;
  readonly movingPanels?: readonly number[] | undefined;
}

export interface ProductWire {
  readonly id: string;
  readonly slug: string;
  readonly nameTh: string;
  readonly categoryId: string;
  readonly summaryTh: string;
  readonly elevation: ElevationWire;
  readonly heroImage: string;
  readonly leadTimeDays: readonly [number, number];
  readonly pricePerSqm: MoneyRateWire<'THB'>;
  readonly minBillableSqUm: AreaWire;
  readonly groups: readonly OptionGroupWire[];
  readonly rules: readonly RuleWire[];
  readonly skuPrefix: string;
  /**
   * ⭐ 0052. The gallery and the video, carried to whoever renders the product.
   *
   * ⛔ These arrived late and the wire hop is where they were dropped: `Product` had them,
   * the document had them, the repository wrote them, and `encodeProduct` — a hand-written
   * list of thirteen keys — simply did not mention them. Nothing failed to compile, because
   * an absent optional key is neither an excess property nor a missing one. The test that
   * catches it now is the encode/decode round trip in `tests/catalog.test.ts`, given a
   * product that actually has a gallery.
   */
  readonly images?: readonly string[] | undefined;
  readonly videoUrl?: string | null | undefined;
}

export interface CategoryWire {
  readonly id: string;
  readonly labelTh: string;
  readonly summaryTh: string;
}

/** What `GET /products/:slug` answers: the document, and the handle to send back. */
export interface ProductDocumentWire extends CatalogRef {
  readonly product: ProductWire;
}

/** The decoded form: a core `Product`, plus the handle it was published under. */
export interface ProductDocument extends CatalogRef {
  readonly product: Product;
}

/* ------------------------------------------------------------------ *
 * Schemas
 * ------------------------------------------------------------------ */

const thbAmount = moneyWireSchema('THB');
const thbRate = moneyRateWireSchema('THB');

/*
 * Exported rather than file-local because `./admin.ts` builds request schemas out of the
 * same three leaves. A second spelling of "what a price delta looks like" would be a
 * second thing to keep in step with `option_values`' CHECK constraints, and the write side
 * accepting a shape the read side cannot emit is the drift this package exists to prevent.
 */
export const priceDeltaWireSchema: z.ZodType<PriceDeltaWire> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('flat'), amount: thbAmount }),
  z.object({ type: z.literal('per_sqm'), amount: thbRate }),
  z.object({ type: z.literal('percent'), amount: basisPointsWireSchema }),
]);

const optionValueWireSchema: z.ZodType<OptionValueWire> = z.object({
  code: z.string().min(1),
  labelTh: z.string().min(1),
  swatchHex: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'swatchHex must be a #RRGGBB colour')
    .optional(),
  delta: priceDeltaWireSchema,
  available: z.boolean(),
});

// Deliberately un-annotated: `z.discriminatedUnion` needs a member it can read the
// discriminant off, which a `z.ZodType<…>` annotation erases. The union below carries
// the annotation instead, so the shapes are still checked against the wire types.
const skuGroupWireSchema = z.object({
  kind: z.literal('sku'),
  code: z.string().min(1),
  labelTh: z.string().min(1),
  input: z.literal(['swatch', 'chip', 'toggle']),
  required: z.literal(true),
  includeInSkuCode: z.boolean(),
  values: z.array(optionValueWireSchema).min(1),
  defaultValue: z.string().min(1),
});

const customGroupWireSchema = z.object({
  kind: z.literal('custom'),
  code: z.string().min(1),
  labelTh: z.string().min(1),
  input: z.literal('number'),
  unit: z.literal(['cm', 'mm']),
  minUm: lengthWireSchema,
  maxUm: lengthWireSchema,
  stepUm: lengthWireSchema,
  defaultUm: lengthWireSchema,
  helperTh: z.string().optional(),
});

const optionGroupWireSchema: z.ZodType<OptionGroupWire> = z.discriminatedUnion('kind', [
  skuGroupWireSchema,
  customGroupWireSchema,
]);

const constValueWireSchema: z.ZodType<ConstValueWire> = exactSchema(['um', 'um2', 'count']);

const numExprWireSchema: z.ZodType<NumExprWire> = z.lazy(() =>
  z.discriminatedUnion('n', [
    z.object({ n: z.literal('const'), value: constValueWireSchema }),
    z.object({ n: z.literal('measure'), group: z.string().min(1) }),
    z.object({ n: z.literal('area') }),
    z.object({ n: z.literal('mul'), left: numExprWireSchema, right: numExprWireSchema }),
  ]),
);

const comparison = <T extends 'gt' | 'lt' | 'gte' | 'lte'>(op: T) =>
  z.object({ op: z.literal(op), left: numExprWireSchema, right: numExprWireSchema });

export const ruleExprWireSchema: z.ZodType<RuleExprWire> = z.lazy(() =>
  z.discriminatedUnion('op', [
    comparison('gt'),
    comparison('lt'),
    comparison('gte'),
    comparison('lte'),
    z.object({ op: z.literal('selected'), group: z.string().min(1), value: z.string().min(1) }),
    z.object({ op: z.literal('and'), all: z.array(ruleExprWireSchema).min(1) }),
    z.object({ op: z.literal('or'), any: z.array(ruleExprWireSchema).min(1) }),
    z.object({ op: z.literal('not'), expr: ruleExprWireSchema }),
  ]),
);

const ruleWireSchema: z.ZodType<RuleWire> = z.object({
  id: z.string().min(1),
  messageTh: z.string().min(1),
  severity: z.literal(['error', 'warning']),
  when: ruleExprWireSchema,
  referencedGroupCodes: z.array(z.string().min(1)),
});

export const elevationWireSchema: z.ZodType<ElevationWire> = z.object({
  panels: z.number().int().min(1).max(24),
  operation: z.literal(['fixed', 'casement', 'awning', 'slide', 'fold', 'hang', 'vertical']),
  infill: z.literal(['glass', 'louvre', 'mesh']),
  panelWidths: z.array(z.number().finite().positive()).optional(),
  movingPanels: z.array(z.number().int().nonnegative()).optional(),
});

export const productWireSchema: z.ZodType<ProductWire> = z.object({
  id: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/, 'slug must be lowercase kebab-case'),
  nameTh: z.string().min(1),
  categoryId: z.string().min(1),
  summaryTh: z.string().min(1),
  elevation: elevationWireSchema,
  heroImage: z.string().min(1),
  leadTimeDays: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  pricePerSqm: thbRate,
  minBillableSqUm: areaWireSchema,
  groups: z.array(optionGroupWireSchema).min(1),
  rules: z.array(ruleWireSchema),
  skuPrefix: z.string().min(1),
  images: z.array(z.string().min(1)).optional(),
  videoUrl: z.union([z.string().min(1), z.null()]).optional(),
});

export const categoryWireSchema: z.ZodType<CategoryWire> = z.object({
  id: z.string().min(1),
  labelTh: z.string().min(1),
  summaryTh: z.string().min(1),
});

export const productDocumentWireSchema: z.ZodType<ProductDocumentWire> = z.object({
  // The same two fields, the same rules — spread rather than restated so the response
  // schema and the request schema cannot drift into accepting different handles.
  ...catalogRefShape,
  product: productWireSchema,
});

/* ------------------------------------------------------------------ *
 * Encode — domain to wire
 * ------------------------------------------------------------------ */

const MINOR_PER_BAHT = 100n;
const BP_PER_PERCENT = 100n;

/**
 * A catalogue figure that has to be whole, refusing anything that is not.
 *
 * Not a rounding, in either direction. `calcPrice` reaches `BigInt(product.pricePerSqm)`
 * and `BigInt(value.delta.amount)` (pricing.ts:196, 221) and `BigInt(1200.5)` throws, so
 * a fractional figure is one the server itself cannot price. Rounding it on the way out
 * would publish a price nobody can reproduce; rounding it on the way in would hide the
 * day a fraction reached a column that has only ever held whole baht. Both ends refuse,
 * so both ends tell the same story. Verified whole across all 81 products today.
 */
function whole(value: number, field: string): bigint {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`contract: ${field} is ${String(value)}, which core cannot price`);
  }
  return BigInt(value);
}

const bahtToMinor = (baht: number, field: string): bigint => whole(baht, field) * MINOR_PER_BAHT;

function encodePriceDelta(delta: PriceDelta, field: string): PriceDeltaWire {
  switch (delta.type) {
    case 'none':
      return { type: 'none' };
    case 'flat':
      return { type: 'flat', amount: encodeMinor(bahtToMinor(delta.amount, field), 'THB') };
    case 'per_sqm':
      return {
        type: 'per_sqm',
        amount: encodeMinorPerSqm(bahtToMinor(delta.amount, field), 'THB'),
      };
    case 'percent':
      return {
        type: 'percent',
        amount: encodeBasisPoints(whole(delta.amount, field) * BP_PER_PERCENT),
      };
  }
}

function encodeOptionValue(value: OptionValue, field: string): OptionValueWire {
  const wire: { -readonly [K in keyof OptionValueWire]: OptionValueWire[K] } = {
    code: value.code,
    labelTh: value.labelTh,
    delta: encodePriceDelta(value.delta, `${field}.${value.code}`),
    available: value.available,
  };
  // Written only when present: `JSON.stringify` drops an explicit `undefined`, so
  // emitting one here would make the encoded document differ from its own round trip.
  if (value.swatchHex !== undefined) wire.swatchHex = value.swatchHex;
  return wire;
}

function encodeGroup(group: OptionGroup, field: string): OptionGroupWire {
  if (group.kind === 'sku') {
    return {
      kind: 'sku',
      code: group.code,
      labelTh: group.labelTh,
      input: group.input,
      required: true,
      includeInSkuCode: group.includeInSkuCode,
      values: group.values.map((value) => encodeOptionValue(value, `${field}.${group.code}`)),
      defaultValue: group.defaultValue,
    };
  }

  const wire: { -readonly [K in keyof CustomGroupWire]: CustomGroupWire[K] } = {
    kind: 'custom',
    code: group.code,
    labelTh: group.labelTh,
    input: 'number',
    unit: group.unit,
    minUm: encodeUm(group.minUm),
    maxUm: encodeUm(group.maxUm),
    stepUm: encodeUm(group.stepUm),
    defaultUm: encodeUm(group.defaultUm),
  };
  if (group.helperTh !== undefined) wire.helperTh = group.helperTh;
  return wire;
}

const CONST_UNIT: Record<Dimension, 'um' | 'um2' | 'count'> = {
  length: 'um',
  area: 'um2',
  scalar: 'count',
};

function encodeNumExpr(expr: NumExpr): NumExprWire {
  switch (expr.n) {
    case 'const':
      return { n: 'const', value: encodeExact(CONST_UNIT[expr.dim], expr.value) };
    case 'measure':
      return { n: 'measure', group: expr.group };
    case 'area':
      return { n: 'area' };
    case 'mul':
      return { n: 'mul', left: encodeNumExpr(expr.left), right: encodeNumExpr(expr.right) };
  }
}

export function encodeRuleExpr(expr: RuleExpr): RuleExprWire {
  switch (expr.op) {
    case 'gt':
    case 'lt':
    case 'gte':
    case 'lte':
      return { op: expr.op, left: encodeNumExpr(expr.left), right: encodeNumExpr(expr.right) };
    case 'selected':
      return { op: 'selected', group: expr.group, value: expr.value };
    case 'and':
      return { op: 'and', all: expr.all.map(encodeRuleExpr) };
    case 'or':
      return { op: 'or', any: expr.any.map(encodeRuleExpr) };
    case 'not':
      return { op: 'not', expr: encodeRuleExpr(expr.expr) };
  }
}

/** Group codes a rule reads. The `referenced_group_codes` handle of plan 5. */
export function referencedGroupCodes(expr: RuleExpr): string[] {
  const found = new Set<string>();

  const walkNum = (node: NumExpr): void => {
    if (node.n === 'measure') found.add(node.group);
    if (node.n === 'mul') {
      walkNum(node.left);
      walkNum(node.right);
    }
  };

  const walk = (node: RuleExpr): void => {
    switch (node.op) {
      case 'gt':
      case 'lt':
      case 'gte':
      case 'lte':
        walkNum(node.left);
        walkNum(node.right);
        break;
      case 'selected':
        found.add(node.group);
        break;
      case 'and':
        node.all.forEach(walk);
        break;
      case 'or':
        node.any.forEach(walk);
        break;
      case 'not':
        walk(node.expr);
        break;
    }
  };

  walk(expr);
  // Sorted so the document has one spelling and `documentHash` is stable across two
  // compilations of the same rule.
  return [...found].sort();
}

const encodeRule = (rule: Rule): RuleWire => ({
  id: rule.id,
  messageTh: rule.messageTh,
  severity: rule.severity,
  when: encodeRuleExpr(rule.when),
  referencedGroupCodes: referencedGroupCodes(rule.when),
});

export function encodeElevation(elevation: Elevation): ElevationWire {
  const wire: { -readonly [K in keyof ElevationWire]: ElevationWire[K] } = {
    panels: elevation.panels,
    operation: elevation.operation,
    infill: elevation.infill,
  };
  if (elevation.panelWidths !== undefined) wire.panelWidths = elevation.panelWidths;
  if (elevation.movingPanels !== undefined) wire.movingPanels = elevation.movingPanels;
  return wire;
}

export const encodeProduct = (product: Product): ProductWire => ({
  id: product.id,
  slug: product.slug,
  nameTh: product.nameTh,
  categoryId: product.categoryId,
  summaryTh: product.summaryTh,
  elevation: encodeElevation(product.elevation),
  heroImage: product.heroImage,
  leadTimeDays: product.leadTimeDays,
  pricePerSqm: encodeMinorPerSqm(bahtToMinor(product.pricePerSqm, `${product.id}.pricePerSqm`), 'THB'),
  minBillableSqUm: encodeSqUm(product.minBillableSqUm),
  groups: product.groups.map((group) => encodeGroup(group, product.id)),
  rules: product.rules.map(encodeRule),
  skuPrefix: product.skuPrefix,
  /* Absent stays absent: a product with no gallery encodes exactly as it did before 0052. */
  ...(product.images === undefined ? {} : { images: [...product.images] }),
  ...(product.videoUrl === undefined || product.videoUrl === null
    ? {}
    : { videoUrl: product.videoUrl }),
});

export const encodeCategory = (category: Category): CategoryWire => ({ ...category });

export const encodeProductDocument = (document: ProductDocument): ProductDocumentWire => ({
  productVersionId: document.productVersionId,
  documentHash: document.documentHash,
  product: encodeProduct(document.product),
});

/* ------------------------------------------------------------------ *
 * Decode — wire to domain
 * ------------------------------------------------------------------ */

/**
 * Satang back to the whole baht core's pricer needs.
 *
 * It refuses a fraction rather than rounding one away, because `calcPrice` reaches
 * `BigInt(product.pricePerSqm)` and `BigInt(value.delta.amount)` (pricing.ts:196, 221),
 * and `BigInt(1200.5)` throws. A rounding here would hide the day somebody stores
 * ฿1,200.50 in a column that has always held whole baht; the throw names the field
 * while the document is still in hand.
 */
function bahtOf(minor: bigint, field: string): number {
  if (minor % MINOR_PER_BAHT !== 0n) {
    throw new TypeError(
      `contract: ${field} is ${String(minor)} satang, which is not a whole baht — ` +
        'core prices in whole baht and would throw on the fraction',
    );
  }
  return Number(minor / MINOR_PER_BAHT);
}

function decodePriceDelta(wire: PriceDeltaWire, field: string): PriceDelta {
  switch (wire.type) {
    case 'none':
      return { type: 'none' };
    case 'flat':
      return { type: 'flat', amount: bahtOf(toBigInt(wire.amount), field) };
    case 'per_sqm':
      return { type: 'per_sqm', amount: bahtOf(toBigInt(wire.amount), field) };
    case 'percent': {
      const bp = decodeBasisPoints(wire.amount);
      if (bp % BP_PER_PERCENT !== 0n) {
        throw new TypeError(
          `contract: ${field} is ${String(bp)} bp, which is not a whole percent — ` +
            'core takes a percent delta as an integer and would throw on the fraction',
        );
      }
      return { type: 'percent', amount: Number(bp / BP_PER_PERCENT) };
    }
  }
}

function decodeOptionValue(wire: OptionValueWire, field: string): OptionValue {
  const value: OptionValue = {
    code: wire.code,
    labelTh: wire.labelTh,
    delta: decodePriceDelta(wire.delta, `${field}.${wire.code}`),
    available: wire.available,
  };
  if (wire.swatchHex !== undefined) value.swatchHex = wire.swatchHex;
  return value;
}

function decodeGroup(wire: OptionGroupWire, field: string): OptionGroup {
  if (wire.kind === 'sku') {
    const group: SkuGroup = {
      kind: 'sku',
      code: wire.code,
      labelTh: wire.labelTh,
      input: wire.input,
      required: true,
      includeInSkuCode: wire.includeInSkuCode,
      values: wire.values.map((value) => decodeOptionValue(value, `${field}.${wire.code}`)),
      defaultValue: wire.defaultValue,
    };
    return group;
  }

  const group: CustomGroup = {
    kind: 'custom',
    code: wire.code,
    labelTh: wire.labelTh,
    input: 'number',
    unit: wire.unit,
    minUm: decodeUm(wire.minUm),
    maxUm: decodeUm(wire.maxUm),
    stepUm: decodeUm(wire.stepUm),
    defaultUm: decodeUm(wire.defaultUm),
  };
  if (wire.helperTh !== undefined) group.helperTh = wire.helperTh;
  return group;
}

const CONST_DIMENSION: Record<'um' | 'um2' | 'count', Dimension> = {
  um: 'length',
  um2: 'area',
  count: 'scalar',
};

function decodeNumExpr(wire: NumExprWire): NumExpr {
  switch (wire.n) {
    case 'const':
      return {
        n: 'const',
        value: toBigInt(wire.value),
        dim: CONST_DIMENSION[unitOf(wire.value)],
      };
    case 'measure':
      return { n: 'measure', group: wire.group };
    case 'area':
      return { n: 'area' };
    case 'mul':
      return { n: 'mul', left: decodeNumExpr(wire.left), right: decodeNumExpr(wire.right) };
  }
}

/**
 * Exported for the write side: a rule arriving from the dashboard has to become the AST
 * `product_version_rules.when_expr` stores and the group-code list beside it. Both
 * conversions already exist (`@wewin/db`'s `toDocRule` and `referencedGroupCodes`) and
 * both take core's `RuleExpr`, so this is the one step that was missing rather than a new
 * one. A second wire-to-AST walk in apps/api would be a second place for `area` to forget
 * that it reads two groups.
 */
export function decodeRuleExpr(wire: RuleExprWire): RuleExpr {
  switch (wire.op) {
    case 'gt':
    case 'lt':
    case 'gte':
    case 'lte':
      return { op: wire.op, left: decodeNumExpr(wire.left), right: decodeNumExpr(wire.right) };
    case 'selected':
      return { op: 'selected', group: wire.group, value: wire.value };
    case 'and':
      return { op: 'and', all: wire.all.map(decodeRuleExpr) };
    case 'or':
      return { op: 'or', any: wire.any.map(decodeRuleExpr) };
    case 'not':
      return { op: 'not', expr: decodeRuleExpr(wire.expr) };
  }
}

export function decodeElevation(wire: ElevationWire): Elevation {
  const elevation: Elevation = {
    panels: wire.panels,
    operation: wire.operation,
    infill: wire.infill,
  };
  if (wire.panelWidths !== undefined) elevation.panelWidths = [...wire.panelWidths];
  if (wire.movingPanels !== undefined) elevation.movingPanels = [...wire.movingPanels];
  return elevation;
}

/**
 * A wire product back into core's `Product`.
 *
 * Structure only. The invariants `parseCatalog` checks — a default that is one of its
 * own values, a step on the 25 µm lattice, a rule that compares a length to an area —
 * are core's and, per plan 5 point 3, the database's. Re-running them here would give
 * every request a second opinion about data that was validated when it was published,
 * and a second opinion is a second place to disagree.
 */
export function toProduct(wire: ProductWire): Product {
  return {
    id: wire.id,
    slug: wire.slug,
    nameTh: wire.nameTh,
    categoryId: wire.categoryId,
    summaryTh: wire.summaryTh,
    elevation: decodeElevation(wire.elevation),
    heroImage: wire.heroImage,
    leadTimeDays: [wire.leadTimeDays[0], wire.leadTimeDays[1]],
    pricePerSqm: bahtOf(toBigInt(wire.pricePerSqm), `${wire.id}.pricePerSqm`),
    minBillableSqUm: decodeSqUm(wire.minBillableSqUm),
    groups: wire.groups.map((group) => decodeGroup(group, wire.id)),
    rules: wire.rules.map((rule) => ({
      id: rule.id,
      messageTh: rule.messageTh,
      severity: rule.severity,
      when: decodeRuleExpr(rule.when),
    })),
    skuPrefix: wire.skuPrefix,
    ...(wire.images === undefined ? {} : { images: [...wire.images] }),
    ...(wire.videoUrl === undefined || wire.videoUrl === null
      ? {}
      : { videoUrl: wire.videoUrl }),
  };
}

export const toProductDocument = (wire: ProductDocumentWire): ProductDocument => ({
  productVersionId: wire.productVersionId,
  documentHash: wire.documentHash,
  product: toProduct(wire.product),
});

export const toCategory = (wire: CategoryWire): Category => ({ ...wire });

/** Validate an untrusted payload and decode it in one step. Throws `ZodError` on shape. */
export const decodeProductDocument = (input: unknown): ProductDocument =>
  toProductDocument(productDocumentWireSchema.parse(input));

export const decodeProduct = (input: unknown): Product => toProduct(productWireSchema.parse(input));
