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
 * cells here are not opinions: four of them encode decisions taken in four different phases
 * for four different reasons, and every one of them is the kind of decision whose violation is
 * invisible on the screen where it happens.
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

describe('plan 13 — the foreign-currency line is closed, so no surface renders a preference', () => {
  it('the currency preference is honoured nowhere', () => {
    /*
     * Every amount is THB minor units (`orders_currency_is_thb`), and plan 13 keeps the whole
     * foreign line closed until the owner answers five questions — is there an account at all,
     * the real spread per currency measured from five to ten actual transfers, the tolerance,
     * the quote lifetime, OUR/SHA/BEN. Rendering a converted amount needs a rate, and the rate
     * is the thing that cannot be invented.
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

describe('plan 10.6 — the live half', () => {
  it('honours the locale for notifications', () => {
    // A notification is per-recipient and never cached, which is exactly the property that
    // makes a reader's current preference safe to honour there. `accountLocale` in
    // `RecipientLocaleSources` is the seam; the join that fills it is owed by the
    // notifications repository and is reported, not claimed. See profile.module.ts.
    expect(cell('locale', 'notification')).toBe(true);
  });

  it('does not yet honour the length unit for notifications, and that is a coverage fact', () => {
    // No template renders a measurement today. When one does this should become `true` for the
    // same reason the locale is true — per recipient, never cached — and this test is where
    // that gets noticed rather than where it gets discovered.
    expect(cell('lengthUnit', 'notification')).toBe(false);
  });
});
