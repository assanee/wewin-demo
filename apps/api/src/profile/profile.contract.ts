import { z } from 'zod';
import { CURRENCIES, type Currency } from '@wewin/core/money';
import { LENGTH_UNITS, type LengthUnit } from '@wewin/core/units';

import { SUPPORTED_LOCALES, type SupportedLocale } from '../i18n';

/**
 * The wire shape of a person's presentation preferences — locale, currency, length unit.
 *
 * ── Why the schema is here and not in `@wewin/contract` ──────────────────────────
 *
 * Every other request shape this API validates lives in `packages/contract`, because web
 * and dashboard read it too. This one does not, and the reason is ownership rather than
 * taste: this round's brief scopes the profile work to `apps/api/src/profile/**` and the
 * two screens, and `packages/contract` is shared with the reviews round happening beside
 * it. A shape defined in a package both rounds edit is a shape neither round can review.
 *
 * That is a debt with an owner and a shape: `preferencesRequestSchema` and
 * `PreferencesResponseWire` move to `@wewin/contract/profile` verbatim, and the two clients
 * stop restating them. `apps/dashboard/src/lib/api/errors.ts` records the same debt for the
 * error envelope, which is the precedent for writing it down rather than pretending.
 *
 * ── Membership is checked *here*, and that is the division `packages/db` asked for ──
 *
 * `user_preferences_locale_shape` in the schema is a shape check — `^[a-z]{2}(-…)?$` — and
 * `packages/db`'s own comment says why: `packages/db` cannot import `@wewin/i18n`, the
 * dependency graph is `core → db → api`, and a hand-copied list of eight locales in a
 * migration would be a fourth copy with no drift test able to see it. It names this layer
 * as the one that can import the authority. So it does: `SUPPORTED_LOCALES` is
 * `@wewin/i18n`'s list, `CURRENCIES` and `LENGTH_UNITS` are `@wewin/core`'s, and none of
 * the three is retyped anywhere in this directory.
 *
 * The consequence worth stating: the database will accept `'ja'` in that column and this
 * API will not. That is deliberate — the CHECK is the floor that holds for callers who do
 * not exist yet, and this is the answer for the caller who does.
 */

/**
 * PUT replaces the whole resource. All three keys are required and each may be `null`.
 *
 * Not a PATCH, and not `.optional()` on the three. "Absent" and "explicitly cleared" are the
 * two things a preferences form has to be able to say, and a schema where an omitted key
 * means "leave it alone" cannot express the second without a sentinel. A client that wants
 * to change one field sends back the other two as it read them, which is what PUT means and
 * is one fewer state for the service to reason about.
 *
 * All three `null` is legal and is how "I have no preferences" is spelled. It does not write
 * a row of nulls — `user_preferences_says_something` refuses one — it deletes the row. See
 * `ProfileService.replace`; `DELETE` is the same operation with no body.
 */
export const preferencesRequestSchema = z.strictObject({
  /*
   * The eight, by membership. `z.enum(SUPPORTED_LOCALES)` and not a regex: the column's
   * CHECK is already the regex, and repeating it here would leave `'ja'` — a well-formed tag
   * for a language with no catalogue — accepted by both layers and rendered by neither.
   */
  preferredLocale: z.enum(SUPPORTED_LOCALES).nullable(),
  /*
   * ⚠️ Nine currencies are storable and **none of them is honoured anywhere today** — see
   * `PREFERENCE_EFFECTS`. Accepting the value is not a promise to render it, which is the
   * whole reason the response carries the effects table beside the preferences.
   */
  displayCurrency: z.enum(CURRENCIES).nullable(),
  displayLengthUnit: z.enum(LENGTH_UNITS).nullable(),
});

export type PreferencesRequest = z.infer<typeof preferencesRequestSchema>;

/** What is stored, exactly. `null` means "not set", never "the default somebody chose". */
export interface PreferencesWire {
  readonly preferredLocale: SupportedLocale | null;
  readonly displayCurrency: Currency | null;
  readonly displayLengthUnit: LengthUnit | null;
  /** ISO 8601, or `null` when there is no row at all. */
  readonly updatedAt: string | null;
}

/**
 * Plan 10.6's live half, answered rather than assumed.
 *
 * A stored `preferredLocale` is a *request*, and the honest answer to it depends on whether
 * a catalogue entry exists — `resolveAgainst` is what decides, `degraded` is what says so.
 * Without this block a preferences screen would let somebody choose Burmese, save it, and
 * receive Thai forever with nothing on any screen explaining why.
 *
 * `translated`/`total` are counts and not a percentage, for the reason `coverageOf` gives:
 * a number is for a progress bar, and what a screen needs is something a reader can weigh.
 */
export interface MessageLocaleWire {
  /** Verbatim, as stored. `null` when nobody has expressed a preference. */
  readonly requested: string | null;
  /** What a message from this API would actually be written in today. */
  readonly rendered: SupportedLocale;
  /** True when the request was for a language this build has no catalogue for. */
  readonly degraded: boolean;
  readonly translated: number;
  readonly total: number;
}

export const PREFERENCE_KINDS = ['locale', 'currency', 'lengthUnit'] as const;
export type PreferenceKind = (typeof PREFERENCE_KINDS)[number];

export const PREFERENCE_SURFACES = ['notification', 'document', 'storefront', 'dashboard'] as const;
export type PreferenceSurface = (typeof PREFERENCE_SURFACES)[number];

/**
 * One statement of the form "preference *k* reaches surface *s*, or it does not".
 *
 * `honoured: false` is the interesting half. A stored preference that nothing reads is the
 * failure this whole round is most likely to ship — the column exists, the form saves, and
 * the reader never sees a difference — and the only defence against it is that the API says
 * out loud which of the twelve combinations is real.
 *
 * Deliberately **no prose**. A `reason` string here would be Thai UI copy in the API, which
 * this repository's house rules put in `@wewin/i18n` and its clients' catalogues. The value
 * is a pair of enums; the sentence is the screen's, keyed off the pair.
 */
export interface PreferenceEffectWire {
  readonly preference: PreferenceKind;
  readonly surface: PreferenceSurface;
  readonly honoured: boolean;
}

export interface PreferencesResponseWire {
  readonly preferences: PreferencesWire;
  readonly messageLocale: MessageLocaleWire;
  /** All twelve, always — including the false ones, which are the point. */
  readonly effects: readonly PreferenceEffectWire[];
}
