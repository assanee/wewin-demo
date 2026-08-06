import {
  PREFERENCE_KINDS,
  PREFERENCE_SURFACES,
  type PreferenceEffectWire,
  type PreferenceKind,
  type PreferenceSurface,
} from './profile.contract';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT A PREFERENCE ACTUALLY CHANGES — three preferences × four surfaces, all
 * twelve stated, including the eight that are `false`.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This table exists because of one failure mode, and it is the likeliest thing this round
 * could ship: **a preference nobody reads.** The column is there, the form saves, the toast
 * says saved, and nothing on any screen is different — for months, because the surfaces that
 * would have shown it are cached, pinned, or fixed per locale for reasons that are all
 * individually correct. Sections 4.1, 4.2, 8.2 and 10.6 each closed a door for a good
 * reason; nobody added up how many doors were left.
 *
 * So the API answers with the addition. A screen renders this list, so a screen cannot
 * imply an effect that does not exist, and a `false` that becomes a `true` is a one-line
 * diff in a file whose whole subject is that question.
 *
 * ── The rule that produced every `false` below ───────────────────────────────────
 *
 * **A preference is presentation. It never moves a canonical value, and it never reaches a
 * surface whose output was frozen for somebody else's benefit.** Two consequences do most
 * of the work:
 *
 *   *pinned* — plan 10.6: a document uses the language frozen at `submit_for_payment`,
 *   never the reader's current one. A quotation that reprints in a different language than
 *   the original is a document nobody can cite. `order_documents.pinned_locale` is the
 *   authority and `pinnedLocaleOf` is the only function that reads it; nothing in this
 *   directory can reach either.
 *
 *   *cached* — plan 8.2 trap 3: `apps/web` runs `revalidate = false`, so a value that
 *   varies per reader must not appear in a server render. One visitor's preference baked
 *   into a shared cache entry is served to everybody behind them, and nothing errors — the
 *   numbers are all correct, they are just answers to a question the second reader did not
 *   ask.
 */

/** `true` when a preference of this kind changes what this surface shows. */
type EffectTable = Readonly<Record<PreferenceKind, Readonly<Record<PreferenceSurface, boolean>>>>;

const EFFECTS: EffectTable = {
  /**
   * ── LOCALE ────────────────────────────────────────────────────────────────────
   */
  locale: {
    /*
     * ✅ Plan 10.6's live half, and the seam it was written against is now fillable.
     *
     * `RecipientLocaleSources.accountLocale` in `src/i18n/locales.ts` carries the comment
     * *"SEAM: `users.preferred_locale`, which does not exist yet"*. It exists now, as
     * `user_preferences.preferred_locale`. Filling that seam is a change to
     * `NotificationsRepository`'s query and to nothing else — by that file's own design —
     * and that repository is not this round's to edit. **Reported, not claimed:** this row
     * is `true` because the preference is the highest-priority source `preferredLocaleOf`
     * consults, and the join that hands it in is the one line still owed.
     */
    notification: true,
    /*
     * ❌ Never. Plan 10.6, and the one row in this table that must not change without a
     * lawyer and an accountant in the room: a document is a promise made in a language, and
     * re-rendering it in the reader's current one destroys the ability to cite it.
     */
    document: false,
    /*
     * ✅ — and by a mechanism that is worth naming, because it is the one that does not
     * touch a cached page.
     *
     * The storefront's language is a **path segment**, so it is in every cache key
     * structurally (`lib/routing.ts`). A preference therefore does not change what
     * `/th/products` renders; it changes *which URL the reader is sent to* — the profile
     * screen writes the `wewin.locale` cookie and navigates, exactly as `LanguagePicker`
     * already does, and `src/proxy.ts` reads that cookie on the next unprefixed request
     * under `Cache-Control: no-store`.
     */
    storefront: true,
    /*
     * ✅ The dashboard sends `x-wewin-locale` on every call and renders its own chrome in
     * Thai. `lib/i18n/locale.ts` has carried a ⚠️ for a round saying `setPreferredLocale`
     * is called by nothing; the profile screen is what calls it.
     */
    dashboard: true,
  },

  /**
   * ── CURRENCY — ❌ ON EVERY SURFACE, AND THAT IS THE HEADLINE ──────────────────
   *
   * Nine currencies are storable and not one of them is rendered anywhere today. This is
   * not an oversight to be fixed in the screen; it is four separate decisions that happen to
   * agree, and a preferences form that implied otherwise would be lying in a currency.
   */
  currency: {
    /*
     * ❌ Every amount in this system is THB minor units in `bigint` (`orders_currency_is_thb`),
     * and plan 13 keeps the whole foreign-currency line closed until the owner answers five
     * questions — whether an account exists at all, the real spread per currency measured
     * from five to ten actual transfers, the tolerance, the quote lifetime, OUR/SHA/BEN.
     * Rendering a converted amount in a notification would require a rate, and inventing one
     * is precisely what plan 13 exists to stop.
     */
    notification: false,
    /* ❌ Pinned with the other seven things frozen at submit (plan 7.13). */
    document: false,
    /*
     * ❌ Plan 8.2 trap 3, and the storefront's answer to it: **currency is fixed per locale**
     * (all eight resolve to THB today) so that money can render on the server, inside a page
     * that is prerendered once and served to everybody. `ProductCard` calls `f.baht(...)` in
     * a server component. Honouring a per-user currency there means either putting it in the
     * cache key — five currencies × 648 pages, splitting the crawl budget over pages with
     * identical text — or reading a cookie in a server component, which converts trap 3 into
     * trap 2 and turns 683 prerendered documents into 683 function invocations per request.
     * `apps/web/tests/cache-policy.test.ts` fails on both, deliberately.
     *
     * The variant-map trick that rescued the display unit does not transfer: five renderings
     * of one length are five short strings, and a currency conversion needs a *rate*, which
     * is a per-quote pinned value and not a constant this app holds.
     */
    storefront: false,
    /*
     * ❌ The dashboard reads the company's ledger, and the ledger is in baht. An operator
     * whose screen showed euros would be reading a number no invoice, no slip and no posting
     * agrees with.
     */
    dashboard: false,
  },

  /**
   * ── LENGTH UNIT ───────────────────────────────────────────────────────────────
   */
  lengthUnit: {
    /*
     * ❌ No notification template renders a measurement. When one does, this row is where
     * the decision gets made rather than where it gets discovered — and it should be `true`,
     * because a notification is per-recipient and never cached, which is the property that
     * makes a length safe to render per reader.
     */
    notification: false,
    /*
     * ❌ A document restates the unit the customer *typed in* — `enteredUnits` per line,
     * pinned at submit — and not the unit anybody is reading in today. Plan 4.1: the grid a
     * step warning is judged on is a property of the entry, and a reprint that changed it
     * would change which warnings the document appears to have raised.
     */
    document: false,
    /*
     * ✅ — and this is the one preference the storefront honours, through the mechanism
     * plan 8.2 trap 3 was answered with in phase 6b and which this round must not undo.
     *
     * The server renders **all five units** (`unitVariants.ts`) into the cached HTML and the
     * client island picks one. Every string in the page was produced by Node, once, from
     * `bigint` micrometres; the browser only ever chooses between them. So the cached page
     * always carries the `cm` default, no reader is served another reader's preference, and
     * a signed-in preference reaches the reader by moving the island's selection — never by
     * changing what was cached.
     */
    storefront: true,
    /*
     * ❌ The quote screen renders centimetres for every measured group, and says so: nobody
     * recorded what the customer originally typed, so centimetres is what that screen can
     * honestly state (`components/quotes/quote-api.ts`). An operator preference layered on
     * top would make the same line read differently to two colleagues discussing it on the
     * phone, which is worse than one unit everybody knows the name of.
     */
    dashboard: false,
  },
};

/**
 * The table as the wire carries it — a flat list, in a fixed order, all twelve rows.
 *
 * Built by sweeping both enums rather than written out, so a fourth surface or a fourth
 * preference cannot be added to the contract and quietly omitted from the answer: the
 * `Record` types above make the missing cell a compile error.
 */
export const PREFERENCE_EFFECTS: readonly PreferenceEffectWire[] = PREFERENCE_KINDS.flatMap(
  (preference) =>
    PREFERENCE_SURFACES.map((surface) => ({
      preference,
      surface,
      honoured: EFFECTS[preference][surface],
    })),
);

/** For the tests and for anything that wants one cell rather than the list. */
export function preferenceIsHonoured(
  preference: PreferenceKind,
  surface: PreferenceSurface,
): boolean {
  return EFFECTS[preference][surface];
}
