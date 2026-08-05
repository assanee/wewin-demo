import { AppError } from '../common/errors/app-error';
import { message, type NullaryMessageKey } from '../i18n';

/**
 * The constraints in `packages/db`, translated into answers a dashboard can act on.
 *
 * Every rule this module could restate in TypeScript is already a `UNIQUE`, a `CHECK` or a
 * trigger, and plan 5 point 3 is explicit that the cross-row ones *have* to live there —
 * a zod schema cannot see whether another product already claims a slug. The consequence
 * is that the honest failure for "this slug is taken" arrives as a driver error, and the
 * choice is between guessing ahead of the write with a SELECT that races, or reading the
 * error the database actually returned.
 *
 * This reads the error. What it deliberately does not do is forward the driver's own
 * message: `detail` on a unique violation contains the conflicting row's values, which for
 * `users` would be an email address and for anything else is still a column dump in a
 * response body. The constraint *name* is enough to say which rule was broken, and the
 * names in `src/schema` were chosen to be readable for exactly this reason.
 */

interface PostgresErrorLike {
  readonly code: string;
  readonly constraint: string | undefined;
}

/** SQLSTATEs this module knows how to explain. Anything else stays a 500 with a stack. */
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';
/** What `RAISE ... USING ERRCODE = 'restrict_violation'` produces — the freeze triggers. */
const RESTRICT_VIOLATION = '23001';

/**
 * Find the driver error, however deeply it has been wrapped.
 *
 * Drizzle rethrows a query failure as `DrizzleQueryError`, which carries no `code` of its
 * own and keeps the real one on `.cause`. Reading `error.code` off the top therefore sees
 * `undefined` for every CHECK, UNIQUE and FK the catalogue relies on, and each of them
 * reaches the caller as an untranslated 500 — the constraint fires, the database is
 * protected, and the client is told nothing it can act on.
 *
 * Walking the chain rather than reaching for `.cause` once, because a wrapper is free to
 * add another layer and this is not worth revisiting when it does.
 */
function postgresErrorOf(error: unknown): PostgresErrorLike | undefined {
  for (let current: unknown = error, depth = 0; depth < 8; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;

    if ('code' in current) {
      const { code } = current as { code: unknown };
      if (typeof code === 'string') {
        const constraint =
          'constraint' in current ? (current as { constraint: unknown }).constraint : undefined;
        return { code, constraint: typeof constraint === 'string' ? constraint : undefined };
      }
    }

    current = 'cause' in current ? (current as { cause: unknown }).cause : undefined;
  }

  return undefined;
}

/**
 * Which message each constraint means. The sentences live in `src/i18n/catalog/`.
 *
 * A key and not a Thai string, because this table is read on the way to a customer's
 * browser and a customer's browser is not necessarily Thai. The constraint names in
 * `src/schema` were chosen to be readable for exactly this purpose, and they are still what
 * decides the answer — only the answer itself moved.
 */
const EXPLANATIONS: ReadonlyMap<string, NullaryMessageKey> = new Map([
  ['products_slug_unique', 'error.catalog.slug_taken'],
  ['products_sku_prefix_unique', 'error.catalog.sku_prefix_taken'],
  ['products_pkey', 'error.catalog.product_id_taken'],
  ['products_price_whole_baht', 'error.catalog.price_whole_baht'],
  ['products_price_positive', 'error.catalog.price_positive'],
  ['products_lead_time_ordered', 'error.catalog.lead_time_ordered'],
  ['products_min_billable_positive', 'error.catalog.min_billable_positive'],
  ['option_groups_code_unique', 'error.catalog.group_code_taken'],
  ['option_groups_sku_shape', 'error.catalog.sku_group_shape'],
  ['option_groups_custom_shape', 'error.catalog.custom_group_shape'],
  ['option_values_group_code_key', 'error.catalog.value_code_taken'],
  ['option_values_delta_shape', 'error.catalog.delta_shape'],
  ['option_values_delta_whole_units', 'error.catalog.delta_whole_units'],
  ['option_values_swatch_hex_format', 'error.catalog.swatch_hex_format'],
  ['product_version_options_grid', 'error.catalog.size_grid'],
  ['product_version_options_sku_shape', 'error.catalog.version_sku_shape'],
  ['product_version_options_custom_shape', 'error.catalog.version_custom_shape'],
  ['product_version_rules_version_code_key', 'error.catalog.rule_code_taken'],
  ['product_versions_one_published_per_product', 'error.catalog.already_published'],
  ['product_versions_product_version_key', 'error.catalog.version_number_taken'],
]);

/**
 * Turn a driver error into an `AppError`, or hand it back untouched.
 *
 * Rethrowing the original for anything unrecognised is deliberate: an unknown SQLSTATE is
 * a bug in this service, and `AllExceptionsFilter` logs it with a stack and tells the
 * client only the request id. Wrapping it in a 4xx here would file our bug under the
 * caller's mistakes and lose the stack on the way.
 */
export function translatePostgresError(error: unknown): unknown {
  const pg = postgresErrorOf(error);
  if (!pg) return error;

  const named = pg.constraint;
  const explained = named === undefined ? undefined : EXPLANATIONS.get(named);
  const details = named === undefined ? undefined : { constraint: named };
  const say = (fallback: NullaryMessageKey) => message(explained ?? fallback);

  switch (pg.code) {
    case UNIQUE_VIOLATION:
      return AppError.conflict(say('error.catalog.duplicate'), details);

    case FOREIGN_KEY_VIOLATION:
      // 422 and not 404: the request named something that does not exist, but *which*
      // something is the reference and not the resource the request was addressed to.
      return AppError.validationFailed(say('error.catalog.missing_reference'), details);

    case CHECK_VIOLATION:
      return AppError.validationFailed(say('error.catalog.check_failed'), details);

    case RESTRICT_VIOLATION:
      /*
       * A freeze trigger fired. Reaching this means something tried to edit a published or
       * archived version, which every path in this module is written not to do — so it is
       * a 409 with the plain reason rather than a translated one, and the message from
       * `0001_catalog_freeze.sql` names the version and its status.
       */
      return AppError.conflict(message('error.catalog.frozen'), { reason: 'frozen' });

    default:
      return error;
  }
}

/** `await withTranslatedErrors(() => tx.insert(...))` — one wrapper per write path. */
export async function withTranslatedErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw translatePostgresError(error);
  }
}
