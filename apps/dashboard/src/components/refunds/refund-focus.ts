import { formatBaht } from '@wewin/core/format';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ The refund screen's one primary statement: money the company has promised and not sent.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Plan 7.12 says the `approved` queue — decided and **not yet paid** — must be visible, and it
 * was: as a tab, opened first, listing the rows. What did not exist **anywhere on the screen, or
 * anywhere in this dashboard**, was the *sum* of it. A company can read a page of approved
 * refunds and not know whether it owes ฿4,000 or ฿400,000, which is the one number a person
 * responsible for the bank account came here for.
 *
 * ── ⚠️ This sentence is about the company, not about the tab ─────────────────
 *
 * `refund-queue.tsx` therefore counts the payable queue on its own request rather than summing
 * whatever the visible tab happens to hold. Deriving it from the current list would make the
 * headline read "ไม่มีเงินที่อนุมัติแล้วและยังไม่ได้จ่าย" the moment somebody clicked
 * บัญชีไม่ตรงกับที่โอนมา — a false statement produced by a filter.
 *
 * `null` is a third state and not an empty list: a count that failed says so. "A number that
 * leads nowhere says so" is the overview's rule and this is the same thing one step earlier —
 * a zero nobody computed is worse than an admission.
 *
 * Pure and in a `.ts`, because vitest here is `environment: 'node'` and a `.test.tsx` is
 * **silently never collected**.
 */

/** Just enough of a refund to total it. `refund-api.ts`'s `Refund` structurally satisfies this. */
export interface PayableRefund {
  readonly amountThbMinor: bigint;
}

export interface RefundFocus {
  /** `null` when the payable queue could not be counted — never folded into zero. */
  readonly count: number | null;
  readonly totalThbMinor: bigint | null;
  /** The `type-focal` line. A statement, not a label. */
  readonly headlineTh: string;
  readonly detailTh: string;
}

/**
 * @param payable every refund in `approved` — decided, not yet disbursed. `null` when the count
 *   failed or has not arrived.
 * @param capped `true` when the API returned a full page, so the total is a partial sum.
 */
export function refundFocus(payable: readonly PayableRefund[] | null, capped = false): RefundFocus {
  if (payable === null) {
    return {
      count: null,
      totalThbMinor: null,
      headlineTh: 'ยังไม่ทราบยอดที่อนุมัติแล้วแต่ยังไม่ได้จ่าย',
      detailTh: 'นับยอดค้างจ่ายไม่สำเร็จ — ตารางด้านล่างคือหมวดที่เลือกไว้เท่านั้น',
    };
  }

  const totalThbMinor = payable.reduce((total, refund) => total + refund.amountThbMinor, 0n);

  if (payable.length === 0) {
    return {
      count: 0,
      totalThbMinor,
      /*
       * A sentence rather than "฿0". Nothing owed is good news and reads as calm — the same
       * argument `overview-focus.ts` makes for its empty queues.
       */
      headlineTh: 'ไม่มีเงินที่อนุมัติแล้วและยังไม่ได้จ่าย',
      detailTh: 'คำขอที่อนุมัติแล้วถูกบันทึกว่าจ่ายครบทุกรายการ',
    };
  }

  return {
    count: payable.length,
    totalThbMinor,
    headlineTh: `${formatBaht(totalThbMinor)} อนุมัติแล้วแต่ยังไม่ได้จ่าย`,
    detailTh: [
      `${String(payable.length)} รายการ — เงินที่บริษัทรับปากลูกค้าไว้แล้วและยังไม่ออกจากบัญชี`,
      ...(capped ? ['นับเฉพาะรายการที่ API ส่งมา ยอดจริงอาจสูงกว่านี้'] : []),
    ].join(' · '),
  };
}
