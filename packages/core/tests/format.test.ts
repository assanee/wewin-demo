import { describe, expect, test } from 'vitest';
import { formatBaht, formatInteger, formatLength, formatSqm } from '../src/format.js';

/**
 * Spec section 1: "every number on screen goes through a formatter — no float
 * artifacts may escape". Section 11: no NaN, no -0.
 */

describe('formatBaht', () => {
  test('takes minor units and renders baht with separators and two decimals', () => {
    expect(formatBaht(1_843_200n)).toBe('฿18,432.00');
    expect(formatBaht(150_000n)).toBe('฿1,500.00');
    expect(formatBaht(0n)).toBe('฿0.00');
  });

  test('⭐ reports the satang it was given rather than a rounded neighbour', () => {
    /*
     * This test used to be called "rounds half up if handed unrounded satang" and asserted
     * `฿8,791`, `฿614` and `฿1` for these same three inputs. The premise was that totals
     * arrive already whole, so the rounding could only ever tidy a stray caller. Payments
     * broke the premise: 7% VAT on a whole-baht net lands on satang, and an outstanding
     * balance is a subtraction. The rounding was then reporting a number nobody could
     * reconcile against a bank statement, so the owner had it removed.
     */
    expect(formatBaht(879_120n)).toBe('฿8,791.20');
    expect(formatBaht(61_440n)).toBe('฿614.40');

    /*
     * ⚠️ The three that cost the most, kept as the record of what the rounding did.
     * `50n` was the tie the old test pinned — half a baht owed, reported as a whole one.
     * `49n` is the one worth remembering: a real balance rendered as **nothing**, on a
     * red `ยังเหลือ …` error whose entire job is to name a shortfall.
     */
    expect(formatBaht(50n)).toBe('฿0.50');
    expect(formatBaht(49n)).toBe('฿0.49');
    expect(formatBaht(988_680n)).toBe('฿9,886.80');
  });

  test('renders a credit with the sign outside the symbol, and never a signed zero', () => {
    expect(formatBaht(-180_000n)).toBe('-฿1,800.00');
    expect(formatBaht(-1n)).toBe('-฿0.01');
    /* `0n` is not negative, so the sign is never printed for it — spec section 11. */
    expect(formatBaht(0n)).toBe('฿0.00');
  });

  test('has no NaN or -0 case left to guard', () => {
    // v1 needed both: the arithmetic was float, so `-0` and `NaN` could reach the
    // screen and did — `pricing.ts` carried a `+ 0` for exactly that reason. A bigint
    // has neither value, so the defect is gone rather than defended against.
    expect(formatBaht(-0n)).toBe('฿0.00');
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
