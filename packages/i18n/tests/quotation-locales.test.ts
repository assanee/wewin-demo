import { describe, expect, it } from 'vitest';
import { printableQuotation, type PinnedDocument } from '@wewin/core/quotation';

import { INTL_TAG, LOCALES } from '../src/locales.js';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ EVERY LOCALE THE STOREFRONT OFFERS MUST BE ONE `quotation.ts` CAN RENDER.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `packages/core/src/quotation.ts` keeps its own hand-written renderable-locale list
 * rather than importing `@wewin/i18n/locales` — it cannot: `@wewin/i18n` depends on
 * `@wewin/core` (see `packages/i18n/package.json`), so the reverse import would be a
 * cycle. That means nothing inside `packages/core` can ever notice the two lists
 * disagree.
 *
 * This package depends on `@wewin/core` and is the one place both lists are visible
 * at once, so the pin lives here instead. It found the drift on the first run: `ja` is
 * in the renderable set and is not one of the eight storefront locales, and `la` is one
 * of the eight and was missing from the renderable set — so a Lao-pinned quotation
 * rendered `localeDegraded: true` and fell back to Thai, silently, for every customer
 * who ever chose Lao.
 */
describe('every storefront locale renders without degrading', () => {
  const DOCUMENT: PinnedDocument = {
    revision: 1,
    documentHash: 'deadbeef',
    pinnedLocale: 'th',
    destinationCountry: null,
    taxBasis: 'exclusive',
    orderNo: 'WW-1000',
    contactName: null,
    submittedAt: '2026-08-07T00:52:17.000Z',
    vatRateBp: 700,
    leadTimeDays: 30,
    netThbMinor: 100n,
    vatThbMinor: 7n,
    grandTotalThbMinor: 107n,
    lines: [],
    charges: [],
    /* Baht. The currency-replacement path is proved in core and in the storefront; what this
       file exists to pin is that all eight locales render at all, which is orthogonal. */
    fx: null,
    scheduledDepositThbMinor: null,
  };

  it.each(LOCALES)('renders %s rather than falling back to Thai', (locale) => {
    // A pinned document in a locale missing from `quotation.ts`'s renderable set renders
    // `localeDegraded: true` — the customer gets Thai. That is a silent failure with no
    // symptom on any other page.
    const rendered = printableQuotation({ ...DOCUMENT, pinnedLocale: locale });

    expect(rendered.localeDegraded, `${locale} is offered but not renderable`).toBe(false);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ AND THE TAG IT RENDERS THEM WITH MUST BE THE ONE ICU KNOWS.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The sibling failure to the one above, and it survived that fix: `quotation.ts` knew Lao was
 * *renderable* and still handed `Intl` the project's own `la`, which is Latin. ICU has no
 * data for it, so it does not throw and does not visibly fall back — it answers in American
 * English. A Lao quotation grouped its total with commas where Lao uses points, and printed
 * its date in English, for every customer who ever chose Lao.
 *
 * `quotation.ts` now keeps its own `INTL_TAGS`, a copy of `INTL_TAG` here, for the same
 * unavoidable reason it keeps its own renderable set: this package depends on `@wewin/core`,
 * so the reverse import would be a cycle. A copy nothing compares is a copy that drifts, and
 * this file is again the only place both are visible at once.
 *
 * ⚠️ Asserted through **rendered output**, not by reaching for the private table. What
 * matters is not that two objects match but that the document comes out in the right
 * language — a test that read the constant would pass against a table that no call site used,
 * which is exactly the bug being fixed.
 */
describe('every storefront locale renders through the tag ICU knows', () => {
  const DOCUMENT: PinnedDocument = {
    revision: 1,
    documentHash: 'deadbeef',
    pinnedLocale: 'th',
    destinationCountry: null,
    taxBasis: 'exclusive',
    orderNo: 'WW-1000',
    contactName: null,
    submittedAt: '2026-08-07T00:52:17.000Z',
    vatRateBp: 700,
    leadTimeDays: 30,
    netThbMinor: 1_412_400n,
    vatThbMinor: 0n,
    grandTotalThbMinor: 1_412_400n,
    lines: [],
    charges: [],
    fx: null,
    scheduledDepositThbMinor: null,
  };

  it.each(LOCALES)('%s groups money the way its own locale does', (locale) => {
    /*
     * The reference is `Intl` asked directly with the mapped tag — never a hand-typed
     * `'฿14.124,00'`, which would pin today's CLDR and go red the day ICU moves a separator
     * for reasons that are not a bug. What is asserted is that core resolved the *same
     * locale* the rest of the product resolves, whatever that locale then chooses to do.
     */
    const expected = (14_124).toLocaleString(INTL_TAG[locale], { maximumFractionDigits: 0 });

    expect(printableQuotation({ ...DOCUMENT, pinnedLocale: locale }).grandTotalText).toBe(
      `฿${expected}.00`,
    );
  });

  it('⭐ Lao is Lao and not Latin — the failure this pins', () => {
    /*
     * The specific regression, named. `la` is a valid-looking tag ICU has no data for, so
     * `supportedLocalesOf` is empty and `NumberFormat` quietly resolves to `en-US`. Lao
     * groups with `.`; English with `,`. If core ever hands the raw project code to `Intl`
     * again, these two disagree.
     */
    expect(Intl.NumberFormat.supportedLocalesOf(['la'])).toStrictEqual([]);
    expect(Intl.NumberFormat.supportedLocalesOf(['lo-LA'])).not.toStrictEqual([]);

    const lao = printableQuotation({ ...DOCUMENT, pinnedLocale: 'la' });
    const english = printableQuotation({ ...DOCUMENT, pinnedLocale: 'en' });

    expect(lao.grandTotalText).toBe('฿14.124.00');
    expect(lao.grandTotalText).not.toBe(english.grandTotalText);
  });

  it('⭐ Lao dates are Lao, not English', () => {
    /*
     * `dateIn` had the identical bug and one more special case in front of it, so fixing
     * `money()` alone would have left a Lao quotation with a correctly grouped total above an
     * English date. `ສິງຫາ` is the Lao month name; the assertion is that the string is not the
     * English one rather than an exact date spelling, which ICU is entitled to revise.
     */
    const lao = printableQuotation({ ...DOCUMENT, pinnedLocale: 'la' }).submittedAtText;

    expect(lao).not.toMatch(/August/u);
    expect(lao).toBe(
      new Date('2026-08-07T00:52:17.000Z').toLocaleDateString(INTL_TAG.la, {
        timeZone: 'Asia/Bangkok',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
    );
  });

  it('Thai keeps its Buddhist calendar through the mapped tag', () => {
    /* The calendar is a separate fact from the language and had to survive the change:
     * 2569 and 2026 are two different documents to somebody reading one. */
    expect(printableQuotation({ ...DOCUMENT, pinnedLocale: 'th' }).submittedAtText).toMatch(/2569/u);
  });
});
