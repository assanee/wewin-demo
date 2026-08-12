import { describe, expect, it } from 'vitest';

import {
  PREFERENCE_EFFECTS,
  PREFERENCE_KINDS,
  PREFERENCE_SURFACES,
  preferenceIsHonoured,
} from '../../src/profile';

/**
 * The table that says what a preference actually changes — pinned, including the `false`s.
 *
 * A table of booleans is the easiest thing in a codebase to "fix" by flipping a cell, and the
 * cells here are not opinions: they encode decisions taken in several different phases for
 * several different reasons, and every one of them is the kind of decision whose violation is
 * invisible on the screen where it happens.
 *
 * ⚠️ It has been flipped the *other* way once, which is why the last describe block below exists.
 * `locale/notification` and `locale/dashboard` were both `true` on the strength of a mechanism
 * that was nearly there, and the honest comment beside each one did nothing for the customer
 * looking at the tick it produced.
 *
 * So each assertion below names the rule rather than the value. If a cell has to change, the
 * test that goes red says which section of the plan is being overturned.
 */

const cell = (preference: string, surface: string): boolean | undefined =>
  PREFERENCE_EFFECTS.find(
    (effect) => effect.preference === preference && effect.surface === surface,
  )?.honoured;

describe('the effects table is complete and reachable', () => {
  it('states every preference against every surface, once', () => {
    // Non-vacuity first: every assertion below is a lookup into this list, and a list built by
    // a broken sweep would let them all pass by returning `undefined` — which is neither
    // `true` nor `false` and would sail past a `toBe(false)` written carelessly. The lookups
    // below are all `toBe(true)`/`toBe(false)`, which `undefined` fails; this pins the size.
    expect(PREFERENCE_EFFECTS).toHaveLength(PREFERENCE_KINDS.length * PREFERENCE_SURFACES.length);
    expect(PREFERENCE_EFFECTS).toHaveLength(12);

    const keys = PREFERENCE_EFFECTS.map((effect) => `${effect.preference}/${effect.surface}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('agrees with the single-cell accessor', () => {
    for (const effect of PREFERENCE_EFFECTS) {
      expect(preferenceIsHonoured(effect.preference, effect.surface), `${effect.preference}/${effect.surface}`).toBe(
        effect.honoured,
      );
    }
  });
});

describe('plan 10.6 — a document is not re-rendered for the reader', () => {
  it('no preference of any kind reaches a document', () => {
    /*
     * "เอกสาร ใช้ภาษาที่ตรึงตอน `submit_for_payment`" — a quotation, an invoice or a tax
     * document uses the language frozen with the other seven things at submit (plan 7.13), and
     * a reprint that came out in a different language is a document nobody can cite.
     *
     * Asserted for all three preferences and not only for the locale, because the same
     * argument covers the other two: the unit a line's measurements are written in was pinned
     * with `enteredUnits`, and the currency was pinned with the rate. A document that changed
     * any of the three between two prints is two documents.
     */
    const documentRows = PREFERENCE_EFFECTS.filter((effect) => effect.surface === 'document');
    expect(documentRows).toHaveLength(PREFERENCE_KINDS.length);
    expect(documentRows.every((effect) => effect.honoured === false)).toBe(true);
  });
});

describe('a reader’s display currency reaches no surface, even now that documents have one', () => {
  it('the currency preference is honoured nowhere', () => {
    /*
     * Every amount is THB minor units (`orders_currency_is_thb`). A converted amount needs a
     * rate, and a rate is resolved once inside a submit and frozen on the document — it is a
     * property of the *destination*, chosen by the company, not of whoever is reading.
     *
     * ⚠️ So the foreign-currency quotation shipping (`tax_countries.fx_currency`,
     * `QuotationRateService`, SG live) does not move these four cells, and this comment used to
     * rest on it being closed. `display_currency` is a different question and is still read by
     * nothing.
     *
     * This is the row a preferences screen is most likely to lie about, because the control is
     * trivial to build and the failure is silent: the form saves, and every number stays in
     * baht forever. The screens render this list rather than assuming, so they cannot.
     */
    const currencyRows = PREFERENCE_EFFECTS.filter((effect) => effect.preference === 'currency');
    expect(currencyRows).toHaveLength(PREFERENCE_SURFACES.length);
    expect(currencyRows.every((effect) => effect.honoured === false)).toBe(true);
  });
});

describe('plan 8.2 trap 3 — what the cached storefront may and may not carry', () => {
  it('honours the length unit on the storefront, because the island picks between server-rendered variants', () => {
    /*
     * The mechanism is `components/catalog/unitVariants.ts`: the server renders all five units
     * into the cached HTML and the client island indexes into them. Every string in the page
     * was produced by Node once from `bigint` micrometres, the cached page always carries the
     * `cm` default, and the browser only ever chooses. So a signed-in preference reaches the
     * reader by moving the island's selection — never by changing what was cached.
     */
    expect(cell('lengthUnit', 'storefront')).toBe(true);
  });

  it('refuses the currency on the storefront, because money is rendered on the server', () => {
    /*
     * `ProductCard` calls `f.baht(...)` in a server component, which is the whole reason
     * currency is fixed per locale. Honouring a per-user currency there means either the cache
     * key (five currencies × 648 pages) or a `cookies()` read in a server component — trap 3
     * converted into trap 2, and 683 prerendered documents becoming 683 function invocations
     * per request. `apps/web/tests/cache-policy.test.ts` fails on both.
     */
    expect(cell('currency', 'storefront')).toBe(false);
  });

  it('honours the locale on the storefront, because the locale is a path segment', () => {
    /*
     * The one preference the storefront can honour without touching a cached body: the
     * language is the first path segment, so it is in every cache key structurally. The
     * preference does not change what `/th/products` renders — it changes which URL the reader
     * is sent to, through the `wewin.locale` cookie that `src/proxy.ts` reads under
     * `Cache-Control: no-store`.
     */
    expect(cell('locale', 'storefront')).toBe(true);
  });
});

describe('a cell is true when something reads the stored value, not when something could', () => {
  it('does not honour the locale for notifications, because the worker never asks for it', () => {
    /*
     * ⭐ This assertion was `toBe(true)`, on the argument that a notification is per-recipient
     * and never cached — which is the reason it *would* be safe, not evidence that it happens.
     * It does not happen: `NotificationWorkerService.deliver` calls
     * `preferredLocaleOf({ contactLocale })` with no `accountLocale`, and
     * `NotificationsRepository` never selects `user_preferences.preferred_locale`. The row was
     * drawing a tick on `/[locale]/settings` beside "the language of emails we send you".
     *
     * Turning this back to `true` is legitimate only in the commit that adds the join. If this
     * test is what went red, that is the question being asked: does the worker read the
     * preference *now*?
     */
    expect(cell('locale', 'notification')).toBe(false);
  });

  it('does not honour the locale on the dashboard, which has no language control at all', () => {
    /*
     * Also `true` before, and on a claim about another app: "the profile screen is what calls
     * `setPreferredLocale`". Nothing in `apps/dashboard` calls it, there is no language control
     * on any dashboard screen, and `preferredLocale()` reads a staff browser's `localStorage`
     * rather than a customer's row in `user_preferences` — so this cell could not have been
     * satisfied by this API even in principle.
     */
    expect(cell('locale', 'dashboard')).toBe(false);
  });

  it('leaves exactly two cells true, and both are mechanisms that exist', () => {
    // The counter-assertion to the two above: this is not a table that has been flipped to
    // `false` everywhere to make a screen quiet. The storefront honours the language (a path
    // segment, so it is in the cache key structurally) and the display unit (five variants
    // rendered into the cached HTML, the island picks one). Both are traceable to a read.
    const honoured = PREFERENCE_EFFECTS.filter((effect) => effect.honoured).map(
      (effect) => `${effect.preference}/${effect.surface}`,
    );
    expect(honoured).toEqual(['locale/storefront', 'lengthUnit/storefront']);
  });

  it('does not yet honour the length unit for notifications, and that is a coverage fact', () => {
    // No template renders a measurement today. When one does this should become `true` for the
    // same reason the locale is true — per recipient, never cached — and this test is where
    // that gets noticed rather than where it gets discovered.
    expect(cell('lengthUnit', 'notification')).toBe(false);
  });
});
