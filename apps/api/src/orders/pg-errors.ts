import { AppError } from '../common/errors/app-error';

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

export const CATALOG_STALE_MESSAGE_TH =
  'แคตตาล็อกมีการเผยแพร่เวอร์ชันใหม่ระหว่างที่คุณกำลังเลือก — กรุณาตรวจสอบราคาปัจจุบันอีกครั้ง';

/**
 * Find the driver error however deeply it has been wrapped.
 *
 * Drizzle rethrows as `DrizzleQueryError`, which carries no `code` and keeps the real error
 * on `.cause`; reading `error.code` off the top sees `undefined` for every CHECK, UNIQUE and
 * trigger the order lifecycle rests on, and each of them then reaches the caller as an
 * untranslated 500 — the guard fires, the data is safe, and the client is told nothing.
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
 * Thai for the constraints a person on the other end can do something about.
 *
 * Only named constraints appear here — a trigger's `RAISE` carries no constraint name, which
 * is why the `restrict_violation` branch below is generic. That is a limitation of the
 * mechanism and not an oversight: the alternative is matching on the trigger's message text,
 * which turns every message reword into a silently mistranslated error.
 */
const EXPLANATIONS: ReadonlyMap<string, string> = new Map([
  [
    'order_change_requests_one_open',
    'มีคำขอแก้ไขที่ยังไม่ได้ตอบอยู่แล้ว — ต้องปิดคำขอเดิมก่อนจึงจะเปิดใหม่ได้',
  ],
  ['orders_supersedes_order_key', 'ออร์เดอร์นี้ถูกออกใบใหม่แทนไปแล้ว'],
  ['order_events_order_seq_key', 'มีการเปลี่ยนแปลงออร์เดอร์นี้พร้อมกัน — กรุณาลองใหม่อีกครั้ง'],
  ['orders_order_no_unique', 'เลขที่ออร์เดอร์นี้ถูกใช้ไปแล้ว'],
  ['orders_has_an_owner', 'ออร์เดอร์ต้องมีเจ้าของเสมอ'],
  ['orders_submitted_has_a_contact_channel', 'ต้องมีอีเมลสำหรับติดต่อก่อนจึงจะส่งใบเสนอราคาได้'],
  ['orders_contact_email_shape', 'รูปแบบอีเมลไม่ถูกต้อง'],
  ['orders_total_foots', 'ยอดรวมไม่ตรงกับผลบวกของยอดก่อนภาษีและภาษี'],
  ['orders_scheduled_deposit_within_total', 'ยอดมัดจำต้องไม่เกินยอดรวมของสัญญา'],
  ['order_documents_order_revision_key', 'มีการแก้ไขใบเสนอราคาพร้อมกัน — กรุณาโหลดใหม่'],
  [
    'orders_awaiting_payment_is_pre_freeze',
    'ออร์เดอร์ที่เข้าสู่การผลิตแล้วกลับไปสถานะรอชำระเงินไม่ได้',
  ],
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

  switch (pg.code) {
    case UNIQUE_VIOLATION:
      return AppError.conflict(explained ?? 'ข้อมูลนี้ซ้ำกับที่มีอยู่แล้ว', details);

    case FOREIGN_KEY_VIOLATION:
      return AppError.validationFailed(explained ?? 'อ้างถึงข้อมูลที่ไม่มีอยู่', details);

    case CHECK_VIOLATION:
      return AppError.validationFailed(explained ?? 'ข้อมูลไม่ผ่านเงื่อนไขของออร์เดอร์', details);

    case RESTRICT_VIOLATION:
      /*
       * A guard trigger fired. Every path in this module loads the order and takes the row
       * lock before deciding, so reaching this means the state changed underneath us — a
       * second member of staff pressing the same button, a customer cancelling while
       * production was being confirmed. "Reload and look again" is both the honest message
       * and the correct action, and it is a 409 for the same reason a stale catalogue is.
       */
      return AppError.conflict(
        'สถานะของออร์เดอร์เปลี่ยนไปแล้วระหว่างที่ทำรายการ — กรุณาโหลดข้อมูลใหม่แล้วลองอีกครั้ง',
        { reason: 'order_state_changed' },
      );

    case LOCK_NOT_AVAILABLE:
    case QUERY_CANCELED:
      /*
       * 409 rather than 503: the row lock is held by another request against *this order*,
       * so the caller is contending with a colleague and not with an outage. Retrying the
       * same request is the right thing to do, which is what a 409 tells a client and a 503
       * does not.
       */
      return AppError.conflict('ออร์เดอร์นี้กำลังถูกแก้ไขอยู่ — กรุณาลองใหม่อีกครั้ง', {
        reason: 'locked',
      });

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
