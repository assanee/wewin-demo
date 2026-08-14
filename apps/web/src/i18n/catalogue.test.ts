import { describe, expect, test } from 'vitest';
import { UI_CATALOGUES } from './catalogues';
import { th } from './catalogues/th';
import { formattersFor } from './format';
import { parseMeasure } from '@wewin/core/units';
import type { PlainKey, UiKey } from './keys';
import { LOCALES, LOCALE_ENDONYMS, LOCALE_TAGS, SOURCE_LOCALE, type Locale } from './locales';
import { coverageOf, translatorFor, UI_KEYS } from './translate';
import { decodeNumber, decodeNumerals } from './testing/decode';

/*
 * The app's own prose: that the source catalogue is complete, that a lookup can never
 * fail invisibly, and that a partial catalogue is a *stated* condition rather than a
 * discovered one.
 */

/**
 * Run `body` with one entry missing from one catalogue, then put it back.
 *
 * ⚠️ **This exists because all eight catalogues are complete.** The fallback path used to
 * be observable for free — six locales were empty, so any key demonstrated it. Now none is,
 * and the mechanism did not stop mattering: it is what happens between a key landing in
 * Thai and the other seven catching up, which is how every future key arrives.
 *
 * Mutating the real catalogue rather than building a fake one is deliberate. A fake would
 * test a copy of `lookup`'s inputs; this tests `lookup`. The `finally` is not optional —
 * these modules are shared across every test in the file, so a gap left behind would
 * surface as an unrelated failure somewhere later and be very hard to trace back here.
 */
function withGap(locale: Locale, key: UiKey, body: () => void): void {
  // `PartialUiCatalogue` marks its properties readonly, which is right for every caller
  // except this one. The cast is the narrowest way to say so.
  const catalogue = UI_CATALOGUES[locale] as Record<string, unknown>;
  const saved = catalogue[key];

  delete catalogue[key];
  try {
    body();
  } finally {
    catalogue[key] = saved;
  }
}

describe('the source catalogue is the one that has to be complete', () => {
  test('Thai defines every key, and none of them is empty', () => {
    // `UiCatalogue` makes a missing Thai key a compile error, so this cannot fail while
    // that type holds. It is here for the thing the type cannot check: an entry that
    // exists and says nothing renders a blank heading and no fallback can rescue it,
    // because Thai *is* the fallback.
    for (const key of UI_KEYS) {
      const entry = th[key];
      if (typeof entry === 'string') expect(entry.trim().length).toBeGreaterThan(0);
      else expect(entry).toBeTypeOf('function');
    }
  });

  test('the key list is derived from Thai rather than kept beside it', () => {
    expect(UI_KEYS.length).toBe(Object.keys(th).length);
    expect(UI_KEYS.length).toBeGreaterThan(100);
  });

  test('no locale invents a key Thai does not have', () => {
    // A key only some catalogue knows about is a key no other language will ever be
    // asked for and no call site can reach. The type stops it; this catches a catalogue
    // that got there some other way.
    const known = new Set<string>(UI_KEYS);

    for (const locale of LOCALES) {
      for (const key of Object.keys(UI_CATALOGUES[locale])) {
        expect(known.has(key), `${locale} defines unknown key ${key}`).toBe(true);
      }
    }
  });
});

/**
 * One object carrying every param name any key takes, with a plausible value.
 *
 * Rendering all ~150 keys in all 8 locales needs *something* to interpolate, and an
 * empty object is not it: an entry that divides a `bigint` throws on `undefined`, so a
 * sweep with empty params tests the throw rather than the sentence. Passing a superset
 * exercises the real path — every formatter call, every catalogue arrangement — which
 * is what turns the sweep into evidence that the catalogue actually renders.
 *
 * TypeScript cannot check a superset against 150 different param types at once, so the
 * `as never` at the call site is the price. The per-key typing that pays for it is
 * enforced where it matters: in the catalogues, when the entries are written.
 */
const SAMPLE_PARAMS = {
  wordmark: 'WEWIN180',
  count: 3,
  minor: 879_100n,
  days: [10, 14] as const,
  span: [1_500_000_000_000n, 3_000_000_000_000n] as const,
  areaSqUm: 5_120_000_000_000n,
  minBillableSqUm: 1_500_000_000_000n,
  group: 'ความกว้าง',
  stepUm: 5_000n,
  gridUm: 5_000n,
  minUm: 600_000n,
  maxUm: 4_000_000n,
  unit: 'cm',
  skuCode: 'AWN4T-DW-GRN',
  qty: 2,
  lines: 3,
  pieces: 5,
  nickname: 'หน้าต่างห้องนอน 1',
  title: 'ตัวกรอง',
  legalName: 'บริษัท วีวิน180 จำกัด',
  makes: 'บานเกล็ดปรับระดับได้',
  serviceArea: 'จัดส่งและติดตั้ง',
  categories: 4,
  year: 2026,
  // The drawing keys take already-rendered numerals, because the SVG layer is the one
  // boundary a `bigint` may not cross (see `ratioOf` in `Configure.tsx`). The
  // formatting happens on the React side of it, in the locale's own formatter.
  size: '320 × 160 cm',
  width: '320',
  height: '160',
  invalid: false,
  /*
   * Reviews — plan section 9.
   *
   * `ratingSum`/`ratingCount` and not `sum`/`count`: `count` is already in this bag as a
   * `number` (pieces, items, designs) and a rating tally is a pair of `bigint`s straight
   * out of `product_review_stats`. Two params with one name and two types is how a shared
   * sample bag turns into a lie — and the names now match the view's columns, which is
   * where a reader goes to check them.
   *
   * They are a *pair* for the reason plan 9.5 gives: there is no key that renders an
   * average on its own, so there is no sample that could produce one.
   */
  ratingSum: 51n,
  ratingCount: 12n,
  hidden: 2n,
  remaining: 4n,
  stars: 4,
  index: 1,
  widthUm: 1_200_000n,
  heightUm: 2_100_000n,
  /*
   * Settings — plan section 10.
   *
   * `language`, `chosen` and `rendered` are endonyms, and they are the one class of
   * param that is legitimately an already-rendered string. The rule everywhere else is
   * that a param is a *value* so the locale's own formatter can present it; an endonym
   * is the exception because it is written in its own script *by definition* — ไทย is
   * ไทย on the German page too. Passing the locale code instead would put a copy of the
   * endonym table in all eight catalogues, and the eighth copy is where a typo lives.
   * The single table is `LOCALE_ENDONYMS`, which `SettingsScreen.tsx` reads.
   *
   * `translated`/`total` stay `number` and go through `f.plain`, so the Burmese page
   * gets Burmese digits. They are the coverage line's own pair, and — the same argument
   * `ratingSum`/`ratingCount` makes above — there is no key that renders a percentage
   * on its own, so a reader cannot be shown "83%" without being shown what of.
   */
  language: 'ไทย',
  currency: 'THB',
  /* Baht per one whole unit, as `thbPerUnitText` renders it — six places, never rounded to
     something tidier, because the tidy version is not the number the document pinned. */
  rateText: '27.238806',
  observedAt: '12 สิงหาคม 2569',
  chosen: 'မြန်မာ',
  rendered: 'ไทย',
  translated: 412,
  total: 496,
  // A fixed instant, not `new Date()`: a sample that moves is a test that can only fail
  // on a Tuesday.
  at: new Date('2026-03-14T04:00:00Z'),
  name: 'บานเกล็ดปรับระดับได้ 4 ใบ',
  /*
   * Payment and slips — plan section 12/13.
   *
   * `owedMinor`/`slipMinor` and not `minor`: `minor` is already bound above as
   * `879_100n` for `price.perPiece`, and an outstanding balance or a slip amount is a
   * different figure with a different shape of consequence — a param with one name and
   * two call sites is how this bag would stop meaning what its own comment says it means.
   *
   * ⚠️ Both end in `.24`/`.29` on purpose, not a round number. A sample divisible by 100
   * makes `p.owedMinor % 100n` render `00` whether or not the catalogue entry actually
   * divides — deleting the whole satang half of `payment.outstandingAmount` and
   * `payment.history.*` would still produce a non-empty string with no `undefined` in it,
   * which is everything the sweep below checks. `.29` is not arbitrary either:
   * `readSatang`'s doc comment in `packages/core/src/money.ts` singles it out as one of
   * the values `Math.trunc(parseFloat(text) * 100)` gets wrong (`0.29` becomes `28`), so
   * this sample keeps that exact hazard visible in the one place a reader here is most
   * likely to reach for a float instead of splitting the string.
   */
  owedMinor: 2_824_824n,
  slipMinor: 1_412_429n,
  sentAt: new Date('2026-03-14T04:00:00Z'),
  accountDigits: '1234567890',
  reason: 'ยอดเงินไม่ตรงกับที่แจ้ง',
  limitMib: 8,
  /*
   * Acting on your own order — the cancel and objection strings.
   *
   * `openedAt` is an already-rendered date, the same exception `observedAt` above is: the
   * component formats it through `f.date` because the wire carries an ISO string and a
   * catalogue entry that called `new Date()` on a param would be parsing, not presenting.
   *
   * ⚠️ Three separate money params rather than one `minor`, and none of them divisible by 100.
   * `minor` is already bound to `879_100n` for `price.perPiece`, and these are figures with a
   * different shape of consequence — the amount somebody is about to forfeit is not a unit
   * price. The three are also internally coherent (`held = forfeit + refund`, 1843267 =
   * 921634 + 921633), so a catalogue that swapped two of them in one sentence reads as
   * nonsense to a person rather than as three plausible numbers.
   */
  openedAt: '9 สิงหาคม 2569',
  heldMinor: 1_843_267n,
  forfeitMinor: 921_634n,
  refundMinor: 921_633n,
} as const;

describe('a lookup always returns a sentence', () => {
  test.each(LOCALES.map((locale) => [locale] as const))(
    '%s: every key renders, never empty, never a raw key',
    (locale: Locale) => {
      const { t } = translatorFor(locale);

      for (const key of UI_KEYS) {
        const text = t(key as never, SAMPLE_PARAMS as never);

        expect(text, `${locale} → ${key}`).toBeTypeOf('string');
        expect(text.length, `${locale} → ${key}`).toBeGreaterThan(0);
        expect(text, `${locale} → ${key}`).not.toBe(key);
        // The two ways an interpolation goes wrong without throwing.
        expect(text, `${locale} → ${key}`).not.toContain('undefined');
        expect(text, `${locale} → ${key}`).not.toContain('[object Object]');
      }
    },
  );

  test('a missing entry falls back to Thai and says it did', () => {
    /*
     * ⚠️ **The gap is synthetic now, and it has to be.**
     *
     * This test used to pick German and rely on its catalogue being empty. All eight are
     * complete, so there is no naturally missing entry left to observe — and the mechanism
     * did not stop mattering. It fires the moment a 347th key lands in Thai and the other
     * seven have not caught up, which is the ordinary way this app grows.
     *
     * So the gap is made here and put back in a `finally`. That exercises the real
     * `lookup`, through the real `translatorFor`, on the real catalogues — rather than
     * asserting against a state the app is no longer in.
     */
    withGap('de', 'catalog.heading', () => {
      const heading = translatorFor('de').td('catalog.heading');
      expect(heading.fallback).toBe(true);
      expect(heading.text).toBe('สินค้าทั้งหมด');
    });

    // Restored, and now it is German's own sentence rather than a fallback.
    expect(translatorFor('de').td('catalog.heading')).toEqual({
      text: 'Alle Produkte',
      fallback: false,
    });
    expect(translatorFor('en').td('catalog.heading')).toEqual({
      text: 'All products',
      fallback: false,
    });

    // And Thai is never "falling back" to itself — that distinction is what the
    // `lang="th"` marker at the call sites is switched on.
    expect(translatorFor('th').td('catalog.heading').fallback).toBe(false);
  });
});

describe('a fallback sentence still carries the reader’s own numbers', () => {
  test('words fall back to Thai; numbers do not fall back at all', () => {
    /*
     * The bargain the language picker announces, and the half of it that survives every
     * catalogue being complete: **the formatters follow the active locale even when the
     * words do not.** A German reader looking at a Thai sentence can still act on the
     * number in it, because the number is written the way they write numbers.
     *
     * Synthetic gap, for the reason given above — there is no empty catalogue left.
     */
    const params = {
      areaSqUm: 5_120_000_000_000n,
      minBillableSqUm: 1_500_000_000_000n,
    };

    withGap('de', 'configure.area.line', () => {
      const line = translatorFor('de').td('configure.area.line', params);

      expect(line.fallback).toBe(true);
      expect(line.text).toContain('พื้นที่');
      // German decimal commas inside a Thai sentence.
      expect(line.text).toContain('5,12');
      expect(line.text).toContain('1,50');
      expect(decodeNumerals(line.text, 'de')).toBe(
        translatorFor('th').t('configure.area.line', params),
      );
    });

    // And with the entry present, the words are German too.
    const own = translatorFor('de').td('configure.area.line', params);
    expect(own.fallback).toBe(false);
    expect(own.text).toContain('Fläche');
    expect(own.text).toContain('5,12');
  });

  test('and a price inside a fallback sentence is still the same price', () => {
    for (const locale of LOCALES) {
      const { t } = translatorFor(locale);
      const perPiece = t('price.perPiece', { minor: 879_100n });
      expect(perPiece).toContain(formattersFor(locale).baht(879_100n));
    }
  });
});

/**
 * Fix round 2: `SAMPLE_PARAMS.owedMinor`/`.slipMinor` were changed to end in `.24`/`.29`
 * rather than a round number, but that change is only half the fix — the sweep in
 * `describe('a lookup always returns a sentence', …)` above asserts only that the
 * rendered text is a non-empty string, is not the raw key, and contains neither
 * `'undefined'` nor `'[object Object]'`. Deleting the `% 100n` half of the inline split
 * from `payment.outstandingAmount` or any `payment.history.*` entry, in any or all of
 * the eight catalogues, would still produce a non-empty string containing none of those
 * — so that sweep would not move, whatever the sample. These two tests are the ones that
 * would actually fail.
 */
describe('the payment page never rounds a customer’s own money to whole baht', () => {
  /**
   * Extracts the baht digits and the two-digit satang pad from one rendered entry.
   *
   * The money is always the first thing in the template, so cutting at the first `·`
   * (present in every `payment.history.*` entry, absent from `payment.outstandingAmount`,
   * which is money and nothing else) isolates it from whatever comes after — which matters
   * because a German date can itself contain a literal `.` (`14. März 2026`), so "the first
   * `.` in the whole string" is not safe once a date is in play.
   */
  function bahtAndSatang(rendered: string): { readonly baht: string; readonly satang: string } {
    const separator = rendered.indexOf('·');
    const money = separator === -1 ? rendered : rendered.slice(0, separator);
    /*
     * ⚠️ `lastIndexOf`, and the change is the helper's, not the assertions'.
     *
     * `indexOf` was correct only while the baht half carried no group separator. Now that it
     * does — `f.bahtExact` groups it, so this screen and the quotation page print the same
     * `฿28,248.24` — German and Vietnamese group with `.` and the *first* dot in
     * `฿28.248.24` is a thousands separator, not the decimal point. That made this helper
     * report `28` baht and pass `24` satang through unnoticed.
     *
     * The satang separator is always a literal ASCII `.`: every one of these four entries is
     * built by `bahtExact`, which writes `${baht}.${satang}` itself rather than letting a
     * locale choose. So the last dot is the decimal point in all eight, grouped or not, and
     * this is the reading that was always meant.
     *
     * The two assertions below are untouched — the property being tested has not moved.
     */
    const dot = money.lastIndexOf('.');
    expect(dot, `${rendered} (locale money prefix: ${money})`).toBeGreaterThan(0);
    return { baht: money.slice(0, dot), satang: money.slice(dot + 1, dot + 3) };
  }

  test('payment.outstandingAmount keeps .24, in every locale', () => {
    for (const locale of LOCALES) {
      const rendered = translatorFor(locale).t('payment.outstandingAmount', {
        owedMinor: 2_824_824n,
      });
      const { baht, satang } = bahtAndSatang(rendered);

      // The baht half goes through `f.plain` — Myanmar digits in `my`, ASCII everywhere
      // else — so it is decoded back through the locale's own alphabet (derived from
      // `Intl` at test time, exactly as `decodeNumber`'s own header argues for) rather
      // than compared against a hand-typed literal.
      expect(decodeNumber(baht, locale), locale).toBe('28248');
      // The satang pad is deliberately ASCII in *every* locale and must never be
      // `f.plain`'d — it is a fixed two-digit fraction, not a counted quantity. Comparing
      // it as a literal string, not decoding it, is what catches the pad being routed
      // through a formatter by mistake: in `my` that would silently swap `24` for its
      // Myanmar digits, and a decode step would quietly launder the mistake away.
      expect(satang, locale).toBe('24');
    }
  });

  test('payment.history.submitted/accepted/rejected keep .29 — the reconciliation view, fix round 1', () => {
    const slipMinor = 1_412_429n;
    const sentAt = new Date('2026-03-14T04:00:00Z');

    for (const locale of LOCALES) {
      const { t } = translatorFor(locale);
      const entries = [
        t('payment.history.submitted', { slipMinor, sentAt }),
        t('payment.history.accepted', { slipMinor, sentAt }),
        t('payment.history.rejected', { slipMinor, reason: 'ยอดเงินไม่ตรงกับที่แจ้ง' }),
      ];

      for (const rendered of entries) {
        const { baht, satang } = bahtAndSatang(rendered);
        expect(decodeNumber(baht, locale), `${locale}: ${rendered}`).toBe('14124');
        expect(satang, `${locale}: ${rendered}`).toBe('29');
      }
    }
  });

  /**
   * Fix round 3 — F1: an overpayment is a negative `owedMinor`/`slipMinor` reaching this
   * exact template (`order_outstanding_thb_minor()` has no floor at zero, and the
   * slip-review screen's own copy treats an excess as a modelled case, not an error).
   * BigInt `/` and `%` truncate toward zero rather than floor, so the split these four
   * entries used before this fix rendered `-150n` as `-1.-50` and `-1n` as `0.-1` — the
   * minus landing inside the digits instead of in front of the amount.
   *
   * `-150n`/`-1n` are the exact figures the finding named, kept rather than swapped for
   * round numbers so this test pins the reported failure and not a paraphrase of it.
   * Every locale is checked, per `LOCALES` — not only Thai and Burmese — because the sign
   * bug lives in the shared split, not in any one catalogue's prose.
   */
  test('an overpayment renders the sign in front of the ฿, not truncated into the digits — fix round 3', () => {
    const owedMinor = -150n;
    const slipMinor = -1n;
    const sentAt = new Date('2026-03-14T04:00:00Z');

    for (const locale of LOCALES) {
      const { t } = translatorFor(locale);

      const outstanding = t('payment.outstandingAmount', { owedMinor });
      const outstandingSplit = bahtAndSatang(outstanding);
      expect(decodeNumber(outstandingSplit.baht, locale), `${locale}: ${outstanding}`).toBe('-1');
      expect(outstandingSplit.satang, `${locale}: ${outstanding}`).toBe('50');

      const entries = [
        t('payment.history.submitted', { slipMinor, sentAt }),
        t('payment.history.accepted', { slipMinor, sentAt }),
        t('payment.history.rejected', { slipMinor, reason: 'ยอดเงินไม่ตรงกับที่แจ้ง' }),
      ];

      for (const rendered of entries) {
        const { baht, satang } = bahtAndSatang(rendered);
        expect(decodeNumber(baht, locale), `${locale}: ${rendered}`).toBe('-0');
        expect(satang, `${locale}: ${rendered}`).toBe('01');
      }
    }
  });
});

describe('the two complete catalogues disagree where they must', () => {
  test('the era comes from the catalogue, not from the footer', () => {
    // The year was written into a Thai literal as พ.ศ. 2569. It is a param now, and
    // each catalogue converts it — which is the smallest possible demonstration that a
    // *value* in a key can mean different things in different languages.
    const params = { year: 2026, legalName: 'บริษัท วีวิน180 จำกัด' };

    expect(translatorFor('th').t('footer.copyright', params)).toContain('พ.ศ. 2569');
    expect(translatorFor('en').t('footer.copyright', params)).toContain('© 2026');
    // Ungrouped, in both. `f.integer` would produce `2,026`, which is not a year.
    expect(translatorFor('en').t('footer.copyright', params)).not.toContain('2,026');
  });

  test('word order really does move, so the params are load-bearing', () => {
    // Thai says `ลด${group} ${step}` as one clause. English needs the verb first, the
    // noun second and the amount last. A key that had shipped a pre-joined sentence
    // would have made this entry unwritable, which is the whole argument for params.
    const params = { group: 'ความกว้าง', stepUm: 5_000n, unit: 'cm' } as const;

    expect(translatorFor('th').t('measure.decrease', params)).toBe('ลดความกว้าง 0.5 cm');
    expect(translatorFor('en').t('measure.decrease', params)).toBe('Reduce ความกว้าง by 0.5 cm');
  });

  test('a counted noun agrees in English and does not in Thai', () => {
    expect(translatorFor('th').t('count.items', { count: 1 })).toBe('1 รายการ');
    expect(translatorFor('th').t('count.items', { count: 2 })).toBe('2 รายการ');
    expect(translatorFor('en').t('count.items', { count: 1 })).toBe('1 item');
    expect(translatorFor('en').t('count.items', { count: 2 })).toBe('2 items');
  });
});

describe('coverage is read from the catalogues, not maintained beside them', () => {
  test('all eight are complete', () => {
    /*
     * ⚠️ This assertion is the reverse of the one it replaces, which read "Thai is complete
     * and the untranslated six are not". That was true and deliberate: plan 13 called the
     * translations a bottleneck that is not code, and six empty catalogues were the honest
     * state rather than a placeholder. The six were translated on request and are shipped.
     *
     * What did **not** change is the argument for *content* — product names, option labels,
     * rule messages — which still goes through `ContentRef` in `content.ts` and is still a
     * person's job. This covers the UI shell only: a closed set of keys, which is what made
     * finishing it a bounded piece of work in the first place.
     */
    for (const locale of LOCALES) expect(coverageOf(locale), locale).toBe(1);
  });

  test('and the figure is derived, so removing one entry moves it', () => {
    /*
     * ⭐ Without this, the test above proves nothing.
     *
     * `coverageOf` could return a hardcoded 1 and every assertion here would still pass.
     * Taking one entry away and watching the number fall is the only thing that shows it is
     * counting the catalogue rather than reporting a constant — and it is the same check
     * that would catch the figure being maintained by hand beside the files again.
     */
    withGap('de', 'catalog.heading', () => {
      expect(coverageOf('de')).toBeLessThan(1);
      expect(coverageOf('de')).toBeGreaterThan(0.99);
      expect(coverageOf('th'), 'an unrelated locale must not move').toBe(1);
    });

    expect(coverageOf('de')).toBe(1);
  });

  test('the picker has a note to show, in every language, before it is needed', () => {
    /*
     * ⚠️ Asserted unconditionally, and it used to be skipped for any locale at full
     * coverage — which is now all of them, so the loop body would never run and the test
     * would pass by doing nothing.
     *
     * `LanguagePicker` renders this notice when coverage drops below 1. That happens the
     * day a key is added to Thai, in whichever language is behind — so the sentence has to
     * already exist in all eight rather than be written in the same hurry as the new key.
     */
    for (const locale of LOCALES) {
      expect(translatorFor(locale).t('locale.partial').length, locale).toBeGreaterThan(0);
    }
  });
});

describe('the eight locales themselves', () => {
  test('every one has a tag, an endonym and a catalogue', () => {
    for (const locale of LOCALES) {
      expect(LOCALE_TAGS[locale]).toBeTypeOf('string');
      expect(LOCALE_ENDONYMS[locale].length).toBeGreaterThan(0);
      expect(UI_CATALOGUES[locale]).toBeTypeOf('object');
    }
  });

  test('endonyms are distinct and are not translated', () => {
    // The picker has to be usable by someone who cannot read the page it is on, so a
    // German speaker must find "Deutsch" whatever language the site is currently in.
    expect(new Set(Object.values(LOCALE_ENDONYMS)).size).toBe(LOCALES.length);
    expect(LOCALE_ENDONYMS.de).toBe('Deutsch');
    expect(LOCALE_ENDONYMS.th).toBe('ไทย');
  });

  test('Thai is the source, and the source is what everything falls back to', () => {
    expect(SOURCE_LOCALE).toBe('th');
    expect(UI_CATALOGUES[SOURCE_LOCALE]).toBe(th);
  });

  test('the numbers a field asks for can be typed back into that field, in all eight', () => {
    // The German page read `60–600 cm · ทีละ 0,5` above a field that silently discards
    // `320,5`: `parseMeasure` returns `null`, the blur falls through to `group.defaultUm`,
    // and the window resizes because somebody changed language. Reproduced in Chromium —
    // de/`320,5` gave 300 cm, en/`320.5` gave 320.5 cm, same keystrokes.
    //
    // `MeasureInput` keeps its field ASCII deliberately and says so at the line. What was
    // missing was the *helper under it* obeying the same rule, so the instruction and the
    // control it labels agreed. This is that rule, asserted the only way that means
    // anything: every number the helper prints is fed back through the app's own parser.
    const NUMERAL = /[\p{Nd}][\p{Nd}.,'"/ ]*/gu;

    for (const locale of LOCALES) {
      const helper = translatorFor(locale).t('measure.helper', {
        minUm: 600_000n,
        maxUm: 6_000_000n,
        gridUm: 5_000n,
        unit: 'cm',
      });

      const numerals = helper.match(NUMERAL) ?? [];
      expect(numerals.length, `${locale}: ${helper}`).toBeGreaterThan(2);

      for (const numeral of numerals) {
        const typed = numeral.trim();
        expect(
          parseMeasure(typed, 'cm', { stepUm: 5_000n }),
          `${locale}: the helper says "${typed}", which the field rejects`,
        ).not.toBeNull();
      }
    }

    // And the control: the *readings* around it really are localised, so the exemption is
    // narrow rather than "this app does not localise numbers".
    expect(formattersFor('de').measure(3_205_000n, 'mm')).toBe('3205 mm');
    expect(formattersFor('de').measure(5_000n, 'cm')).toBe('0,5 cm');
    expect(formattersFor('de').entry(5_000n, 'cm')).toBe('0.5 cm');
  });

  test('`la` is Lao to this project, and no tag reaches Intl unmapped', () => {
    // The finding this replaces a wrong test with. `LOCALE_TAGS.la` used to be the string
    // `la`, on the stated grounds that ICU would resolve it to the root locale. It does
    // not: `la` is **Latin** in BCP 47, ICU has no data for it, and V8 falls through to
    // *the host's* default. Same app, same stored preference, same product, four browser
    // contexts — `en-US` → `฿5,000`, `de-DE` → `5.000 ฿`. A price that depends on the
    // reader's operating system is not a price.
    //
    // ⚠️ Which language `la` *names* is a business question nobody has answered (see
    // `@wewin/i18n`'s header). Lao is the working answer because `@wewin/core/money`
    // carries LAK and because its failure mode is visible — Lao month names to a Latin
    // reader — where the other is invisible.
    expect(LOCALE_TAGS.la).toBe('lo-LA');

    // The property that actually matters, and it holds for all eight: the tag this app
    // hands `Intl` resolves to the language it claims, rather than to whatever the host
    // happens to be configured as. Asserted through `resolvedOptions().locale`, which is
    // what ICU decided — not through a formatted string, which would agree with itself.
    for (const locale of LOCALES) {
      const resolved = new Intl.NumberFormat(LOCALE_TAGS[locale]).resolvedOptions().locale;
      expect(resolved.split('-')[0], `${locale} resolved to ${resolved}`).toBe(
        LOCALE_TAGS[locale].split('-')[0],
      );
    }
  });
});

/** A compile-time guard: `UI_KEYS` really is `UiKey[]` and not `string[]`. */
const KEYS_ARE_TYPED: readonly UiKey[] = UI_KEYS;
describe('typing', () => {
  test('the key list keeps its type', () => {
    expect(KEYS_ARE_TYPED.length).toBe(UI_KEYS.length);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ A MATERIAL BELONGS TO A PRODUCT, NEVER TO A STATUS OR A SHARED LABEL.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The owner's rule, in their own words: *"ที่ฉันพูดก่อนหน้าคือมีคำว่า อะลูมิเนียม อยู่ในสถานะ
 * หรือ หัวตาราง ซึ่งไม่ควรเป็นแบบนั้นเพราะวัสดุของสินค้าไม่เหมือนกัน"* — a material may sit in a
 * product's own attributes, and must not sit in a status or a heading, because those are shared
 * by every product.
 *
 * ⚠️ **This pins the rule, not the sentences.** An earlier round rewrote five keys across all
 * eight catalogues and every suite stayed green, because nothing asserted anything about their
 * text — the suite proved only that the structure held. Pinning the strings instead would be
 * worse than nothing: copy is meant to be edited, and a test that fails on every edit is a test
 * people delete. What must not come back is a *material noun on a shared surface*.
 *
 * ⚠️ The catalogue keys listed here are the shared ones by construction: the cancel panel is
 * gated on order state and never on product (`OrderActions.tsx:85`), the review intro renders
 * directly beneath whichever product was invited (`ReviewFormIsland.tsx:152`), and the pricing
 * notes describe how every order is priced.
 *
 * ⚠️ Deliberately NOT listed, and they must stay that way: `spec.material.value`, `home.hero.*`
 * and `about.intro`. Those describe a product's own attribute or the company, where naming
 * aluminium is correct — the company does make aluminium joinery, and every profile in the
 * catalogue is aluminium. Over-correcting them would be the mirror defect.
 */
const SILENT_KEYS: readonly PlainKey[] = [
  'about.stance.itemised.body',
  'review.form.intro',
  'orderActions.cancel.preFreezeNote',
  'orderActions.cancel.postFreezeNote',
];

/**
 * ⚠️ The exception, and it is what makes the rule precise.
 *
 * `home.pricing.formula.note` exists to make "options" tangible, and the thing that fills a
 * panel is one of exactly three: glass, louvre blades, or mesh (`KIT_INFILL`,
 * packages/core/src/data/products.ts:224). Naming all three is accurate for all 81 products and
 * is the fix. Naming only glass — which is what this key used to do — describes 53 of them and
 * silently omits the 4 insect screens and the 24 louvre products.
 *
 * So the invariant is not "no material" but "not one material as though it were universal": if
 * glass is named here, mesh must be too. That is exactly the state a revert would break.
 */
const ENUMERATING_KEY: PlainKey = 'home.pricing.formula.note';

/*
 * One entry per language, because a Thai search reaches none of the other seven — which is how
 * "cut aluminium" survived in all of them after the Thai was fixed. Materials only: the verbs
 * (ตัด / cut / schneiden) are excluded on purpose, since naming a process is not the defect.
 */
const MATERIAL_WORDS: Readonly<Record<Locale, readonly string[]>> = {
  th: ['อะลูมิเนียม', 'อลูมิเนียม', 'กระจก'],
  en: ['aluminium', 'aluminum', 'glass'],
  de: ['aluminium', 'glas'],
  vi: ['nhôm', 'kính'],
  zh: ['铝', '玻璃'],
  hi: ['एल्युमिनियम', 'एल्यूमिनियम', 'काँच', 'कांच'],
  my: ['အလူမီနီယမ်', 'မှန်'],
  la: ['ອາລູມິນຽມ', 'ແກ້ວ'],
};

/** The infill that no glass product has, in each language. */
const MESH_WORD: Readonly<Record<Locale, string>> = {
  th: 'มุ้ง',
  en: 'mesh',
  de: 'Gewebe',
  vi: 'lưới',
  zh: '纱网',
  hi: 'जाली',
  my: 'ဇကာ',
  la: 'ມຸ້ງ',
};

describe('⭐ no shared surface names a material', () => {
  for (const locale of LOCALES) {
    const { t } = translatorFor(locale);

    for (const key of SILENT_KEYS) {
      test(`${locale} · ${key}`, () => {
        const sentence = t(key).toLowerCase();

        for (const word of MATERIAL_WORDS[locale]) {
          expect(
            sentence.includes(word.toLowerCase()),
            `${key} in ${locale} names "${word}". This surface is shown for every product, and ` +
              'the catalogue spans ten categories — louvres, glass units and insect screens ' +
              'among them. Name what the sentence is actually about (the production ' +
              'commitment, made-to-order work) rather than one material. See ' +
              'packages/db/drizzle/0043 for the same fix on the transition descriptions.',
          ).toBe(false);
        }
      });
    }

    test(`${locale} · ${ENUMERATING_KEY} lists every infill, not just glass`, () => {
      const sentence = t(ENUMERATING_KEY).toLowerCase();
      const glass = MATERIAL_WORDS[locale].find((word) => sentence.includes(word.toLowerCase()));

      if (glass === undefined) return; // named no material at all, which is also fine

      expect(
        sentence.includes(MESH_WORD[locale].toLowerCase()),
        `${ENUMERATING_KEY} in ${locale} names "${glass}" but not ` +
          `"${MESH_WORD[locale]}". A panel is filled with glass, louvre blades OR mesh; ` +
          'naming one of the three here tells the 4 insect-screen and 24 louvre products ' +
          'that their price is made of something they do not have.',
      ).toBe(true);
    });
  }
});
