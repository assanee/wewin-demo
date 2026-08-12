import { describe, expect, it } from 'vitest';
import { printableQuotation, type PinnedDocument } from '@wewin/core/quotation';

import { LOCALES } from '../src/locales.js';

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
