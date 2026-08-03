import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * The closed sets the catalogue is built from, as Postgres enums rather than `text`.
 *
 * Every one of these already exists as a TypeScript union in `@wewin/core`, and a
 * `text` column would let a typo like `'per_sq_m'` reach the compiled document, where
 * `calcPrice`'s switch would silently price it as zero. An enum makes that a write
 * error on the row that caused it. The literal lists are asserted equal to core's
 * unions in `tests/enums.test.ts`, so adding a member to one and not the other fails.
 */

export const optionGroupKind = pgEnum('option_group_kind', ['sku', 'custom']);

export const optionInput = pgEnum('option_input', ['swatch', 'chip', 'toggle', 'number']);

/** How the row was *written*, never how a length is stored — storage is always µm. */
export const authoredUnit = pgEnum('authored_unit', ['cm', 'mm']);

export const priceDeltaType = pgEnum('price_delta_type', ['none', 'flat', 'per_sqm', 'percent']);

export const ruleSeverity = pgEnum('rule_severity', ['error', 'warning']);

/**
 * A version's place in its lifecycle.
 *
 * Deliberately three states and not a boolean: `archived` is what a published version
 * becomes, and it has to stay readable forever because an order line points at it.
 * There is no path back to `draft` — see the freeze trigger in
 * `drizzle/0001_catalog_freeze.sql`.
 */
export const productVersionStatus = pgEnum('product_version_status', [
  'draft',
  'published',
  'archived',
]);
