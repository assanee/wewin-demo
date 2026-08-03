import { describe, expect, test } from 'vitest';
import { formatBaht, formatCm, formatInteger, formatSqm } from '../src/format.js';

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

describe('formatCm', () => {
  test('drops a trailing .0 so whole centimetres read cleanly', () => {
    expect(formatCm(320)).toBe('320');
    expect(formatCm(160)).toBe('160');
  });

  test('keeps a half step when there is one', () => {
    expect(formatCm(160.5)).toBe('160.5');
    expect(formatCm(320.5)).toBe('320.5');
  });

  test('rounds to the nearest 0.1 rather than printing float dust', () => {
    expect(formatCm(160.30000000000001)).toBe('160.3');
  });

  test('falls back to 0 for a non-finite value', () => {
    expect(formatCm(Number.NaN)).toBe('0');
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
