import { describe, expect, test } from 'vitest';
import {
  BUSINESS_TIME_ZONE,
  FALLBACK_LOCALE,
  INTL_TAG,
  LOCALES,
  LOCALE_CALENDAR,
  LOCALE_ENDONYM,
  LOCALE_SCRIPT,
  type Locale,
  SOURCE_LOCALE,
  documentLocale,
  isLocale,
  negotiateLocale,
  notificationLocale,
  resolveLocale,
  resolveRenderLocale,
} from '../src/locales.js';

describe('the eight', () => {
  test('are the eight, and every table covers all of them', () => {
    expect([...LOCALES]).toEqual(['de', 'en', 'hi', 'la', 'my', 'th', 'vi', 'zh']);

    // `Record<Locale, …>` already makes a missing entry a compile error. This catches the
    // other direction — a stray entry for a locale that no longer exists — which the type
    // does not, and which would sit in the table looking authoritative.
    for (const table of [INTL_TAG, LOCALE_ENDONYM, LOCALE_SCRIPT, LOCALE_CALENDAR]) {
      expect(Object.keys(table).sort()).toEqual([...LOCALES].sort());
    }
  });

  test('Thai is both the source and the fallback', () => {
    expect(SOURCE_LOCALE).toBe('th');
    expect(FALLBACK_LOCALE).toBe('th');
  });

  test('isLocale refuses everything that is not one of them', () => {
    expect(isLocale('th')).toBe(true);
    expect(isLocale('th-TH')).toBe(false); // narrowing is `resolveLocale`'s job, not this one
    expect(isLocale('lo')).toBe(false);
    expect(isLocale('')).toBe(false);
    expect(isLocale(7)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The tag the project uses is not always the tag ICU knows
 * ------------------------------------------------------------------ */

const languageOf = (tag: string): string =>
  new Intl.NumberFormat(tag).resolvedOptions().locale.split('-')[0] ?? '';

describe('every locale reaches its own ICU data', () => {
  /**
   * The language each project tag actually *means*. `la` is the whole reason this test
   * exists: in BCP 47 it is Latin, ICU has no data for it, and the answer it gives back
   * instead is `en-US` — American grouping, American date order, in a language nobody
   * asked for and no error anywhere.
   */
  const MEANS: Readonly<Record<Locale, string>> = {
    de: 'de',
    en: 'en',
    hi: 'hi',
    la: 'lo',
    my: 'my',
    th: 'th',
    vi: 'vi',
    zh: 'zh',
  };

  test.each(LOCALES)('%s resolves to its own language, not to a substitute', (locale) => {
    expect(languageOf(INTL_TAG[locale])).toBe(MEANS[locale]);
  });

  test('the bare project tag for Lao is the trap this mapping exists to avoid', () => {
    // Documenting the failure, not asserting a preference: if a future ICU ships `la`
    // data this still holds, because the point is that `la` is not Lao either way.
    expect(languageOf('la')).not.toBe('lo');
    expect(INTL_TAG.la).toBe('lo-LA');
  });

  test('Devanagari and CJK are not the only scripts the fonts have to cover', () => {
    // Plan 8.3 names `hi` and `zh`. There are four non-Latin scripts among the eight,
    // and `my` renders its digits in Myanmar numerals as well as its words.
    const scripts = new Set(LOCALES.map((locale) => LOCALE_SCRIPT[locale]));
    expect([...scripts].sort()).toEqual(['devanagari', 'han', 'lao', 'latin', 'myanmar', 'thai']);
  });
});

/* ------------------------------------------------------------------ *
 * Narrowing a request
 * ------------------------------------------------------------------ */

describe('resolveRenderLocale', () => {
  test('keeps a region subtag from costing a customer their language', () => {
    expect(resolveRenderLocale('th-TH')).toEqual({
      requested: 'th-TH',
      rendered: 'th',
      fallback: false,
    });
    expect(resolveLocale('de-AT')).toBe('de');
    expect(resolveLocale('zh-Hans-CN')).toBe('zh');
    expect(resolveLocale('EN_gb')).toBe('en');
  });

  test('says so when it gave up, rather than reporting a match it did not make', () => {
    // Both render Thai. Only one of them is a match, and `notification_attempts.locale`
    // is the poorer for not being able to tell them apart.
    expect(resolveRenderLocale('th').fallback).toBe(false);
    expect(resolveRenderLocale('ko').fallback).toBe(true);
    expect(resolveRenderLocale('').fallback).toBe(true);
  });
});

describe('negotiateLocale', () => {
  test('honours q-values rather than header order', () => {
    expect(negotiateLocale('ko;q=0.9,de-DE;q=0.8,en;q=0.7').rendered).toBe('de');
  });

  test('an unweighted tag outranks a weighted one, per the spec default of q=1', () => {
    expect(negotiateLocale('en;q=0.5,vi').rendered).toBe('vi');
  });

  test('* is not a match, because answering "anything" with a guess is a wrong page', () => {
    expect(negotiateLocale('*').rendered).toBe('th');
    expect(negotiateLocale('*').fallback).toBe(true);
  });

  test('q=0 means explicitly refused', () => {
    expect(negotiateLocale('de;q=0,vi;q=0.1').rendered).toBe('vi');
  });

  test('an empty or unparseable header lands on the fallback and admits it', () => {
    expect(negotiateLocale('')).toEqual({ requested: '', rendered: 'th', fallback: true });
    expect(negotiateLocale('nonsense;;q=x').fallback).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Plan 10.6 — the two things that look like one
 * ------------------------------------------------------------------ */

describe('a notification uses the preference now', () => {
  test('an account preference beats the order it was placed under', () => {
    expect(notificationLocale({ accountLocale: 'en', contactLocale: 'th' }).rendered).toBe('en');
  });

  test('the order contact locale is used when there is no account preference', () => {
    // `users.preferred_locale` does not exist yet; a guest has no account at all.
    expect(notificationLocale({ accountLocale: null, contactLocale: 'vi' }).rendered).toBe('vi');
    expect(notificationLocale({ contactLocale: 'vi' }).rendered).toBe('vi');
  });

  test('nothing at all is the fallback, and is marked as one', () => {
    expect(notificationLocale({ accountLocale: '  ', contactLocale: '' })).toEqual({
      requested: '',
      rendered: 'th',
      fallback: true,
    });
  });
});

describe('a document uses the locale pinned at submit', () => {
  test('a reprint is the same document however the recipient has since changed', () => {
    // The property plan 10.6 asks for, and the reason `documentLocale` takes one
    // argument: there is no preference in scope for it to prefer.
    const pinned = 'de';
    const firstPrint = documentLocale(pinned);

    // …a year later, the customer now reads English and the notification path says so.
    expect(notificationLocale({ accountLocale: 'en', contactLocale: 'en' }).rendered).toBe('en');

    expect(documentLocale(pinned)).toEqual(firstPrint);
    expect(documentLocale(pinned).rendered).toBe('de');
  });

  test('a lost pin falls back and says so, rather than silently changing language', () => {
    expect(documentLocale(null)).toEqual({ requested: '', rendered: 'th', fallback: true });
    expect(documentLocale('kl').fallback).toBe(true);
  });
});

test('the business time zone is the one the company is in', () => {
  expect(BUSINESS_TIME_ZONE).toBe('Asia/Bangkok');
});
