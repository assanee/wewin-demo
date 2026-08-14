import { formatBaht } from '@wewin/core/format';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ The slip queue's one primary statement: how much is waiting, and for how much money.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The screen had **no heading of any kind** — the table was the whole page, wrapped in a `Card`
 * that drew a second edge around a grid that already has edges. So the question somebody opens
 * this screen to answer (*is there a pile, and is it a big one?*) had to be answered by counting
 * rows, and the sum of the amounts existed nowhere at all.
 *
 * Lives in a `.ts` with no React in it because `apps/dashboard`'s vitest is `environment: 'node'`
 * and a `.test.tsx` is **silently never collected** — logic in a `.tsx` here is logic nobody can
 * prove.
 *
 * ── ⚠️ THE SENTENCE MAY NOT CALL THIS MONEY ──────────────────────────────────
 *
 * `slip-queue.tsx`'s own header: *a submitted slip is a photograph, not money.*
 * `order_settled_thb_minor()` counts **accepted** slips only, so nothing in this total has moved
 * a balance and nothing here appears in the overview's รับชำระเดือนนี้ figure. A headline reading
 * "฿52,000 เข้ามาแล้ว" would be a different and false claim, and the two screens would disagree
 * by exactly the size of this queue. Hence `claimedThbMinor` rather than `receivedThbMinor`, and
 * hence the detail line, which is not decoration: it is the qualifier that makes the number true.
 *
 * ⚠️ **`bigint` throughout, and it is load-bearing rather than tidy.** These are satang and a
 * queue of two hundred slips sums past `Number.MAX_SAFE_INTEGER` sooner than the baht figure
 * suggests. `slip-focus.test.ts` pins a total that a `number` accumulator gets wrong.
 */

/** Just enough of a queued slip to summarise it. `slip-api.ts`'s `Slip` structurally satisfies this. */
export interface CountedSlip {
  readonly amountThbMinor: bigint;
  /** Without one there is nothing for a reviewer to read the payer off — see `hasImage` in `slip-api.ts`. */
  readonly hasImage: boolean;
}

export interface SlipQueueFocus {
  readonly waiting: number;
  /** What customers *say* they transferred. Never call it received — see the header. */
  readonly claimedThbMinor: bigint;
  readonly withoutImage: number;
  /** The `type-focal` line. A statement, not a label. */
  readonly headlineTh: string;
  /** The caption under it. Always present here: the headline is not true without it. */
  readonly detailTh: string;
}

/**
 * @param capped `true` when the API returned a full page and there may be more behind it.
 *   ⚠️ Not cosmetic. `GET /payments/slips` caps at `limit` and the overview's count does not, so
 *   a headline of "200 สลิปรอตรวจ" on a queue of three hundred makes the two screens disagree
 *   with nothing on either of them saying which is wrong. The count becomes a floor and says so.
 */
export function slipQueueFocus(slips: readonly CountedSlip[], capped = false): SlipQueueFocus {
  const claimedThbMinor = slips.reduce((total, slip) => total + slip.amountThbMinor, 0n);
  const withoutImage = slips.filter((slip) => !slip.hasImage).length;

  if (slips.length === 0) {
    return {
      waiting: 0,
      claimedThbMinor,
      withoutImage,
      /*
       * A sentence, not "0 สลิป". An empty queue is good news and has to read as calm — the same
       * argument `overview-focus.ts` makes about ไม่มีงานค้าง, and the reason zero gets its own
       * wording rather than a number a reader still has to parse before they can relax.
       */
      headlineTh: 'ไม่มีสลิปรอตรวจ',
      detailTh: 'สลิปที่ลูกค้าส่งเข้ามาถูกตัดสินครบแล้ว',
    };
  }

  const counted = `${capped ? 'อย่างน้อย ' : ''}${String(slips.length)} สลิปรอตรวจ`;

  return {
    waiting: slips.length,
    claimedThbMinor,
    withoutImage,
    headlineTh: `${counted} รวม ${formatBaht(claimedThbMinor)}`,
    detailTh: [
      'ยอดที่ลูกค้าแจ้ง ยังไม่ตัดเข้างวดจนกว่าจะมีคนรับสลิป',
      /*
       * ⚠️ A slip with no image is a claim with no evidence — the reviewer has nothing to read
       * the payer's name off, and `slip-review-dialog.tsx` treats an unattested payer as `no` on
       * the refund path. Worth stating up front rather than found one row at a time.
       */
      ...(withoutImage === 0 ? [] : [`ไม่มีภาพแนบ ${String(withoutImage)} รายการ`]),
      ...(capped ? ['นับเฉพาะรายการที่ API ส่งมา — ตัวเลขบนภาพรวมคือยอดจริงทั้งหมด'] : []),
    ].join(' · '),
  };
}
