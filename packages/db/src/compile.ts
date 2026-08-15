import type {
  CustomGroup,
  NumExpr,
  OptionGroup,
  OptionValue,
  PriceDelta,
  Product,
  Rule,
  RuleExpr,
  SkuGroup,
} from '@wewin/core';
import { bahtToMinor } from '@wewin/core/money';
import type {
  CatalogDocumentV1,
  DocCustomGroup,
  DocNumExpr,
  DocOptionGroup,
  DocOptionValue,
  DocPriceDelta,
  DocRule,
  DocRuleExpr,
  DocSkuGroup,
} from './document.js';
import { CATALOG_DOCUMENT_SCHEMA_VERSION } from './document.js';

/**
 * The two directions between the domain's `Product` and the stored document.
 *
 * They are in one file because they are one decision seen from two sides: every
 * conversion `toDocument` performs, `fromDocument` has to undo exactly, and splitting
 * them is how a field gets added to one and forgotten in the other.
 * `tests/compile.test.ts` round-trips all 81 catalogue products through both and
 * re-parses the result with core's own zod schema, so "exactly" is checked rather
 * than asserted.
 */

const PERCENT_TO_BP = 100;

const MINOR_PER_BAHT = 100n;

/**
 * A stored satang figure back to the whole baht `calcPrice` takes — refusing a fraction
 * rather than truncating one away.
 *
 * This was `Number(BigInt(minor) / 100n)`, and integer division is silent: a document
 * holding `pricePerSqmMinor: "150001"` came back as ฿1,500 and compared equal to a
 * catalogue that says ฿1,500. Found by mutating exactly that field in Postgres and
 * watching the fidelity test stay green — the one satang the document held that nobody
 * would ever be charged.
 *
 * The `products.price_per_sqm_minor` column has a CHECK for this (`products_price_whole_baht`)
 * but the compiled document is a jsonb blob and carries no such constraint, so the read
 * is where it has to be caught. `@wewin/contract` refuses the same figure on the wire for
 * the same reason: `calcPrice` reaches `BigInt(product.pricePerSqm)` (pricing.ts:196) and
 * would throw on ฿1,500.01, so a fraction here is a price the server cannot honour, and
 * two readers rounding it differently is worse than one reader refusing it.
 */
function wholeBaht(minor: bigint, field: string): number {
  if (minor % MINOR_PER_BAHT !== 0n) {
    throw new Error(
      `@wewin/db: ${field} is ${minor.toString()} satang, which is not a whole baht — ` +
        'core prices in whole baht and would throw on the fraction',
    );
  }
  return Number(minor / MINOR_PER_BAHT);
}

const toDocDelta = (delta: PriceDelta): DocPriceDelta => {
  switch (delta.type) {
    case 'none':
      return { type: 'none' };
    case 'flat':
      return { type: 'flat', currency: 'THB', minor: bahtToMinor(delta.amount).toString() };
    case 'per_sqm':
      return { type: 'per_sqm', currency: 'THB', minor: bahtToMinor(delta.amount).toString() };
    case 'percent':
      return { type: 'percent', bp: Math.round(delta.amount * PERCENT_TO_BP) };
  }
};

const fromDocDelta = (delta: DocPriceDelta): PriceDelta => {
  switch (delta.type) {
    case 'none':
      return { type: 'none' };
    case 'flat':
      return { type: 'flat', amount: wholeBaht(BigInt(delta.minor), 'delta.flat') };
    case 'per_sqm':
      return { type: 'per_sqm', amount: wholeBaht(BigInt(delta.minor), 'delta.per_sqm') };
    case 'percent': {
      // Same argument one column over: `calcPrice` does `BigInt(value.delta.amount)`
      // (pricing.ts:221) and 8.01 is not a bigint. 801 bp is a surcharge the pricer
      // cannot apply, so it is refused where it is read rather than thrown much later
      // with only a customer's configuration to explain it.
      if (delta.bp % PERCENT_TO_BP !== 0) {
        throw new Error(
          `@wewin/db: delta.percent is ${String(delta.bp)} bp, which is not a whole percent — ` +
            'core takes a percent delta as an integer and would throw on the fraction',
        );
      }
      return { type: 'percent', amount: delta.bp / PERCENT_TO_BP };
    }
  }
};

const toDocValue = (value: OptionValue): DocOptionValue => ({
  code: value.code,
  labelTh: value.labelTh,
  // `exactOptionalPropertyTypes` is on: an explicit `swatchHex: undefined` is a
  // different type from an absent key, and it would also survive into the JSONB as
  // a null the reader has to handle.
  ...(value.swatchHex === undefined ? {} : { swatchHex: value.swatchHex }),
  delta: toDocDelta(value.delta),
});

const toDocNum = (expr: NumExpr): DocNumExpr => {
  switch (expr.n) {
    case 'const':
      return { n: 'const', value: expr.value.toString(), dim: expr.dim };
    case 'measure':
      return { n: 'measure', group: expr.group };
    case 'area':
      return { n: 'area' };
    case 'mul':
      return { n: 'mul', left: toDocNum(expr.left), right: toDocNum(expr.right) };
  }
};

const fromDocNum = (expr: DocNumExpr): NumExpr => {
  switch (expr.n) {
    case 'const':
      return { n: 'const', value: BigInt(expr.value), dim: expr.dim };
    case 'measure':
      return { n: 'measure', group: expr.group };
    case 'area':
      return { n: 'area' };
    case 'mul':
      return { n: 'mul', left: fromDocNum(expr.left), right: fromDocNum(expr.right) };
  }
};

const toDocExpr = (expr: RuleExpr): DocRuleExpr => {
  switch (expr.op) {
    case 'gt':
    case 'lt':
    case 'gte':
    case 'lte':
      return { op: expr.op, left: toDocNum(expr.left), right: toDocNum(expr.right) };
    case 'selected':
      return { op: 'selected', group: expr.group, value: expr.value };
    case 'and':
      return { op: 'and', all: expr.all.map(toDocExpr) };
    case 'or':
      return { op: 'or', any: expr.any.map(toDocExpr) };
    case 'not':
      return { op: 'not', expr: toDocExpr(expr.expr) };
  }
};

const fromDocExpr = (expr: DocRuleExpr): RuleExpr => {
  switch (expr.op) {
    case 'gt':
    case 'lt':
    case 'gte':
    case 'lte':
      return { op: expr.op, left: fromDocNum(expr.left), right: fromDocNum(expr.right) };
    case 'selected':
      return { op: 'selected', group: expr.group, value: expr.value };
    case 'and':
      return { op: 'and', all: expr.all.map(fromDocExpr) };
    case 'or':
      return { op: 'or', any: expr.any.map(fromDocExpr) };
    case 'not':
      return { op: 'not', expr: fromDocExpr(expr.expr) };
  }
};

/**
 * The group codes a rule reads, for `product_version_rules.referenced_group_codes`.
 *
 * Wider than the walk in core's `schema.ts` in one place, on purpose: an `area` term
 * reads `width` and `height` — `calcAreaSqUm` takes exactly those two — so a rule
 * written as "area over 8 m²" does reference two groups, and reporting none would make
 * the integrity check at publish time pass for a rule that cannot be evaluated.
 */
export function referencedGroupCodes(expr: RuleExpr): string[] {
  const found = new Set<string>();

  const walkNum = (node: NumExpr): void => {
    switch (node.n) {
      case 'measure':
        found.add(node.group);
        break;
      case 'area':
        found.add('width');
        found.add('height');
        break;
      case 'mul':
        walkNum(node.left);
        walkNum(node.right);
        break;
      case 'const':
        break;
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
  return [...found].sort();
}

const toDocGroup = (group: OptionGroup): DocOptionGroup => {
  if (group.kind === 'sku') {
    const skuGroup: DocSkuGroup = {
      kind: 'sku',
      code: group.code,
      labelTh: group.labelTh,
      input: group.input,
      includeInSkuCode: group.includeInSkuCode,
      values: group.values.map(toDocValue),
      defaultValue: group.defaultValue,
    };
    return skuGroup;
  }

  const customGroup: DocCustomGroup = {
    kind: 'custom',
    code: group.code,
    labelTh: group.labelTh,
    input: 'number',
    unit: group.unit,
    minUm: group.minUm.toString(),
    maxUm: group.maxUm.toString(),
    stepUm: group.stepUm.toString(),
    defaultUm: group.defaultUm.toString(),
    ...(group.helperTh === undefined ? {} : { helperTh: group.helperTh }),
  };
  return customGroup;
};

export const toDocRule = (rule: Rule): DocRule => ({
  id: rule.id,
  messageTh: rule.messageTh,
  severity: rule.severity,
  when: toDocExpr(rule.when),
});

/** Compile a domain product into the document a version freezes. */
export function toDocument(product: Product): CatalogDocumentV1 {
  return {
    schemaVersion: CATALOG_DOCUMENT_SCHEMA_VERSION,
    id: product.id,
    slug: product.slug,
    nameTh: product.nameTh,
    categoryId: product.categoryId,
    summaryTh: product.summaryTh,
    elevation: product.elevation,
    heroImage: product.heroImage,
    leadTimeDays: product.leadTimeDays,
    currency: 'THB',
    pricePerSqmMinor: bahtToMinor(product.pricePerSqm).toString(),
    minBillableSqUm: product.minBillableSqUm.toString(),
    groups: product.groups.map(toDocGroup),
    rules: product.rules.map(toDocRule),
    skuPrefix: product.skuPrefix,
    /*
     * Omitted rather than written as `[]` and `null` when there is nothing. An absent key and
     * an empty array decode to the same thing, but only the absent key leaves a document
     * byte-identical to one frozen before 0052 — which is what stops every unchanged product
     * getting a new `document_hash` the first time it is republished after this shipped.
     */
    ...(product.images === undefined || product.images.length === 0
      ? {}
      : { images: [...product.images] }),
    ...(product.videoUrl === undefined || product.videoUrl === null
      ? {}
      : { videoUrl: product.videoUrl }),
  };
}

/**
 * Whether a value is currently sellable. The api passes a lookup built from
 * `option_values.available`; the default is the honest answer when nobody asked.
 */
export type AvailabilityLookup = (groupCode: string, valueCode: string) => boolean;

const alwaysAvailable: AvailabilityLookup = () => true;

/**
 * Materialise a stored document back into the `Product` the domain prices from.
 *
 * `isAvailable` is the overlay plan 5 point 2 asks for: everything else in the returned
 * product came from a frozen row, and this one field comes from now. Leaving it out
 * gives an all-available product, which is right for a preview and wrong for a live
 * configurator — so api must pass it.
 */
export function fromDocument(
  document: CatalogDocumentV1,
  isAvailable: AvailabilityLookup = alwaysAvailable,
): Product {
  const groups: OptionGroup[] = document.groups.map((group): OptionGroup => {
    if (group.kind === 'sku') {
      const skuGroup: SkuGroup = {
        kind: 'sku',
        code: group.code,
        labelTh: group.labelTh,
        input: group.input,
        required: true,
        includeInSkuCode: group.includeInSkuCode,
        values: group.values.map((value) => ({
          code: value.code,
          labelTh: value.labelTh,
          ...(value.swatchHex === undefined ? {} : { swatchHex: value.swatchHex }),
          delta: fromDocDelta(value.delta),
          available: isAvailable(group.code, value.code),
        })),
        defaultValue: group.defaultValue,
      };
      return skuGroup;
    }

    const customGroup: CustomGroup = {
      kind: 'custom',
      code: group.code,
      labelTh: group.labelTh,
      input: 'number',
      unit: group.unit,
      minUm: BigInt(group.minUm),
      maxUm: BigInt(group.maxUm),
      stepUm: BigInt(group.stepUm),
      defaultUm: BigInt(group.defaultUm),
      ...(group.helperTh === undefined ? {} : { helperTh: group.helperTh }),
    };
    return customGroup;
  });

  return {
    id: document.id,
    slug: document.slug,
    nameTh: document.nameTh,
    categoryId: document.categoryId,
    summaryTh: document.summaryTh,
    elevation: document.elevation,
    heroImage: document.heroImage,
    leadTimeDays: document.leadTimeDays,
    pricePerSqm: wholeBaht(BigInt(document.pricePerSqmMinor), `${document.id}.pricePerSqmMinor`),
    minBillableSqUm: BigInt(document.minBillableSqUm),
    groups,
    rules: document.rules.map((rule) => ({
      id: rule.id,
      messageTh: rule.messageTh,
      severity: rule.severity,
      when: fromDocExpr(rule.when),
    })),
    skuPrefix: document.skuPrefix,
    /* Absent stays absent, so a round trip through the document changes nothing. */
    ...(document.images === undefined ? {} : { images: [...document.images] }),
    ...(document.videoUrl === undefined ? {} : { videoUrl: document.videoUrl }),
  };
}
