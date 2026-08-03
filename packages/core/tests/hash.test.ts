import { describe, expect, test } from 'vitest';
import { configHash } from '../src/hash.js';

/**
 * configHash is the dedupe key for quote lines (spec section 3): two lines with the
 * same sku_code and the same measurements are the same configuration.
 */

describe('configHash', () => {
  test('is stable across calls', () => {
    const a = configHash('AWN4T-DW-GRN-T5-NS0', { width: 320, height: 160 });
    const b = configHash('AWN4T-DW-GRN-T5-NS0', { width: 320, height: 160 });

    expect(a).toBe(b);
  });

  test('ignores the key insertion order of measures', () => {
    const a = configHash('AWN4T-DW-GRN-T5-NS0', { width: 320, height: 160 });
    const b = configHash('AWN4T-DW-GRN-T5-NS0', { height: 160, width: 320 });

    expect(a).toBe(b);
  });

  test('changes when the sku code changes', () => {
    const a = configHash('AWN4T-DW-GRN-T5-NS0', { width: 320, height: 160 });
    const b = configHash('AWN4T-DW-GRN-T5-NS1', { width: 320, height: 160 });

    expect(a).not.toBe(b);
  });

  test('changes when a measurement changes, including by half a centimetre', () => {
    const a = configHash('AWN4T-DW-GRN-T5-NS0', { width: 320, height: 160 });
    const b = configHash('AWN4T-DW-GRN-T5-NS0', { width: 320, height: 160.5 });

    expect(a).not.toBe(b);
  });

  test('does not collide when width and height are swapped', () => {
    const a = configHash('AWN4T-DW-GRN-T5-NS0', { width: 320, height: 160 });
    const b = configHash('AWN4T-DW-GRN-T5-NS0', { width: 160, height: 320 });

    expect(a).not.toBe(b);
  });

  test('returns a lowercase hex string of fixed length', () => {
    const hash = configHash('AWN4T-DW-GRN-T5-NS0', { width: 320, height: 160 });

    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test('handles an empty measure set', () => {
    expect(configHash('LVR3-DW-B150-MAN', {})).toMatch(/^[0-9a-f]{16}$/);
  });
});
