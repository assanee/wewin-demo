import { AppError } from '../../common/errors/app-error';
import type { SchedulePlanFailure } from './plan';

/**
 * A planning failure, as an answer a person can act on.
 *
 * ── Why `refund_required` is not a validation error ──────────────────────────────
 *
 * Every other case here is "the schedule is wrong, fix it". `refund_required` is not: the
 * schedule is fine and the *order* is now worth less than the money already received, which
 * plan 7.5(ง)(4) says must enter the refund process and must never become a negative row. It
 * carries its own `reason` in the details so that the caller branches on a machine-readable
 * fact rather than on a Thai sentence, and so that the day somebody wires the refund service
 * to it, they wire it to one code and not to a substring match.
 *
 * ── Why the numbers are in `details` ─────────────────────────────────────────────
 *
 * "ตารางงวดไม่ตรงกับยอดรวม" tells a salesperson nothing. "฿9,406.38 against ฿9,406.37, over
 * by ฿0.01" tells them which row to change. Amounts go out as decimal strings of minor units,
 * the way every other amount in this API travels, because a `bigint` cannot be serialised to
 * JSON and a `number` loses satang above 2^53.
 */

const minor = (amount: bigint): string => amount.toString();

export function scheduleFailureError(failure: SchedulePlanFailure): AppError {
  switch (failure.reason) {
    case 'no_terms':
      return AppError.validationFailed('ตารางการชำระเงินต้องมีอย่างน้อยหนึ่งงวด', {
        reason: failure.reason,
      });

    case 'too_many_instalments':
      return AppError.validationFailed(
        `แบ่งงวดได้สูงสุด ${String(failure.maxCount)} งวด แต่ระบุมา ${String(failure.count)} งวด`,
        { reason: failure.reason, count: failure.count, maxCount: failure.maxCount },
      );

    case 'bad_percent':
      return AppError.validationFailed(
        'สัดส่วนของงวดต้องอยู่ระหว่าง 1 ถึง 10000 basis points',
        { reason: failure.reason, seq: failure.seq, percentBp: failure.percentBp },
      );

    case 'negative_fixed':
      return AppError.validationFailed('ยอดของงวดติดลบไม่ได้', {
        reason: failure.reason,
        seq: failure.seq,
        fixedThbMinor: minor(failure.fixedThbMinor),
      });

    case 'multiple_remainders':
      return AppError.validationFailed(
        'งวดที่รับส่วนต่างมีได้เพียงงวดเดียว',
        { reason: failure.reason, seqs: failure.seqs },
      );

    case 'remainder_not_last':
      return AppError.validationFailed(
        'งวดที่รับส่วนต่างต้องเป็นงวดสุดท้าย',
        { reason: failure.reason, seq: failure.seq, lastSeq: failure.lastSeq },
      );

    case 'seq_not_dense':
      /*
       * Not a client mistake — nothing outside this module chooses a `seq`. Reaching this
       * means the stored schedule has a hole in it, which is the exact state that makes a
       * `MAX(seq)` frontier and a `COUNT(*)` frontier disagree (plan 7.5(ค)). A 409 rather
       * than a 422 because the caller cannot fix their request to make it go away.
       */
      return AppError.conflict('ลำดับงวดของออร์เดอร์นี้ไม่ต่อเนื่อง — ต้องแก้ข้อมูลก่อน', {
        reason: failure.reason,
        seqs: failure.seqs,
      });

    case 'does_not_foot':
      return AppError.validationFailed(
        'ผลรวมของงวดไม่เท่ากับยอดรวมของออร์เดอร์ — งวดสุดท้ายต้องเป็นส่วนต่าง',
        {
          reason: failure.reason,
          scheduledThbMinor: minor(failure.scheduledMinor),
          totalThbMinor: minor(failure.totalMinor),
          deltaThbMinor: minor(failure.deltaMinor),
        },
      );

    case 'exceeds_total':
      return AppError.validationFailed('ยอดรวมของงวดที่ระบุเกินยอดรวมของออร์เดอร์', {
        reason: failure.reason,
        scheduledThbMinor: minor(failure.scheduledMinor),
        totalThbMinor: minor(failure.totalMinor),
      });

    case 'refund_required':
      return AppError.conflict(
        'ยอดใหม่ต่ำกว่าเงินที่รับมาแล้ว — ต้องเข้ากระบวนการคืนเงิน ไม่ใช่ตั้งงวดติดลบ',
        {
          reason: failure.reason,
          receivedThbMinor: minor(failure.receivedMinor),
          totalThbMinor: minor(failure.totalMinor),
          overpaidThbMinor: minor(failure.overpaidMinor),
        },
      );

    case 'locked_exceeds_total':
      return AppError.conflict(
        'งวดที่ชำระแล้วรวมกันเกินยอดใหม่ของออร์เดอร์ — ต้องจัดตารางงวดใหม่',
        {
          reason: failure.reason,
          committedThbMinor: minor(failure.committedMinor),
          totalThbMinor: minor(failure.totalMinor),
          receivedThbMinor: minor(failure.receivedMinor),
        },
      );

    default:
      return AppError.conflict(
        'งวดสุดท้ายจะต่ำกว่าเงินที่ชำระเข้ามาแล้วในงวดนั้น — ต้องย้ายเงินหรือคืนเงินก่อน',
        {
          reason: failure.reason,
          seq: failure.seq,
          dueThbMinor: minor(failure.dueMinor),
          allocatedThbMinor: minor(failure.allocatedMinor),
        },
      );
  }
}

/**
 * There is already a schedule, and `open` is for orders that have none.
 *
 * A conflict rather than a validation failure: nothing about the request is malformed, the
 * world is not in the state the caller believed. Reaching it twice on one order is the shape
 * of a submit that ran twice, which is worth seeing rather than absorbing.
 */
export const scheduleExistsError = (seqs: readonly number[]): AppError =>
  AppError.conflict('ออร์เดอร์นี้มีตารางการชำระเงินอยู่แล้ว', {
    reason: 'schedule_exists',
    seqs: [...seqs],
  });

/**
 * Money has been allocated, so the schedule may be recomputed but not replaced.
 *
 * The distinction is plan 7.5(ง) in one sentence: a paid instalment is *locked*, and
 * replacing the schedule would delete the row the allocation points at. The database refuses
 * that with `restrict_violation`; this says which instalment and how much, so the caller can
 * route to the recompute instead of retrying.
 */
export const scheduleHasMoneyError = (
  paid: readonly { readonly seq: number; readonly allocatedThbMinor: bigint }[],
): AppError =>
  AppError.conflict('ตารางงวดนี้มีเงินชำระเข้ามาแล้ว — ต้องคำนวณใหม่ ไม่ใช่เขียนทับ', {
    reason: 'schedule_has_money',
    instalments: paid.map((row) => ({ seq: row.seq, allocatedThbMinor: minor(row.allocatedThbMinor) })),
  });

/** The order is past the point where its schedule may be rewritten. */
export const notEditableError = (status: string, editable: readonly string[]): AppError =>
  AppError.conflict('สถานะของออร์เดอร์นี้ไม่อนุญาตให้แก้ไขตารางการชำระเงิน', {
    reason: 'order_not_editable',
    status,
    editableStatuses: [...editable],
  });
