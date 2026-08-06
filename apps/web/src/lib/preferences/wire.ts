import { CURRENCIES, type Currency } from '@wewin/core/money';
import { LENGTH_UNITS, type LengthUnit } from '@wewin/core/units';
import { LOCALES, isLocale, type Locale } from '@wewin/i18n/locales';

/**
 * `GET/PUT/DELETE /me/preferences`, as this storefront reads it — narrowed, never cast.
 *
 * ── Restated, not imported, and the debt is written down ─────────────────────────
 *
 * apps/api owns this shape (`src/profile/profile.contract.ts`) and this file is a second
 * copy of the parts the storefront uses. That is not laziness: `turbo boundaries` exists to
 * stop app-to-app reaching, apps/api is CommonJS with decorator metadata, and the shared home
 * for a wire type is `packages/contract` — where this one has not landed yet, because the API
 * round and the two screens are the same round and a shape defined in a package both rounds
 * edit is a shape neither round can review. `apps/dashboard/src/lib/api/errors.ts` records
 * exactly this debt for the error envelope; it is the precedent, and the resolution is the
 * same: when it lands in `@wewin/contract/profile`, delete everything above `decodePreferences`
 * and import instead.
 *
 * ── Narrowed rather than cast, for the reason `decodePrincipal` gives ────────────
 *
 * The shorthand — `body as PreferencesResponse` — is a cast on a value that arrived over a
 * network from a service versioned separately from this bundle, and it is how a field renamed
 * six weeks ago becomes `undefined` three components deep instead of a message at the point it
 * was read. Every narrower below throws with the field name.
 *
 * ── This module is pure, and that is what makes it testable ──────────────────────
 *
 * No `fetch`, no `window`, no React. It runs under plain Node in `tests/`, which is where the
 * decoding rules are actually pinned; `client.ts` next door is the part that cannot be tested
 * without a browser and holds nothing but the request.
 */

/** What is stored, exactly. `null` means "not set", never "the default somebody chose". */
export interface StoredPreferences {
  readonly preferredLocale: Locale | null;
  readonly displayCurrency: Currency | null;
  readonly displayLengthUnit: LengthUnit | null;
  /** ISO 8601, or `null` when the account has no preferences row at all. */
  readonly updatedAt: string | null;
}

/** Plan 10.6's live half: what a message from the API would actually be written in today. */
export interface MessageLocale {
  readonly requested: string | null;
  readonly rendered: Locale;
  readonly degraded: boolean;
  readonly translated: number;
  readonly total: number;
}

export const PREFERENCE_KINDS = ['locale', 'currency', 'lengthUnit'] as const;
export type PreferenceKind = (typeof PREFERENCE_KINDS)[number];

export const PREFERENCE_SURFACES = ['notification', 'document', 'storefront', 'dashboard'] as const;
export type PreferenceSurface = (typeof PREFERENCE_SURFACES)[number];

/**
 * "Preference *k* reaches surface *s*, or it does not" — as the API answers it.
 *
 * The screen renders this rather than deciding for itself, and that is the whole point of the
 * field existing on the wire: eight of the twelve are `false` today, for four separate and
 * individually correct reasons (documents are pinned, the storefront is cached, the ledger is
 * in baht, the foreign-currency line is closed by plan 13). A screen that decided locally
 * would be a second opinion that goes stale the day one of them changes.
 */
export interface PreferenceEffect {
  readonly preference: PreferenceKind;
  readonly surface: PreferenceSurface;
  readonly honoured: boolean;
}

export interface Preferences {
  readonly preferences: StoredPreferences;
  readonly messageLocale: MessageLocale;
  readonly effects: readonly PreferenceEffect[];
}

/** The body a PUT carries. All three keys, each nullable — the resource is replaced whole. */
export interface PreferencesRequest {
  readonly preferredLocale: Locale | null;
  readonly displayCurrency: Currency | null;
  readonly displayLengthUnit: LengthUnit | null;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`preferences: ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || typeof value === 'string') return value;
  throw new Error(`preferences: ${field} must be a string or null`);
}

function count(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`preferences: ${field} must be a count`);
  }
  return value;
}

/**
 * A member of a closed list, or `null`.
 *
 * A value the API sent that this build does not recognise becomes `null` rather than throwing.
 * That is the one place this module is lenient and it is deliberate: an API one release ahead
 * may offer a ninth currency, and a settings screen that refused to render at all because of a
 * value it could not put in a `<select>` would lock the person out of changing the two settings
 * it *does* understand. The unrecognised value is reported separately — `messageLocale.requested`
 * is verbatim for exactly this reason — so nothing is silently lost.
 */
function member<T extends string>(value: unknown, allowed: readonly T[], field: string): T | null {
  const text = nullableString(value, field);
  if (text === null) return null;
  return (allowed as readonly string[]).includes(text) ? (text as T) : null;
}

export function decodePreferences(body: unknown): Preferences {
  const root = object(body, 'body');
  const stored = object(root['preferences'], 'preferences');
  const message = object(root['messageLocale'], 'messageLocale');

  const rendered = nullableString(message['rendered'], 'messageLocale.rendered');
  if (rendered === null || !isLocale(rendered)) {
    // Unlike the fields above, this one has no honest `null`: `rendered` is what the reader
    // *will* get, the API guarantees it is one of the eight, and a screen that printed nothing
    // there would be silent about the substitution the field exists to announce.
    throw new Error('preferences: messageLocale.rendered must be one of the eight locales');
  }

  return {
    preferences: {
      preferredLocale: member(stored['preferredLocale'], LOCALES, 'preferredLocale'),
      displayCurrency: member(stored['displayCurrency'], CURRENCIES, 'displayCurrency'),
      displayLengthUnit: member(stored['displayLengthUnit'], LENGTH_UNITS, 'displayLengthUnit'),
      updatedAt: nullableString(stored['updatedAt'], 'updatedAt'),
    },
    messageLocale: {
      requested: nullableString(message['requested'], 'messageLocale.requested'),
      rendered,
      degraded: message['degraded'] === true,
      translated: count(message['translated'], 'messageLocale.translated'),
      total: count(message['total'], 'messageLocale.total'),
    },
    effects: decodeEffects(root['effects']),
  };
}

/**
 * The twelve statements, filtered to the ones this build understands.
 *
 * A row naming a surface or a preference added after this bundle was built is dropped rather
 * than rendered as an unlabelled row — there would be no sentence in any catalogue to put
 * beside it, and a settings screen showing a blank line with a tick next to it is worse than
 * one showing eleven statements.
 */
function decodeEffects(value: unknown): readonly PreferenceEffect[] {
  if (!Array.isArray(value)) throw new Error('preferences: effects must be an array');

  return value.flatMap((entry: unknown): PreferenceEffect[] => {
    const row = object(entry, 'effects[]');
    const preference = member(row['preference'], PREFERENCE_KINDS, 'effects[].preference');
    const surface = member(row['surface'], PREFERENCE_SURFACES, 'effects[].surface');
    if (preference === null || surface === null) return [];
    return [{ preference, surface, honoured: row['honoured'] === true }];
  });
}

/**
 * Is this preference worth offering on this screen at all?
 *
 * The storefront asks about the `storefront` surface. A control for a preference the reader's
 * own screen will not honour is not hidden — hiding it would make the *absence* the message,
 * which is exactly the failure "no reviews yet on 81 pages" is about in plan 9.5 — it is shown
 * with the honest note beside it. This is what decides which note.
 */
export function honours(
  effects: readonly PreferenceEffect[],
  preference: PreferenceKind,
  surface: PreferenceSurface,
): boolean {
  return effects.some(
    (effect) =>
      effect.preference === preference && effect.surface === surface && effect.honoured,
  );
}
