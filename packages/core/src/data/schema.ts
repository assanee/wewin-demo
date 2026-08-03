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
    z.object({ n: z.literal('const'), value: z.number().finite() }),
    z.object({ n: z.literal('measure'), group: z.string().min(1) }),
    z.object({ n: z.literal('area') }),
    z.object({ n: z.literal('div'), left: numExprSchema, right: numExprSchema }),
  ]),
);

const comparison = <T extends 'gt' | 'lt' | 'gte' | 'lte'>(op: T) =>
  z.object({ op: z.literal(op), left: numExprSchema, right: numExprSchema });

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

const ruleSchema = z.object({
  id: z.string().min(1),
  messageTh: z.string().min(1),
  severity: z.enum(['error', 'warning']),
  when: ruleExprSchema,
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

const customGroupSchema = z
  .object({
    kind: z.literal('custom'),
    code: z.string().min(1),
    labelTh: z.string().min(1),
    input: z.literal('number'),
    unit: z.enum(['cm', 'mm']),
    min: z.number().finite(),
    max: z.number().finite(),
    step: z.number().finite().positive(),
    defaultValue: z.number().finite(),
    helperTh: z.string().optional(),
  })
  .superRefine((group, ctx) => {
    if (group.min > group.max) {
      ctx.addIssue({ code: 'custom', message: `group "${group.code}" has min above max` });
    }

    if (group.defaultValue < group.min || group.defaultValue > group.max) {
      ctx.addIssue({
        code: 'custom',
        message: `group "${group.code}" defaultValue is outside min/max`,
      });
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
    if (node.n === 'div') {
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
    minBillableSqm: z.number().finite().positive(),
    groups: z.array(optionGroupSchema).min(1),
    rules: z.array(ruleSchema),
    skuPrefix: z.string().min(1),
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
