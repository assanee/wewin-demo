import { char, check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { CURRENCIES } from '@wewin/core/money';
import { LENGTH_UNITS } from '@wewin/core/units';
import { users } from './auth.js';

/**
 * Per-user presentation preferences: locale, currency, measurement unit.
 *
 * ── All three are presentation, and the schema says so by holding nothing else ───
 *
 * Sections 4.1 and 4.2 settled this before there was any code: **the canonical value never
 * moves.** A length is µm in `bigint`, a price is THB minor units in `bigint`, and both stay
 * that way whatever anybody prefers to read. Phase 2 pinned it for units — `fromMicrons` is
 * for showing a number to a person, and only `toMicrons`, called on something a person
 * actually typed, may produce a new canonical length — and phase 6a pinned it for locale.
 *
 * The risk this table introduces, and the reason it is one table with three columns and
 * nothing else, is that a preference becomes **a fourth way to change a stored number**.
 * Three properties keep that unrepresentable rather than merely discouraged:
 *
 *   ⓵ **No money and no length live here.** There is no `bigint` in this file. A preference
 *      cannot be multiplied into anything because nothing here is a quantity.
 *   ⓶ **The column names carry the word `display`.** `display_currency`, not `currency`;
 *      `display_length_unit`, not `unit`. Every money column in this schema is named
 *      `*_thb_minor` precisely so that a rate applied to it reads as a mistake in the SQL;
 *      the same trick applied from the other end.
 *   ⓷ **Nothing references this table.** No order, no document, no ledger entry, no pin.
 *      A row here cannot be a term of a contract, which is what `order_documents.pinned_locale`
 *      is for and what plan 10.6 splits: a *notification* uses the recipient's current
 *      language, a *document* uses the language frozen at `submit_for_payment`. A reprint
 *      that came out in a different language than the original is a document nobody can cite.
 *
 * ── ⚠️ 8.2 trap 3: a signed-in preference must not un-cache the storefront ───────
 *
 * `apps/web` runs `revalidate = false` and fixes the currency per locale, and it keeps the
 * display unit inside a client island, precisely so that a cached page can never carry one
 * visitor's preference into another visitor's browser. **Reading this table during a
 * server render of a cached route would undo exactly that**, and it would do it silently —
 * the first symptom is one customer seeing another's currency.
 *
 * The schema cannot enforce a rendering rule, and pretending otherwise would be worse than
 * saying it plainly, so: the legitimate readers are the ones that are already per-recipient
 * and never cached — the notification worker (plan 10.6, current value at send time), the
 * dashboard, and the client island that already owns the unit toggle. That constraint lives
 * in `apps/web` and is not enforced here. It is written down here because this is the file
 * somebody opens when they are about to break it.
 *
 * ── A separate table, not three columns on `users` ───────────────────────────────
 *
 * Two reasons, and the second is the load-bearing one:
 *
 *   * `users` is deliberately "a person" and holds no email, no address and no settings.
 *     Presentation on that row would be the third kind of fact on it.
 *   * **`ERASURE_TREATMENTS` is derived from foreign keys.** Three nullable columns on
 *     `users` would be personal data that `tests/erasure.test.ts` structurally cannot see —
 *     the same blindness the ⚠️ on that constant already admits to for guest orders. A table
 *     with a foreign key forces the decision to be written down, and the decision is
 *     `delete`: a preference is not an accounting record, and a tombstone that still
 *     remembers somebody reads Burmese and thinks in inches is personal data being retained
 *     for no stated purpose at all.
 *
 * A missing row means "no preference", not "the defaults somebody chose". That is why every
 * column is nullable and why there is no row created at signup: the request's own
 * `Accept-Language` is the fallback, and a table full of `('th', 'THB', 'mm')` rows nobody
 * set would make it impossible to tell a choice from an absence.
 */

/** `in ('a', 'b')` for a CHECK, built from the same literal list the union comes from. */
const inList = (values: readonly string[]) =>
  sql.raw(`(${values.map((value) => `'${value}'`).join(', ')})`);

export const userPreferences = pgTable(
  'user_preferences',
  {
    /**
     * One row per person, and the primary key is the reference.
     *
     * `ON DELETE CASCADE` towards `users`, which is the fail-closed direction here and the
     * opposite of what `orders` and the spine do. Those hold accounting records and refuse;
     * this holds a display setting, and a preference outliving its owner is a leak with no
     * upside. Under the owner's never-delete decision the cascade never fires — `erase_user()`
     * deletes these rows by hand, like every other credential-shaped table — and it stays
     * for the same reason 0009 keeps the others: removing a guard because today's policy
     * makes it unreachable is how the next policy change becomes data loss.
     */
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onUpdate: 'cascade', onDelete: 'cascade' }),

    /**
     * The language this person reads, when they have said.
     *
     * ⚠️ **Shape, not membership, and that is a decision.** There is no CHECK enumerating
     * the eight locales, because the authority for that list is `LOCALES` in `@wewin/i18n`
     * and `packages/db` does not depend on that package — the dependency graph is
     * `core → db → api`, and putting an i18n build in front of every migration to gain a
     * list would be the wrong trade. A hand-copied list here would be a **fourth** copy
     * (i18n's `LOCALES`, the web's route segments, the request narrower) with no drift test
     * anywhere able to see it, which this repository's house rules call a guard with no
     * evidence.
     *
     * The precedent is already set and is followed rather than broken: `orders.contact_locale`
     * and `order_documents.pinned_locale` are plain `text` with no membership CHECK either,
     * and the narrowing that turns an arbitrary tag into a `Locale` (falling back to Thai)
     * already exists and already has to be total. So the CHECK below refuses obvious rubbish
     * — an empty string, a sentence, a case-shifted tag — and membership is the API's zod
     * schema, which can import the authority.
     */
    preferredLocale: text('preferred_locale'),

    /**
     * What prices are rendered in. **Never what anything is stored in** — plan 4.2: one base
     * currency, THB, plus a pinned rate, and `orders_currency_is_thb` is what holds that.
     *
     * The list comes from `CURRENCIES` in `@wewin/core/money` rather than being retyped, so
     * there is one definition and no mirror. `tests/review.test.ts` reads the constraint
     * back out of `pg_constraint` and fails if the two ever disagree — the same drift test
     * `tests/enums.test.ts` does for the catalogue's unions, and the reason a CHECK built
     * from an import is safe where a hand-copied list is not.
     */
    displayCurrency: char('display_currency', { length: 3, enum: CURRENCIES }),

    /**
     * What lengths are rendered in. `LENGTH_UNITS` from `@wewin/core/units`, same argument.
     *
     * `mm`, `cm`, `m`, `in`, `ft` — and note that the storefront's unit toggle is a client
     * island that already owns this choice for anonymous visitors. This column is what makes
     * the choice survive a new device for somebody who signed in; it is not a second place
     * the choice is made.
     */
    displayLengthUnit: text('display_length_unit', { enum: LENGTH_UNITS }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /*
     * A row that prefers nothing is a row that says nothing, and it is the row an UPDATE
     * that meant to clear one field leaves behind. Deleting the row is how "no preference"
     * is spelled — see the block comment on why an absence has to stay distinguishable.
     */
    check(
      'user_preferences_says_something',
      sql`num_nonnulls(${table.preferredLocale}, ${table.displayCurrency}, ${table.displayLengthUnit}) >= 1`,
    ),
    /* Shape and not membership. See the column. */
    check(
      'user_preferences_locale_shape',
      sql`${table.preferredLocale} is null or ${table.preferredLocale} ~ '^[a-z]{2}(-[A-Za-z0-9]{2,8})?$'`,
    ),
    check(
      'user_preferences_currency_known',
      sql`${table.displayCurrency} is null or ${table.displayCurrency} in ${inList(CURRENCIES)}`,
    ),
    check(
      'user_preferences_length_unit_known',
      sql`${table.displayLengthUnit} is null or ${table.displayLengthUnit} in ${inList(LENGTH_UNITS)}`,
    ),
  ],
);
