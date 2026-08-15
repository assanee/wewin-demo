/**
 * Runtime schema for the mock catalog (spec section 9).
 *
 * `src/data/products.ts` is hand-written data, and TypeScript only checks its shape.
 * It cannot check that a rule's `group: 'contorl'` matches a group that exists, or
 * that a sku group's `defaultValue` is one of its own values. Those are exactly the
 * typos that produce a silently broken configurator, so they are checked here and
 * the app refuses to boot on failure.
 */

import { z } from 'zod';
import type { Category, Product } from '../types/catalog.js';
import type { NumExpr, RuleExpr } from '../types/rule.js';
import { numDimension } from '../validation.js';
import { LATTICE_UM } from '../units.js';

const HEX = /^#[0-9a-fA-F]{6}$/;

/* ------------------------------------------------------------------ *
 * Leaves
 * ------------------------------------------------------------------ */

const priceDeltaSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('flat'), amount: z.number().finite() }),
  z.object({ type: z.literal('per_sqm'), amount: z.number().finite() }),
  z.object({ type: z.literal('percent'), amount: z.number().finite() }),
]);

const optionValueSchema = z.object({
  code: z.string().min(1),
  labelTh: z.string().min(1),
  swatchHex: z.string().regex(HEX, 'swatchHex must be a #RRGGBB colour').optional(),
  delta: priceDeltaSchema,
  available: z.boolean(),
});

/* ------------------------------------------------------------------ *
 * Rule expressions — recursive, so z.lazy with an explicit annotation
 * ------------------------------------------------------------------ */

const numExprSchema: z.ZodType<NumExpr> = z.lazy(() =>
  z.discriminatedUnion('n', [
    z.object({
      n: z.literal('const'),
      value: z.bigint(),
      dim: z.enum(['length', 'area', 'scalar']),
    }),
    z.object({ n: z.literal('measure'), group: z.string().min(1) }),
    z.object({ n: z.literal('area') }),
    z.object({ n: z.literal('mul'), left: numExprSchema, right: numExprSchema }),
  ]),
);

const comparison = <T extends 'gt' | 'lt' | 'gte' | 'lte'>(op: T) =>
  z.object({ op: z.literal(op), left: numExprSchema, right: numExprSchema });

/**
 * Report any comparison that is not dimensionally sensible.
 *
 * `evalExpr` throws on a mismatch rather than returning false, and this walk is what
 * keeps that throw off the customer's screen. It matters most for the shape it cannot
 * otherwise catch: `gt(measure('width'), scalar(200))` reads as "wider than 200 cm"
 * and evaluates as "wider than 200 µm", which is true for every window ever built —
 * an error-severity rule that fires always is as broken as one that never fires.
 */
function checkDimensions(expr: RuleExpr, ctx: z.RefinementCtx, ruleId: string): void {
  switch (expr.op) {
    case 'gt':
    case 'lt':
    case 'gte':
    case 'lte': {
      const left = numDimension(expr.left);
      const right = numDimension(expr.right);
      if (left === null || right === null || left !== right) {
        ctx.addIssue({
          code: 'custom',
          message: `rule "${ruleId}" compares ${String(left)} against ${String(right)}`,
        });
      }
      break;
    }
    case 'and':
      for (const child of expr.all) checkDimensions(child, ctx, ruleId);
      break;
    case 'or':
      for (const child of expr.any) checkDimensions(child, ctx, ruleId);
      break;
    case 'not':
      checkDimensions(expr.expr, ctx, ruleId);
      break;
    case 'selected':
      break;
  }
}

const ruleExprSchema: z.ZodType<RuleExpr> = z.lazy(() =>
  z.discriminatedUnion('op', [
    comparison('gt'),
    comparison('lt'),
    comparison('gte'),
    comparison('lte'),
    z.object({ op: z.literal('selected'), group: z.string().min(1), value: z.string().min(1) }),
    z.object({ op: z.literal('and'), all: z.array(ruleExprSchema).min(1) }),
    z.object({ op: z.literal('or'), any: z.array(ruleExprSchema).min(1) }),
    z.object({ op: z.literal('not'), expr: ruleExprSchema }),
  ]),
);

const ruleSchema = z
  .object({
    id: z.string().min(1),
    messageTh: z.string().min(1),
    severity: z.enum(['error', 'warning']),
    when: ruleExprSchema,
  })
  .superRefine((rule, ctx) => {
    checkDimensions(rule.when, ctx, rule.id);
  });

/* ------------------------------------------------------------------ *
 * Groups
 * ------------------------------------------------------------------ */

const skuGroupSchema = z
  .object({
    kind: z.literal('sku'),
    code: z.string().min(1),
    labelTh: z.string().min(1),
    input: z.enum(['swatch', 'chip', 'toggle']),
    required: z.literal(true),
    includeInSkuCode: z.boolean(),
    values: z.array(optionValueSchema).min(1),
    defaultValue: z.string().min(1),
  })
  .superRefine((group, ctx) => {
    const codes = group.values.map((value) => value.code);

    if (new Set(codes).size !== codes.length) {
      ctx.addIssue({ code: 'custom', message: `group "${group.code}" has duplicate option codes` });
    }

    if (!codes.includes(group.defaultValue)) {
      ctx.addIssue({
        code: 'custom',
        message: `group "${group.code}" defaultValue "${group.defaultValue}" is not one of its values`,
      });
    }

    // A swatch renders a colour chip; without a hex there is nothing to render.
    if (group.input === 'swatch') {
      for (const value of group.values) {
        if (!value.swatchHex) {
          ctx.addIssue({
            code: 'custom',
            message: `swatch option "${group.code}.${value.code}" is missing swatchHex`,
          });
        }
      }
    }
  });

/**
 * A measurement group, with the grid invariants checked rather than assumed.
 *
 * The bounds in `products.ts` are written in centimetres and converted by `cm()`, so
 * the numbers a person reviews are not the numbers the app uses. These refinements
 * are what makes that conversion verifiable by machine: every one of the 48 authored
 * bounds has to land on the group's own step, and the step has to land on the 25 µm
 * lattice that keeps metric and imperial entry mutually representable.
 *
 * Every field is declared, including the ones with nothing to check. zod strips keys
 * it does not know about, so a field left out here disappears silently on the way
 * from the table to the configurator.
 */
const customGroupSchema = z
  .object({
    kind: z.literal('custom'),
    code: z.string().min(1),
    labelTh: z.string().min(1),
    input: z.literal('number'),
    unit: z.enum(['cm', 'mm']),
    minUm: z.bigint(),
    maxUm: z.bigint(),
    stepUm: z.bigint(),
    defaultUm: z.bigint(),
    helperTh: z.string().optional(),
  })
  .superRefine((group, ctx) => {
    const fail = (message: string): void =>
      ctx.addIssue({ code: 'custom', message: `group "${group.code}" ${message}` });

    // A zero or negative bound is not a small window, it is a unit that went missing.
    if (group.minUm <= 0n) fail('has a min at or below zero');
    if (group.minUm > group.maxUm) fail('has min above max');
    if (group.defaultUm < group.minUm || group.defaultUm > group.maxUm) {
      fail('defaultUm is outside min/max');
    }

    if (group.stepUm <= 0n) {
      fail('has a step at or below zero');
      return; // everything below divides by it
    }

    if (group.stepUm % LATTICE_UM !== 0n) {
      fail(`stepUm ${String(group.stepUm)} is not a multiple of the ${String(LATTICE_UM)} µm lattice`);
    }

    // Snapping is anchored at absolute zero, not at the min, so the min has to sit
    // on the grid itself — otherwise the smallest size in the range is permanently
    // off-step and the customer is warned about a bound they were handed.
    if (group.minUm % group.stepUm !== 0n) {
      fail('has a min that is not itself on its step grid');
    }

    // The max has to be reachable from the min by whole steps, or the top of the
    // range is a size the customer can see but never select.
    if ((group.maxUm - group.minUm) % group.stepUm !== 0n) {
      fail('has a max that is not a whole number of steps above its min');
    }

    if ((group.defaultUm - group.minUm) % group.stepUm !== 0n) {
      fail('has a default that is not on its own step grid');
    }
  });

const optionGroupSchema = z.union([skuGroupSchema, customGroupSchema]);

/* ------------------------------------------------------------------ *
 * Product
 * ------------------------------------------------------------------ */

/** Walk a rule expression and collect every group code it reads. */
function referencedGroups(expr: RuleExpr): { sku: string[]; measure: string[] } {
  const sku: string[] = [];
  const measure: string[] = [];

  const walkNum = (node: NumExpr): void => {
    if (node.n === 'measure') measure.push(node.group);
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
        sku.push(node.group);
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
  return { sku, measure };
}

/**
 * The elevation drawing spec.
 *
 * Declared here for two reasons, not one: to reject bad data, and because zod
 * strips keys it does not know about — a field missing from this schema silently
 * disappears between products.ts and the UI.
 */
const elevationSchema = z
  .object({
    panels: z.number().int().min(1).max(24),
    operation: z.enum(['fixed', 'casement', 'awning', 'slide', 'fold', 'hang', 'vertical']),
    infill: z.enum(['glass', 'louvre', 'mesh']),
    panelWidths: z.array(z.number().finite().positive()).optional(),
    movingPanels: z.array(z.number().int().nonnegative()).optional(),
  })
  .superRefine((elevation, ctx) => {
    for (const index of elevation.movingPanels ?? []) {
      if (index >= elevation.panels) {
        ctx.addIssue({
          code: 'custom',
          message: `elevation movingPanels references panel ${index} but only has ${elevation.panels}`,
        });
      }
    }

    if (elevation.panelWidths && elevation.panelWidths.length !== elevation.panels) {
      ctx.addIssue({
        code: 'custom',
        message: `elevation has ${elevation.panels} panels but ${elevation.panelWidths.length} panelWidths`,
      });
    }
  });

export const productSchema = z
  .object({
    id: z.string().min(1),
    slug: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/, 'slug must be lowercase kebab-case'),
    nameTh: z.string().min(1),
    categoryId: z.string().min(1),
    summaryTh: z.string().min(1),
    elevation: elevationSchema,
    heroImage: z.string().min(1),
    leadTimeDays: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
    pricePerSqm: z.number().finite().positive(),
    minBillableSqUm: z.bigint().positive(),
    groups: z.array(optionGroupSchema).min(1),
    rules: z.array(ruleSchema),
    skuPrefix: z.string().min(1),
    /*
     * Optional on both, because documents frozen before 0052 carry neither. A path is
     * checked for shape and not for existence — this layer has no filesystem and no object
     * store, and a rule it cannot enforce is a rule that lies.
     */
    images: z
      .array(z.string().regex(/^\/[A-Za-z0-9._/-]+$/u, 'an image path starts with /'))
      .optional(),
    videoUrl: z.string().url('a video link must be a URL').nullable().optional(),
  })
  .superRefine((product, ctx) => {
    const groupCodes = product.groups.map((group) => group.code);

    if (new Set(groupCodes).size !== groupCodes.length) {
      ctx.addIssue({ code: 'custom', message: `product "${product.id}" has duplicate group codes` });
    }

    const skuCodes = new Set(
      product.groups.filter((group) => group.kind === 'sku').map((group) => group.code),
    );
    const customCodes = new Set(
      product.groups.filter((group) => group.kind === 'custom').map((group) => group.code),
    );

    // Pricing reads width and height directly; a product without them prices as 0.
    for (const required of ['width', 'height']) {
      if (!customCodes.has(required)) {
        ctx.addIssue({
          code: 'custom',
          message: `product "${product.id}" is missing the custom group "${required}"`,
        });
      }
    }

    const [minLead, maxLead] = product.leadTimeDays;
    if (minLead > maxLead) {
      ctx.addIssue({ code: 'custom', message: `product "${product.id}" has an inverted leadTimeDays` });
    }

    const ruleIds = product.rules.map((rule) => rule.id);
    if (new Set(ruleIds).size !== ruleIds.length) {
      ctx.addIssue({ code: 'custom', message: `product "${product.id}" has duplicate rule ids` });
    }

    for (const rule of product.rules) {
      const { sku, measure } = referencedGroups(rule.when);

      for (const code of sku) {
        if (!skuCodes.has(code)) {
          ctx.addIssue({
            code: 'custom',
            message: `rule "${rule.id}" selects unknown sku group "${code}"`,
          });
        }
      }

      for (const code of measure) {
        if (!customCodes.has(code)) {
          ctx.addIssue({
            code: 'custom',
            message: `rule "${rule.id}" measures unknown custom group "${code}"`,
          });
        }
      }
    }
  });

export const categorySchema = z.object({
  id: z.string().min(1),
  labelTh: z.string().min(1),
  summaryTh: z.string().min(1),
});

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export interface Catalog {
  products: Product[];
  categories: Category[];
}

/**
 * Validate the catalog. Throws on any problem — a typo in the data is a build-time
 * mistake, and failing loudly at boot beats a configurator that quietly prices wrong.
 */
export function parseCatalog(rawProducts: unknown, rawCategories: unknown): Catalog {
  const parsedCategories = z.array(categorySchema).min(1).parse(rawCategories);
  const parsedProducts = z.array(productSchema).parse(rawProducts);

  const categoryIds = new Set(parsedCategories.map((category) => category.id));
  const errors: string[] = [];

  const slugs = parsedProducts.map((product) => product.slug);
  const duplicateSlug = slugs.find((slug, index) => slugs.indexOf(slug) !== index);
  if (duplicateSlug !== undefined) {
    errors.push(`duplicate product slug "${duplicateSlug}"`);
  }

  const ids = parsedProducts.map((product) => product.id);
  const duplicateId = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicateId !== undefined) {
    errors.push(`duplicate product id "${duplicateId}"`);
  }

  // Two products sharing a prefix can emit identical sku_codes for different
  // products, which would make a quote line ambiguous on the shop floor.
  const prefixes = parsedProducts.map((product) => product.skuPrefix);
  const duplicatePrefix = prefixes.find((prefix, index) => prefixes.indexOf(prefix) !== index);
  if (duplicatePrefix !== undefined) {
    errors.push(`duplicate skuPrefix "${duplicatePrefix}"`);
  }

  for (const product of parsedProducts) {
    if (!categoryIds.has(product.categoryId)) {
      errors.push(`product "${product.id}" has unknown categoryId "${product.categoryId}"`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid catalog data:\n  - ${errors.join('\n  - ')}`);
  }

  return { products: parsedProducts as Product[], categories: parsedCategories };
}
