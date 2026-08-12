import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PAYABLE_ORDER_STATUSES, acceptsPayment } from '../src/lib/payment/payable';
import { printableQuotation } from '@wewin/core/quotation';

import { formattersFor } from '../src/i18n/format';
import { LOCALES, type Locale } from '../src/i18n/locales';

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

describe('⭐ the field opens on what the quotation promised', () => {
  /*
   * ─────────────────────────────────────────────────────────────────────────────
   * The owner's ruling, and the assertion this round turns on.
   * ─────────────────────────────────────────────────────────────────────────────
   *
   *   "ถ้าเป็นเคสที่ระบุว่าต้องมัดจำ จึงจะมัดจำ ถ้าไม่ได้ระบุให้ใช้ยอดเต็มเลย"
   *
   * The screen used to open on `outstandingThbMinor` — everything still owed — while the
   * quotation two clicks earlier printed `ชำระมัดจำก่อน ฿4,320.00`. One number shown, another
   * asked for. What follows pins the wiring that closes it: the prefill reads `nextDue`, the
   * server decides which figure that is, and a response without the field is refused rather
   * than quietly defaulted back to the old one.
   */
  const island = read('../src/components/payment/PaymentIsland.tsx');
  const paymentApi = read('../src/lib/payment/api.ts');

  it('⭐ prefills from nextDue, and no longer from the outstanding', () => {
    expect(island).toContain('satangField(result.data.nextDueThbMinor)');
    expect(island).not.toContain('satangField(result.data.outstandingThbMinor)');
  });

  it('⭐ does not re-decide the rule on the client', () => {
    /*
     * A `deposit ?? total` here would be a second implementation of the ruling, and the two
     * would disagree the first time somebody paid half a deposit — the server answers the
     * *remainder* of the instalment, which no client-side pick between two pinned figures can
     * produce. The prefill must therefore be one field, not a choice.
     */
    expect(island).not.toMatch(/depositThbMinor\s*\?\?/u);
    expect(island).not.toMatch(/scheduledDeposit/u);
  });

  it('⭐ refuses a response with no nextDue rather than falling back', () => {
    /*
     * ⚠️ The regression this guards is silent and expensive. An API one version behind sends
     * no `nextDueThbMinor`; a decoder that defaulted it to the outstanding would restore the
     * exact ฿14,400-against-฿4,320 bug with every test still green. `satang()` returning null
     * has to fail the whole decode, the same as a missing grand total.
     */
    /*
     * ⚠️ The whole statement, terminator included — a `toContain` of the prefix alone let
     * `satang(body['nextDueThbMinor']) ?? outstandingThbMinor` through a mutation run with
     * every test still green, which is the precise regression being guarded and would have
     * shipped the old bug back under a passing suite.
     */
    const apiCode = paymentApi.replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, '');

    /*
     * The assignment ends at its semicolon: `satang(…) ?? outstandingThbMinor;` fails this,
     * and so does any other coalescing tacked onto the read.
     */
    expect(apiCode).toMatch(/const nextDueThbMinor = satang\(body\['nextDueThbMinor'\]\);\s*\n/u);
    /* And a null still fails the whole decode, beside the other two required figures. */
    expect(apiCode).toContain('nextDueThbMinor === null');
  });

  it('⭐ still states the outstanding, because it answers a different question', () => {
    /*
     * Next-due is what the field opens on; outstanding is what the customer still owes in
     * total. Dropping the second would leave somebody paying a ฿4,320 deposit with no way to
     * see the ฿14,400 the order comes to.
     */
    expect(island).toContain("t('payment.outstanding')");
    expect(island).toContain('data.outstandingThbMinor');
  });

  it('⭐ the quotation states a deposit at every destination, not only foreign ones', () => {
    /*
     * `@wewin/core` conditioned `depositThbText` on `fx`, which hid the deposit on every
     * domestic order — so a Thai customer met ฿4,237.20 on the payment screen having been
     * promised only ฿14,124.00. The promise has to exist before the field can honour it.
     */
    const core = read('../../../packages/core/src/quotation.ts');
    /*
     * ⚠️ Comments stripped, and for the second time in this file the first draft caught its
     * own prose: the doc comment on `depositThbText` *quotes* the condition it removed
     * ("This was `fx === null || !depositIsSeparate ? null : …`"), so a bare `not.toContain`
     * failed against the sentence explaining the fix.
     */
    const coreCode = core.replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, '');

    expect(coreCode).toContain('depositThbText: !depositIsSeparate ? null :');
    expect(coreCode).not.toContain('fx === null || !depositIsSeparate');
    /* And the page has to render it outside the fx branch, or core's fix reaches nobody. */
    expect(quotationIsland).toContain('quotation.fxRate !== null || depositRow === null');
  });
});

describe('⭐ the payment screen and the quotation write the same number the same way', () => {
  /*
   * ─────────────────────────────────────────────────────────────────────────────
   * A customer walks from the quotation to the payment screen in one click.
   * ─────────────────────────────────────────────────────────────────────────────
   *
   * The quotation printed `฿14,124.00` and the payment screen `฿14124.00` — one figure, two
   * spellings, one click apart. The cause was `f.plain` in the payment catalogue, whose
   * entire purpose is to *not* group (a year reads `2026`, never `2,026`).
   *
   * ⚠️ This is the assertion the round needed and the suite did not have. `catalogue.test.ts`
   * pins that the satang survive, that the pad stays ASCII and that a minus lands in front of
   * the `฿` — all three by *decoding* the rendering, which deliberately strips group
   * separators and therefore cannot see grouping at all. Taking the grouping away again would
   * leave every one of those green.
   *
   * It compares the two renderers against each other rather than against a literal:
   * `@wewin/core`'s `money()` is what the quotation prints via `printableQuotation`, and
   * `f.bahtExact` is what the payment screen prints. A hard-coded `'฿14,124.00'` would pin
   * today's CLDR and go red the day ICU moves a separator, which is not a bug — what matters
   * is that the two agree, in every locale, whatever ICU says.
   */
  const FIGURES = [1_412_400n, 423_720n, 2_824_824n, 100n, -150n] as const;

  /** As the quotation page renders it: `payableThbText` is core's `money()` verbatim. */
  function asQuotationPrints(minor: bigint, locale: Locale): string | null {
    return printableQuotation({
      revision: 1,
      documentHash: 'f'.repeat(16),
      pinnedLocale: locale,
      destinationCountry: null,
      taxBasis: 'exclusive',
      orderNo: 'WW-1000',
      contactName: null,
      submittedAt: '2026-08-12T00:00:00.000Z',
      vatRateBp: 700,
      leadTimeDays: 30,
      netThbMinor: minor,
      vatThbMinor: 0n,
      grandTotalThbMinor: minor,
      lines: [],
      charges: [],
      /* `payableThbText` is only produced when there is an fx block — see core. */
      fx: {
        currency: 'SGD',
        source: 'mid_market',
        spreadBp: 0,
        rateText: '25.315148',
        observedAt: null,
        netMinor: 1n,
        vatMinor: 0n,
        grandTotalMinor: 1n,
      },
      scheduledDepositThbMinor: null,
    }).payableThbText;
  }

  it('⭐ agrees with @wewin/core’s money(), figure for figure', () => {
    for (const locale of LOCALES) {
      const f = formattersFor(locale);
      for (const minor of FIGURES) {
        expect(asQuotationPrints(minor, locale), `${locale} @ ${String(minor)}`).toBe(
          f.bahtExact(minor),
        );
      }
    }
  });

  it('⭐ …including Lao, which is where this last disagreed', () => {
    /*
     * ⭐ THE DIVERGENCE THIS TEST USED TO DOCUMENT, NOW CLOSED.
     *
     * It read: *"a Lao customer reads `฿14,124.00` on the quotation and `฿14.124.00` on the
     * payment screen — left as it is, deliberately… this test states the divergence so the
     * day it is fixed, the suite says so rather than staying quietly green."* It went red on
     * the fix, which is the whole reason it was written that way round.
     *
     * The cause was in `@wewin/core`: `money()` handed `Intl` the project's own `la`, which
     * is **Latin**, not Lao — `supportedLocalesOf(['la'])` is `[]`, so ICU resolved to
     * `en-US` and grouped a Lao total with commas. Core now maps through its own `INTL_TAGS`,
     * pinned against `@wewin/i18n`'s `INTL_TAG` by `quotation-locales.test.ts`.
     *
     * The reason to fix it now rather than later was a fact rather than a preference: at the
     * time, `order_documents` held 39 Thai rows and 1 English one and **no Lao document at
     * all**, so plan 10.6's "a document that reprints differently is one nobody can cite" had
     * nothing to bind on. The first Lao quotation issued would have made this permanent.
     *
     * Kept as its own case rather than folded into the loop above so the regression has a
     * name: `la` is the only one of the eight whose project code is a *different real
     * language*, so it is the only one that fails silently instead of throwing.
     */
    expect(Intl.NumberFormat.supportedLocalesOf(['la'])).toStrictEqual([]);

    expect(asQuotationPrints(1_412_400n, 'la')).toBe(formattersFor('la').bahtExact(1_412_400n));
    expect(asQuotationPrints(1_412_400n, 'la')).toBe('฿14.124.00');
  });

  it('⭐ groups the baht, which is the half the decoding tests cannot see', () => {
    /*
     * The direct statement of the fix, on the locale whose grouping is unambiguous — and the
     * two figures from the browser walk-through rather than invented ones: WW-1038's total
     * and the deposit its payment field opens on.
     */
    expect(formattersFor('th').bahtExact(1_412_400n)).toBe('฿14,124.00');
    expect(formattersFor('th').bahtExact(423_720n)).toBe('฿4,237.20');
  });
});
