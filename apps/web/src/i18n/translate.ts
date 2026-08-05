import { UI_CATALOGUES } from './catalogues';
import { formattersFor, type Formatters } from './format';
import type { ParamKey, PlainKey, UiKey, UiParamsByKey } from './keys';
import { SOURCE_LOCALE, type Locale } from './locales';

/**
 * Looking a key up, and what happens when the locale has not got it.
 *
 * One rule, and it is the reason this file is separate from the catalogues:
 * **a lookup always returns a sentence.** Never an empty string, never `undefined`,
 * never the key itself. Those three are how an i18n layer fails in a way nobody
 * notices until a customer reads `catalog.empty.title` off a screen — and with six of
 * eight catalogues empty today, they would not be edge cases here, they would be the
 * normal path.
 *
 * So a miss falls through to Thai, the source language, and reports that it did.
 */

/**
 * Every key there is.
 *
 * Read off the Thai catalogue rather than written out again: Thai is typed
 * `UiCatalogue`, so its key set *is* `UiKey` and cannot drift from it. A hand-kept
 * second list is a list that goes stale, and the failure of a stale one is a key that
 * no coverage figure counts and no translator is ever asked for.
 */
export const UI_KEYS: readonly UiKey[] = Object.keys(UI_CATALOGUES.th) as UiKey[];

/**
 * An entry with its key forgotten.
 *
 * `UI_CATALOGUES[locale][key]` cannot be typed precisely while `key` is a variable —
 * the params differ per key, which is the point of the scheme. The one conversion in
 * this module is here, and what it stands in for is enforced at both ends: catalogues
 * are checked per key by `UiEntry<P>` when they are written, and call sites are
 * checked per key by `t`'s overloads when they are read.
 */
type OpaqueEntry = string | ((params: object, formatters: Formatters) => string);

export interface Lookup {
  readonly text: string;
  /** True when the active locale had no entry and Thai is standing in. */
  readonly fallback: boolean;
}

function lookup(locale: Locale, key: UiKey, params: object): Lookup {
  const own = UI_CATALOGUES[locale][key] as OpaqueEntry | undefined;
  const fallback = own === undefined && locale !== SOURCE_LOCALE;
  // Thai is `UiCatalogue`, so this side of the `??` is always defined — that is what
  // makes "a lookup always returns a sentence" a type-level fact rather than a habit.
  const entry: OpaqueEntry = own ?? (UI_CATALOGUES.th[key] as OpaqueEntry);

  // The formatters follow the *active* locale even when the words fall back to Thai.
  // A German visitor reading a Thai sentence should still see German numbers in it:
  // the number is the part they can read, and it is the part the sentence is about.
  const text = typeof entry === 'string' ? entry : entry(params, formattersFor(locale));

  return { text, fallback };
}

/**
 * Translate, with the params the key requires and nothing else.
 *
 * Two overloads rather than one optional argument: a key that carries values must not
 * be callable without them. `t('catalog.resultCount')` is the bug this shape makes
 * impossible — it would otherwise compile and render `undefined` inside a sentence.
 */
export interface Translate {
  <K extends PlainKey>(key: K): string;
  <K extends ParamKey>(key: K, params: UiParamsByKey[K]): string;
}

/** The same, when the caller needs to know whether it fell back to Thai. */
export interface TranslateDetailed {
  <K extends PlainKey>(key: K): Lookup;
  <K extends ParamKey>(key: K, params: UiParamsByKey[K]): Lookup;
}

const EMPTY: object = {};

export function translatorFor(locale: Locale): { t: Translate; td: TranslateDetailed } {
  const td: TranslateDetailed = ((key: UiKey, params?: object): Lookup =>
    lookup(locale, key, params ?? EMPTY)) as TranslateDetailed;

  const t: Translate = ((key: UiKey, params?: object): string =>
    lookup(locale, key, params ?? EMPTY).text) as Translate;

  return { t, td };
}

/**
 * How much of the app's prose this locale actually covers, 0…1.
 *
 * Not decoration. `LanguagePicker` shows it, because a visitor who picks Vietnamese
 * and gets Thai words with Vietnamese numbers deserves to be told that is what
 * happened rather than to conclude the site is broken. It is also the number that
 * makes progress on the translation bottleneck visible without anyone counting files.
 */
export function coverageOf(locale: Locale): number {
  const { translated, total } = coverageCountsOf(locale);
  return translated / total;
}

/**
 * The same figure as two integers rather than a ratio.
 *
 * `LanguagePicker` needs the counts, not the quotient, and the reason is the one finding
 * this round could not fix with a translation: **the notice that says "not translated yet"
 * is itself untranslated**, because the only locales it can appear in are the ones with no
 * catalogue to say it in. It renders in Thai, to a reader who by definition does not read
 * Thai, which is the same as not rendering at all.
 *
 * Two integers and an endonym are language-neutral. `Deutsch 0/158 · ไทย 158/158` tells a
 * German reader exactly what they are getting without anyone inventing a German sentence —
 * and inventing one is the thing plan 13 forbids. The Thai sentence stays beside it,
 * marked `lang="th"`, for whoever can use it.
 */
export function coverageCountsOf(locale: Locale): { translated: number; total: number } {
  const total = UI_KEYS.length;
  if (locale === SOURCE_LOCALE) return { translated: total, total };

  const catalogue = UI_CATALOGUES[locale];
  return {
    translated: UI_KEYS.filter((key) => catalogue[key] !== undefined).length,
    total,
  };
}
