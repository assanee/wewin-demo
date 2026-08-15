import { describe, expect, it } from 'vitest';

import { encodeUm } from '@wewin/contract/measure';

import { cmToUm, duplicateRequest, umToCm } from './duplicate-line';

describe('centimetres a person types, micrometres the wire carries', () => {
  it('scales a decimal to micrometres exactly', () => {
    /*
     * ⚠️ These pass under `Number(cm) * 10000` too — checked by mutation, not assumed. The
     * `bigint` path is kept for being exact by construction rather than by the numbers being
     * small, and this test does not pretend to prove more than it does. The assertion that
     * bites is the refusal one below.
     */
    expect(cmToUm('180.05')).toBe(1_800_500n);
    expect(cmToUm('180.5')).toBe(1_805_000n);
    expect(cmToUm('300')).toBe(3_000_000n);
    expect(cmToUm('0.0001')).toBe(1n);
  });

  it('refuses anything that is not a plain decimal', () => {
    for (const bad of ['', ' ', 'abc', '-5', '1e3', '180.00001', '1,800']) {
      expect(cmToUm(bad)).toBeNull();
    }
  });

  it('reads back what it wrote, without trailing zeros', () => {
    expect(umToCm(encodeUm(3000000n))).toBe('300');
    expect(umToCm(encodeUm(1805000n))).toBe('180.5');
    expect(umToCm(encodeUm(1800500n))).toBe('180.05');
  });

  it('⭐ round-trips every value the boxes will hold', () => {
    for (const cm of ['300', '180.5', '180.05', '0.0001', '1']) {
      const um = cmToUm(cm);
      expect(um).not.toBeNull();
      if (um !== null) expect(umToCm(encodeUm(um))).toBe(cm);
    }
  });
});

describe('building the copy', () => {
  const entries = [
    { groupCode: 'width', labelTh: 'ความกว้าง', cm: '180' },
    { groupCode: 'height', labelTh: 'ความสูง', cm: '200' },
  ];

  it('turns the boxes into the measures record the endpoint takes', () => {
    const result = duplicateRequest(entries, '2');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.measures).toStrictEqual({
        width: encodeUm(1800000n),
        height: encodeUm(2000000n),
      });
      expect(result.qty).toBe(2);
    }
  });

  it('⭐ reports every bad box at once, not the first', () => {
    const result = duplicateRequest(
      [
        { groupCode: 'width', labelTh: 'ความกว้าง', cm: 'สองเมตร' },
        { groupCode: 'height', labelTh: 'ความสูง', cm: '0' },
      ],
      '0',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toHaveLength(3);
      expect(result.problems[0]).toContain('ความกว้าง');
      expect(result.problems[1]).toContain('ความสูง');
      expect(result.problems[2]).toContain('จำนวน');
    }
  });

  it('⚠️ refuses a fractional quantity rather than rounding it', () => {
    /* `qty` is `z.number().int()` on the wire; 1.5 windows is a 400 nobody can act on. */
    expect(duplicateRequest(entries, '1.5').ok).toBe(false);
    expect(duplicateRequest(entries, '1').ok).toBe(true);
  });
});
