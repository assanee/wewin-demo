import type { Elevation, Product } from '@wewin/core';
import { productSchema } from '@wewin/core/schema';
import type {
  CatalogDocumentV1,
  DocOptionGroup,
  DocOptionValue,
  DocPriceDelta,
  DocRule,
  DocRuleExpr,
} from '@wewin/db/document';
import { CATALOG_DOCUMENT_SCHEMA_VERSION } from '@wewin/db/document';
import { fromDocument, type AvailabilityLookup } from '@wewin/db/compile';
import { documentHash } from '@wewin/db/hash';
import { ZodError } from 'zod';

import { AppError, type JsonValue } from '../common/errors/app-error';

/**
 * Compiling a draft: the normalised rows an editor changes, turned into the document a
 * publish would freeze.
 *
 * Plan 5 splits the catalogue in two and `packages/db` implements both halves, but nothing
 * there joins them: `seedCatalog` writes a document it already had in hand from the TS
 * table, and `publishProductVersion` moves a version's *status* without looking at what is
 * inside it. That is the correct division — publishing is an ordering problem and has
 * enough to get right — but it leaves one question for the write side to answer, and this
 * file is the answer:
 *
 *     given the rows, what document do they mean?
 *
 * Two decisions make the rest of the admin surface simple.
 *
 * **It compiles to the storage document directly, not through core's `Product`.** Every
 * exact quantity a row holds is already in the unit the document wants — satang in
 * `price_per_sqm_minor`, micrometres in `min_um`, basis points in `delta_bp` — so the
 * compile is a re-shaping and not a conversion. Going via `Product` would mean satang →
 * baht → satang and bp → percent → bp on the *write* path, which is two roundings in the
 * one direction where a rounding is persisted rather than merely displayed.
 *
 * **The result is validated by core's own `productSchema`, not by a second opinion.** The
 * invariants that matter here are cross-entity — a default that is not one of the values
 * offered, a step off the 25 µm lattice, a rule naming a group the product does not offer,
 * a product with no `width` — and plan 5 point 3 says they belong to core and to Postgres.
 * `fromDocument` materialises the compiled document exactly as the read path would, and
 * `productSchema.parse` is then the same check `parseCatalog` runs over the TS table. A
 * draft that fails it is refused *at the edit that broke it*, which is why every mutation
 * in this module recompiles: the invariant "a draft always holds a document that parses"
 * is what makes `publish` a pure ordering operation with no data failure mode left in it.
 */

/* ------------------------------------------------------------------ *
 * The rows, as the repository reads them
 * ------------------------------------------------------------------ */

export interface DraftProductRow {
  readonly id: string;
  readonly slug: string;
  readonly skuPrefix: string;
  readonly categoryId: string;
  readonly nameTh: string;
  readonly summaryTh: string;
  readonly heroImage: string;
  readonly leadTimeMinDays: number;
  readonly leadTimeMaxDays: number;
  readonly pricePerSqmMinor: bigint;
  readonly minBillableSqUm: bigint;
  readonly elevation: Elevation;
  /** ⭐ 0052. `null` and absent both mean this product has no video. */
  readonly videoUrl: string | null;
}

export interface DraftOptionValueRow {
  readonly code: string;
  readonly labelTh: string;
  readonly swatchHex: string | null;
  readonly deltaType: 'none' | 'flat' | 'per_sqm' | 'percent';
  readonly deltaMinor: bigint | null;
  readonly deltaBp: number | null;
  /** Stock. Never enters the document — it is overlaid at read time (plan 5 point 2). */
  readonly available: boolean;
  readonly sortOrder: number;
}

export interface DraftOptionRow {
  readonly groupCode: string;
  readonly kind: 'sku' | 'custom';
  readonly labelTh: string;
  readonly input: 'swatch' | 'chip' | 'toggle' | 'number';
  readonly includeInSkuCode: boolean;
  readonly authoredUnit: 'cm' | 'mm' | null;
  readonly helperTh: string | null;
  readonly sortOrder: number;
  readonly defaultValueCode: string | null;
  readonly minUm: bigint | null;
  readonly maxUm: bigint | null;
  readonly stepUm: bigint | null;
  readonly defaultUm: bigint | null;
  readonly values: readonly DraftOptionValueRow[];
}

export interface DraftRuleRow {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly messageTh: string;
  readonly whenExpr: DocRuleExpr;
  readonly sortOrder: number;
}

export interface DraftRows {
  readonly product: DraftProductRow;
  readonly options: readonly DraftOptionRow[];
  readonly rules: readonly DraftRuleRow[];
  /** ⭐ 0052. The gallery, already in `sort_order`. Empty when the product has none. */
  readonly images: readonly string[];
}

/* ------------------------------------------------------------------ *
 * Compile
 * ------------------------------------------------------------------ */

const toDocDelta = (value: DraftOptionValueRow): DocPriceDelta => {
  switch (value.deltaType) {
    case 'none':
      return { type: 'none' };
    case 'flat':
      return { type: 'flat', currency: 'THB', minor: amountOf(value).toString() };
    case 'per_sqm':
      return { type: 'per_sqm', currency: 'THB', minor: amountOf(value).toString() };
    case 'percent':
      if (value.deltaBp === null) throw shapeViolation(value.code, 'a percent delta with no basis points');
      return { type: 'percent', bp: value.deltaBp };
  }
};

function amountOf(value: DraftOptionValueRow): bigint {
  if (value.deltaMinor === null) {
    throw shapeViolation(value.code, `a ${value.deltaType} delta with no amount`);
  }
  return value.deltaMinor;
}

/**
 * A row that `option_values_delta_shape` should have refused.
 *
 * A 500 and not a 422: the caller did nothing wrong, the database is holding a row that
 * its own CHECK forbids, and inventing a surcharge of ฿0 to carry on would be the exact
 * silent mispricing the constraint exists to prevent.
 */
const shapeViolation = (code: string, what: string): Error =>
  new Error(`admin: option value "${code}" is ${what}; option_values_delta_shape should have refused this row`);

const toDocValue = (value: DraftOptionValueRow): DocOptionValue => ({
  code: value.code,
  labelTh: value.labelTh,
  // Written only when present. `exactOptionalPropertyTypes` makes an explicit `undefined`
  // a different type from an absent key, and it would survive into the JSONB as a null
  // that `fromDocument` would then have to handle.
  ...(value.swatchHex === null ? {} : { swatchHex: value.swatchHex }),
  delta: toDocDelta(value),
});

function toDocGroup(option: DraftOptionRow): DocOptionGroup {
  if (option.kind === 'sku') {
    /*
     * `option_groups_sku_shape` guarantees this, and it is still checked: `input` arrives
     * as the four-member enum and the document's type is the three-member subset, so the
     * narrowing has to happen somewhere. Here, where the group code can be named.
     */
    if (option.input === 'number') {
      throw shapeViolation(option.groupCode, "a sku group with input 'number'");
    }
    if (option.defaultValueCode === null) {
      throw shapeViolation(option.groupCode, 'a sku group with no default value');
    }

    return {
      kind: 'sku',
      code: option.groupCode,
      labelTh: option.labelTh,
      input: option.input,
      includeInSkuCode: option.includeInSkuCode,
      values: option.values.map(toDocValue),
      defaultValue: option.defaultValueCode,
    };
  }

  const { authoredUnit, minUm, maxUm, stepUm, defaultUm } = option;
  if (authoredUnit === null || minUm === null || maxUm === null || stepUm === null || defaultUm === null) {
    throw shapeViolation(option.groupCode, 'a measurement group missing its unit or its bounds');
  }

  return {
    kind: 'custom',
    code: option.groupCode,
    labelTh: option.labelTh,
    input: 'number',
    unit: authoredUnit,
    minUm: minUm.toString(),
    maxUm: maxUm.toString(),
    stepUm: stepUm.toString(),
    defaultUm: defaultUm.toString(),
    ...(option.helperTh === null ? {} : { helperTh: option.helperTh }),
  };
}

const toDocRule = (rule: DraftRuleRow): DocRule => ({
  id: rule.code,
  messageTh: rule.messageTh,
  severity: rule.severity,
  when: rule.whenExpr,
});

/**
 * The rows, as one document.
 *
 * Order is part of the output, not a detail: the document is hashed, and the hash is what a
 * storefront compares to decide whether it is still looking at the version it was priced
 * from. Two compiles of the same rows have to produce the same bytes, so the caller sorts
 * the rows it hands in and this function preserves that order rather than imposing one of
 * its own — see `orderedBy` in the repository.
 */
export function compileDraftDocument(rows: DraftRows): CatalogDocumentV1 {
  const { product } = rows;

  return {
    schemaVersion: CATALOG_DOCUMENT_SCHEMA_VERSION,
    id: product.id,
    slug: product.slug,
    nameTh: product.nameTh,
    categoryId: product.categoryId,
    summaryTh: product.summaryTh,
    elevation: product.elevation,
    heroImage: product.heroImage,
    leadTimeDays: [product.leadTimeMinDays, product.leadTimeMaxDays],
    currency: 'THB',
    pricePerSqmMinor: product.pricePerSqmMinor.toString(),
    minBillableSqUm: product.minBillableSqUm.toString(),
    groups: rows.options.map(toDocGroup),
    rules: rows.rules.map(toDocRule),
    skuPrefix: product.skuPrefix,
    /*
     * ⚠️ Omitted when empty, matching `toDocument` in `@wewin/db`. An absent key and an empty
     * array decode alike, but only the absent one leaves the canonical JSON — and therefore
     * the hash — identical to a document frozen before 0052. `compile.test.ts` holds both
     * halves of that.
     */
    ...(rows.images.length === 0 ? {} : { images: [...rows.images] }),
    ...(product.videoUrl === null ? {} : { videoUrl: product.videoUrl }),
  };
}

/** Stock for one draft, keyed the way `fromDocument` asks for it. */
export function availabilityOf(rows: DraftRows): AvailabilityLookup {
  const index = new Map<string, boolean>();
  for (const option of rows.options) {
    for (const value of option.values) {
      index.set(`${option.groupCode}:${value.code}`, value.available);
    }
  }
  // Absent means not sellable, for the same reason the read path says so: a value with no
  // row is a value this version does not offer, and defaulting it to `true` would put an
  // option in the preview that nothing in the database backs.
  return (groupCode, valueCode) => index.get(`${groupCode}:${valueCode}`) ?? false;
}

export interface CompiledDraft {
  readonly document: CatalogDocumentV1;
  readonly documentHash: string;
  /** The document materialised, with current stock overlaid — what the preview serves. */
  readonly product: Product;
}

/**
 * Compile, then prove the result is a product core would accept.
 *
 * The `fromDocument` call is not a formality. It is the same function the read path uses,
 * so anything it refuses — a satang that is not a whole baht, a basis-point figure that is
 * not a whole percent — is refused here, on the edit that introduced it, instead of on a
 * customer's first request after the publish.
 */
export function compileDraft(rows: DraftRows): CompiledDraft {
  const document = compileDraftDocument(rows);

  let product: Product;
  try {
    product = fromDocument(document, availabilityOf(rows));
  } catch (error) {
    throw AppError.validationFailed(
      `ร่างนี้ยังบันทึกไม่ได้: ${error instanceof Error ? error.message : String(error)}`,
      { productId: rows.product.id },
    );
  }

  /*
   * `parse` and not `safeParse` on the happy path — the throw is caught two lines down and
   * turned into the one thing a dashboard can act on: a list of which fields are wrong.
   * `AppError.validationFailed` is 422 rather than 400 because the request was well-formed
   * and the *catalogue* it would produce is not, which is a different thing for a client to
   * show a user.
   */
  try {
    productSchema.parse(product);
  } catch (error) {
    throw AppError.validationFailed(
      'ร่างนี้ยังไม่ครบถ้วนตามกฎของแคตตาล็อก — ตรวจรายการด้านล่าง',
      { productId: rows.product.id, issues: issuesOf(error) },
    );
  }

  return { document, documentHash: documentHash(document), product };
}

/**
 * A `ZodError` reduced to the two things a form can use: where, and what.
 *
 * Not the whole error — it carries the input value, which for a catalogue draft means the
 * entire product would be echoed back inside an error body.
 */
function issuesOf(error: unknown): JsonValue {
  if (!(error instanceof ZodError)) {
    return [error instanceof Error ? error.message : String(error)];
  }
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.'),
    message: issue.message,
  }));
}
