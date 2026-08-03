import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { optionGroupKind, productVersionStatus, ruleSeverity } from './enums.js';
import { optionGroups, optionValues, products } from './catalog.js';
import type { CatalogDocumentV1, DocRuleExpr } from '../document.js';
import { CATALOG_DOCUMENT_SCHEMA_VERSION } from '../document.js';

/**
 * The published layer: one frozen document per version, and the rows it was compiled
 * from.
 *
 * Web and api read `product_versions.document` and nothing else; an order line points
 * at a `product_versions.id`, so the shape a customer was quoted from stays retrievable
 * after the dashboard has moved on five versions (plan section 5).
 */

export const productVersions = pgTable(
  'product_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onUpdate: 'cascade', onDelete: 'cascade' }),
    version: integer('version').notNull(),
    status: productVersionStatus('status').notNull().default('draft'),
    /**
     * The compiled product, as web and api read it.
     *
     * Every length and every amount inside is a decimal *string*, because JSON has no
     * bigint and `JSON.parse` would hand back a `number` that quietly loses the low
     * digits of a µm² area. `src/document.ts` is the shape; `src/compile.ts` is the
     * only thing allowed to build one.
     */
    document: jsonb('document').$type<CatalogDocumentV1>().notNull(),
    /**
     * Which document shape this row holds.
     *
     * Plan 4.5 is about exactly this: a stored payload with no version field gets
     * reinterpreted under new rules and nobody finds out. A column rather than a field
     * inside the blob so a migration can find the old rows without parsing them all.
     */
    documentSchemaVersion: smallint('document_schema_version')
      .notNull()
      .default(CATALOG_DOCUMENT_SCHEMA_VERSION),
    /**
     * Hash of the canonical serialisation of `document`.
     *
     * The configurator sends this back with every price and order request and the api
     * answers 409 with the new document when it does not match, so a customer who
     * spent five minutes configuring during a publish is told rather than charged from
     * a document they never saw (plan 5, point 5).
     */
    documentHash: text('document_hash').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('product_versions_product_version_key').on(table.productId, table.version),
    /**
     * At most one published version per product.
     *
     * ⚠️ ORDER OF STATEMENTS AT PUBLISH TIME ⚠️
     *
     * A partial unique index is enforced per statement, not at commit, and a partial
     * index cannot be declared DEFERRABLE — only unique *constraints* can, and a
     * constraint cannot carry a WHERE clause. So there is no way to be briefly in
     * violation inside a transaction and tidy up before commit:
     *
     *     archive the current published version FIRST, publish the new one SECOND.
     *
     * The reverse order raises 23505 even though the transaction would have ended in a
     * legal state. Both statements run inside one transaction that begins by taking
     * `SELECT ... FOR UPDATE` on the product row, so two editors publishing at the same
     * instant queue instead of racing. `publishProductVersion` in `src/publish.ts` is
     * that sequence written down and executable; `tests/publish.test.ts` fails if the
     * order is swapped.
     */
    uniqueIndex('product_versions_one_published_per_product')
      .on(table.productId)
      .where(sql`status = 'published'`),
    index('product_versions_product_status_idx').on(table.productId, table.status),
    check('product_versions_version_positive', sql`${table.version} > 0`),
    check(
      'product_versions_published_at_present',
      sql`${table.status} <> 'published' or ${table.publishedAt} is not null`,
    ),
    check(
      'product_versions_archived_at_present',
      sql`${table.status} <> 'archived' or ${table.archivedAt} is not null`,
    ),
  ],
);

/**
 * A group offered by one version of one product, with the part that varies per product.
 *
 * The group definition itself is shared (`option_groups`); what a product decides is
 * which default it opens on and — for a measurement — the size range, which is why the
 * eight size profiles in `products.ts` produce different bounds for the same `width`.
 */
export const productVersionOptions = pgTable(
  'product_version_options',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productVersionId: uuid('product_version_id')
      .notNull()
      .references(() => productVersions.id, { onDelete: 'cascade' }),
    optionGroupId: uuid('option_group_id').notNull(),
    /** Denormalised from `option_groups` so the shape CHECKs below can be enforced by Postgres. */
    groupKind: optionGroupKind('group_kind').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    /** sku groups only. That it is one of the offered values is checked at compile time. */
    defaultValueCode: text('default_value_code'),
    /* Measurement bounds, canonical micrometres. Custom groups only. */
    minUm: bigint('min_um', { mode: 'bigint' }),
    maxUm: bigint('max_um', { mode: 'bigint' }),
    stepUm: bigint('step_um', { mode: 'bigint' }),
    defaultUm: bigint('default_um', { mode: 'bigint' }),
  },
  (table) => [
    foreignKey({
      name: 'product_version_options_group_fk',
      columns: [table.optionGroupId, table.groupKind],
      foreignColumns: [optionGroups.id, optionGroups.kind],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    unique('product_version_options_version_group_key').on(
      table.productVersionId,
      table.optionGroupId,
    ),
    /* The handle the value list hangs off: a value may only be attached through the group it belongs to. */
    unique('product_version_options_id_group_key').on(table.id, table.optionGroupId),
    check(
      'product_version_options_sku_shape',
      sql`${table.groupKind} <> 'sku' or (
            ${table.defaultValueCode} is not null
            and ${table.minUm} is null and ${table.maxUm} is null
            and ${table.stepUm} is null and ${table.defaultUm} is null
          )`,
    ),
    check(
      'product_version_options_custom_shape',
      sql`${table.groupKind} <> 'custom' or (
            ${table.defaultValueCode} is null
            and ${table.minUm} is not null and ${table.maxUm} is not null
            and ${table.stepUm} is not null and ${table.defaultUm} is not null
          )`,
    ),
    /*
     * The grid invariants `customGroupSchema` checks in `@wewin/core/schema`, restated
     * where they can be enforced on write. They are all within-row, so a CHECK is the
     * whole job — unlike the cross-row ones above, which is the distinction plan 5
     * point 3 draws.
     *
     * `step % 25 = 0` is the lattice from `@wewin/core/units`: gcd(5 mm, 1/8 in) = 25 µm,
     * and a step off that lattice is a size a customer can type in inches and never
     * reach in centimetres.
     */
    check(
      'product_version_options_grid',
      sql`${table.groupKind} <> 'custom' or (
            ${table.minUm} > 0
            and ${table.stepUm} > 0
            and ${table.stepUm} % 25 = 0
            and ${table.minUm} <= ${table.maxUm}
            and ${table.minUm} % ${table.stepUm} = 0
            and (${table.maxUm} - ${table.minUm}) % ${table.stepUm} = 0
            and ${table.defaultUm} between ${table.minUm} and ${table.maxUm}
            and (${table.defaultUm} - ${table.minUm}) % ${table.stepUm} = 0
          )`,
    ),
  ],
);

/**
 * Which values of a group this version offers.
 *
 * The pair of foreign keys is the point: one proves the row belongs to a version's
 * group, the other proves the value belongs to that same group. Together they make
 * "glass colour BLU offered under the profile colour group" unrepresentable rather
 * than merely unlikely.
 */
export const productVersionOptionValues = pgTable(
  'product_version_option_values',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productVersionOptionId: uuid('product_version_option_id').notNull(),
    optionGroupId: uuid('option_group_id').notNull(),
    optionValueId: uuid('option_value_id').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (table) => [
    foreignKey({
      name: 'pvov_version_option_fk',
      columns: [table.productVersionOptionId, table.optionGroupId],
      foreignColumns: [productVersionOptions.id, productVersionOptions.optionGroupId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'pvov_option_value_fk',
      columns: [table.optionValueId, table.optionGroupId],
      foreignColumns: [optionValues.id, optionValues.optionGroupId],
    }).onDelete('restrict'),
    unique('pvov_option_value_key').on(table.productVersionOptionId, table.optionValueId),
  ],
);

/**
 * A rule of one version.
 *
 * The predicate stays an AST in JSONB — normalising an expression tree into rows buys
 * nothing, since nothing ever queries for "rules whose left operand is a product" —
 * and `referenced_group_codes` is the handle beside it that makes the tree queryable
 * for the one question that matters: does this rule name a group the version actually
 * offers? (plan section 5). `publishProductVersion` refuses to publish when it does
 * not, which is the same class of mistake `parseCatalog` catches for the TS table.
 */
export const productVersionRules = pgTable(
  'product_version_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productVersionId: uuid('product_version_id')
      .notNull()
      .references(() => productVersions.id, { onDelete: 'cascade' }),
    /** The rule's catalogue id, e.g. `'awn4t-max-area'`. Named `code` because `id` is the surrogate. */
    code: text('code').notNull(),
    severity: ruleSeverity('severity').notNull(),
    messageTh: text('message_th').notNull(),
    whenExpr: jsonb('when_expr').$type<DocRuleExpr>().notNull(),
    referencedGroupCodes: text('referenced_group_codes').array().notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (table) => [
    unique('product_version_rules_version_code_key').on(table.productVersionId, table.code),
    index('product_version_rules_referenced_groups_idx').using(
      'gin',
      table.referencedGroupCodes,
    ),
    /* An empty array is a rule that reads nothing and therefore fires always or never. */
    check(
      'product_version_rules_references_something',
      sql`array_length(${table.referencedGroupCodes}, 1) >= 1`,
    ),
  ],
);
