import { z } from 'zod';
import type { Elevation } from '@wewin/core';
import {
  elevationWireSchema,
  priceDeltaWireSchema,
  productWireSchema,
  ruleExprWireSchema,
  type ElevationWire,
  type PriceDeltaWire,
  type ProductWire,
  type RuleExprWire,
} from './catalog.js';
import {
  areaWireSchema,
  encodeBasisPoints,
  encodeSqUm,
  encodeUm,
  lengthWireSchema,
  type AreaWire,
  type LengthWire,
} from './measure.js';
import {
  encodeMinorPerSqm,
  encodeMinor,
  moneyRateWireSchema,
  type MoneyRateWire,
} from './money.js';
import { toBigInt } from './exact.js';

/**
 * The write side of the catalogue — the dashboard's half of plan section 5.
 *
 * `./catalog.ts` is the read side: one frozen document per published version, leaving the
 * API. This module is the other direction, and the asymmetry is the whole design rather
 * than an oversight:
 *
 *   **A published document is never edited.** There is no request shape here that names a
 *   published version, because there is nothing about one that can be changed. Editing a
 *   product means editing its *draft* — the normalised rows — and publishing compiles a
 *   new document, freezes it, and archives the one before it. The types below say that
 *   out loud: every mutation is addressed to `.../draft`, and the only thing that can be
 *   said about a published version is `publish` (make one) and `open a draft` (start the
 *   next one).
 *
 *   **Every exact quantity keeps its unit.** A width is `LengthWire` — `{"unit":"um",
 *   "digits":"600000"}` — and a bare `600` is not assignable to it in TypeScript and does
 *   not parse in zod. That is the same defence `./exact.ts` describes, applied to the
 *   direction where it matters more: a read that misreads a unit shows a wrong number on a
 *   screen, a *write* that misreads one stores a wrong number in a column that will be
 *   frozen into a document and quoted from. A dashboard sending centimetres where
 *   micrometres are meant is rejected at the boundary rather than committed.
 *
 *   **Money never crosses in baht.** `pricePerSqm` is `MoneyRateWire<'THB'>` — satang per
 *   square metre — and a `MoneyWire<'THB'>` (a plain amount) is a different type, so a
 *   per-m² rate cannot be sent where a total is meant or the reverse. The whole-baht rule
 *   the pricer needs (`calcPrice` reaches `BigInt(product.pricePerSqm)`) is enforced here
 *   as a refinement rather than left to blow up at compile time: the request is where the
 *   figure still has a field name attached to it.
 *
 * Nothing in this module validates *across* entities. That a default is one of the values
 * a group offers, that a step lands on the 25 µm lattice, that a rule names a group the
 * product offers — those are core's `productSchema` and Postgres' constraints (plan 5
 * point 3), and re-checking them here would be a second opinion that can disagree.
 */

/* ------------------------------------------------------------------ *
 * Identifiers
 * ------------------------------------------------------------------ */

/**
 * The catalogue's own spellings, pinned to what the 81 seeded products actually use.
 *
 * They are not cosmetic. A product id appears in a URL and in a sku code; an option value
 * code is concatenated into `skuCode`; a group code is what a rule names. Accepting a
 * second casing of any of them creates two identifiers that a human reads as one, and the
 * place that discovers the difference is a quote that cannot be matched to an order.
 */
const productIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/, 'must be lowercase kebab-case');

const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/, 'slug must be lowercase kebab-case');

/**
 * ⭐ 0052. A picture is referred to by path, never by a media id.
 *
 * `schema/media.ts` states the contract: the reference between the media ledger and the
 * catalogue is exactly the string `/media/<id>`. A path may also point at a static file, the
 * way `products.hero_image` does today, so this checks the shape and not the namespace.
 */
const imagePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^\/[A-Za-z0-9._/-]+$/u, 'an image path starts with / and has no spaces');

/**
 * ⚠️ Checked here rather than by a database CHECK. A constraint that accepted `https://…`
 * would still accept `https://example.com/nothing`, buying the appearance of validation and
 * none of the substance — so the shape is checked where a refusal can be a sentence.
 */
const videoUrlSchema = z.url('a video link must be a URL').max(500);

const skuPrefixSchema = z
  .string()
  .min(1)
  .max(16)
  .regex(/^[A-Z0-9]+$/, 'skuPrefix must be upper-case letters and digits');

const groupCodeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'an option group code is lower snake_case');

const valueCodeSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Z0-9_]+$/, 'an option value code is upper snake_case');

const ruleCodeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'a rule code is lowercase kebab-case');

const labelSchema = z.string().min(1).max(200);
const proseSchema = z.string().min(1).max(1000);
const sortOrderSchema = z.int().min(0).max(9999);

/** SHA-256 of the canonicalised document, as `@wewin/db`'s hash.ts writes it. */
const documentHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex SHA-256 digest');

/* ------------------------------------------------------------------ *
 * Whole-unit refinements
 * ------------------------------------------------------------------ */

const MINOR_PER_BAHT = 100n;
const BP_PER_PERCENT = 100;

/**
 * Refuse a fraction of a baht before it reaches a column that has only held whole ones.
 *
 * `products_price_whole_baht` and `option_values_delta_whole_units` say the same thing in
 * Postgres, and `compile.ts` says it a third time when a document is read back. This is
 * the earliest of the three and the only one that can name the request field, which is the
 * difference between "pricePerSqm is ฿1,500.01" and a 500 from a constraint the person
 * filling in a form has never heard of.
 */
const wholeBaht = (schema: z.ZodType<MoneyRateWire<'THB'>>): z.ZodType<MoneyRateWire<'THB'>> =>
  schema.refine(
    (wire) => toBigInt(wire) % MINOR_PER_BAHT === 0n,
    'must be a whole number of baht — core prices in whole baht and would throw on the fraction',
  );

const positiveRate = (schema: z.ZodType<MoneyRateWire<'THB'>>): z.ZodType<MoneyRateWire<'THB'>> =>
  schema.refine((wire) => toBigInt(wire) > 0n, 'must be greater than zero');

export const pricePerSqmSchema: z.ZodType<MoneyRateWire<'THB'>> = positiveRate(
  wholeBaht(moneyRateWireSchema('THB')),
);

const positiveLength = (schema: z.ZodType<LengthWire>): z.ZodType<LengthWire> =>
  schema.refine((wire) => toBigInt(wire) > 0n, 'must be greater than zero micrometres');

export const positiveLengthSchema: z.ZodType<LengthWire> = positiveLength(lengthWireSchema);

export const positiveAreaSchema: z.ZodType<AreaWire> = areaWireSchema.refine(
  (wire) => toBigInt(wire) > 0n,
  'must be greater than zero square micrometres',
);

/**
 * The same rule for a surcharge, on whichever of the two amount columns carries it.
 *
 * `option_values_delta_whole_units` checks both in one CHECK; here the two live in
 * different arms of a discriminated union, so it is one refinement over the union.
 */
export const catalogPriceDeltaSchema: z.ZodType<PriceDeltaWire> = priceDeltaWireSchema.refine(
  (delta) => {
    switch (delta.type) {
      case 'none':
        return true;
      case 'flat':
      case 'per_sqm':
        return toBigInt(delta.amount) % MINOR_PER_BAHT === 0n;
      case 'percent':
        return toBigInt(delta.amount) % BigInt(BP_PER_PERCENT) === 0n;
    }
  },
  'a surcharge must be a whole baht, or a whole percent — core takes both as integers',
);

/* ------------------------------------------------------------------ *
 * The normalised delta, as `option_values` holds it
 * ------------------------------------------------------------------ */

/**
 * A surcharge in the two columns that store it, rather than in the baht the domain prices
 * in.
 *
 * `./catalog.ts` decodes a delta into core's `PriceDelta`, whose amount is whole baht for
 * `flat`/`per_sqm` and whole percent for `percent`, because that is what `calcPrice` takes.
 * The write side must not go through that shape: `option_values.delta_minor` is satang and
 * `delta_bp` is basis points, and a round trip through baht is two divisions and two
 * multiplications in the one place where a rounding would be silently persisted rather
 * than merely displayed. So the admin surface decodes straight to storage.
 *
 * `minor` and `bp` are both nullable and exactly one is ever set, which is
 * `option_values_delta_shape` restated in a type: `none` sets neither.
 */
export interface StoredPriceDelta {
  readonly type: 'none' | 'flat' | 'per_sqm' | 'percent';
  /** Satang, for `flat` and `per_sqm`. */
  readonly minor: bigint | null;
  /** Basis points, for `percent`. Not money — 8% is 8% in every currency (plan 4.2). */
  readonly bp: number | null;
}

export function decodeStoredPriceDelta(wire: PriceDeltaWire): StoredPriceDelta {
  switch (wire.type) {
    case 'none':
      return { type: 'none', minor: null, bp: null };
    case 'flat':
      return { type: 'flat', minor: toBigInt(wire.amount), bp: null };
    case 'per_sqm':
      return { type: 'per_sqm', minor: toBigInt(wire.amount), bp: null };
    case 'percent':
      return { type: 'percent', minor: null, bp: Number(toBigInt(wire.amount)) };
  }
}

/**
 * Back out again, for the option-catalogue responses.
 *
 * It throws on a row whose two columns disagree with its `delta_type` rather than
 * inventing a zero, because such a row means `option_values_delta_shape` was dropped or
 * the row was written by something that is not this code, and serving a surcharge of ฿0
 * for it is the failure the CHECK exists to prevent.
 */
export function encodeStoredPriceDelta(stored: StoredPriceDelta): PriceDeltaWire {
  switch (stored.type) {
    case 'none':
      return { type: 'none' };
    case 'flat':
      return { type: 'flat', amount: encodeMinor(amountOf(stored), 'THB') };
    case 'per_sqm':
      return { type: 'per_sqm', amount: encodeMinorPerSqm(amountOf(stored), 'THB') };
    case 'percent': {
      if (stored.bp === null) throw new TypeError('contract: a percent delta with no basis points');
      return { type: 'percent', amount: encodeBasisPoints(BigInt(stored.bp)) };
    }
  }
}

function amountOf(stored: StoredPriceDelta): bigint {
  if (stored.minor === null) {
    throw new TypeError(`contract: a ${stored.type} delta with no amount`);
  }
  return stored.minor;
}

/* ------------------------------------------------------------------ *
 * Product-level fields
 * ------------------------------------------------------------------ */

/**
 * Everything about a product that is not one of its options.
 *
 * These are the columns of the `products` row, which is *not* versioned — there is one of
 * it per product and the published document holds a frozen copy. So an edit here is an
 * edit to the draft in the same sense an option edit is: it changes what the next publish
 * will freeze, and changes nothing about what is currently published. `AdminProductWire`
 * below reports where the two have diverged, so "saved but not published" is visible in
 * the API rather than something the dashboard has to infer.
 */
export interface ProductFieldsWire {
  readonly nameTh: string;
  readonly categoryId: string;
  readonly summaryTh: string;
  readonly heroImage: string;
  readonly leadTimeDays: readonly [number, number];
  readonly pricePerSqm: MoneyRateWire<'THB'>;
  readonly minBillableSqUm: AreaWire;
  readonly elevation: ElevationWire;
  /** ⭐ 0052. The gallery, in display order. Absent and empty both mean no pictures. */
  readonly images?: readonly string[] | undefined;
  /** ⭐ 0052. One video link. `null` removes it; absent leaves it alone. */
  readonly videoUrl?: string | null | undefined;
}

/**
 * ⛔ One shape, spread into both the whole-product schema and the patch schema below.
 *
 * Until 0052 the PATCH route restated all eight fields inline. zod strips keys it was not
 * told about *silently*, so `images` and `videoUrl` — added to the schema above and to the
 * repository, with a passing typecheck the whole way — arrived at the service as `{}` and
 * were refused as a request that changes nothing. Nothing in the type system could see it:
 * both objects satisfied their declared types, and neither knew the other existed.
 *
 * Sharing the shape is the same fix `draftMutationShape` already applies two screens down,
 * and it means the next field somebody adds cannot be dropped by the half they forgot.
 */
const productFieldsShape = {
  nameTh: labelSchema,
  categoryId: z.string().min(1).max(64),
  summaryTh: proseSchema,
  heroImage: z.string().min(1).max(500),
  leadTimeDays: z.tuple([z.int().min(0).max(3650), z.int().min(0).max(3650)]),
  pricePerSqm: pricePerSqmSchema,
  minBillableSqUm: positiveAreaSchema,
  elevation: elevationWireSchema,
  /**
   * ⭐ 0052. The gallery, in the order it is shown, and one video link.
   *
   * ⚠️ `images` replaces the whole list rather than patching it. Order is content here — the
   * first picture is the one a customer sees first — and a partial patch of an ordered list
   * needs an index vocabulary (insert-at, move-from-to) that two clients will disagree about.
   * Sending the list you want is unambiguous and idempotent.
   *
   * ⚠️ `videoUrl` is nullable so a link can be *removed*: with `optional` alone there is no
   * way to say "no video" that is distinguishable from "leave it alone".
   */
  images: z.array(imagePathSchema).max(24).optional(),
  videoUrl: z.union([videoUrlSchema, z.null()]).optional(),
} as const;

export const productFieldsWireSchema: z.ZodType<ProductFieldsWire> = z.object(productFieldsShape);

/**
 * The same fields, any subset.
 *
 * Derived from `ProductFieldsWire` rather than restated, so a field added above cannot
 * become one the dashboard may set at creation and never change again. `| undefined` is
 * spelled out because `exactOptionalPropertyTypes` makes `Partial<T>`'s optional keys
 * refuse an explicit `undefined`, and zod's inferred output type carries one.
 */
export type ProductFieldsPatchWire = {
  readonly [K in keyof ProductFieldsWire]?: ProductFieldsWire[K] | undefined;
};

/* ------------------------------------------------------------------ *
 * Draft options and rules
 * ------------------------------------------------------------------ */

/**
 * A group as one draft offers it.
 *
 * The group *definition* — its label, its input style, the values that exist at all — is
 * catalogue-wide and lives in `option_groups` / `option_values`. What a product decides is
 * which of those values it offers, which one it opens on, and (for a measurement) the size
 * range. That split is why editing one option value's label does not require republishing
 * 60 products, and why this shape names values by code instead of restating them.
 */
export interface DraftSkuOptionWire {
  readonly kind: 'sku';
  readonly sortOrder: number;
  /** In display order. Must contain `defaultValueCode`; checked when the draft compiles. */
  readonly valueCodes: readonly string[];
  readonly defaultValueCode: string;
}

export interface DraftCustomOptionWire {
  readonly kind: 'custom';
  readonly sortOrder: number;
  readonly minUm: LengthWire;
  readonly maxUm: LengthWire;
  readonly stepUm: LengthWire;
  readonly defaultUm: LengthWire;
}

export type DraftOptionWire = DraftSkuOptionWire | DraftCustomOptionWire;

const draftSkuOptionSchema = z.object({
  kind: z.literal('sku'),
  sortOrder: sortOrderSchema,
  valueCodes: z.array(valueCodeSchema).min(1).max(200),
  defaultValueCode: valueCodeSchema,
});

const draftCustomOptionSchema = z.object({
  kind: z.literal('custom'),
  sortOrder: sortOrderSchema,
  minUm: positiveLengthSchema,
  maxUm: positiveLengthSchema,
  stepUm: positiveLengthSchema,
  defaultUm: positiveLengthSchema,
});

export const draftOptionWireSchema: z.ZodType<DraftOptionWire> = z.discriminatedUnion('kind', [
  draftSkuOptionSchema,
  draftCustomOptionSchema,
]);

export interface DraftRuleWire {
  readonly severity: 'error' | 'warning';
  readonly messageTh: string;
  readonly when: RuleExprWire;
  readonly sortOrder: number;
}

export const draftRuleWireSchema: z.ZodType<DraftRuleWire> = z.object({
  severity: z.literal(['error', 'warning']),
  messageTh: proseSchema,
  when: ruleExprWireSchema,
  sortOrder: sortOrderSchema,
});

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

/**
 * Create a product and its first draft, in one call.
 *
 * A product with no groups cannot be compiled into a `Product` — core's schema requires
 * `width` and `height`, and pricing reads them directly — so there is no useful state
 * between "does not exist" and "has enough to compile". Asking for the options up front
 * keeps the invariant this whole module rests on: **a draft always holds the document its
 * own rows compile to, and that document always parses as a core `Product`.** Every
 * mutation below preserves it or is refused, which is what makes `publish` a pure ordering
 * operation that cannot fail because of the data.
 */
export interface CreateProductRequestWire {
  readonly id: string;
  readonly slug: string;
  readonly skuPrefix: string;
  readonly fields: ProductFieldsWire;
  /** Keyed by option group code. */
  readonly options: Readonly<Record<string, DraftOptionWire>>;
  /** Keyed by rule code. Optional: a product may have no rules at all. */
  readonly rules?: Readonly<Record<string, DraftRuleWire>> | undefined;
}

export const createProductRequestSchema: z.ZodType<CreateProductRequestWire> = z.object({
  id: productIdSchema,
  slug: slugSchema,
  skuPrefix: skuPrefixSchema,
  fields: productFieldsWireSchema,
  options: z.record(groupCodeSchema, draftOptionWireSchema),
  rules: z.record(ruleCodeSchema, draftRuleWireSchema).optional(),
});

/**
 * The handle every draft mutation carries back.
 *
 * Plan 5 point 5 applied one layer in. The storefront sends a `documentHash` with every
 * price request and is answered 409 when a publish moved underneath it; a dashboard has
 * exactly the same problem with a colleague, and the same answer costs one field. Without
 * it, two editors on one draft is last-write-wins over a whole option list, and neither of
 * them finds out.
 */
export interface DraftMutationWire {
  readonly expectedDocumentHash: string;
}

const draftMutationShape = { expectedDocumentHash: documentHashSchema } as const;

export interface UpdateProductDraftRequestWire extends DraftMutationWire {
  readonly slug?: string | undefined;
  readonly skuPrefix?: string | undefined;
  readonly fields?: ProductFieldsPatchWire | undefined;
}

export const updateProductDraftRequestSchema: z.ZodType<UpdateProductDraftRequestWire> = z.object({
  ...draftMutationShape,
  slug: slugSchema.optional(),
  skuPrefix: skuPrefixSchema.optional(),
  /* Every field of the product, each one optional — see `productFieldsShape`. */
  fields: z.object(productFieldsShape).partial().optional(),
});

export interface PutDraftOptionRequestWire extends DraftMutationWire {
  readonly option: DraftOptionWire;
}

export const putDraftOptionRequestSchema: z.ZodType<PutDraftOptionRequestWire> = z.object({
  ...draftMutationShape,
  option: draftOptionWireSchema,
});

export interface PutDraftRuleRequestWire extends DraftMutationWire {
  readonly rule: DraftRuleWire;
}

export const putDraftRuleRequestSchema: z.ZodType<PutDraftRuleRequestWire> = z.object({
  ...draftMutationShape,
  rule: draftRuleWireSchema,
});

export const draftMutationSchema: z.ZodType<DraftMutationWire> = z.object(draftMutationShape);

/**
 * Publishing names the draft it means.
 *
 * The version id and not just the product: "publish whatever draft this product has" is a
 * request that does something different depending on what a colleague did thirty seconds
 * ago. Naming the version makes a concurrent open-and-edit a 404 or a 409 instead of a
 * publication of somebody else's work, and the hash makes it a 409 even when the id still
 * matches because the rows moved underneath.
 */
export interface PublishDraftRequestWire extends DraftMutationWire {
  readonly productVersionId: string;
}

export const publishDraftRequestSchema: z.ZodType<PublishDraftRequestWire> = z.object({
  ...draftMutationShape,
  productVersionId: z.uuid(),
});

/* ------------------------------------------------------------------ *
 * Option catalogue requests
 * ------------------------------------------------------------------ */

export interface CreateOptionGroupRequestWire {
  readonly code: string;
  readonly kind: 'sku' | 'custom';
  readonly labelTh: string;
  readonly input: 'swatch' | 'chip' | 'toggle' | 'number';
  readonly includeInSkuCode: boolean;
  /** How a measurement's bounds are written for a human. Custom groups only; storage is µm. */
  readonly authoredUnit?: 'cm' | 'mm' | undefined;
  readonly helperTh?: string | undefined;
}

export const createOptionGroupRequestSchema: z.ZodType<CreateOptionGroupRequestWire> = z.object({
  code: groupCodeSchema,
  kind: z.literal(['sku', 'custom']),
  labelTh: labelSchema,
  input: z.literal(['swatch', 'chip', 'toggle', 'number']),
  includeInSkuCode: z.boolean(),
  authoredUnit: z.literal(['cm', 'mm']).optional(),
  helperTh: proseSchema.optional(),
});

export interface UpdateOptionGroupRequestWire {
  readonly labelTh?: string | undefined;
  readonly helperTh?: string | undefined;
}

export const updateOptionGroupRequestSchema: z.ZodType<UpdateOptionGroupRequestWire> = z.object({
  labelTh: labelSchema.optional(),
  helperTh: proseSchema.optional(),
});

export interface CreateOptionValueRequestWire {
  readonly code: string;
  readonly labelTh: string;
  readonly swatchHex?: string | undefined;
  readonly delta: PriceDeltaWire;
  readonly sortOrder: number;
}

const swatchHexSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'swatchHex must be a #RRGGBB colour');

export const createOptionValueRequestSchema: z.ZodType<CreateOptionValueRequestWire> = z.object({
  code: valueCodeSchema,
  labelTh: labelSchema,
  swatchHex: swatchHexSchema.optional(),
  delta: catalogPriceDeltaSchema,
  sortOrder: sortOrderSchema,
});

export interface UpdateOptionValueRequestWire {
  readonly labelTh?: string | undefined;
  readonly swatchHex?: string | undefined;
  readonly delta?: PriceDeltaWire | undefined;
  readonly sortOrder?: number | undefined;
}

export const updateOptionValueRequestSchema: z.ZodType<UpdateOptionValueRequestWire> = z.object({
  labelTh: labelSchema.optional(),
  swatchHex: swatchHexSchema.optional(),
  delta: catalogPriceDeltaSchema.optional(),
  sortOrder: sortOrderSchema.optional(),
});

/**
 * Stock, on its own endpoint and in its own request type.
 *
 * Plan 5 point 2: `available` is the one catalogue fact that changes without a publish,
 * which is why it is not in the frozen document. That makes it the one write on this whole
 * surface that changes what a customer sees *immediately*, on every published version that
 * offers the value — so it is not folded into `UpdateOptionValueRequestWire` beside a
 * label. A caller cannot change a colour's name and take it out of stock in one request
 * without having decided to do both.
 */
export interface SetOptionValueAvailabilityRequestWire {
  readonly available: boolean;
}

export const setOptionValueAvailabilityRequestSchema: z.ZodType<SetOptionValueAvailabilityRequestWire> =
  z.object({ available: z.boolean() });

/* ------------------------------------------------------------------ *
 * Responses
 * ------------------------------------------------------------------ */

/** A published version, as the dashboard lists it. Immutable, so there is nothing to edit. */
export interface PublishedVersionWire {
  readonly productVersionId: string;
  readonly version: number;
  readonly documentHash: string;
  readonly publishedAt: string;
}

/**
 * The draft, and the document it would freeze.
 *
 * `product` is not a copy of the draft rows — it is `toDocument(compile(rows))` decoded
 * back out through the same encoder the storefront reads, so what the dashboard previews
 * is byte-for-byte what a publish would put in front of a customer. A preview built from
 * the edit form instead would agree with the form and disagree with production.
 *
 * `available` inside it is the current stock, overlaid the same way the read path overlays
 * it — a preview that showed every value as sellable would be a preview of a catalogue
 * nobody has.
 */
export interface DraftWire {
  readonly productVersionId: string;
  readonly version: number;
  /** Of the draft's compiled document. Send it back with the next mutation. */
  readonly documentHash: string;
  readonly updatedAt: string;
  readonly product: ProductWire;
}

/**
 * Which product-level fields the draft has moved away from the published document.
 *
 * The `products` row is not versioned, so an edit to `nameTh` or `pricePerSqm` is stored
 * the moment it is made while the published document keeps its frozen copy. That is
 * correct — pricing must not change without a publish — but it is invisible unless
 * something says so, and "I changed the price an hour ago" followed by an unchanged quote
 * is a support ticket. Empty when there is no draft or nothing has moved.
 */
export interface AdminProductWire {
  readonly id: string;
  readonly slug: string;
  readonly skuPrefix: string;
  readonly categoryId: string;
  readonly nameTh: string;
  readonly published: PublishedVersionWire | null;
  readonly draft: DraftWire | null;
  readonly unpublishedFields: readonly string[];
}

/**
 * A draft in a list, without the document it would freeze.
 *
 * The list endpoint serves every product — 81 today — and a `DraftWire` carries a whole
 * compiled `ProductWire` with every option value and every rule inside it. Compiling all
 * of them to render a table of names is the N+1 of this surface, so a list says *that*
 * there is a draft and how to address it, and the detail endpoint says what is in it.
 */
export interface DraftSummaryWire {
  readonly productVersionId: string;
  readonly version: number;
  readonly documentHash: string;
  readonly updatedAt: string;
}

export interface AdminProductSummaryWire {
  readonly id: string;
  readonly slug: string;
  readonly skuPrefix: string;
  readonly categoryId: string;
  readonly nameTh: string;
  readonly published: PublishedVersionWire | null;
  readonly draft: DraftSummaryWire | null;
  readonly unpublishedFields: readonly string[];
}

export interface AdminProductListWire {
  readonly products: readonly AdminProductSummaryWire[];
}

export interface AdminOptionValueWire {
  readonly code: string;
  readonly labelTh: string;
  readonly swatchHex?: string | undefined;
  readonly delta: PriceDeltaWire;
  readonly available: boolean;
  readonly sortOrder: number;
}

export interface AdminOptionGroupWire {
  readonly code: string;
  readonly kind: 'sku' | 'custom';
  readonly labelTh: string;
  readonly input: 'swatch' | 'chip' | 'toggle' | 'number';
  readonly includeInSkuCode: boolean;
  readonly authoredUnit?: 'cm' | 'mm' | undefined;
  readonly helperTh?: string | undefined;
  readonly values: readonly AdminOptionValueWire[];
}

export interface AdminOptionGroupListWire {
  readonly groups: readonly AdminOptionGroupWire[];
}

/** What a publish did, including which version it displaced. */
export interface PublishResultWire {
  readonly productVersionId: string;
  readonly version: number;
  readonly documentHash: string;
  readonly publishedAt: string;
  /** The version this one replaced, or `null` for a product's first publish. */
  readonly archivedVersionId: string | null;
}

/* ------------------------------------------------------------------ *
 * Response schemas — for a client that wants to check what it was sent
 * ------------------------------------------------------------------ */

export const publishedVersionWireSchema: z.ZodType<PublishedVersionWire> = z.object({
  productVersionId: z.uuid(),
  version: z.int().positive(),
  documentHash: documentHashSchema,
  publishedAt: z.iso.datetime(),
});

export const draftWireSchema: z.ZodType<DraftWire> = z.object({
  productVersionId: z.uuid(),
  version: z.int().positive(),
  documentHash: documentHashSchema,
  updatedAt: z.iso.datetime(),
  product: productWireSchema,
});

export const draftSummaryWireSchema: z.ZodType<DraftSummaryWire> = z.object({
  productVersionId: z.uuid(),
  version: z.int().positive(),
  documentHash: documentHashSchema,
  updatedAt: z.iso.datetime(),
});

export const adminProductWireSchema: z.ZodType<AdminProductWire> = z.object({
  id: productIdSchema,
  slug: slugSchema,
  skuPrefix: skuPrefixSchema,
  categoryId: z.string().min(1),
  nameTh: labelSchema,
  published: publishedVersionWireSchema.nullable(),
  draft: draftWireSchema.nullable(),
  unpublishedFields: z.array(z.string().min(1)),
});

export const adminProductSummaryWireSchema: z.ZodType<AdminProductSummaryWire> = z.object({
  id: productIdSchema,
  slug: slugSchema,
  skuPrefix: skuPrefixSchema,
  categoryId: z.string().min(1),
  nameTh: labelSchema,
  published: publishedVersionWireSchema.nullable(),
  draft: draftSummaryWireSchema.nullable(),
  unpublishedFields: z.array(z.string().min(1)),
});

export const adminProductListWireSchema: z.ZodType<AdminProductListWire> = z.object({
  products: z.array(adminProductSummaryWireSchema),
});

export const publishResultWireSchema: z.ZodType<PublishResultWire> = z.object({
  productVersionId: z.uuid(),
  version: z.int().positive(),
  documentHash: documentHashSchema,
  publishedAt: z.iso.datetime(),
  archivedVersionId: z.uuid().nullable(),
});

/* ------------------------------------------------------------------ *
 * Decoders for the exact quantities a request carries
 * ------------------------------------------------------------------ */

/**
 * The only sanctioned way out of the wire types above, gathered here so a handler never
 * reaches for `toBigInt` itself.
 *
 * They look like one-liners and are the point of the module: `decodePricePerSqmMinor` is
 * the *only* thing that turns a `MoneyRateWire<'THB'>` into a number a column can hold, so
 * grepping for it lists every place a price is written. A handler that did the conversion
 * inline would not appear in that list.
 */
export const decodePricePerSqmMinor = (wire: MoneyRateWire<'THB'>): bigint => toBigInt(wire);
export const decodeMinBillableSqUm = (wire: AreaWire): bigint => toBigInt(wire);
export const decodeLengthUm = (wire: LengthWire): bigint => toBigInt(wire);

export const encodePricePerSqmMinor = (minor: bigint): MoneyRateWire<'THB'> =>
  encodeMinorPerSqm(minor, 'THB');
export const encodeMinBillableSqUm = (sqUm: bigint): AreaWire => encodeSqUm(sqUm);
export const encodeLengthUm = (um: bigint): LengthWire => encodeUm(um);

/** Re-exported so a caller building a create request has one import for the elevation too. */
export type { Elevation, ElevationWire };
