import { AppError } from '../common/errors/app-error';
import { message, type NullaryMessageKey } from '../i18n';

/**
 * The tax-country guards in `packages/db`, translated into answers an admin can act on.
 *
 * ── Why this did not exist before Task 3 ─────────────────────────────────────────
 *
 * `i18n/message.ts`'s note beside `error.organisation.account_missing` says the two existing
 * organisation errors are "ordinary `AppError.notFound`s", not constraint translators, because
 * "neither trips a database CHECK a customer could reach." That stopped being true the moment
 * Task 1 added `tax_countries_rate_matches_treatment`: a body that validates cleanly against
 * `taxCountryPatchSchema`/`taxCountryCreateSchema` (Task 2) can still trip it, and, on a
 * different constraint, a body can still collide with the primary key or leave a name that is
 * whitespace once trimmed. Without this file those three reach `AllExceptionsFilter` as a raw
 * `DrizzleQueryError` — a 500 plus a production alert for something a client did on purpose.
 *
 * ── What is mapped, and what deliberately is not ─────────────────────────────────
 *
 * Every CHECK on `tax_countries` (migration 0029) was checked against Task 2's zod schemas
 * one at a time, by experiment rather than by reading the two side by side:
 *
 *   - `tax_countries_code_shape` (`^[A-Z]{2}$`), `tax_countries_rate_in_range` (0..10000) and
 *     `tax_countries_treatment_allowed` (the four values) are each already enforced by zod in
 *     exactly the same shape — unreachable through a validated body, so not mapped here.
 *   - `tax_countries_name_says_something` (`length(btrim(name_th)) > 0`) is **not** the same
 *     check as zod's `nameTh: z.string().min(1).max(120)` — `.min(1)` counts the raw string,
 *     not the trimmed one, so `nameTh: '   '` passes the schema and fails the CHECK. Mapped.
 *   - `tax_countries_rate_matches_treatment` has no zod equivalent at all — Task 1's own review
 *     found that `taxCountryCreateSchema` does not enforce the pair either — and is the
 *     constraint the reviewer's probe actually hit. Mapped.
 *   - `tax_countries_pkey` (the primary key on `code`) is reachable the ordinary way: `create`
 *     with a code that already exists. Mapped.
 *
 * A foreign-key violation is not reachable from a request body at all: `taxCountryChanges`'s
 * FK to `taxCountries.code` is always populated from a code this service just inserted or
 * already locked, and the FK to `users.id` is populated from the authenticated actor, never
 * from the body. Neither is mapped — "do not map codes you cannot reach."
 * `tax_countries_block_delete` and `tax_country_changes_append_only` (both `restrict_violation`)
 * fire only on a DELETE, or an UPDATE/DELETE of a change row, and this service never issues
 * either — also not mapped.
 */

interface PostgresErrorLike {
  readonly code: string;
  readonly constraint: string | undefined;
}

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

/**
 * Find the driver error however deeply it has been wrapped.
 *
 * Drizzle rethrows as `DrizzleQueryError`, whose own `.message` is hardcoded to the query text
 * and never the driver's — the real SQLSTATE and constraint name sit one level down on
 * `.cause`. Reading `error.code` off the top therefore sees `undefined` for every one of the
 * constraints above, and each of them then reaches the caller as an untranslated 500.
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

/** Thai for the three named constraints a validated body can still reach. */
const EXPLANATIONS: ReadonlyMap<string, NullaryMessageKey> = new Map([
  ['tax_countries_pkey', 'error.tax_country.code_taken'],
  ['tax_countries_name_says_something', 'error.tax_country.name_blank'],
  ['tax_countries_rate_matches_treatment', 'error.tax_country.rate_treatment_conflict'],
]);

/**
 * Turn a driver error into an `AppError`, or hand it back untouched.
 *
 * Rethrowing anything unrecognised is deliberate, the same choice every sibling translator
 * makes: an unknown SQLSTATE is a bug in this module, and wrapping it in a 4xx here would file
 * our bug under the caller's mistakes and lose the stack `AllExceptionsFilter` would otherwise
 * log.
 */
export function translateOrganisationError(error: unknown): unknown {
  const pg = postgresErrorOf(error);
  if (!pg) return error;

  const named = pg.constraint;
  const explained = named === undefined ? undefined : EXPLANATIONS.get(named);
  const details = named === undefined ? undefined : { constraint: named };
  const say = (fallback: NullaryMessageKey) => message(explained ?? fallback);

  switch (pg.code) {
    case UNIQUE_VIOLATION:
      return AppError.conflict(say('error.tax_country.duplicate'), details);

    case CHECK_VIOLATION:
      /*
       * ⚠️ `rate_matches_treatment` is answered as a 409, not the 422 every other CHECK here
       * gets — the one deliberate exception to the usual "CHECK violation is a 422" rule every
       * sibling translator follows. What refuses the request is not the shape of the body in
       * isolation but the row's *own already-committed* rate: zero-rating a destination
       * without clearing its rate in the same request is exactly the mistake a real admin will
       * make, and the message below is what tells them to clear it rather than file a bug.
       * Every other CHECK on this table (`name_says_something`, and the generic fallback for
       * one this file does not yet know) really is about the body alone, so those stay 422.
       */
      if (named === 'tax_countries_rate_matches_treatment') {
        return AppError.conflict(say('error.tax_country.check_failed'), details);
      }
      return AppError.validationFailed(say('error.tax_country.check_failed'), details);

    default:
      return error;
  }
}

/** `await withTranslatedOrganisationErrors(() => this.repository.transaction(...))`. */
export async function withTranslatedOrganisationErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    /*
     * An `AppError` — `patch`'s own `notFound` when the code does not exist — is already an
     * answer, and it carries a `code` (`'NOT_FOUND'`) that `postgresErrorOf` cannot distinguish
     * from a SQLSTATE by looking. It survives today only because `'NOT_FOUND'` matches neither
     * constant above, which is the same "luck rather than design" `quotes/pg-errors.ts` calls
     * out about itself — checked here rather than left to the shape of a string.
     */
    if (error instanceof AppError) throw error;
    throw translateOrganisationError(error);
  }
}
