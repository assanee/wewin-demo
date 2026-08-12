import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PAYABLE_ORDER_STATUSES, acceptsPayment } from '../src/lib/payment/payable';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE PAYMENT SCREEN HAD NO DOOR, AND NOW HAS TWO.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `PaymentIsland` has been finished and tested since task 10 and no `href`, `Link` or
 * `router.push` anywhere in `apps/web` pointed at `/payment`. A customer confirmed a
 * quotation, read `ยอดที่ต้องชำระ ฿14,400.00` off the page, and had nowhere to press.
 *
 * The two doors are `QuotationIsland` (under the totals) and `MyQuotations` (per row on
 * `/account`). What is asserted here is the thing neither a type nor a green render can
 * catch: **when the doors must not be there**, and that both agree on it.
 */

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const quotationIsland = read('../src/components/quotation/QuotationIsland.tsx');
const myQuotations = read('../src/components/account/MyQuotations.tsx');

describe('⭐ the action does not appear when there is nothing to pay', () => {
  /*
   * ⚠️ THE ASSERTION THIS TASK TURNS ON.
   *
   * "ชำระเงิน" on a job delivered last month reads as a bill already settled, and the screen
   * behind it refuses the slip anyway — `payment_slips_live_orders_only` fires on the INSERT.
   * A customer who transfers against that button has sent money to a closed contract, which
   * becomes a reconciliation exception and a phone call rather than a payment.
   */
  it('refuses the three finished statuses', () => {
    expect(acceptsPayment('delivered')).toBe(false);
    expect(acceptsPayment('cancelled')).toBe(false);
    expect(acceptsPayment('superseded')).toBe(false);
  });

  it('refuses a draft, which is a cart and has no document to pay against', () => {
    /* Absent from the server's list for a different reason than the three above: not
     * "finished" but "never started" — no order number, no pinned document, no total. */
    expect(acceptsPayment('draft')).toBe(false);
  });

  it('refuses a status this bundle has never heard of, rather than guessing', () => {
    /*
     * `decodeQuotation` defaults an unreadable status to `'unknown'`, and a status added to
     * the API after this bundle shipped arrives here as an unrecognised string. Both must
     * answer false: a missing button sends the customer to sales, a wrong one sends them to
     * a screen that refuses them.
     */
    expect(acceptsPayment('unknown')).toBe(false);
    expect(acceptsPayment('')).toBe(false);
    expect(acceptsPayment('awaiting_payment_')).toBe(false);
    expect(acceptsPayment('AWAITING_PAYMENT')).toBe(false);
  });

  it('offers the action for every status a slip may actually be attached to', () => {
    expect(acceptsPayment('awaiting_payment')).toBe(true);
    /*
     * ⚠️ The four past `awaiting_payment` are the deposit's doing and are the half a naive
     * rule gets wrong: the balance is transferred while the order is already in production,
     * so a rule reading only `awaiting_payment` hides the button from every customer paying
     * the second instalment.
     */
    expect(acceptsPayment('production_confirmed')).toBe(true);
    expect(acceptsPayment('in_production')).toBe(true);
    expect(acceptsPayment('awaiting_installation')).toBe(true);
    expect(acceptsPayment('redesign')).toBe(true);
  });
});

describe('⭐ the storefront rule is the server rule, and cannot drift from it quietly', () => {
  it('matches SLIP_ATTACHABLE_STATUSES in the API, read out of its own source', () => {
    /*
     * ⚠️ THE MIRROR TEST. `payable.ts` is the third copy of this list —
     * `0011_payment_guards.sql` is the definition, `slips.service.ts` mirrors it for the
     * pre-upload check, and this bundle mirrors it again to decide whether to draw a button.
     * A copy nothing compares is a copy that drifts, and the failure is silent in the
     * direction that matters: a status added to the server's list would leave customers
     * unable to reach a screen that would have accepted them.
     *
     * Parsed out of the API's source rather than imported because `apps/web` does not depend
     * on `apps/api` and must not start.
     */
    const service = read('../../api/src/payments/slips/slips.service.ts');
    const block = /SLIP_ATTACHABLE_STATUSES: readonly OrderStatus\[\] = \[([^\]]*)\]/u.exec(service);

    expect(block, 'the API constant should still be findable by this shape').not.toBeNull();

    const serverStatuses = [...(block?.[1] ?? '').matchAll(/'([a-z_]+)'/gu)].map((match) => match[1]);

    expect(serverStatuses.length).toBeGreaterThan(0);
    expect([...PAYABLE_ORDER_STATUSES]).toStrictEqual(serverStatuses);
  });

  it('agrees with the database trigger that is the actual definition', () => {
    /* `payment_slips_live_orders_only` — the one that fires on INSERT and is therefore the
     * only copy a customer's money can actually be refused by. */
    const migration = read('../../../packages/db/drizzle/0011_payment_guards.sql');
    const trigger = /CREATE TRIGGER payment_slips_live_orders_only[\s\S]*?'\{([a-z_,]+)\}'/u.exec(migration);

    expect(trigger, 'the trigger should still be findable by this shape').not.toBeNull();

    expect([...PAYABLE_ORDER_STATUSES]).toStrictEqual((trigger?.[1] ?? '').split(','));
  });
});

describe('⭐ both doors are gated, and by the same rule', () => {
  /*
   * A unit test of `acceptsPayment` proves the rule; it does not prove either component
   * calls it. These read the source for the call, which is what a refactor that "simplified"
   * a conditional away would break while leaving every other test in this file green.
   */
  it('the quotation page renders its action only through acceptsPayment', () => {
    expect(quotationIsland).toContain('acceptsPayment(phase.status)');
    /* Nothing to pay *and* nothing to link with collapse to the same `null` prop. */
    expect(quotationIsland).toContain('payOrderId === null ? null :');
  });

  it('the account list renders its action only through acceptsPayment', () => {
    expect(myQuotations).toContain('acceptsPayment(row.status)');
  });

  it('neither reimplements the status list beside the call', () => {
    /*
     * A second literal list in a component is how the two doors would come to disagree —
     * one updated, the other not — which is precisely the bug `payable.ts` exists to prevent.
     */
    for (const source of [quotationIsland, myQuotations]) {
      expect(source).not.toContain("'delivered'");
      expect(source).not.toContain("'cancelled'");
      expect(source).not.toContain("'awaiting_payment'");
    }
  });
});

describe('⭐ the order id does not leak out of the browser', () => {
  it('the quotation page links only the id it was opened with, never one off the response', () => {
    /*
     * ⚠️ The token half of this page has **no order id to have**: `LinkedDocumentWire` carries
     * `orderNo`, `status`, `contactName`, `submittedAt`, `document` and `seller` and
     * deliberately no `id`, because `/orders/{id}?t=…` is the URL shape
     * `document-link.controller.ts` refuses. Lighting up the button on that half would have
     * meant adding an id to an anonymous, forwardable, emailable response — undoing the one
     * property the route is built around. So the id comes from `source`, which only the
     * `?order=` half has, and the button is simply absent on the other.
     */
    expect(quotationIsland).toContain("source.kind === 'owned' ? source.orderId : null");
    expect(quotationIsland).not.toMatch(/orderId:\s*result\.data/u);
  });

  it('both links are built from localeHref and the query string, never a path segment', () => {
    /*
     * `/payment/<id>` would put a real order id in a path — forwarded, pasted into chat,
     * logged by every proxy on the way — and would make the route dynamic, dropping it out
     * of the eight prerendered shells. `?order=` keeps it a query the island reads in the
     * browser, which is the same choice `/orders` already made for its token.
     */
    for (const source of [quotationIsland, myQuotations]) {
      expect(source).toContain("localeHref(locale, '/payment')}?order=");
    }
  });

  it('the payment route still reads no searchParams and stays noindex', () => {
    /*
     * The property this task was required not to undo, asserted against the route rather
     * than trusted. A `searchParams` read here would opt the route out of static rendering
     * and put one customer's order id into a server render; `index: false` with no hreflang
     * is what keeps the URL out of a crawler's and a sitemap's hands.
     */
    const route = read('../src/app/[locale]/payment/page.tsx');

    expect(route).toContain('index: false');

    /*
     * ⚠️ Comments stripped first, and the first draft of this test is why. That file's own
     * header explains the design in prose — "read in the browser by `PaymentIsland` rather
     * than through `params` or `searchParams`" — so a bare `not.toContain('searchParams')`
     * failed against the very sentence promising the property it was checking for. The
     * assertion has to read the code, which is the only place the word would do harm.
     */
    const code = route.replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, '');

    expect(code).not.toContain('searchParams');
    expect(code).not.toContain('alternates');
  });
});

describe('the label promises a screen and not a figure', () => {
  it('carries no amount, in any of the eight catalogues', () => {
    /*
     * ⚠️ The failure this wording exists to avoid. The quotation shows a pinned grand total
     * and a pinned deposit; `PaymentIsland` opens on `outstandingThbMinor`, folded live, and
     * prefills its amount field with it — equal to the grand total on a fresh order, and to
     * neither figure once a deposit has been paid. Any digit in this label is a promise the
     * destination is free to contradict.
     */
    const catalogues = ['th', 'en', 'zh', 'vi', 'my', 'la', 'hi', 'de'] as const;

    for (const locale of catalogues) {
      const source = read(`../src/i18n/catalogues/${locale}.ts`);
      const entry = /'payment\.action': '([^']*)'/u.exec(source);

      expect(entry, `${locale} should define payment.action`).not.toBeNull();

      const label = entry?.[1] ?? '';
      expect(label.trim().length, `${locale} must not be empty`).toBeGreaterThan(0);
      /* Arabic digits and Thai/Devanagari/Burmese/Lao numerals alike. */
      expect(label, `${locale} must not name an amount`).not.toMatch(/[\d๐-๙०-९၀-၉໐-໙]/u);
      expect(label, `${locale} must not name a currency`).not.toMatch(/[฿$€]|THB/u);
    }
  });
});
