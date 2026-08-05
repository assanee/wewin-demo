import { describe, expect, test } from 'vitest';
import { MESSAGE_KEYS, isMessage } from '@wewin/core/message';
import { type Currency, divRoundHalfUp, minorPerUnit } from '@wewin/core/money';
import {
  formatMeasure as coreMeasure,
  formatRange as coreRange,
} from '@wewin/core/format';
import { formatMeasure, formatMoney, formatRange } from '../src/format.js';
import { INTL_TAG, LOCALES, type Locale } from '../src/locales.js';
import { createTranslator } from '../src/translate.js';
import { produced } from './support/messages.js';
import { decodeInteger, deLocalise } from './support/decode.js';

/*
 * The property plan 4.1 and 4.5 pinned for display *units*, applied to display
 * *language*: switching it must never write a value back.
 *
 * Phase 2 could only test that property by exercising the round trip, because a display
 * unit is an input to the domain. A locale is not — core takes no locale at all — so the
 * claim here is stronger and cheaper: by the time the language is known the value is
 * already a finished string of digits, and all that remains is which glyphs to draw.
 *
 * These tests check that from the outside, by reading every rendering back.
 */

const translators = LOCALES.map((locale) => ({
  locale,
  tag: INTL_TAG[locale],
  translate: createTranslator(locale, { onIssue: () => undefined }),
}));

const thai = createTranslator('th', { onIssue: () => undefined });

describe('a message says the same thing in eight languages', () => {
  test.each(MESSAGE_KEYS)('%s decodes back to the Thai rendering, exactly', (key) => {
    const expected = thai.message(produced[key]);

    for (const { tag, translate } of translators) {
      // Only the glyphs may differ. Same digits, same order, same `≈`, same separators
      // between them — a locale that dropped a decimal place or reordered a range would
      // not survive being read back.
      expect(deLocalise(tag, translate.message(produced[key]))).toBe(expected);
    }
  });

  test('and the message itself is untouched by having been rendered eight times', () => {
    // A renderer that normalised a param in place would be invisible to every assertion
    // above and would corrupt the value on its way into localStorage or onto the wire.
    const message = produced['issue.range.outOfRange'];
    const before = JSON.stringify(message, (_key, value: unknown) =>
      typeof value === 'bigint' ? `${value.toString()}n` : value,
    );

    for (const { translate } of translators) translate.message(message);

    const after = JSON.stringify(message, (_key, value: unknown) =>
      typeof value === 'bigint' ? `${value.toString()}n` : value,
    );

    expect(after).toBe(before);
    // Still a sound `Message` by core's own guard — micrometres still `bigint`, not the
    // digit strings a careless round trip would have left behind.
    expect(isMessage(message)).toBe(true);
  });
});

describe('money', () => {
  const AMOUNTS: readonly bigint[] = [
    0n,
    1n,
    -1n,
    49n,
    50n,
    -50n,
    879_123n,
    1_234_567_800n,
    -1_234_567_800n,
    87_912_345_678_901_234_567n,
  ];

  test.each(LOCALES)('%s rounds to the same whole unit as core, to the satang', (locale) => {
    for (const minor of AMOUNTS) {
      const expected = divRoundHalfUp(minor, minorPerUnit('THB'));
      const decoded = decodeInteger(INTL_TAG[locale], formatMoney(locale, minor, 'THB'));

      // `decodeInteger` is a magnitude; the sign is checked separately below because
      // ICU expresses it differently per locale (`-฿1` vs `(฿1)` in some conventions).
      expect(decoded === expected || decoded === -expected).toBe(true);
    }
  });

  test.each(LOCALES)('%s renders an exact amount that reads back as the same minor units', (
    locale: Locale,
  ) => {
    for (const currency of ['THB', 'VND'] as const satisfies readonly Currency[]) {
      for (const minor of AMOUNTS) {
        const rendered = formatMoney(locale, minor, currency, 'exact');
        const decoded = decodeInteger(INTL_TAG[locale], rendered);

        // The whole round trip, in one line: minor units in, minor units out, through
        // eight numbering systems and three symbol placements.
        expect(decoded === minor || decoded === -minor).toBe(true);
      }
    }
  });

  test('a negative keeps its sign, and a rounded-away negative loses it', () => {
    for (const { locale, tag } of translators) {
      expect(formatMoney(locale, -1_234_567_800n, 'THB')).toContain('-');
      // -1 satang rounds to zero baht, and zero is not negative.
      expect(deLocalise(tag, formatMoney(locale, -1n, 'THB'))).not.toContain('-');
    }
  });
});

describe('lengths', () => {
  const LENGTHS: readonly bigint[] = [0n, 3_175n, 600_000n, 1_605_000n, 2_498_725n, 4_000_000n];

  test.each(LOCALES)('%s is core’s exact string with this locale’s glyphs', (locale) => {
    for (const um of LENGTHS) {
      for (const unit of ['mm', 'cm', 'm', 'in', 'ft'] as const) {
        expect(deLocalise(INTL_TAG[locale], formatMeasure(locale, um, unit))).toBe(
          coreMeasure(um, unit),
        );
        expect(deLocalise(INTL_TAG[locale], formatRange(locale, um, um + 500_000n, unit))).toBe(
          coreRange(um, um + 500_000n, unit),
        );
      }
    }
  });

  test('the eighth-inch grid survives eight numbering systems', () => {
    // 2,498,725 µm is exactly 98 3/8". A locale that reformatted the number rather than
    // the glyphs would have to choose a decimal and would lose the fraction.
    for (const { locale, tag } of translators) {
      expect(deLocalise(tag, formatMeasure(locale, 2_498_725n, 'in'))).toBe('98 3/8"');
    }
  });
});
