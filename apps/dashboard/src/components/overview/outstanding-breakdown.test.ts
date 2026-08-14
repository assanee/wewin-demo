import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  OUTSTANDING_ORDERS_CAP,
  outstandingBreakdown,
  type OwingOrder,
} from './outstanding-breakdown';

/**
 * ⚠️ Whole strings with `toBe`. `'แสดง 8 ออเดอร์ที่ค้างมากที่สุด'` is a substring of
 * `'แสดง 18 ออเดอร์ที่ค้างมากที่สุด'`, so `toContain` on the note would pass for the wrong count
 * — the repository's own house rule, and live here.
 */

const owing = (orderNo: string, minor: bigint): OwingOrder => ({
  id: `id-${orderNo}`,
  orderNo,
  status: 'awaiting_payment',
  outstandingThbMinor: minor,
});

/** `n` owing orders of ฿10,000 each — enough to exercise a count, and never the point. */
const owingRows = (n: number): readonly OwingOrder[] =>
  Array.from({ length: n }, (_, index) => owing(`SO-${String(1000 + index)}`, 1_000_000n));

describe('outstandingBreakdown', () => {
  it('says nothing is owed when the total is zero and no order is listed', () => {
    const breakdown = outstandingBreakdown(0n, []);

    expect(breakdown.shown).toEqual([]);
    expect(breakdown.coversAll).toBe(true);
    expect(breakdown.noteTh).toBe('ไม่มีออเดอร์ที่ค้างชำระ');
  });

  it('refuses to claim nothing is owed when the total says otherwise', () => {
    /*
     * `outstandingOrders` is a newer key than `outstanding`: an older API paired with this
     * bundle sends the figure and no rows. "ไม่มีออเดอร์ที่ค้างชำระ" under ฿120,000 is the card
     * contradicting itself on one line.
     */
    const breakdown = outstandingBreakdown(12_000_000n, []);

    expect(breakdown.coversAll).toBe(false);
    expect(breakdown.noteTh).toBe('ยอดข้างบนยังไม่มีรายการแยกรายออเดอร์');
  });

  it('says the total is the whole story when the query came back short of its cap', () => {
    const breakdown = outstandingBreakdown(1_500_000n, [
      owing('SO-0002', 1_000_000n),
      owing('SO-0007', 500_000n),
    ]);

    expect(breakdown.coversAll).toBe(true);
    expect(breakdown.noteTh).toBe('ยอดค้างชำระทั้งหมดมาจาก 2 ออเดอร์นี้');
  });

  it('says the list is capped when the query returned a full page', () => {
    /*
     * ⭐ The case the sentence exists for, and note what makes it that case: the page is
     * **full**, so there may be a ninth debt nobody on this screen can see. The totals are
     * deliberately made to agree here — under the old sum-based test this exact input read as
     * complete, which is the more dangerous of the two failures.
     */
    const orders = owingRows(OUTSTANDING_ORDERS_CAP);
    const breakdown = outstandingBreakdown(BigInt(OUTSTANDING_ORDERS_CAP) * 1_000_000n, orders);

    expect(breakdown.coversAll).toBe(false);
    expect(breakdown.noteTh).toBe('แสดง 8 ออเดอร์ที่ค้างมากที่สุด — ยอดข้างบนนับทุกออเดอร์ที่ค้าง');
  });

  it('counts the rows it was given rather than asserting the API cap', () => {
    /*
     * A server whose cap has been raised past this bundle's mirror returns more rows than the
     * constant here. That still reads as "top N" — the conservative direction — and the N is
     * the rows', so nine rows are never described as eight.
     */
    const orders = owingRows(OUTSTANDING_ORDERS_CAP + 1);

    expect(outstandingBreakdown(20_000_000n, orders).noteTh).toBe(
      'แสดง 9 ออเดอร์ที่ค้างมากที่สุด — ยอดข้างบนนับทุกออเดอร์ที่ค้าง',
    );
  });

  it('hands the rows back in the API order and does not re-sort them', () => {
    /*
     * The ordering is the query's — amount descending, oldest submission breaking a tie — and
     * a second implementation of it here is a second thing to keep in step. Two equal debts
     * are the case that catches a stray `sort`: the API has already put the older one first
     * and nothing on the row says which that is.
     */
    const first = owing('SO-0100', 1_000_000n);
    const second = owing('SO-0200', 1_000_000n);
    const third = owing('SO-0300', 4_000_000n);
    const given = [first, second, third];

    expect(outstandingBreakdown(6_000_000n, given).shown).toEqual([first, second, third]);
    /* And the input is left alone — an in-place sort would reorder what the screen renders. */
    expect(given).toEqual([first, second, third]);
  });

  /* ---------------------------------------------------------------- *
   * ⭐ The defect: two sums taken over different predicates
   * ---------------------------------------------------------------- */

  it('does not claim truncation when one live order has been overpaid', () => {
    /*
     * ⭐ THE ASSERTION THIS FIX TURNS ON.
     *
     * `outstanding` sums `order_outstanding_thb_minor()` over **every live order**; the rows
     * are the live orders where that fold is `> 0`. The fold is `grand_total − settled`
     * (`0011_payment_guards.sql`), so an order that was overpaid by ฿5 folds to −500 satang and
     * pulls the total below the sum of the rows — while being correctly absent from a call
     * list, because an order that owes nothing is not a debt to phone anybody about.
     *
     * Two orders here: one owing ฿10,000, one overpaid by ฿5. The rows sum to 1,000,000 and
     * the total is 999,500. Nothing was truncated, and the old test — `summed === total` —
     * printed "แสดง 1 ออเดอร์ที่ค้างมากที่สุด — ยอดข้างบนนับทุกออเดอร์ที่ค้าง" over a list
     * containing every order there was to show.
     */
    const breakdown = outstandingBreakdown(999_500n, [owing('SO-0042', 1_000_000n)]);

    expect(breakdown.coversAll).toBe(true);
    expect(breakdown.noteTh).toBe('ยอดค้างชำระทั้งหมดมาจาก 1 ออเดอร์นี้');
  });

  it('does not claim a missing breakdown when every live order has been overpaid', () => {
    /*
     * The same fold, all the way negative: no order owes anything, so the query returns no
     * rows and the aggregate is below zero. Nothing is hidden and nothing failed to arrive.
     */
    const breakdown = outstandingBreakdown(-50_000n, []);

    expect(breakdown.coversAll).toBe(true);
    expect(breakdown.noteTh).toBe('ไม่มีออเดอร์ที่ค้างชำระ');
  });

  it('still reads a full page as capped even when the rows happen to match the total', () => {
    /*
     * The mirror image of the case above, and the reason the row count is the right test in
     * both directions. Eight rows that add up exactly to the total is what a company with
     * eight owing orders looks like — and also what a company with a ninth looks like when the
     * ninth is offset by an overpayment elsewhere. The sum cannot tell them apart; the full
     * page can, and errs toward saying so.
     */
    const orders = owingRows(OUTSTANDING_ORDERS_CAP);

    expect(outstandingBreakdown(8_000_000n, orders).coversAll).toBe(false);
  });
});

describe('OUTSTANDING_ORDERS_CAP', () => {
  it("matches the API's own constant, read out of its own source", () => {
    /*
     * ⚠️ THE MIRROR TEST. `overview.repository.ts` applies the `limit`, so it is the
     * definition; this bundle restates it because `apps/dashboard` does not depend on
     * `apps/api` and must not start.
     *
     * The dangerous direction is a cap **lowered** on the server: this bundle would then see a
     * short page where the server had truncated, and print "ยอดค้างชำระทั้งหมดมาจาก N ออเดอร์นี้"
     * over a list with a debt missing from it. Nothing else in either app would fail.
     */
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../../api/src/overview/overview.repository.ts'),
      'utf8',
    );
    const declared = /export const OUTSTANDING_ORDERS_CAP = (\d+);/u.exec(source);

    expect(declared, 'the API constant should still be findable by this shape').not.toBeNull();
    expect(OUTSTANDING_ORDERS_CAP).toBe(Number(declared?.[1]));
  });

  it('is the number the API actually applies as a limit', () => {
    /* A constant declared and then not used in the query would make the mirror meaningless. */
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../../api/src/overview/overview.repository.ts'),
      'utf8',
    );

    expect(source).toContain('limit ${OUTSTANDING_ORDERS_CAP}');
  });
});
