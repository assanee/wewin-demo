import { describe, expect, it } from 'vitest';
import { CURRENCIES, divRoundHalfUp, type Currency } from '@wewin/core/money';
import { formatCount, formatMoney, formatPlain } from '../src/format.js';
import { INTL_TAG, LOCALES, type Locale } from '../src/locales.js';
import {
  NARROW_SYMBOL,
  NUMBER_SPEC,
  SPECIFIED_CURRENCIES,
  SPECIFIED_LOCALES,
} from '../src/numberSpec.js';

/**
 * # The table is pinned at run time and **derived here**, and that is the whole bargain.
 *
 * `numberSpec.ts` writes out how each of the eight locales spells a number, because asking
 * the runtime produced two different answers in two runtimes: Chromium has no CLDR data
 * for `lo-LA` or `my-MM`, resolved both to `en-US`, and respelt the server's price after
 * hydration on every product page. The cost of a table is that a table goes stale, and
 * `numerals.ts` said so in its own header before this existed.
 *
 * This file is the payment. Every field of every entry is rebuilt from `Intl` on the
 * machine running the suite — which is Node with full ICU, the runtime that *does* have
 * the data — and compared. So:
 *
 *   · a ninth locale added without an entry fails here, loudly, rather than rendering badly
 *   · a CLDR revision that moves a separator fails here rather than shipping
 *   · the storefront still renders identically in every engine, because it never asks one
 *
 * The comparison is against **rendered output**, not only against the fields: a table that
 * is right field by field and assembled wrongly is still a wrong price, and `groupDigits`
 * is where an Indian lakh or a Burmese digit would go missing.
 */

const AMOUNTS = [0n, 1n, 42n, 768_000n, 1_280_000n, 123_456_789n, -768_000n, -1n] as const;

/*
 * `divRoundHalfUp`, not `/` — the reference has to round the way the code under test
 * rounds, or this asserts the rounding rule rather than the spelling. Truncating instead
 * made ฿1,234,567.89 come out one baht short and looked like a Burmese-digit bug.
 */
const intlWhole = (locale: Locale, currency: Currency, minorPerUnit: bigint, minor: bigint) =>
  new Intl.NumberFormat(INTL_TAG[locale], {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(divRoundHalfUp(minor, minorPerUnit));

describe('every locale in the project has an entry, and every entry is a locale', () => {
  it('covers exactly the eight', () => {
    expect([...SPECIFIED_LOCALES].sort()).toEqual([...LOCALES].sort());
    expect(Object.keys(NUMBER_SPEC).sort()).toEqual([...LOCALES].sort());
  });

  it('covers exactly the nine currencies', () => {
    expect([...SPECIFIED_CURRENCIES].sort()).toEqual([...CURRENCIES].sort());
    expect(Object.keys(NARROW_SYMBOL).sort()).toEqual([...CURRENCIES].sort());
  });
});

describe('the pinned spec is what ICU says, field by field', () => {
  for (const locale of LOCALES) {
    const tag = INTL_TAG[locale];
    const spec = NUMBER_SPEC[locale];

    it(`${locale} — digits`, () => {
      const plain = new Intl.NumberFormat(tag, { useGrouping: false, maximumFractionDigits: 0 });
      expect(spec.digits).toEqual(Array.from({ length: 10 }, (_u, d) => plain.format(d)));
    });

    it(`${locale} — decimal and group separators`, () => {
      const decimal = new Intl.NumberFormat(tag, {
        useGrouping: false,
        minimumFractionDigits: 1,
      })
        .formatToParts(1.5)
        .find((part) => part.type === 'decimal')?.value;
      const group = new Intl.NumberFormat(tag, { useGrouping: true, maximumFractionDigits: 0 })
        .formatToParts(1234567)
        .find((part) => part.type === 'group')?.value;

      expect(spec.decimal).toBe(decimal);
      expect(spec.group).toBe(group);
    });

    it(`${locale} — grouping style`, () => {
      // 1234567 is the discriminator: `1,234,567` in western grouping, `12,34,567` where a
      // lakh is a unit. Nothing smaller can tell the two apart.
      const chunks = new Intl.NumberFormat(tag, { maximumFractionDigits: 0 })
        .format(1234567)
        .split(spec.group);

      // The *count* of chunks does not discriminate — `1,234,567` and `12,34,567` are both
      // three. The width of the second-from-last one does: threes everywhere in western
      // grouping, twos above the first three in Indian.
      const secondFromLast = chunks[chunks.length - 2] ?? '';
      expect(spec.grouping).toBe(secondFromLast.length === 2 ? 'indian' : 'western');
    });

    it(`${locale} — currency layout`, () => {
      const parts = new Intl.NumberFormat(tag, {
        style: 'currency',
        currency: 'THB',
        currencyDisplay: 'narrowSymbol',
        maximumFractionDigits: 0,
      }).formatToParts(-7680);

      const order = parts.map((part) => part.type);
      const currencyAt = order.indexOf('currency');
      const minusAt = order.indexOf('minusSign');
      const literal = parts.find((part) => part.type === 'literal')?.value ?? '';

      expect(spec.currency.symbolFirst).toBe(currencyAt < order.indexOf('integer'));
      expect(spec.currency.minusAfterSymbol).toBe(minusAt > currencyAt);
      expect(spec.currency.gap).toBe(spec.currency.symbolFirst ? '' : literal);
    });
  }
});

describe('the assembled output is what ICU renders — not just the fields', () => {
  for (const locale of LOCALES) {
    it(`${locale} — money, whole baht, across eight amounts including negatives`, () => {
      for (const minor of AMOUNTS) {
        expect(formatMoney(locale, minor, 'THB')).toBe(intlWhole(locale, 'THB', 100n, minor));
      }
    });

    it(`${locale} — money, exact, in a zero-decimal currency and a two-decimal one`, () => {
      // A `number` is safe for these three and only these three: they are small enough to
      // be exact as doubles. Production never takes this route — `formatMoney` assembles
      // the decimal from `bigint` division precisely because ₫879,123,456,789,012,345 is
      // an ordinary amount and a double counts in tens there.
      const exact = (currency: Currency, digits: 0 | 2, value: number) =>
        new Intl.NumberFormat(INTL_TAG[locale], {
          style: 'currency',
          currency,
          currencyDisplay: 'narrowSymbol',
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        }).format(value);

      expect(formatMoney(locale, 1_234_567n, 'THB', 'exact')).toBe(exact('THB', 2, 12345.67));
      expect(formatMoney(locale, -1_234_567n, 'THB', 'exact')).toBe(exact('THB', 2, -12345.67));
      // VND has no minor unit at all: the exact rendering has no decimal mark to place.
      expect(formatMoney(locale, 1_234_567n, 'VND', 'exact')).toBe(exact('VND', 0, 1234567));
    });

    it(`${locale} — counts are grouped and plain integers are not`, () => {
      const grouped = new Intl.NumberFormat(INTL_TAG[locale], {
        maximumFractionDigits: 0,
        useGrouping: true,
      });
      const ungrouped = new Intl.NumberFormat(INTL_TAG[locale], {
        maximumFractionDigits: 0,
        useGrouping: false,
      });

      for (const value of [0, 7, 81, 1234, 1234567, -42]) {
        expect(formatCount(locale, value)).toBe(grouped.format(value));
        expect(formatPlain(locale, value)).toBe(ungrouped.format(value));
      }
    });
  }

  it('every currency symbol is the same string in all eight locales', () => {
    for (const currency of CURRENCIES) {
      const rendered = new Set(
        LOCALES.map(
          (locale) =>
            new Intl.NumberFormat(INTL_TAG[locale], {
              style: 'currency',
              currency,
              currencyDisplay: 'narrowSymbol',
            })
              .formatToParts(1)
              .find((part) => part.type === 'currency')?.value ?? '',
        ),
      );

      // If this ever fails, `NARROW_SYMBOL` has to become a locale × currency table and
      // the one-dimensional shortcut in `numberSpec.ts` is no longer available.
      expect([...rendered]).toEqual([NARROW_SYMBOL[currency]]);
    }
  });
});

describe('the guard can fail — the two runtimes really do differ', () => {
  it('a locale whose CLDR data is missing resolves to something else entirely', () => {
    // This is the shape of the browser's failure, reproduced with a tag Node also lacks:
    // `Intl` does not throw and does not warn, it answers in another language. That is why
    // the spec is a table — the same call in Chromium answers this way for `lo-LA` and
    // `my-MM`, which are two of the eight.
    const resolved = new Intl.NumberFormat('la').resolvedOptions().locale;
    expect(resolved).not.toBe('la');

    // And the consequence, made concrete: Lao groups with `.` while the fallback groups
    // with `,`, so the same amount comes out as two different strings.
    expect(new Intl.NumberFormat('lo-LA').format(7680)).not.toBe(
      new Intl.NumberFormat(resolved).format(7680),
    );
  });
});
