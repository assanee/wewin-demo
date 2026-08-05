import { LOCALES, SOURCE_LOCALE, type Locale, isLocale } from '@wewin/i18n/locales';

/**
 * Which language this dashboard asks the API to answer in.
 *
 * ── Imported, not restated ───────────────────────────────────────────────────────
 *
 * This file used to declare its own copy of the eight, with a note saying it had to because
 * `apps/api` is an app and `turbo boundaries` exists to stop app-to-app reaching. Both true;
 * the conclusion was wrong. The list does not belong to `apps/api` either — it belongs to
 * `@wewin/i18n`, which is a package, which any app may depend on, and which now owns the
 * tags, the endonyms and the narrowing rule as well.
 *
 * That mattered: with three copies, two of them already disagreed on `la` and on `en`.
 *
 * ── ⚠️ Why the dashboard sends a header at all, being Thai-first ─────────────────
 *
 * Because without one it would be *accidentally* multilingual. Staff laptops are commonly
 * configured `en-US`, the API honours `Accept-Language`, and its English catalogue is
 * deliberately partial (11 of ~100 keys). A Thai member of staff would therefore get a
 * screen with eleven English error messages and ninety Thai ones — not a translation, a
 * mixture, and one that looks like a rendering bug rather than a language setting.
 *
 * So this app states its preference explicitly. The default is Thai because the plan says
 * the dashboard is staff-facing and Thai-first; the preference is *changeable* because
 * "staff" is not a synonym for "Thai speaker", and the mechanism costs one header.
 */

export const SUPPORTED_LOCALES = LOCALES;

export type SupportedLocale = Locale;

/** Thai. Staff-facing and Thai-first — plan 8.4, and the only complete catalogue. */
export const DEFAULT_LOCALE: SupportedLocale = SOURCE_LOCALE;

/**
 * The header the API reads before `Accept-Language`.
 *
 * A header and not a query parameter: it has to reach every endpoint without appearing in
 * every call signature, and unlike `?locale=` it does not fragment a cache key or survive
 * into a URL somebody pastes into a ticket.
 */
export const LOCALE_HEADER = 'x-wewin-locale';

export const isSupportedLocale = isLocale;

const STORAGE_KEY = 'wewin.dashboard.locale';

/**
 * The staff member's chosen language, or Thai.
 *
 * ⚠️ **Today it can only ever return Thai, and that is worth saying out loud.** Nothing in
 * this app calls `setPreferredLocale`: there is no language control on any dashboard screen,
 * so the storage key this reads is a key nobody writes. The function is mutation-tested at
 * its own contract and *unreachable at the product* — a guard with no evidence behind it, in
 * the phrase this project uses for it.
 *
 * It is left in place rather than deleted because the missing half is a control, not a
 * mechanism, and building the control now would ship something worse than nothing: the API's
 * English catalogue covers 12 of ~100 keys, so a staff member who picked English would get
 * twelve English sentences among ninety Thai ones. That reads as a rendering bug, not a
 * language setting. The control lands when a catalogue is complete enough to be worth
 * choosing — which is plan 13's translator, not this round's code.
 *
 * Read from storage on every call rather than cached in a module variable, because two tabs
 * are the normal way this dashboard is used and a value cached at import time would leave
 * the second tab on the language the first one had when it opened.
 *
 * Every failure — no `window`, storage disabled by policy, a value from a build that
 * supported a language this one does not — answers Thai. A language preference is not worth
 * a thrown exception on a screen that was about to show somebody an error.
 */
export function preferredLocale(): SupportedLocale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isSupportedLocale(stored) ? stored : DEFAULT_LOCALE;
  } catch {
    /* Safari in private mode throws on `localStorage`. Thai, silently. */
    return DEFAULT_LOCALE;
  }
}

export function setPreferredLocale(locale: SupportedLocale): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* Nothing to recover: the next request asks for Thai, which is what it asked for before. */
  }
}
