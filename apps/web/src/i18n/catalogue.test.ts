import { describe, expect, test } from 'vitest';
import { UI_CATALOGUES } from './catalogues';
import { th } from './catalogues/th';
import { formattersFor } from './format';
import { parseMeasure } from '@wewin/core/units';
import type { UiKey } from './keys';
import { LOCALES, LOCALE_ENDONYMS, LOCALE_TAGS, SOURCE_LOCALE, type Locale } from './locales';
import { coverageOf, translatorFor, UI_KEYS } from './translate';
import { decodeNumerals } from './testing/decode';

/*
 * The app's own prose: that the source catalogue is complete, that a lookup can never
 * fail invisibly, and that a partial catalogue is a *stated* condition rather than a
 * discovered one.
 */

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
    const { td } = translatorFor('de');

    // German has no catalogue at all today, so every key is the fallback path.
    const heading = td('catalog.heading');
    expect(heading.fallback).toBe(true);
    expect(heading.text).toBe('สินค้าทั้งหมด');

    // English has one, so it is not.
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
  test('German words fall back to Thai; German numbers do not fall back at all', () => {
    // This is the bargain the language picker announces. The words are Thai because
    // nobody has translated them (plan 13); the *number* is the part a German reader
    // can act on, and it is written the way they write numbers.
    const { td } = translatorFor('de');
    const line = td('configure.area.line', {
      areaSqUm: 5_120_000_000_000n,
      minBillableSqUm: 1_500_000_000_000n,
    });

    expect(line.fallback).toBe(true);
    expect(line.text).toContain('พื้นที่');
    expect(line.text).toContain('5,12');
    expect(line.text).toContain('1,50');
    expect(decodeNumerals(line.text, 'de')).toBe(
      translatorFor('th').t('configure.area.line', {
        areaSqUm: 5_120_000_000_000n,
        minBillableSqUm: 1_500_000_000_000n,
      }),
    );
  });

  test('and a price inside a fallback sentence is still the same price', () => {
    for (const locale of LOCALES) {
      const { t } = translatorFor(locale);
      const perPiece = t('price.perPiece', { minor: 879_100n });
      expect(perPiece).toContain(formattersFor(locale).baht(879_100n));
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
  test('Thai is complete and the untranslated six are not', () => {
    expect(coverageOf('th')).toBe(1);
    expect(coverageOf('en')).toBe(1);

    for (const locale of LOCALES) {
      if (locale === 'th' || locale === 'en') continue;
      // Zero today. The assertion is `< 1`, not `=== 0`: the first entry a translator
      // adds must not turn this test red, or the test becomes a reason not to translate.
      expect(coverageOf(locale), locale).toBeLessThan(1);
      expect(coverageOf(locale)).toBeGreaterThanOrEqual(0);
    }
  });

  test('the picker has a note to show for exactly the incomplete ones', () => {
    // `LanguagePicker` renders the notice when coverage < 1, so the notice has to exist
    // in the language the notice is about — or at least in its fallback.
    for (const locale of LOCALES) {
      if (coverageOf(locale) === 1) continue;
      expect(translatorFor(locale).t('locale.partial').length).toBeGreaterThan(0);
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
