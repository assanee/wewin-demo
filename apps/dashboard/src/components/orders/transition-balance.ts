import { outstandingDisplay, readOutstanding, type OwedFigures } from './order-outstanding';
import type { OrderStatus } from './order-language';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ SAY WHAT IS STILL OWED, AT THE MOMENT THE JOB IS CLOSED. DO NOT BLOCK IT.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The owner reported the loss end of this: *"ถ้าส่งมอบไปก่อนเก็บครบ จะเก็บผ่านระบบไม่ได้อีก"* — hand
 * the job over before the balance is collected and the money could never be taken through the
 * software again. `0046_slips_after_delivery.sql` fixed the trap; it does not fix the moment
 * the trap was sprung in, which is a member of staff pressing "ส่งมอบแล้ว" without the figure
 * in front of them.
 *
 * ── ⚠️ WHY THIS IS A NOTICE AND NOT A GATE ──────────────────────────────────
 *
 * The owner's first proposal was to block the close until the order is paid. Asked when their
 * business actually collects the balance, they answered **"แล้วแต่งาน ไม่ตายตัว"** — it varies by
 * job. A blanket gate would then refuse the close on every job of the kind they collect on the
 * day for, and a rule staff have to work around every week is a rule that teaches them to work
 * around rules. The model *does* support a per-order gate
 * (`order_instalments.gates_entry_to`), which is the shape this belongs in if it ever becomes
 * a rule at all — and authoring a schedule per order is an unbuilt seam.
 *
 * So the person who knows the job decides, and this module's only job is to make sure they are
 * deciding with the number visible. **Nothing here can refuse a transition.**
 *
 * ── ⚠️ WHICH TWO TRANSITIONS, AND WHY NOT ALL OF THEM ───────────────────────
 *
 * `awaiting_installation` and `delivered`. These are the last two moments at which the company
 * still has something the customer wants: after `delivered` there is no transition out at all,
 * and `awaiting_installation` is the point where the van is loaded and the balance is
 * conventionally collected on site. Every earlier transition is a step the customer is waiting
 * on and a balance there is not news — a notice on all of them is a notice staff stop reading,
 * which would cost the two that matter their attention.
 *
 * ── ⛔ NO MONEY IS COMPUTED HERE ────────────────────────────────────────────
 *
 * `readOutstanding` and `outstandingDisplay` (`order-outstanding.ts`) decide the reading and
 * the formatting, from `outstandingThbMinor` — `order_outstanding_thb_minor()`'s answer,
 * carried as a column on the read that fetched the order. This file compares nothing, adds
 * nothing and formats nothing; it chooses a sentence to put a figure into. The figure is
 * literally `outstandingDisplay(...).textTh`, which is the same string the ค้างชำระ row of the
 * order card is printing three centimetres away, so the dialog cannot name a different number
 * from the screen behind it.
 *
 * ── ⚠️ Why a plain `.ts` and not a branch inside the dialog ──────────────────
 *
 * `apps/dashboard`'s vitest is `environment: 'node'` and a `.test.tsx` is **silently never
 * collected**, so a decision left in `order-detail.tsx` is a decision no test in this repo can
 * reach. Same reason `order-focus.ts`, `order-timeline.ts` and `order-outstanding.ts` exist.
 */

/**
 * The two transitions at which an unpaid balance is worth saying out loud.
 *
 * Exported so the test can enumerate the whole status set against it rather than restate the
 * pair — a tenth status arriving unclassified should be visible, not silently quiet.
 */
export const BALANCE_ANNOUNCED_ON: readonly OrderStatus[] = ['awaiting_installation', 'delivered'];

export interface BalanceNotice {
  /**
   * The sentence with the amount in it. `ค้างชำระ` is the word the ค้างชำระ column and the order
   * card already use for this figure; nothing new is coined here.
   */
  readonly headlineTh: string;
  /**
   * Why it is being said, and — since 0046 — that saying it costs nothing. Staff must not read
   * the headline as a refusal, because the owner's answer to "when do you collect" was that it
   * depends on the job.
   */
  readonly noteTh: string;
}

/**
 * What to add to the transition confirmation, or `null` when there is nothing to add.
 *
 * `null` for every transition that is not one of the two, and for every order that is settled,
 * that has no figure at all (a cancelled or superseded order, or a cart), or that the API sent
 * no folds for. All four are the same decision — **say nothing** — and none of them is an
 * error: a dialog that announced "฿0.00 ค้างชำระ" on a fully paid job is the notice staff learn
 * to dismiss without reading, which is how the one that matters gets dismissed too.
 */
export function balanceNoticeFor(
  toStatus: OrderStatus,
  order: OwedFigures,
): BalanceNotice | null {
  if (!BALANCE_ANNOUNCED_ON.includes(toStatus)) return null;

  const reading = readOutstanding(order);
  if (reading.kind !== 'owing') return null;

  return {
    headlineTh: `ออเดอร์นี้ยังค้างชำระ ${outstandingDisplay(reading).textTh}`,
    /*
     * ⚠️ Two clauses, and the second is the one 0046 earned. Before it, closing the job with a
     * balance meant the money could never be taken through the software — so a truthful note
     * would have had to say "collect it now or telephone about it forever". It can now say the
     * ordinary thing, which is why this is information rather than a gate.
     */
    noteTh: 'เดินสถานะต่อได้ตามปกติ — ลูกค้ายังแจ้งชำระยอดคงค้างผ่านระบบได้หลังส่งมอบ',
  };
}
