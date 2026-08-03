import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { Elevation } from '@wewin/core';
import { authoredUnit, optionGroupKind, optionInput, priceDeltaType } from './enums.js';

/**
 * The editable layer: the normalised tables the dashboard writes to.
 *
 * Nothing here is frozen and nothing here is what a price is computed from. A price
 * comes from the compiled document in `versions.ts`; these rows are the material a
 * document is compiled out of, so an editor can change one option value without
 * rewriting a product (plan section 5).
 *
 * Two conventions hold for every table below and are not repeated at each column:
 *
 *   money   `bigint` minor units — satang for THB — with the currency named in a
 *           column beside it. Never `numeric`, never `double precision` (plan 4.2).
 *           `mode: 'bigint'` matters: node-postgres hands int8 back as a *string*,
 *           and a string that looks like a number silently concatenates where the
 *           domain would have multiplied. `tests/bigint.test.ts` proves the mapping
 *           against a real server, including a value above 2^53.
 *   lengths `bigint` micrometres (`_um`), areas square micrometres (`_sq_um`), for
 *           the gcd reason in `@wewin/core/units`: µm is the only lattice on which
 *           the 5 mm catalogue grid and the 1/8 in entry grid both land.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/**
 * Base currency, as a column rather than an assumption.
 *
 * Plan 4.2 settled on one base currency per product and conversion at the display
 * edge, so every row below carries `'THB'` today. It is written down anyway because
 * "the number is in baht" is exactly the kind of fact that lives only in a reviewer's
 * head until the day it is wrong; the CHECK makes a second base currency a migration
 * with a name instead of a discovery.
 */
const baseCurrency = char('currency', { length: 3 }).notNull().default('THB');

export const categories = pgTable('categories', {
  /** The catalogue's own id (`'louvers'`), not a surrogate: it is stable, human-legible, and appears in URLs. */
  id: text('id').primaryKey(),
  labelTh: text('label_th').notNull(),
  summaryTh: text('summary_th').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  ...timestamps,
});

/**
 * A product, in the sense the dashboard edits one.
 *
 * The four uniqueness rules `parseCatalog` checks in `@wewin/core/schema` land here
 * as constraints, because one zod object schema cannot see across rows and the ones
 * that matter are all cross-row (plan 5, point 3):
 *
 *   duplicate id        → the primary key
 *   duplicate slug      → `products_slug_unique`
 *   duplicate skuPrefix → `products_sku_prefix_unique`, so two products can never
 *                         emit the same sku_code and leave a quote line ambiguous
 *   unknown categoryId  → the foreign key
 */
export const products = pgTable(
  'products',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    skuPrefix: text('sku_prefix').notNull().unique(),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id, { onUpdate: 'cascade', onDelete: 'restrict' }),
    nameTh: text('name_th').notNull(),
    summaryTh: text('summary_th').notNull(),
    heroImage: text('hero_image').notNull(),
    leadTimeMinDays: integer('lead_time_min_days').notNull(),
    leadTimeMaxDays: integer('lead_time_max_days').notNull(),
    currency: baseCurrency,
    pricePerSqmMinor: bigint('price_per_sqm_minor', { mode: 'bigint' }).notNull(),
    minBillableSqUm: bigint('min_billable_sq_um', { mode: 'bigint' }).notNull(),
    /**
     * The elevation drawing spec, one blob.
     *
     * Not normalised into panels on purpose (plan section 5). Panels have no identity
     * of their own — nothing references panel 3 of a folding door — and a `panels`
     * table would buy joins in exchange for nothing an editor can use.
     */
    elevation: jsonb('elevation').$type<Elevation>().notNull(),
    ...timestamps,
  },
  (table) => [
    check('products_currency_is_thb', sql`${table.currency} = 'THB'`),
    check('products_lead_time_ordered', sql`${table.leadTimeMinDays} <= ${table.leadTimeMaxDays}`),
    check('products_lead_time_nonnegative', sql`${table.leadTimeMinDays} >= 0`),
    check('products_price_positive', sql`${table.pricePerSqmMinor} > 0`),
    /*
     * `calcPrice` reads `pricePerSqm` as whole baht (`BigInt(product.pricePerSqm)` in
     * pricing.ts:196) and would throw on a fraction. Rejecting ฿2,200.50 here fails on
     * the row that wrote it; allowing it fails at compile time with no clue where it
     * came from. When core learns sub-baht prices this check is the list of what else
     * has to change.
     */
    check('products_price_whole_baht', sql`${table.pricePerSqmMinor} % 100 = 0`),
    check('products_min_billable_positive', sql`${table.minBillableSqUm} > 0`),
  ],
);

/**
 * An option group definition, shared across products.
 *
 * `products.ts` builds all 81 products from ten group factories — five sku groups for
 * glass, three for louvres, plus `width` and `height` — so a group is a catalogue-wide
 * concept and only its *use* is per product. What varies per product lives on
 * `product_version_options`: which values are offered, which is the default, and (for
 * a measurement) the size range.
 */
export const optionGroups = pgTable(
  'option_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(),
    kind: optionGroupKind('kind').notNull(),
    labelTh: text('label_th').notNull(),
    input: optionInput('input').notNull(),
    includeInSkuCode: boolean('include_in_sku_code').notNull().default(false),
    /** cm or mm — the idiom the catalogue is written in, for messages. Custom groups only. */
    authoredUnit: authoredUnit('authored_unit'),
    helperTh: text('helper_th'),
    ...timestamps,
  },
  (table) => [
    /*
     * The composite key exists so child rows can carry `kind` and have Postgres check
     * it matches. Without it, `kind` on a child is a copy that can drift, and every
     * CHECK written against it is checking the copy.
     */
    unique('option_groups_id_kind_key').on(table.id, table.kind),
    check(
      'option_groups_sku_shape',
      sql`${table.kind} <> 'sku' or (${table.input} in ('swatch', 'chip', 'toggle') and ${table.authoredUnit} is null)`,
    ),
    check(
      'option_groups_custom_shape',
      sql`${table.kind} <> 'custom' or (${table.input} = 'number' and ${table.authoredUnit} is not null and ${table.includeInSkuCode} = false)`,
    ),
  ],
);

/**
 * One selectable value of a sku group, with its surcharge.
 *
 * `available` lives here and **not** in the compiled document, which is plan 5's
 * second warning: stock is the one catalogue fact that changes without a publish, and
 * a colour going out of stock must not require freezing a new version of all 60
 * products that offer it. The api overlays this column when it materialises a
 * document into a `Product` — see `fromDocument` in `src/compile.ts`.
 */
export const optionValues = pgTable(
  'option_values',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    optionGroupId: uuid('option_group_id').notNull(),
    /** Carried so the CHECK below is a fact Postgres enforces, not a copy that drifts. */
    groupKind: optionGroupKind('group_kind').notNull(),
    code: text('code').notNull(),
    labelTh: text('label_th').notNull(),
    swatchHex: char('swatch_hex', { length: 7 }),
    deltaType: priceDeltaType('delta_type').notNull(),
    currency: baseCurrency,
    /** `flat` (per unit) and `per_sqm` (per billable m²) surcharges, in satang. */
    deltaMinor: bigint('delta_minor', { mode: 'bigint' }),
    /**
     * A `percent` surcharge, in basis points.
     *
     * Not a money column and not a currency-bearing one: 8% is 8% in every market
     * (plan 4.2). Integer basis points rather than a float percentage for the same
     * reason every other number here is exact.
     */
    deltaBp: integer('delta_bp'),
    available: boolean('available').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: 'option_values_group_fk',
      columns: [table.optionGroupId, table.groupKind],
      foreignColumns: [optionGroups.id, optionGroups.kind],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    check('option_values_currency_is_thb', sql`${table.currency} = 'THB'`),
    unique('option_values_group_code_key').on(table.optionGroupId, table.code),
    /* Lets a version's value list prove, in the FK, that a value belongs to the group it was picked for. */
    unique('option_values_id_group_key').on(table.id, table.optionGroupId),
    /* A measurement has no values to enumerate; a row claiming otherwise is a mis-typed group id. */
    check('option_values_sku_groups_only', sql`${table.groupKind} = 'sku'`),
    check(
      'option_values_swatch_hex_format',
      sql`${table.swatchHex} is null or ${table.swatchHex} ~ '^#[0-9a-fA-F]{6}$'`,
    ),
    /*
     * Exactly one amount column carries the surcharge, chosen by `delta_type`. Both
     * columns filled means two answers to "how much"; the wrong one filled means the
     * surcharge silently disappears at compile time.
     */
    check(
      'option_values_delta_shape',
      sql`case ${table.deltaType}
            when 'none'    then ${table.deltaMinor} is null and ${table.deltaBp} is null
            when 'percent' then ${table.deltaMinor} is null and ${table.deltaBp} is not null
            else ${table.deltaMinor} is not null and ${table.deltaBp} is null
          end`,
    ),
    /* Same reason as `products_price_whole_baht`: pricing.ts:221,225,229 take these as whole integers. */
    check(
      'option_values_delta_whole_units',
      sql`(${table.deltaMinor} is null or ${table.deltaMinor} % 100 = 0)
          and (${table.deltaBp} is null or ${table.deltaBp} % 100 = 0)`,
    ),
  ],
);

/**
 * A marker for data written by the seed, so a re-seed can tell its own rows from an
 * editor's. `smallint` because it is a generation counter, not money.
 */
export const seedRuns = pgTable('seed_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** The `@wewin/core` version the catalogue table was read from. */
  coreVersion: text('core_version').notNull(),
  productCount: smallint('product_count').notNull(),
  ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
});
