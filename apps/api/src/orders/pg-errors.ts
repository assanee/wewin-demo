import { AppError } from '../common/errors/app-error';
import { message, type NullaryMessageKey } from '../i18n';

/**
 * The order guards in `packages/db`, translated into answers a client can act on.
 *
 * ── Why this is not `src/admin/pg-errors.ts` ─────────────────────────────────────
 *
 * The admin translator is the same *mechanism* — walk the cause chain, read the SQLSTATE,
 * name the constraint — and a deliberately different *vocabulary*. Its `restrict_violation`
 * branch answers "this version is published and cannot be edited; open a new draft", which is
 * true of the catalogue and is nonsense about an order. Sharing it would have made every
 * order conflict tell a customer about catalogue versions. The chain-walking is duplicated,
 * eighteen lines of it, and that is the cheaper of the two mistakes.
 *
 * ── What reaches here, and what does not ─────────────────────────────────────────
 *
 * The service loads the order under `SELECT … FOR UPDATE` and refuses an illegal move itself,
 * with the from-status and the to-status in the message. So a trigger firing means one of
 * two things: a concurrent transaction won a race this one lost — which is a real 409 and the
 * correct answer is "reload and look again" — or there is a bug in this module. Both are
 * conflicts from the caller's point of view, and neither should leak the trigger's own
 * English prose, which names tables and ids.
 */

interface PostgresErrorLike {
  readonly code: string;
  readonly constraint: string | undefined;
}

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';
/** `RAISE … USING ERRCODE = 'restrict_violation'` — every guard trigger in 0007. */
const RESTRICT_VIOLATION = '23001';
/** A lock wait that hit `statement_timeout`, which under load is the ordinary outcome. */
const LOCK_NOT_AVAILABLE = '55P03';
const QUERY_CANCELED = '57014';

/**
 * The catalogue moved while a customer was configuring.
 *
 * A key rather than the constant it used to be, and the two audiences stay two keys: this
 * one is said in the configurator, `error.stale.catalog_while_editing_quote` to a
 * salesperson. They were two constants before and collapsing them now would be a behaviour
 * change wearing a refactor's clothes.
 */
export const CATALOG_STALE_MESSAGE = message('error.stale.catalog_while_configuring');

/**
 * Find the driver error however deeply it has been wrapped.
 *
 * Drizzle rethrows as `DrizzleQueryError`, which carries no `code` and keeps the real error
 * on `.cause`; reading `error.code` off the top sees `undefined` for every CHECK, UNIQUE and
 * trigger the order lifecycle rests on, and each of them then reaches the caller as an
 * untranslated 500 — the guard fires, the data is safe, and the client is told nothing.
 */
export function postgresErrorOf(error: unknown): PostgresErrorLike | undefined {
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
 * Thai for the constraints a person on the other end can do something about.
 *
 * Only named constraints appear here — a trigger's `RAISE` carries no constraint name, which
 * is why the `restrict_violation` branch below is generic. That is a limitation of the
 * mechanism and not an oversight: the alternative is matching on the trigger's message text,
 * which turns every message reword into a silently mistranslated error.
 */
const EXPLANATIONS: ReadonlyMap<string, NullaryMessageKey> = new Map([
  ['order_change_requests_one_open', 'error.order.change_request_already_open'],
  ['orders_supersedes_order_key', 'error.order.already_superseded'],
  ['order_events_order_seq_key', 'error.order.concurrent_event'],
  ['orders_order_no_unique', 'error.order.order_no_taken'],
  ['orders_has_an_owner', 'error.order.needs_an_owner'],
  ['orders_submitted_has_a_contact_channel', 'error.order.needs_a_contact_channel'],
  ['orders_contact_email_shape', 'error.order.contact_email_shape'],
  ['orders_total_foots', 'error.order.total_does_not_foot'],
  ['orders_scheduled_deposit_within_total', 'error.order.deposit_exceeds_total'],
  ['order_documents_order_revision_key', 'error.order.concurrent_document'],
  ['orders_awaiting_payment_is_pre_freeze', 'error.order.cannot_return_to_awaiting_payment'],
]);

/**
 * Turn a driver error into an `AppError`, or hand it back untouched.
 *
 * Rethrowing anything unrecognised is deliberate: an unknown SQLSTATE is a bug in this
 * module, and `AllExceptionsFilter` logs it with a stack while telling the client only the
 * request id. Wrapping it in a 4xx here would file our bug under the caller's mistakes and
 * lose the stack on the way.
 */
export function translateOrderError(error: unknown): unknown {
  const pg = postgresErrorOf(error);
  if (!pg) return error;

  const named = pg.constraint;
  const explained = named === undefined ? undefined : EXPLANATIONS.get(named);
  const details = named === undefined ? undefined : { constraint: named };
  const say = (fallback: NullaryMessageKey) => message(explained ?? fallback);

  switch (pg.code) {
    case UNIQUE_VIOLATION:
      return AppError.conflict(say('error.order.duplicate'), details);

    case FOREIGN_KEY_VIOLATION:
      return AppError.validationFailed(say('error.order.missing_reference'), details);

    case CHECK_VIOLATION:
      return AppError.validationFailed(say('error.order.check_failed'), details);

    case RESTRICT_VIOLATION:
      /*
       * A guard trigger fired. Every path in this module loads the order and takes the row
       * lock before deciding, so reaching this means the state changed underneath us — a
       * second member of staff pressing the same button, a customer cancelling while
       * production was being confirmed. "Reload and look again" is both the honest message
       * and the correct action, and it is a 409 for the same reason a stale catalogue is.
       */
      return AppError.conflict(message('error.order.state_changed'), {
        reason: 'order_state_changed',
      });

    case LOCK_NOT_AVAILABLE:
    case QUERY_CANCELED:
      /*
       * 409 rather than 503: the row lock is held by another request against *this order*,
       * so the caller is contending with a colleague and not with an outage. Retrying the
       * same request is the right thing to do, which is what a 409 tells a client and a 503
       * does not.
       */
      return AppError.conflict(message('error.order.locked'), { reason: 'locked' });

    default:
      return error;
  }
}

/** `await withTranslatedOrderErrors(() => tx.insert(...))` — one wrapper per write path. */
export async function withTranslatedOrderErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw translateOrderError(error);
  }
}
