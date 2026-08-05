import { describe, expect, it } from 'vitest';

import {
  coverage,
  coverageOf,
  FALLBACK_LOCALE,
  formattersOf,
  message,
  normaliseLocale,
  parseAcceptLanguage,
  pinnedLocaleOf,
  preferredLocaleOf,
  renderIn,
  renderServerMessage,
  SERVER_MESSAGE_KEYS,
  SOURCE_LOCALE,
  SUPPORTED_LOCALES,
  thb,
  type SupportedLocale,
} from '../../src/i18n';

/**
 * The eight languages, and the two things that decide which one a reader gets.
 *
 * Plan 10.6 splits them: a **notification or a response** follows the reader's current
 * preference, a **document** follows the one pinned at `submit_for_payment`. Everything in
 * this file is one of those two, and the tests that matter most are the ones about what
 * happens when the answer is a language we do not have — because that is the state seven of
 * the eight are in, and will be in for as long as translation is a person's job (plan 13).
 */

describe('the eight', () => {
  it('is exactly the list the plan names, with Thai as source and fallback', () => {
    expect([...SUPPORTED_LOCALES]).toStrictEqual(['de', 'en', 'hi', 'la', 'my', 'th', 'vi', 'zh']);
    expect(SOURCE_LOCALE).toBe('th');
    expect(FALLBACK_LOCALE).toBe('th');
  });

  it('reads a region subtag, a script subtag and a case-mangled tag', () => {
    expect(normaliseLocale('th-TH')).toBe('th');
    expect(normaliseLocale('ZH_Hans_CN')).toBe('zh');
    expect(normaliseLocale('  DE  ')).toBe('de');
    expect(normaliseLocale('my-MM')).toBe('my');
  });

  it('answers null for something that is not one of the eight', () => {
    // `null` and not the fallback. "They asked for Klingon" and "they asked for Thai" are
    // different facts and the caller decides what to do with the first one; collapsing them
    // here would make an unrecognised tag indistinguishable from a satisfied one.
    expect(normaliseLocale('klingon')).toBeNull();
    expect(normaliseLocale('')).toBeNull();
    expect(normaliseLocale(undefined)).toBeNull();
    expect(normaliseLocale(42)).toBeNull();
  });
});

describe('Accept-Language', () => {
  it('takes the highest q among the languages we support', () => {
    // `fr` outranks everything and is not one of ours; the answer is the best of what is
    // left, not "nothing we can do".
    expect(parseAcceptLanguage('fr;q=1.0,de;q=0.8,en;q=0.9')).toBe('en');
    expect(parseAcceptLanguage('en-GB,en;q=0.9,th;q=0.8')).toBe('en');
  });

  it('breaks a tie by document order, which is what the grammar says', () => {
    expect(parseAcceptLanguage('vi;q=0.7,de;q=0.7')).toBe('vi');
    expect(parseAcceptLanguage('de;q=0.7,vi;q=0.7')).toBe('de');
  });

  it('drops q=0, which means *not this one*', () => {
    // Ranking it last instead of dropping it is the difference between "I would rather not"
    // and "absolutely not", and only one of those is what the header says.
    expect(parseAcceptLanguage('en;q=0')).toBeNull();
    expect(parseAcceptLanguage('en;q=0,th;q=0.1')).toBe('th');
  });

  it('does not let an out-of-range q outrank a well-formed one', () => {
    // `q=99` is clamped to 1 rather than believed, so it *ties* with a well-formed `q=1`
    // and loses to document order — it cannot jump the queue. Both directions are asserted,
    // because a single one of them would also pass if the clamp did nothing.
    expect(parseAcceptLanguage('en;q=1.0,de;q=99')).toBe('en');
    expect(parseAcceptLanguage('de;q=99,en;q=1.0')).toBe('de');
    // And a clamped q still loses to nothing, because nothing outranks 1.
    expect(parseAcceptLanguage('en;q=0.9,de;q=99')).toBe('de');
  });

  it('drops a q that is not a number at all', () => {
    // Unparseable is different from out of range: `banana` is not a preference expressed
    // badly, it is no preference, and ranking it as 1 would let a typo choose a language.
    expect(parseAcceptLanguage('de;q=banana,en')).toBe('en');
    expect(parseAcceptLanguage('de;q=banana')).toBeNull();
  });

  it('answers null rather than Thai when the header names nothing we have', () => {
    // The caller may have a better source — an account preference, an order's contact
    // locale — and a header that quietly resolved to Thai would outrank all of them.
    expect(parseAcceptLanguage('fr,es;q=0.9')).toBeNull();
    expect(parseAcceptLanguage('')).toBeNull();
    expect(parseAcceptLanguage(undefined)).toBeNull();
  });
});

describe('whose preference wins — plan 10.6, the live half', () => {
  it('account, then the order’s contact locale, then the request', () => {
    expect(preferredLocaleOf({ accountLocale: 'en', contactLocale: 'th', requestLocale: 'de' })).toBe('en');
    expect(preferredLocaleOf({ contactLocale: 'th', requestLocale: 'de' })).toBe('th');
    expect(preferredLocaleOf({ requestLocale: 'de' })).toBe('de');
    expect(preferredLocaleOf({})).toBeNull();
  });

  it('treats blank and null the same as absent', () => {
    expect(preferredLocaleOf({ accountLocale: '   ', contactLocale: 'th' })).toBe('th');
    expect(preferredLocaleOf({ accountLocale: null, contactLocale: 'th' })).toBe('th');
  });
});

describe('what a document pins — plan 10.6, the frozen half', () => {
  it('narrows to one of the eight at the moment of pinning', () => {
    expect(pinnedLocaleOf('vi')).toBe('vi');
    expect(pinnedLocaleOf('zh-Hant-TW')).toBe('zh');
  });

  it('is total, because rows exist that were pinned before this rule did', () => {
    // ⚠️ `order_documents.pinned_locale` is `text` and the request schema was
    // `z.string().min(2).max(16)` — `klingon` is a value that is really in the column shape.
    // A reprint of such a row still has to produce a document, and it produces the one it
    // was always rendered as.
    expect(pinnedLocaleOf('klingon')).toBe('th');
    expect(pinnedLocaleOf('')).toBe('th');
  });

  it('does not re-negotiate — a document ignores who is reading it', () => {
    // The whole point of pinning. `renderIn` takes the pinned locale and nothing else; there
    // is no parameter on it for the reader's preference, which is what stops a reprint from
    // coming out in a different language than the original.
    const value = message('error.http.busy');
    expect(renderIn(value, 'en').text).toBe(
      'The service is handling a lot of requests right now. Please try again.',
    );
    expect(renderIn(value, 'th').text).toBe('ระบบกำลังมีคำขอพร้อมกันจำนวนมาก กรุณาลองใหม่อีกครั้ง');
  });
});

describe('degrading to Thai, visibly', () => {
  it('renders an untranslated key in Thai and says so', () => {
    const rendered = renderServerMessage(message('error.slip.reviewer_is_submitter'), 'de');

    expect(rendered.text).toBe(
      'ผู้ตรวจสลิปต้องไม่ใช่ผู้อัปโหลดสลิปใบเดียวกัน — การตรวจด้วยคนคือมาตรการควบคุมเดียวของระบบนี้',
    );
    expect(rendered.locale.rendered).toBe('th');
    expect(rendered.locale.requested).toBe('de');
    expect(rendered.locale.degraded).toBe(true);
  });

  it('does not call a region subtag a degradation', () => {
    // ⭐ `degraded` is a field rather than something a reader derives from
    // `requested !== rendered`, because that expression is also true of `th-TH` → `th`. A
    // storefront that marked every Thai response as untranslated would be marking all of
    // them, which is the same as marking none.
    expect(renderServerMessage(message('error.http.busy'), 'th-TH').locale.degraded).toBe(false);
    expect(renderServerMessage(message('error.http.busy'), 'klingon').locale.degraded).toBe(false);
    expect(renderServerMessage(message('error.http.busy'), null).locale.degraded).toBe(false);
  });

  it('falls back per key, so a partial catalogue is used for what it has', () => {
    // The same request language, two keys, two answers. This is what makes shipping an
    // unfinished language worth doing at all.
    const covered = renderServerMessage(message('error.http.payload_too_large'), 'en');
    const uncovered = renderServerMessage(message('error.order.locked'), 'en');

    expect(covered.locale.rendered).toBe('en');
    expect(covered.locale.degraded).toBe(false);
    expect(covered.text).toBe('The request body is larger than this endpoint accepts.');

    expect(uncovered.locale.rendered).toBe('th');
    expect(uncovered.locale.degraded).toBe(true);
    expect(uncovered.text).toBe('ออร์เดอร์นี้กำลังถูกแก้ไขอยู่ — กรุณาลองใหม่อีกครั้ง');
  });

  it('never produces a key, an empty string, or a placeholder', () => {
    // The failure this whole design exists to prevent. Every key, in every locale,
    // including the six with no catalogue at all.
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of SERVER_MESSAGE_KEYS) {
        /* Params are only reached for the parametric keys; a plausible set for each. */
        const value = paramsFor(key);
        const { text } = renderIn(value, locale);

        expect(text.length, `${key}/${locale}`).toBeGreaterThan(0);
        expect(text, `${key}/${locale}`).not.toContain(key);
        expect(text, `${key}/${locale}`).not.toContain('undefined');
        expect(text, `${key}/${locale}`).not.toContain('[object');
      }
    }
  });
});

describe('coverage is reported rather than claimed', () => {
  it('Thai is complete and is the only one that is', () => {
    expect(coverageOf('th').missing).toStrictEqual([]);
    expect(coverageOf('th').translated).toBe(SERVER_MESSAGE_KEYS.length);
  });

  it('English is partial and the other six are empty', () => {
    const en = coverageOf('en');
    expect(en.translated).toBeGreaterThan(0);
    expect(en.translated).toBeLessThan(en.total);

    for (const locale of ['de', 'hi', 'la', 'my', 'vi', 'zh'] as const) {
      expect(coverageOf(locale).translated, locale).toBe(0);
    }
  });

  it('reports every locale, so nothing is invisible', () => {
    expect(coverage().map((row) => row.locale)).toStrictEqual([...SUPPORTED_LOCALES]);
  });
});

describe('a locale change moves no money and no digits', () => {
  /*
   * ⭐ The property this round is required to hold, and it is the same one phase 2 pinned
   * for display units: rendering is a function *of* a value, never a change *to* it.
   *
   * Recovering the digits and comparing them to the input is stronger than comparing the
   * eight strings to each other, because all eight use `latn` today and a string comparison
   * would keep passing on the day one of them does not.
   */
  const AMOUNTS: readonly bigint[] = [0n, 1n, 40n, 552_960n, 1_972_224n, 123_456_789_012n];

  const digitsOf = (locale: SupportedLocale, text: string): string => {
    /* Build the locale's own 0–9 so a non-`latn` numbering system reads back correctly. */
    const zeroToNine = Array.from({ length: 10 }, (_, n) =>
      formattersOf(locale).count({ kind: 'count', value: n }),
    );

    return [...text]
      .map((character) => {
        const index = zeroToNine.indexOf(character);
        return index === -1 ? '' : String(index);
      })
      .join('');
  };

  it('renders the same satang in every one of the eight', () => {
    for (const minor of AMOUNTS) {
      const expected = minor.toString().padStart(3, '0');

      for (const locale of SUPPORTED_LOCALES) {
        const text = formattersOf(locale).money(thb(minor));
        expect(digitsOf(locale, text), `${locale} ${minor.toString()}`).toBe(expected);
      }
    }
  });

  it('keeps the sign, which is not a digit', () => {
    // `startsWith('-')` was the original assertion and it encoded an assumption ICU does
    // not share: Lao writes a negative amount `฿-0,40`, with the sign *after* the symbol.
    // It passed only because every locale was pinned to `en-US` grouping, which is the
    // three-formatter bug this round removed. What matters is that the sign is present and
    // that a positive amount does not carry one — where the locale puts it is the locale's
    // typography, exactly like where it puts the ฿.
    const MINUS = /[-\u2212]/;

    for (const locale of SUPPORTED_LOCALES) {
      expect(formattersOf(locale).money(thb(-40n)), locale).toMatch(MINUS);
      expect(formattersOf(locale).money(thb(40n)), locale).not.toMatch(MINUS);
    }
  });

  it('never renders a satang with one digit', () => {
    // `฿0.4` is forty satang written as four. The padding is part of the meaning.
    for (const locale of SUPPORTED_LOCALES) {
      const text = formattersOf(locale).money(thb(40n));
      expect(digitsOf(locale, text), locale).toBe('040');
    }
  });
});

/** A plausible `ServerMessage` for any key, so the completeness sweep can render them all. */
function paramsFor(key: (typeof SERVER_MESSAGE_KEYS)[number]) {
  switch (key) {
    case 'error.catalog.product_not_found':
      return message(key, { productId: { kind: 'code', value: 'awn-4t' } });
    case 'error.slip.over_allocated':
      return message(key, { seq: { kind: 'count', value: 2 }, remaining: thb(1n), requested: thb(2n) });
    case 'error.slip.foot_with_room_left':
      return message(key, { allocated: thb(1n), slip: thb(2n), roomLeft: thb(1n) });
    case 'error.slip.overpayment_not_acknowledged':
      return message(key, { excess: thb(1n) });
    case 'error.slip.overpayment_mismatch':
      return message(key, { acknowledged: thb(1n), excess: thb(2n) });
    case 'error.slip.foot_mismatch':
      return message(key, { allocated: thb(1n), slip: thb(2n), difference: thb(1n) });
    default:
      return message(key);
  }
}
