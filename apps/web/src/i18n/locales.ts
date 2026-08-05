import {
  INTL_TAG,
  LOCALES,
  LOCALE_ENDONYM,
  LOCALE_SCRIPT,
  SOURCE_LOCALE,
  type Locale,
  isLocale,
  resolveRenderLocale,
} from '@wewin/i18n/locales';

/**
 * The eight languages — **restated from `@wewin/i18n`, not redefined.**
 *
 * This file used to declare its own list, its own BCP 47 table and its own endonyms, and
 * `apps/api` declared a third set. Three lists is three lists that disagree at the edges,
 * and phase 6a's review found them already disagreeing on two of the eight:
 *
 *   `la` — this file mapped it to the tag `la`, which in BCP 47 is **Latin**, the dead
 *          language. ICU has no data for it, so `Intl` fell through to *the host's* default
 *          locale: the same page, the same stored preference and the same product rendered
 *          `฿5,000` on an `en-US` machine and `5.000 ฿` on a `de-DE` one. A price that
 *          depends on the reader's operating system is not a price.
 *   `en` — `en-US` here, `en-GB` there. A quotation dated 06/08 meant June in one surface
 *          and August in the other.
 *
 * Neither could be caught by a test inside one package, because no test in either package
 * could see the other. So the answer is not a better test: it is one table. Everything
 * below is a re-export, and the only thing this module still owns is the browser-preference
 * adapter at the bottom, which is a DOM concern and has no business in a package that must
 * compile without `navigator`.
 *
 * ⚠️ `la` is Lao here, and that is a **decision awaiting a human** (see `@wewin/i18n`'s
 * header). The brief names the eight as `de · en · hi · la · my · th · vi · zh` and
 * `@wewin/core/money` carries LAK, so Lao is what the business almost certainly means; but
 * `la` is genuinely Latin in BCP 47 and nobody has said so out loud. It is mapped to
 * `lo-LA` because that failure mode is *visible* — a Latin reader would see Lao month names
 * — while the other is invisible: an American number format silently served to a Lao reader.
 *
 * All eight are LTR (plan 8.3), so there is no bidi work anywhere in this app. Thai is the
 * source language and the fallback; the other seven catalogues are allowed to be — and
 * today mostly are — incomplete, and what is missing degrades to Thai, marked `lang="th"`
 * where it happens, and never to an empty string or a raw key.
 */

export { LOCALES, SOURCE_LOCALE, isLocale, type Locale };

/** BCP 47 tags, for `Intl` and for the `lang` attribute. Owned by `@wewin/i18n`. */
export const LOCALE_TAGS: Readonly<Record<Locale, string>> = INTL_TAG;

/**
 * What each language calls itself.
 *
 * Endonyms, not names in the current language: the whole point of the control is to be
 * findable by someone who cannot read the page they are looking at. A German speaker
 * stranded on a Thai page is looking for the word "Deutsch", and "เยอรมัน" is no help.
 *
 * These are the one set of strings that must never be translated, and therefore the one
 * set that is not in the catalogue.
 */
export const LOCALE_ENDONYMS: Readonly<Record<Locale, string>> = LOCALE_ENDONYM;

/** Which script each language is written in — for font stacks (plan 8.3). */
export { LOCALE_SCRIPT };

/**
 * Pick a locale from a browser's ordered preference list.
 *
 * Language-only matching: `de-AT` gets German, because this app has one German catalogue
 * and refusing it over a region subtag would hand an Austrian visitor Thai. The list is
 * walked in order, so the browser's own ranking decides.
 *
 * Returns `null` rather than `SOURCE_LOCALE` when nothing matches, so the caller can tell
 * "the visitor asked for Thai" apart from "the visitor asked for something we do not have".
 * Today both land on Thai; the difference matters the moment a banner offering a different
 * language exists.
 *
 * The narrowing itself is `@wewin/i18n`'s `resolveRenderLocale`, which is also what the API
 * negotiates `Accept-Language` with — so the language a visitor is greeted in and the
 * language an error comes back in cannot be decided by two different rules.
 */
export function negotiateLocale(preferences: readonly string[]): Locale | null {
  for (const preference of preferences) {
    const resolved = resolveRenderLocale(preference);
    if (!resolved.fallback) return resolved.rendered;
  }
  return null;
}
