import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ORDER_STATUSES } from './order-language';
import { BALANCE_ANNOUNCED_ON, balanceNoticeFor } from './transition-balance';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE NUMBER IS IN FRONT OF THE PERSON WHO DECIDES, AND NOTHING IS BLOCKED.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ Whole strings with `toBe`, never `toContain` — the house rule from
 * `order-outstanding.test.ts`, and the trap is live here: `'฿4,200'` is a substring of
 * `'฿14,200'`, so a containment assertion on a baht figure passes for the wrong money.
 *
 * ⚠️ This is a `.test.ts` and not a `.test.tsx` because `apps/dashboard`'s vitest runs
 * `environment: 'node'` and would collect a `.tsx` **silently never** — which is the whole
 * reason the decision is in a module rather than in the dialog's markup.
 *
 * ⚠️ The figures below read `฿10,354` and not `฿10,354.18`, and that is `formatBaht`'s doing,
 * not a typo: this dashboard states money to the whole baht everywhere (`divRoundHalfUp` to
 * 100), so ค้างชำระ on the order card beside this dialog reads `฿10,354` too. The customer's own
 * payment screen states the satang, because that is where somebody types a transfer amount.
 * Asserting the app's own formatter rather than a hand-written string is what keeps the two
 * sentences on this screen identical.
 */

const owing = { outstandingThbMinor: 1_035_418n, nextDueThbMinor: 1_035_418n };

describe('which transitions say anything at all', () => {
  it('⭐ announces the balance on the two closing moves, and on nothing else', () => {
    /*
     * ⚠️ Enumerated over the whole status set rather than spot-checked, so a tenth status added
     * to the API arrives here unclassified and visible instead of silently quiet. The two are
     * the last moments the company still holds something the customer wants: `delivered` has no
     * transition out at all, and `awaiting_installation` is when the van is loaded.
     */
    const announced = ORDER_STATUSES.filter(
      (status) => balanceNoticeFor(status, owing) !== null,
    );

    expect([...announced]).toStrictEqual(['awaiting_installation', 'delivered']);
    expect([...announced]).toStrictEqual([...BALANCE_ANNOUNCED_ON]);
  });

  it('says nothing on the steps the customer is still waiting on', () => {
    /*
     * Named individually as well, because the enumeration above would also pass for a module
     * that announced on *nothing* if `BALANCE_ANNOUNCED_ON` were emptied — both sides of that
     * assertion move together. These do not.
     */
    expect(balanceNoticeFor('production_confirmed', owing)).toBeNull();
    expect(balanceNoticeFor('in_production', owing)).toBeNull();
    expect(balanceNoticeFor('redesign', owing)).toBeNull();
    expect(balanceNoticeFor('cancelled', owing)).toBeNull();
  });
});

describe('⭐ what the two closing moves say when money is outstanding', () => {
  it('names the amount in the sentence staff read before confirming', () => {
    /*
     * THE ASSERTION THE FEATURE EXISTS FOR. The owner's loss was staff closing a job without
     * the figure in front of them; a notice that said "ยังมียอดค้างชำระ" and no number would
     * satisfy every other test in this file and would not be the feature.
     *
     * ⚠️ The exact string, and `ค้างชำระ` is the word the ค้างชำระ column and the ยอดเงิน card
     * already use. No vocabulary is invented for this dialog.
     */
    const notice = balanceNoticeFor('delivered', owing);

    expect(notice?.headlineTh).toBe('ออเดอร์นี้ยังค้างชำระ ฿10,354');
  });

  it('says the same thing on the installation move', () => {
    const notice = balanceNoticeFor('awaiting_installation', owing);

    expect(notice?.headlineTh).toBe('ออเดอร์นี้ยังค้างชำระ ฿10,354');
  });

  it('⭐ tells staff to proceed anyway — this is information, not a gate', () => {
    /*
     * The owner's answer to "when do you collect the balance" was **"แล้วแต่งาน ไม่ตายตัว"**, so a
     * blanket gate would refuse the close on every job of the kind they collect on the day for.
     * The note has to say so in words, or staff will read the headline as a refusal and either
     * stop or start editing statuses around it.
     *
     * The second clause is only true because `0046_slips_after_delivery.sql` opened `delivered`
     * to slips. Before it, closing the job with a balance really did put the money beyond the
     * software — so this string is also the assertion that the two halves of this change shipped
     * together.
     */
    const notice = balanceNoticeFor('delivered', owing);

    expect(notice?.noteTh).toBe(
      'เดินสถานะต่อได้ตามปกติ — ลูกค้ายังแจ้งชำระยอดคงค้างผ่านระบบได้หลังส่งมอบ',
    );
  });

  it('reads the figure the API sent and never a figure of its own', () => {
    /*
     * ⛔ Money is computed in Postgres. `outstandingThbMinor` is `order_outstanding_thb_minor()`
     * carried as a column; a different value in must produce a different sentence out, and
     * `nextDueThbMinor` — a *smaller* figure on a 30/70 — must never be the one printed. A
     * module that reached for the next-due would pass every assertion above, where the two are
     * equal, and understate the debt on exactly the orders that have one.
     */
    const thirtySeventy = { outstandingThbMinor: 1_440_000n, nextDueThbMinor: 432_000n };

    expect(balanceNoticeFor('delivered', thirtySeventy)?.headlineTh).toBe(
      'ออเดอร์นี้ยังค้างชำระ ฿14,400',
    );
  });
});

describe('the states that must stay silent', () => {
  it('says nothing about a job that is paid off', () => {
    /*
     * ⚠️ The most important silence. "฿0.00 ค้างชำระ" on every completed job is the notice staff
     * learn to dismiss without reading — and then dismiss the one that matters the same way.
     */
    expect(
      balanceNoticeFor('delivered', { outstandingThbMinor: 0n, nextDueThbMinor: 0n }),
    ).toBeNull();
  });

  it('says nothing about an overpaid job either', () => {
    /* `readOutstanding` treats a credit as settled; a "ค้างชำระ -฿500" sentence is not one. */
    expect(
      balanceNoticeFor('delivered', { outstandingThbMinor: -50_000n, nextDueThbMinor: 0n }),
    ).toBeNull();
  });

  it('says nothing when the API withheld the figures', () => {
    /*
     * Null folds mean a cart, or a cancelled/superseded order, or a bundle newer than the API
     * it is talking to. None of the three is a debt this dialog can name, and guessing one from
     * `grandTotalThbMinor` would be this file computing money.
     */
    expect(
      balanceNoticeFor('delivered', { outstandingThbMinor: null, nextDueThbMinor: null }),
    ).toBeNull();
  });

  it('still announces when only the next-due is missing, which is half a contract', () => {
    /*
     * `readOutstanding` degrades a missing next-due to the whole outstanding rather than to
     * zero — the safe direction, and it means the debt is still named here. Silence would be
     * the wrong half to fall back on: an order that owes ฿10,354.18 does not stop owing it
     * because a second column went missing.
     */
    expect(
      balanceNoticeFor('delivered', { outstandingThbMinor: 1_035_418n, nextDueThbMinor: null })
        ?.headlineTh,
    ).toBe('ออเดอร์นี้ยังค้างชำระ ฿10,354');
  });
});

describe('⭐ and the dialog actually renders it, without gating on it', () => {
  /*
   * A unit test of `balanceNoticeFor` proves the rule; it does not prove the dialog calls it.
   * `order-detail.tsx` is a `.tsx`, so `apps/dashboard`'s `environment: 'node'` vitest can
   * never render it — the source is read instead, which is the same arrangement
   * `overview/outstanding-breakdown.test.ts` uses for its own cap and `apps/web`'s
   * `payment-entry.test.ts` for its two link sites.
   */
  const detail = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'order-detail.tsx'),
    'utf8',
  );

  it('asks this module, with the transition being confirmed and the order in hand', () => {
    expect(detail).toContain('balanceNoticeFor(available.toStatus, owed)');
    /* And the figures handed over are the order's own, not a second read. */
    expect(detail).toContain('owed={order}');
  });

  it('puts both halves of the notice on screen', () => {
    /*
     * The headline alone would be the amount with no permission to proceed beside it, which is
     * the reading that turns a notice into a gate in a staff member's head.
     */
    expect(detail).toContain('{balance.headlineTh}');
    expect(detail).toContain('{balance.noteTh}');
    expect(detail).toContain('{balance !== null && (');
  });

  it('⛔ does NOT let the balance disable the confirm button', () => {
    /*
     * ⚠️ THE CONSTRAINT, ASSERTED ON THE SOURCE. The owner said collection *"แล้วแต่งาน
     * ไม่ตายตัว"*, so this must never become a gate — and the way it would become one is a single
     * `|| balance !== null` added to the button's `disabled`. That is a one-token change no
     * behavioural test in this repo could see, because the dialog cannot be rendered here.
     *
     * `busy || missing` is the whole condition and is asserted whole: a `toContain('busy ||')`
     * would still pass with a third term appended.
     */
    const code = detail.replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, '');

    expect(code).toContain('disabled={busy || missing}');
    expect(code).not.toContain('balance !== null ||');
    expect(code).not.toContain('|| balance !== null');
  });
});
