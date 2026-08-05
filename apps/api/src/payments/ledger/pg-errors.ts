import { AppError } from '../../common/errors/app-error';

/**
 * The money guards in `packages/db`, translated into answers a client can act on.
 *
 * ── Why a third translator ───────────────────────────────────────────────────────
 *
 * `src/admin/pg-errors.ts` and `src/orders/pg-errors.ts` are the same *mechanism* — walk the
 * cause chain, read the SQLSTATE, name the constraint — with deliberately different
 * *vocabularies*, and the orders one records why: its `restrict_violation` branch says "the
 * order moved underneath you, reload", which is true of a transition and is nonsense about a
 * refund that was frozen when it was approved. Sharing it would tell somebody looking at a
 * ฿12,902 payable to reload the order.
 *
 * So this file is the money vocabulary, shared by the two modules of this round that write
 * money — the ledger and refunds — and by nothing else. The chain walk is duplicated a third
 * time, twenty lines of it, and that remains the cheaper of the two mistakes.
 *
 * ── What reaching here means ─────────────────────────────────────────────────────
 *
 * Every write path in these two modules takes the order's row lock and checks the rule itself
 * first, with a sentence naming the amounts. A guard firing therefore means one of two
 * things: a concurrent transaction won a race this one lost (a real 409 — "look again"), or
 * there is a bug in this module. Both are conflicts to the caller, and neither should leak
 * the trigger's own English prose, which names tables, ids and amounts belonging to a row the
 * caller may not be entitled to see.
 */

interface PostgresErrorLike {
  readonly code: string;
  readonly constraint: string | undefined;
}

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';
/** `RAISE … USING ERRCODE = 'restrict_violation'` — every guard trigger in 0011. */
const RESTRICT_VIOLATION = '23001';
const LOCK_NOT_AVAILABLE = '55P03';
const QUERY_CANCELED = '57014';

/**
 * Find the driver error however deeply it has been wrapped.
 *
 * Drizzle rethrows as `DrizzleQueryError`, which carries no `code` and keeps the real error on
 * `.cause`. Reading `error.code` off the top sees `undefined` for every CHECK, UNIQUE and
 * trigger this phase rests on, and each of them then reaches the caller as an untranslated
 * 500: the guard fires, the money is safe, and the client is told the server broke.
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
 * Thai for the named constraints somebody on the other end can act on.
 *
 * Only *named* constraints appear here. A trigger's `RAISE` carries no constraint name, which
 * is why the `restrict_violation` branch is generic — a limitation of the mechanism and not an
 * oversight, because the alternative is matching on message text and turning every reword into
 * a silently mistranslated error.
 */
const EXPLANATIONS: ReadonlyMap<string, string> = new Map([
  [
    'refunds_accrual_entry_key',
    'ยอดค้างจ่ายก้อนนี้มีคำขอคืนเงินอยู่แล้ว — เงินก้อนเดียวคืนได้ครั้งเดียว',
  ],
  [
    'refunds_approver_is_not_requester',
    'ผู้อนุมัติต้องไม่ใช่ผู้ยื่นคำขอคืนเงิน',
  ],
  [
    'refunds_disburser_is_not_approver',
    'ผู้กดโอนเงินคืนต้องไม่ใช่ผู้อนุมัติ',
  ],
  ['refunds_amount_positive', 'ยอดคืนเงินต้องมากกว่าศูนย์'],
  ['refunds_currency_is_thb', 'ระบบคืนเงินเป็นเงินบาทเท่านั้น'],
  ['refunds_status_shape', 'สถานะของคำขอคืนเงินกับข้อมูลผู้อนุมัติ/ผู้โอนไม่สอดคล้องกัน'],
  ['refunds_payee_last4_shape', 'เลขบัญชีสี่หลักท้ายต้องเป็นตัวเลขสี่หลัก'],
  ['ledger_postings_amount_nonzero', 'รายการบัญชีที่เป็นศูนย์ไม่มีความหมาย'],
  ['ledger_entries_slip_required', 'รายการบัญชีประเภทนี้ต้องอ้างอิงสลิป'],
  ['ledger_entries_variance_shape', 'รายการส่วนต่างต้องระบุประเภทของส่วนต่าง'],
]);

/**
 * Turn a driver error into an `AppError`, or hand it back untouched.
 *
 * Rethrowing anything unrecognised is deliberate: an unknown SQLSTATE is a bug in this module,
 * and `AllExceptionsFilter` logs it with a stack while telling the client only the request id.
 * Wrapping it in a 4xx here would file our bug under the caller's mistakes and lose the stack.
 */
export function translatePaymentError(error: unknown): unknown {
  const pg = postgresErrorOf(error);
  if (!pg) return error;

  const named = pg.constraint;
  const explained = named === undefined ? undefined : EXPLANATIONS.get(named);
  const details = named === undefined ? undefined : { constraint: named };

  switch (pg.code) {
    case UNIQUE_VIOLATION:
      return AppError.conflict(explained ?? 'รายการนี้ซ้ำกับที่มีอยู่แล้ว', details);

    case FOREIGN_KEY_VIOLATION:
      return AppError.validationFailed(explained ?? 'อ้างถึงข้อมูลที่ไม่มีอยู่', details);

    case CHECK_VIOLATION:
      return AppError.validationFailed(explained ?? 'ข้อมูลไม่ผ่านเงื่อนไขของระบบการเงิน', details);

    case RESTRICT_VIOLATION:
      /*
       * A money guard fired. Every path here locks the order first, so this is a race lost to
       * a colleague — a second reviewer pressing approve, a refund disbursed while this
       * request was reading it — or a bug. "Reload and look again" is the honest message and
       * the correct action, and it must not say which, because the difference is not
       * something the caller can act on differently.
       */
      return AppError.conflict(
        'สถานะทางการเงินของรายการนี้เปลี่ยนไปแล้วระหว่างที่ทำรายการ — กรุณาโหลดข้อมูลใหม่แล้วตรวจสอบอีกครั้ง',
        { reason: 'payment_state_changed' },
      );

    case LOCK_NOT_AVAILABLE:
    case QUERY_CANCELED:
      return AppError.conflict('รายการนี้กำลังถูกดำเนินการอยู่ — กรุณาลองใหม่อีกครั้ง', {
        reason: 'locked',
      });

    default:
      return error;
  }
}

/** `await withTranslatedPaymentErrors(() => tx.insert(...))` — one wrapper per write path. */
export async function withTranslatedPaymentErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw translatePaymentError(error);
  }
}
