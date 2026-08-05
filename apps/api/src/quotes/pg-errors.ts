import { AppError } from '../common/errors/app-error';

/**
 * The quote guards in `packages/db`, translated into answers a salesperson can act on.
 *
 * ── Why a third translator ───────────────────────────────────────────────────────
 *
 * `src/admin/pg-errors.ts` and `src/orders/pg-errors.ts` are the same *mechanism* — walk the
 * cause chain, read the SQLSTATE, name the constraint — with deliberately different
 * *vocabularies*, and their own notes say why sharing one would make every conflict tell the
 * wrong story. This one exists for a sharper reason than vocabulary: the orders translator
 * answers **every** `restrict_violation` with "the order's status changed, reload", and the
 * two guards that matter most here are `restrict_violation` and are nothing of the kind.
 *
 * `quote_lines_guard_write()` refuses a reprice because the line carries a live promise, and
 * the recovery is *supersede the override first* — a deliberate act with a person's name on
 * it, which is the whole of plan 7.9(ง)(2). `quote_overrides_guard_write()` refuses an UPDATE
 * because the table is append-only. Telling either of those callers to reload and try again
 * sends them round a loop that cannot terminate.
 *
 * The trigger's own `RAISE` carries no constraint name, so those two branches cannot be
 * distinguished by the driver's `constraint` field. They are distinguished by SQLSTATE plus
 * the table the statement was against, which the service knows and the error does not — hence
 * `withTranslatedQuoteErrors` takes the *operation* as a label, and the generic message stays
 * honest about being generic rather than guessing.
 */

interface PostgresErrorLike {
  readonly code: string;
  readonly constraint: string | undefined;
}

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';
/** `RAISE … USING ERRCODE = 'restrict_violation'` — every guard trigger in 0016. */
const RESTRICT_VIOLATION = '23001';
const LOCK_NOT_AVAILABLE = '55P03';
const QUERY_CANCELED = '57014';

/**
 * Find the driver error however deeply it has been wrapped.
 *
 * Drizzle rethrows as `DrizzleQueryError`, which carries no `code` and keeps the real error
 * on `.cause`. Reading `error.code` off the top sees `undefined` for every CHECK and every
 * trigger this feature rests on, and each one then reaches the caller as an untranslated 500:
 * the guard fired, the data is safe, and the client was told nothing.
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
 * Thai for the constraints somebody on the other end can do something about.
 *
 * Only *named* constraints appear here. A trigger's `RAISE` carries no name, which is why the
 * `restrict_violation` branch below is parameterised by the caller rather than by the error —
 * the alternative is matching on the trigger's English message text, which turns every
 * reword into a silently mistranslated error.
 */
const EXPLANATIONS: ReadonlyMap<string, string> = new Map([
  [
    'quote_overrides_one_active_per_line',
    'รายการนี้มีราคาที่ตกลงไว้อยู่แล้ว — ระบบกำลังแทนที่ให้ กรุณาลองใหม่อีกครั้ง',
  ],
  [
    'quote_overrides_one_active_per_document',
    'ใบเสนอราคานี้มียอดรวมที่ตกลงไว้อยู่แล้ว — ระบบกำลังแทนที่ให้ กรุณาลองใหม่อีกครั้ง',
  ],
  ['quote_lines_order_seq_key', 'มีการเพิ่มรายการพร้อมกัน — กรุณาลองใหม่อีกครั้ง'],
  [
    'quote_overrides_value_differs',
    'ราคาที่กรอกเท่ากับราคาที่ระบบคำนวณอยู่แล้ว — ถ้าต้องการยืนยันราคานี้ ให้ยกเลิกราคาที่ตกลงไว้เดิมแทน',
  ],
  ['quote_overrides_money_nonnegative', 'ราคาติดลบไม่ได้'],
  ['quote_overrides_days_nonnegative', 'ระยะเวลาส่งมอบติดลบไม่ได้'],
  ['quote_lines_charge_nonzero', 'รายการที่เป็นศูนย์บาทไม่มีความหมาย'],
  ['quote_lines_qty_positive', 'จำนวนต้องเป็นอย่างน้อย 1'],
  [
    'quote_overrides_other_needs_a_note',
    'เหตุผล "อื่นๆ" ต้องเขียนคำอธิบายกำกับด้วย',
  ],
  [
    'quote_overrides_entry_mode_fits_anchor',
    'ช่องที่กรอกไม่ตรงกับสิ่งที่กำลังแก้ไข',
  ],
]);

/** What the caller was trying to do, so a nameless trigger can still produce a useful sentence. */
export type QuoteOperation =
  | 'write_line'
  | 'reprice_line'
  | 'remove_line'
  | 'write_override'
  | 'supersede_override';

const RESTRICT_MESSAGES: Record<QuoteOperation, string> = {
  write_line: 'แก้ไขใบเสนอราคานี้ไม่ได้ในสถานะปัจจุบัน — กรุณาโหลดข้อมูลใหม่แล้วลองอีกครั้ง',
  /*
   * ⭐ Plan 7.9(ง)(2), as the sentence the salesperson reads. The database refused because the
   * line carries a live `line_total` override, and ฿17,000 for two is not ฿17,000 for three —
   * `quoteReducer.ts:68` would have dropped that promise silently. The recovery is one extra
   * deliberate act, not a retry.
   */
  reprice_line:
    'รายการนี้มีราคาที่ตกลงกับลูกค้าไว้แล้ว — ต้องยกเลิกหรือแก้ราคาที่ตกลงไว้ก่อนจึงจะเปลี่ยนจำนวนหรือรายละเอียดได้',
  remove_line:
    'รายการนี้มีราคาที่ตกลงกับลูกค้าไว้แล้ว — ต้องยกเลิกราคาที่ตกลงไว้ก่อนจึงจะลบรายการได้',
  write_override: 'แก้ไขราคาในใบเสนอราคานี้ไม่ได้ในสถานะปัจจุบัน — กรุณาโหลดข้อมูลใหม่',
  supersede_override:
    'ราคาที่ตกลงไว้รายการนี้ถูกแก้ไขไปแล้วโดยคนอื่น — กรุณาโหลดข้อมูลใหม่แล้วลองอีกครั้ง',
};

/**
 * Turn a driver error into an `AppError`, or hand it back untouched.
 *
 * Rethrowing anything unrecognised is deliberate and is the same decision the orders
 * translator makes: an unknown SQLSTATE is a bug in this module, and wrapping it in a 4xx
 * files our bug under the caller's mistakes and loses the stack on the way.
 */
export function translateQuoteError(error: unknown, operation: QuoteOperation): unknown {
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
      return AppError.validationFailed(explained ?? 'ข้อมูลไม่ผ่านเงื่อนไขของใบเสนอราคา', details);

    case RESTRICT_VIOLATION:
      /*
       * 409 rather than 422, even for the two that are really "do something else first". The
       * caller's request was well-formed; what refused it is the state of another row, and
       * 409's contract — here is the state, reconcile and try again — is the honest one. The
       * message is what carries the difference, which is why it is chosen by the operation.
       */
      return AppError.conflict(RESTRICT_MESSAGES[operation], {
        reason: 'quote_guard',
        operation,
      });

    case LOCK_NOT_AVAILABLE:
    case QUERY_CANCELED:
      return AppError.conflict('ใบเสนอราคานี้กำลังถูกแก้ไขอยู่ — กรุณาลองใหม่อีกครั้ง', {
        reason: 'locked',
      });

    default:
      return error;
  }
}

/** `await withTranslatedQuoteErrors(() => tx.insert(...), 'write_override')` — one per write path. */
export async function withTranslatedQuoteErrors<T>(
  run: () => Promise<T>,
  operation: QuoteOperation = 'write_line',
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    /*
     * An `AppError` is already an answer, and it carries a `code` — `'CONFLICT'`, `'NOT_FOUND'`
     * — which `postgresErrorOf` cannot tell from a SQLSTATE by looking. It survives today
     * because none of the codes is five digits, which is luck rather than design: the day
     * somebody adds one that is, every deliberate refusal in this feature would be rewritten
     * into a generic conflict on its way out. Checked, rather than left to the shape of a
     * string.
     */
    if (error instanceof AppError) throw error;
    throw translateQuoteError(error, operation);
  }
}
