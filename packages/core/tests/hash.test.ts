import { describe, expect, test } from 'vitest';
import { configHash } from '../src/hash.js';

/**
 * configHash is the dedupe key for quote lines (spec section 3): two lines with the
 * same sku_code and the same measurements are the same configuration.
 *
 * Measures are canonical micrometres, so the fixtures below are the same windows the
 * pre-micrometre version of this file used: 3,200,000 µm is 320 cm.
 */

describe('configHash', () => {
  test('is stable across calls', () => {
    const a = configHash('AWN4T-DW-GRN-T5-NS0', { width: 3_200_000n, height: 1_600_000n });
    const b = configHash('AWN4T-DW-GRN-T5-NS0', { width: 3_200_000n, height: 1_600_000n });

    expect(a).toBe(b);
  });

  test('ignores the key insertion order of measures', () => {
    const a = configHash('AWN4T-DW-GRN-T5-NS0', { width: 3_200_000n, height: 1_600_000n });
    const b = configHash('AWN4T-DW-GRN-T5-NS0', { height: 1_600_000n, width: 3_200_000n });

    expect(a).toBe(b);
  });

  test('changes when the sku code changes', () => {
    const a = configHash('AWN4T-DW-GRN-T5-NS0', { width: 3_200_000n, height: 1_600_000n });
    const b = configHash('AWN4T-DW-GRN-T5-NS1', { width: 3_200_000n, height: 1_600_000n });

    expect(a).not.toBe(b);
  });

  test('changes when a measurement changes by one step of the grid', () => {
    const a = configHash('AWN4T-DW-GRN-T5-NS0', { width: 3_200_000n, height: 1_600_000n });
    const b = configHash('AWN4T-DW-GRN-T5-NS0', { width: 3_200_000n, height: 1_605_000n });

    expect(a).not.toBe(b);
  });

  test('changes when a measurement changes by a single micrometre', () => {
    // The old pair here was 160 against 160.5 cm, and the smallest difference float
    // measures could carry was whatever the parse happened to produce. Canonical
    // measures are integers, so the finest distinction the key has to keep is one
    // micrometre — anything coarser would merge two lines the customer entered apart.
    const a = configHash('AWN4T-DW-GRN-T5-NS0', { width: 3_200_000n, height: 1_600_000n });
    const b = configHash('AWN4T-DW-GRN-T5-NS0', { width: 3_200_000n, height: 1_600_001n });

    expect(a).not.toBe(b);
  });

  test('does not collide when width and height are swapped', () => {
    const a = configHash('AWN4T-DW-GRN-T5-NS0', { width: 3_200_000n, height: 1_600_000n });
    const b = configHash('AWN4T-DW-GRN-T5-NS0', { width: 1_600_000n, height: 3_200_000n });

    expect(a).not.toBe(b);
  });

  test('returns a lowercase hex string of fixed length', () => {
    const hash = configHash('AWN4T-DW-GRN-T5-NS0', { width: 3_200_000n, height: 1_600_000n });

    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test('handles an empty measure set', () => {
    expect(configHash('LVR3-DW-B150-MAN', {})).toMatch(/^[0-9a-f]{16}$/);
  });
});
