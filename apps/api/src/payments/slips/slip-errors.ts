import { AppError } from '../../common/errors/app-error';
import { message, type NullaryMessageKey } from '../../i18n';
import { translateOrderError } from '../../orders';

/**
 * The payment guards in `packages/db`, translated into answers a client can act on.
 *
 * ── Why this is not `src/orders/pg-errors.ts` ────────────────────────────────────
 *
 * Same mechanism, different vocabulary — the argument `orders/pg-errors.ts` makes about not
 * being `admin/pg-errors.ts`, one layer further down. Its `restrict_violation` branch says
 * *"the status of the order changed while you were working; reload and try again"*, which
 * is true of a transition and is the wrong sentence for a reviewer whose allocations did
 * not foot. The two most likely triggers to fire on this module's writes —
 * `slip_allocations_foot` and `payment_slips_allocations_foot` — are **deferred**, so they
 * raise at COMMIT, several statements away from the cause and carrying no constraint name
 * at all. A caller told to reload would reload and do exactly the same thing.
 *
 * ── What reaches here, and what does not ─────────────────────────────────────────
 *
 * `planAllocations` checks the footing eagerly and refuses with the two figures and their
 * difference. So a footing trigger firing here means one of two things: a concurrent
 * transaction changed the schedule between the check and the write, or there is a bug in
 * this module. Both are conflicts from the caller's point of view, and neither should leak
 * the trigger's own English prose, which names tables and ids.
 *
 * Anything unrecognised is handed to `translateOrderError`, which hands anything *it* does
 * not recognise straight back — so an unknown SQLSTATE stays a 500 with a stack in the log
 * rather than being filed under the caller's mistakes.
 */

interface PostgresErrorLike {
  readonly code: string;
  readonly constraint: string | undefined;
}

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
/** `RAISE … USING ERRCODE = 'restrict_violation'` — every guard trigger in 0011. */
const RESTRICT_VIOLATION = '23001';

/**
 * Find the driver error however deeply it has been wrapped.
 *
 * Drizzle rethrows as `DrizzleQueryError`, which carries no `code` and keeps the real error
 * on `.cause`; reading `error.code` off the top sees `undefined` for every CHECK and every
 * trigger this module rests on, and each of them then reaches the caller as an untranslated
 * 500 — the guard fires, the money is safe, and the client is told nothing.
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
 * Thai for the named constraints somebody on the other end can do something about.
 *
 * Only *named* constraints appear here. A trigger's `RAISE` carries no constraint name,
 * which is why the `restrict_violation` branch is generic — matching on the trigger's
 * message text would turn every message reword into a silently mistranslated error.
 */
const EXPLANATIONS: ReadonlyMap<string, NullaryMessageKey> = new Map([
  ['payment_slips_reviewer_is_not_submitter', 'error.slip.reviewer_is_submitter'],
  ['payment_slips_amount_positive', 'error.slip.amount_positive'],
  ['payment_slips_currency_is_thb', 'error.slip.currency_is_thb'],
  ['payment_slips_review_shape', 'error.slip.review_shape'],
  ['payment_slips_erasure_shape', 'error.slip.erasure_shape'],
  ['payment_slips_payer_last4_shape', 'error.slip.payer_last4_shape'],
  ['slip_allocations_slip_instalment_key', 'error.slip.instalment_repeated_in_slip'],
  ['slip_allocations_amount_positive', 'error.slip.allocation_amount_positive'],
  ['ledger_postings_amount_nonzero', 'error.slip.posting_amount_nonzero'],
  /*
   * The same constraint name as `error.money.accrual_already_refunded`, and a different
   * sentence — see the note on that key. Namespacing by domain is what keeps both.
   */
  ['refunds_accrual_entry_key', 'error.slip.accrual_already_refunded'],
]);

export function translateSlipError(error: unknown): unknown {
  const pg = postgresErrorOf(error);
  if (!pg) return error;

  const named = pg.constraint;
  const explained = named === undefined ? undefined : EXPLANATIONS.get(named);
  const details = named === undefined ? undefined : { constraint: named };
  const say = (fallback: NullaryMessageKey) => message(explained ?? fallback);

  switch (pg.code) {
    case UNIQUE_VIOLATION:
      return AppError.conflict(say('error.slip.duplicate'), details);

    case CHECK_VIOLATION:
      return AppError.validationFailed(say('error.slip.check_failed'), details);

    case RESTRICT_VIOLATION:
      /*
       * A money guard fired. The two most likely are deferred and therefore report at
       * COMMIT with no name, so the message covers both honestly rather than guessing:
       * either the schedule moved under this review, or the allocations did not add up to
       * the slip. Both mean the same thing to the person holding the mouse — look again at
       * what is on the screen — and neither is a reason to retry the identical request.
       */
      return AppError.conflict(say('error.slip.guard_refused'), {
        reason: 'payment_guard_refused',
        ...(details ?? {}),
      });

    default:
      /*
       * Foreign keys, lock timeouts and the rest are the same failures with the same right
       * answers as the order lifecycle's, and it already says them in Thai. Delegating is
       * how the two stay one vocabulary rather than two that drift.
       */
      return translateOrderError(error);
  }
}

/** `await withTranslatedSlipErrors(() => tx.insert(...))` — one wrapper per write path. */
export async function withTranslatedSlipErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw translateSlipError(error);
  }
}
