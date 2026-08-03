import { describe, expect, test } from 'vitest';
import { TAX_TREATMENTS, fromGrand, fromNet } from '../src/vat.js';

/*
 * Plan 4.4. The business decision was "VAT is configurable"; the engineering answer
 * is that only the *rate* and *treatment* are configurable, while `grandMinor` always
 * includes VAT. Keeping all three amounts side by side makes the
 * inclusive-or-exclusive question disappear from storage entirely — it becomes a
 * question about how a human typed a number, not about what the number means.
 */
describe('fromNet — sales typed a figure before VAT', () => {
  test('the worked example from the plan', () => {
    // ฿8,791 net at 7% → ฿615.37 VAT → ฿9,406.37 grand.
    const line = fromNet(879_100n, { rateBp: 700, treatment: 'standard' });

    expect(line.netMinor).toBe(879_100n);
    expect(line.vatMinor).toBe(61_537n);
    expect(line.grandMinor).toBe(940_637n);
  });

  test('always foots', () => {
    for (const net of [1n, 7n, 879_100n, 1_843_200n, 999_999n]) {
      const line = fromNet(net, { rateBp: 700, treatment: 'standard' });
      expect(line.netMinor + line.vatMinor).toBe(line.grandMinor);
    }
  });
});

describe('fromGrand — sales typed the figure the customer will transfer', () => {
  test('the worked example from the plan', () => {
    // ฿10,000 inclusive at 7% → ฿9,345.79 net → ฿654.21 VAT.
    const line = fromGrand(1_000_000n, { rateBp: 700, treatment: 'standard' });

    expect(line.netMinor).toBe(934_579n);
    expect(line.vatMinor).toBe(65_421n);
    expect(line.grandMinor).toBe(1_000_000n);
  });

  test('takes VAT from the difference, never from a second multiplication', () => {
    // Multiplying the derived net by the rate would give 65_420.53 → 65_421 here by
    // luck, but there are amounts where it lands a satang off and the invoice stops
    // adding up. Subtraction cannot drift.
    for (const grand of [1n, 107n, 1_000_000n, 940_637n, 3n]) {
      const line = fromGrand(grand, { rateBp: 700, treatment: 'standard' });
      expect(line.netMinor + line.vatMinor).toBe(grand);
    }
  });

  test('round-trips the exclusive example back to the same grand total', () => {
    const out = fromNet(879_100n, { rateBp: 700, treatment: 'standard' });
    const back = fromGrand(out.grandMinor, { rateBp: 700, treatment: 'standard' });
    expect(back.grandMinor).toBe(out.grandMinor);
  });
});

describe('treatments other than standard', () => {
  test('zero-rated, exempt and out-of-scope all charge nothing', () => {
    for (const treatment of TAX_TREATMENTS) {
      if (treatment === 'standard') continue;
      const line = fromNet(879_100n, { rateBp: 700, treatment });
      expect(line.vatMinor).toBe(0n);
      expect(line.grandMinor).toBe(879_100n);
    }
  });

  test('a zero rate under the standard treatment is still standard, and still foots', () => {
    // Not the same thing as zero-rated for filing, even though the money matches.
    const line = fromNet(879_100n, { rateBp: 0, treatment: 'standard' });
    expect(line.vatMinor).toBe(0n);
    expect(line.grandMinor).toBe(879_100n);
  });
});

describe('what the deposit percentage actually applies to', () => {
  test('30% of the plan example is ฿2,822, not ฿2,637', () => {
    // The number that changed the moment VAT became a computed line rather than a
    // static string: a deposit is a share of what the customer transfers.
    const { grandMinor } = fromNet(879_100n, { rateBp: 700, treatment: 'standard' });
    const depositMinor = (grandMinor * 3000n) / 10_000n;

    expect(grandMinor).toBe(940_637n);
    expect(depositMinor / 100n).toBe(2_821n); // ฿2,821.91 before rounding to the baht
    expect((depositMinor + 50n) / 100n).toBe(2_822n);
  });
});

describe('guards', () => {
  test('a negative rate is rejected rather than quietly crediting tax', () => {
    expect(() => fromNet(879_100n, { rateBp: -700, treatment: 'standard' })).toThrow();
  });
});
