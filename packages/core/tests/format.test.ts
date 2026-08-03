import { describe, expect, test } from 'vitest';
import { formatBaht, formatInteger, formatLength, formatSqm } from '../src/format.js';

/**
 * Spec section 1: "every number on screen goes through a formatter — no float
 * artifacts may escape". Section 11: no NaN, no -0.
 */

describe('formatBaht', () => {
  test('takes minor units and renders whole baht with separators', () => {
    expect(formatBaht(1_843_200n)).toBe('฿18,432');
    expect(formatBaht(150_000n)).toBe('฿1,500');
    expect(formatBaht(0n)).toBe('฿0');
  });

  test('rounds half up if handed unrounded satang', () => {
    // Totals arrive already rounded, but a stray caller must not get a third answer.
    expect(formatBaht(879_120n)).toBe('฿8,791');
    expect(formatBaht(61_440n)).toBe('฿614');
    expect(formatBaht(50n)).toBe('฿1');
  });

  test('renders a credit with the sign outside the symbol', () => {
    expect(formatBaht(-180_000n)).toBe('-฿1,800');
  });

  test('has no NaN or -0 case left to guard', () => {
    // v1 needed both: the arithmetic was float, so `-0` and `NaN` could reach the
    // screen and did — `pricing.ts` carried a `+ 0` for exactly that reason. A bigint
    // has neither value, so the defect is gone rather than defended against.
    expect(formatBaht(-0n)).toBe('฿0');
    expect(Object.is(Number(-0n), -0)).toBe(false);
  });
});

describe('formatSqm', () => {
  test('always shows two decimals, per spec section 5', () => {
    expect(formatSqm(5.12)).toBe('5.12');
    expect(formatSqm(3)).toBe('3.00');
    expect(formatSqm(1.5)).toBe('1.50');
  });

  test('does not let float dust through', () => {
    expect(formatSqm(0.1 + 0.2)).toBe('0.30');
  });

  test('falls back to 0.00 for a non-finite value', () => {
    expect(formatSqm(Number.NaN)).toBe('0.00');
  });

  test('normalises -0', () => {
    expect(formatSqm(-0)).toBe('0.00');
  });
});

/*
 * `formatCm(value: number)` and its four cases are gone, and this block is where they
 * went.
 *
 * Everything that formatter did — round to a tenth, trim the trailing `.0`, survive a
 * NaN — was repair work for centimetres held as floats. Its last caller went away when
 * the share link started carrying integer micrometres, and a public length formatter
 * taking a `number` is a standing invitation to divide before calling it, which is
 * exactly the lossy path the phase closed. `formatLength(um, 'cm')` answers the same
 * question from the canonical type, and the cases it inherits are pinned here.
 */
describe('formatLength', () => {
  test('renders whole centimetres without a trailing zero', () => {
    expect(formatLength(3_200_000n, 'cm')).toBe('320');
    expect(formatLength(1_600_000n, 'cm')).toBe('160');
  });

  test('keeps a half step when there is one', () => {
    expect(formatLength(1_605_000n, 'cm')).toBe('160.5');
    expect(formatLength(3_205_000n, 'cm')).toBe('320.5');
  });

  test('has no float dust to round away, in any metric unit', () => {
    // The old formatter existed because 160.3 cm arrived as 160.30000000000001. The
    // canonical value is an integer, so this is division-free string work now.
    expect(formatLength(1_603_000n, 'cm')).toBe('160.3');
    expect(formatLength(1_603_000n, 'mm')).toBe('1603');
    expect(formatLength(1_603_000n, 'm')).toBe('1.603');
  });

  test('reads imperial the way a tape is read, not as a decimal', () => {
    expect(formatLength(2_095_500n, 'in')).toBe('82 1/2"');
    expect(formatLength(1_270_000n, 'ft')).toBe(`4' 2"`);
    expect(formatLength(1_219_200n, 'ft')).toBe(`4'`);
    // Eighths reduce, and a value under an inch drops the leading zero it would
    // otherwise carry — a tape reads 3/8", never 0 3/8".
    expect(formatLength(9_525n, 'in')).toBe('3/8"');
  });

  test('a sub-foot value keeps its foot mark, because the parser reads that mark', () => {
    // The one place a leading zero survives: `1/8"` in a field set to feet would parse
    // back as an eighth of a foot. See the note in formatImperial.
    expect(formatLength(3_175n, 'ft')).toBe(`0' 1/8"`);
    expect(formatLength(3_175n, 'in')).toBe('1/8"');
  });
});

describe('formatInteger', () => {
  test('groups thousands for counts and lead times', () => {
    expect(formatInteger(14)).toBe('14');
    expect(formatInteger(1200)).toBe('1,200');
  });

  test('falls back to 0 for a non-finite value', () => {
    expect(formatInteger(Number.NaN)).toBe('0');
  });
});
