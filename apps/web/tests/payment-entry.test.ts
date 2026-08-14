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
   * "ชำระเงิน" on an order the customer cancelled reads as a bill, and the screen behind it
   * refuses the slip anyway — `payment_slips_live_orders_only` fires on the INSERT. A customer
   * who transfers against that button has sent money to a dead contract, which becomes a
   * reconciliation exception and a phone call rather than a payment — and on a cancellation
   * the money may have been owed the other way to begin with.
   */
  it('refuses the two dead statuses', () => {
    expect(acceptsPayment('cancelled')).toBe(false);
    expect(acceptsPayment('superseded')).toBe(false);
  });

  it('⭐ OFFERS the action on a delivered order, which is a contract fulfilled', () => {
    /*
     * ⚠️ THE OWNER'S DEFECT, ON THE LINK SIDE. *"ถ้าส่งมอบไปก่อนเก็บครบ จะเก็บผ่านระบบไม่ได้อีก"* —
     * hand the job over before the balance is collected and there was no door left at all:
     * `delivered` has no transition out, so the status could not be walked back to one that
     * had a door. The customer received the goods and owes the money; the row gets a button.
     *
     * Deliberately its own case rather than a line added to the list below: this is the one
     * membership that changed, and a mutation that drops `'delivered'` from
     * `PAYABLE_ORDER_STATUSES` must fail on a test whose name says what was lost.
     */
    expect(acceptsPayment('delivered')).toBe(true);
  });

  it('refuses a draft, which is a cart and has no document to pay against', () => {
    /* Absent from the server's list for a different reason than the two above: not
     * "dead" but "never started" — no order number, no pinned document, no total. */
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
     *
     * ⚠️ The constant moved out of `slips.service.ts` into `attachable.ts` when the payment
     * screen's own gate started reading it. That gate has since gone — the wire carries
     * `orderIsLive` alone — so *this regex* is now the only reader outside the API, and it is
     * the reason that file's header still says its declaration shape is load-bearing.
     */
    const service = read('../../api/src/payments/slips/attachable.ts');
    const block = /SLIP_ATTACHABLE_STATUSES: readonly OrderStatus\[\] = \[([^\]]*)\]/u.exec(service);

    expect(block, 'the API constant should still be findable by this shape').not.toBeNull();

    const serverStatuses = [...(block?.[1] ?? '').matchAll(/'([a-z_]+)'/gu)].map((match) => match[1]);

    expect(serverStatuses.length).toBeGreaterThan(0);
    expect([...PAYABLE_ORDER_STATUSES]).toStrictEqual(serverStatuses);
  });

  it('agrees with the database trigger that is the actual definition', () => {
    /*
     * `payment_slips_live_orders_only` — the one that fires on INSERT and is therefore the
     * only copy a customer's money can actually be refused by.
     *
     * ⚠️ Read from `0046_slips_after_delivery.sql` and no longer from `0011_payment_guards.sql`,
     * because migrations are append-only: 0011 still contains the narrower literal and always
     * will, and a test pointed at it would fail against a database that is correct. **The
     * effective list is whatever the LAST migration to write this trigger wrote**, which is
     * why `apps/api/tests/payments/slips/attachable-drift.pg.test.ts` asks the live catalogue
     * instead — this file cannot, because `apps/web` has no database. If a 0047 ever touches
     * this trigger, the path below moves with it.
     */
    const migration = read('../../../packages/db/drizzle/0046_slips_after_delivery.sql');
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

  it('⭐ …and the account list now also refuses an order that owes nothing', () => {
    /*
     * The gap `payable.ts` used to document, closed by the two folds landing on
     * `OrderSummaryWire`. `acceptsPayment` answers from the status alone, and a fully paid
     * order still `in_production` is a payable status — the customer was offered "ชำระเงิน"
     * on a settled bill and found out only on the screen behind it.
     *
     * ⚠️ Asserted on the source rather than through `describeRowMoney`, because the unit
     * tests beside that module already pin `owes` and cannot see whether the markup reads it.
     * The two conditions keep their own owners: the status half stays a character-for-character
     * mirror of the server's list (above), the money half is `quotationRowMoney.ts`.
     */
    expect(myQuotations).toContain('acceptsPayment(row.status) && money.owes');
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

describe('⭐ the payment screen gates on the server’s answer, not on a list of its own', () => {
  /*
   * ─────────────────────────────────────────────────────────────────────────────
   * The defect: both doors above were gated and the screen behind them was not.
   * ─────────────────────────────────────────────────────────────────────────────
   *
   * `/payment?order=<id>` is a stable, bookmarkable URL. Executed against the real database,
   * a cancelled order answered `payment-instructions` with `outstandingThbMinor 1035418`
   * while `GET /orders` answered `null` for the same order at the same moment, and
   * `PaymentIsland` — whose only test was `outstandingThbMinor <= 0n` — printed
   * "ยอดคงค้างทั้งหมด ฿10,354.18" in `text-lead text-lime` with the upload form beneath it. The
   * upload would have been refused 409; the bill would not.
   *
   * The fix is a server-computed boolean on `PaymentInstructionsWire`, from the same list
   * that raises that 409. These assert the wiring — that the screen reads it, that the
   * decoder refuses a response without it, and that the screen did *not* grow a fourth copy
   * of the status list on the way.
   */
  const island = read('../src/components/payment/PaymentIsland.tsx');
  const paymentApi = read('../src/lib/payment/api.ts');

  it('reads `orderIsLive` off the wire and hands it to the render decision', () => {
    expect(island).toContain('orderIsLive: data.orderIsLive');
    expect(island).toContain('describePaymentPanel({');
    /*
     * ⚠️ And it is the ONLY status fact passed. A second boolean here would be the pair this
     * round removed, and the first thing to reappear if somebody "restores" the delivered
     * branch rather than reading why it went.
     */
    expect(island).not.toContain('acceptsPayment:');
    /*
     * ⚠️ And the figures are the panel's, not a second call beside it. Rendering
     * `describeOwedFigures(data.…)` again here would leave every other assertion in this file
     * green and put the ฿10,354.18 straight back onto the cancelled order.
     */
    expect(island).toContain('panel.figures.map(');
    expect(island).not.toContain('describeOwedFigures(');
  });

  it('⭐ refuses a response with no `orderIsLive` rather than assuming one', () => {
    /*
     * ⚠️ Both defaults ship a defect: `true` bills a cancelled order (the bug itself), `false`
     * tells every paying customer the screen is closed. A decode failure is a sentence with a
     * "try again" behind it, which is the only one of the three that is not a wrong statement
     * about somebody's money. It matters more since the wire dropped its second boolean:
     * there is nothing else left for the screen to fall back on.
     */
    const apiCode = paymentApi.replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, '');

    expect(apiCode).toMatch(/const orderIsLive = body\['orderIsLive'\];\s*\n/u);
    expect(apiCode).toContain("typeof orderIsLive !== 'boolean'");
    /* And no `?? true` / `?? false` tacked onto the read, which is the silent version. */
    expect(apiCode).not.toMatch(/orderIsLive\s*(\?\?|\|\|)/u);
  });

  it('does not gate the screen on `payable.ts`, which is the list-only mirror', () => {
    /*
     * The status list in `lib/payment/payable.ts` stays for `MyQuotations` and
     * `QuotationIsland`, which render `GET /orders` rows and a quotation and have no
     * instructions wire to read. Using it *here* would put a fourth copy of the server's list
     * on the one screen that can simply be told the answer — and the copy would be the one
     * deciding whether a customer is shown a bill.
     */
    expect(island).not.toContain('payment/payable');
    for (const literal of ["'delivered'", "'cancelled'", "'superseded'", "'awaiting_payment'"]) {
      expect(island, `the payment screen must not restate ${literal}`).not.toContain(literal);
    }
  });

  it('says one clear thing on a closed order, and it is not `payment.settled`', () => {
    /*
     * `payment.settled` means *paid in full*, which is false and cruel on a cancelled order
     * the customer is owed a deposit on. The distinct key is `payment.closed`; which of the
     * two a given order gets is `paymentPanel.ts`'s decision and is tested beside it.
     */
    const panel = read('../src/components/payment/paymentPanel.ts');

    expect(panel).toContain("noteKey: 'payment.closed'");
    expect(island).toContain('t(panel.noteKey)');
  });

  it('⭐ keeps the slip history outside every gate', () => {
    /*
     * A customer whose order was cancelled after they paid a deposit needs to see that the
     * deposit is recorded — hiding it with the form would make a closed order look like one
     * nothing had ever been sent against, which is worse than the bug being fixed.
     *
     * ⚠️ Asserted by *position*, and the first draft of this test is why: a
     * `toMatch(/\) : null\}[\s\S]*<SlipHistory/)` passed happily with the history moved inside
     * the gate, because an earlier `) : null}` (the note's) sat above it. What has to be true
     * is that the history comes after the form branch **closes**, which is the one arrangement
     * that renders it on an order with no form at all.
     */
    const gateOpens = island.indexOf('panel.showsForm ? (');
    const gateCloses = island.indexOf(') : null}', gateOpens);
    const history = island.indexOf('<SlipHistory slips={slips} t={t} />');

    expect(gateOpens).toBeGreaterThan(-1);
    expect(gateCloses).toBeGreaterThan(gateOpens);
    expect(history, 'the slip history must not sit inside the form gate').toBeGreaterThan(
      gateCloses,
    );
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
  /** Arabic digits and Thai/Devanagari/Burmese/Lao numerals alike. */
  const NUMERAL = /[\d๐-๙०-९၀-၉໐-໙]/u;

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
      expect(label, `${locale} must not name an amount`).not.toMatch(NUMERAL);
      expect(label, `${locale} must not name a currency`).not.toMatch(/[฿$€]|THB/u);
    }
  });

  it('⭐ and neither does `payment.dueNow`, which labels a figure it must not contain', () => {
    /*
     * The account list's prominent figure — `nextDueThbMinor`, the remainder of the first
     * unsettled instalment. The label says *which* figure; `quotationRowMoney.ts` picks it and
     * `f.bahtExact` writes it, so a digit welded into any of the eight would be a second,
     * unformatted, un-updatable amount beside the real one.
     *
     * ⚠️ Present in all eight, which is this repo's convention rather than a nicety:
     * `catalogue.test.ts` asserts `coverageOf(locale) === 1` for every locale.
     */
    for (const locale of ['th', 'en', 'zh', 'vi', 'my', 'la', 'hi', 'de'] as const) {
      const source = read(`../src/i18n/catalogues/${locale}.ts`);
      const entry = /'payment\.dueNow': '([^']*)'/u.exec(source);

      expect(entry, `${locale} should define payment.dueNow`).not.toBeNull();

      const label = entry?.[1] ?? '';
      expect(label.trim().length, `${locale} must not be empty`).toBeGreaterThan(0);
      expect(label, `${locale} must not name an amount`).not.toMatch(NUMERAL);
      expect(label, `${locale} must not name a currency`).not.toMatch(/[฿$€]|THB/u);
    }
  });

  it('⭐ the list and the payment screen choose their figures with one module, not two', () => {
    /*
     * One number, one vocabulary, one click apart — and, since fix round 2, one *decision*.
     *
     * The labels were shared from the start; the rule that picks between them was not, and
     * that is precisely how the list came to lead each row with the next instalment while the
     * payment screen still led with the outstanding. A customer read ฿4,320.00, clicked, and
     * the headline became ฿14,400.00. Both files now ask `describeOwedFigures`, so neither can
     * re-order the pair alone.
     */
    const rowMoney = read('../src/components/account/quotationRowMoney.ts');
    const island = read('../src/components/payment/PaymentIsland.tsx');
    /*
     * ⚠️ The payment screen now asks through `paymentPanel.ts`, which added the *third*
     * decision (whether there is anything to ask for at all) above the two this test was
     * written about. It is one more module and not one more rule: the panel passes both
     * figures straight to `describeOwedFigures`, so the ordering is still decided once for
     * both screens — which is what these two assertions are actually protecting.
     */
    const panel = read('../src/components/payment/paymentPanel.ts');

    expect(rowMoney).toContain('describeOwedFigures(outstandingMinor, nextDueMinor)');
    expect(panel).toContain('describeOwedFigures(outstandingMinor, nextDueMinor)');
    expect(island).toContain('outstandingMinor: data.outstandingThbMinor');
    expect(island).toContain('nextDueMinor: data.nextDueThbMinor');

    /* And neither hard-codes a label the other does not have. */
    for (const source of [rowMoney, island, panel]) {
      expect(source).not.toContain("labelKey: 'payment.outstanding'");
      expect(source).not.toContain("t('payment.outstanding')");
    }
  });

  it('⭐ the outstanding label says *the whole*, in every locale — fix round 2', () => {
    /*
     * ⚠️ THE ASSERTION DEFECT 1 TURNS ON. `payment.dueNow` and `payment.outstanding` sit one
     * above the other on a 30/70 row, and a bare "ยอดคงค้าง" does not say whether the ฿4,320.00
     * is inside the ฿14,400.00 or comes after it — the customer resolves it by noticing which
     * number is bigger, which is the arithmetic showing both figures was meant to remove.
     *
     * Each locale is checked against the qualifier its own catalogue already uses for a total
     * (`price.grandTotal`, `quotation.total`), rather than against a word invented here.
     */
    const qualifier: Readonly<Record<string, string>> = {
      th: 'ทั้งหมด',
      en: 'in total',
      zh: '总',
      vi: 'Tổng',
      my: 'စုစုပေါင်း',
      la: 'ທັງໝົດ',
      hi: 'कुल',
      de: 'Gesamt',
    };

    for (const [locale, marker] of Object.entries(qualifier)) {
      const source = read(`../src/i18n/catalogues/${locale}.ts`);
      const entry = /'payment\.outstanding': '([^']*)'/u.exec(source);

      expect(entry, `${locale} should define payment.outstanding`).not.toBeNull();

      const label = entry?.[1] ?? '';
      expect(label, `${locale} must mark the figure as the whole, not the leftover`).toContain(
        marker,
      );
      expect(label, `${locale} must not name an amount`).not.toMatch(NUMERAL);
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

  it('⭐ states both figures — the one it asks for, and the one still owed', () => {
    /*
     * Next-due is what the field opens on; outstanding is what the customer still owes in
     * total. Dropping the second would leave somebody paying a ฿4,320 deposit with no way to
     * see the ฿14,400 the order comes to — and, until fix round 2, the *first* was the one
     * missing: the screen led with the outstanding and named the due-now nowhere at all,
     * silently prefilling it into a field labelled "จำนวนเงินที่โอน", which asks what the
     * customer transferred rather than what they owe.
     *
     * Both amounts now go into `describeOwedFigures`, and whichever labels it returns are
     * rendered — so this asserts the wiring and `owedFigures.test.ts` asserts the choice.
     */
    expect(island).toContain('outstandingMinor: data.outstandingThbMinor');
    expect(island).toContain('nextDueMinor: data.nextDueThbMinor');
    expect(island).toContain('t(figure.labelKey)');

    const owedFigures = read('../src/lib/payment/owedFigures.ts');
    expect(owedFigures).toContain("labelKey: 'payment.outstanding'");
    expect(owedFigures).toContain("labelKey: 'payment.dueNow'");
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
