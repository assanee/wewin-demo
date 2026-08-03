import { describe, expect, test } from 'vitest';
import { formatBaht, formatCm, formatInteger, formatSqm } from '../src/format.js';

/**
 * Spec section 1: "every number on screen goes through a formatter — no float
 * artifacts may escape". Section 11: no NaN, no -0.
 */

describe('formatBaht', () => {
  test('groups thousands and prefixes the baht sign', () => {
    expect(formatBaht(18432)).toBe('฿18,432');
    expect(formatBaht(1500)).toBe('฿1,500');
    expect(formatBaht(0)).toBe('฿0');
  });

  test('rounds to whole baht — quotes are never quoted in satang', () => {
    expect(formatBaht(8791.2)).toBe('฿8,791');
    expect(formatBaht(614.4)).toBe('฿614');
    expect(formatBaht(0.5)).toBe('฿1');
  });

  test('renders -0 as ฿0, never "-฿0"', () => {
    expect(formatBaht(-0)).toBe('฿0');
    expect(formatBaht(-0.2)).toBe('฿0');
  });

  test('falls back to ฿0 for a non-finite value instead of printing NaN', () => {
    expect(formatBaht(Number.NaN)).toBe('฿0');
    expect(formatBaht(Number.POSITIVE_INFINITY)).toBe('฿0');
  });

  test('keeps negative amounts readable for future discount lines', () => {
    expect(formatBaht(-1800)).toBe('-฿1,800');
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
