import { describe, expect, it } from 'vitest';

import { formatDepositPercent, mayEditDeposit, parseDepositPercent } from './deposit-entry';

/**
 * The deposit box, which is the one place a percentage and basis points meet.
 *
 * Every refusal below is written as a sentence a salesperson can act on, and the tests assert
 * that rather than a boolean: "invalid" is the failure mode this file exists to avoid.
 */

describe('what a person typed into the deposit box', () => {
  it('⭐ reads the ordinary cases', () => {
    expect(parseDepositPercent('30')).toStrictEqual({ ok: true, bp: 3_000 });
    expect(parseDepositPercent('30%')).toStrictEqual({ ok: true, bp: 3_000 });
    expect(parseDepositPercent('  30 % ')).toStrictEqual({ ok: true, bp: 3_000 });
    expect(parseDepositPercent('100')).toStrictEqual({ ok: true, bp: 10_000 });
    expect(parseDepositPercent('30.5')).toStrictEqual({ ok: true, bp: 3_050 });
  });

  it('⚠️ accepts Thai digits, because a Thai keyboard produces them', () => {
    /* Refusing them refuses the person, not the input. */
    expect(parseDepositPercent('๓๐')).toStrictEqual({ ok: true, bp: 3_000 });
    expect(parseDepositPercent('๕๐%')).toStrictEqual({ ok: true, bp: 5_000 });
  });

  it('⛔ refuses more precision than a basis point can carry, rather than rounding it away', () => {
    /*
     * 30.555% is not a number this API can hold. Rounding it silently would send a figure
     * nobody typed and show it back as though they had.
     */
    const answer = parseDepositPercent('30.555');
    expect(answer.ok).toBe(false);
    expect(answer.ok === false && answer.messageTh).toContain('ทศนิยม 2');
  });

  it('⛔ refuses 0 and over 100, each with its own sentence', () => {
    const zero = parseDepositPercent('0');
    expect(zero.ok).toBe(false);
    /* The advice is what makes it useful: no deposit is 100% collected once, not 0%. */
    expect(zero.ok === false && zero.messageTh).toContain('100%');

    const over = parseDepositPercent('101');
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.messageTh).toContain('เกิน 100%');
  });

  it('⛔ refuses text, an empty box, and money', () => {
    for (const raw of ['', '   ', 'สามสิบ', '฿30,000', '30%%', '-30']) {
      expect(parseDepositPercent(raw).ok, raw).toBe(false);
    }
  });

  it('reads back what it read in', () => {
    expect(formatDepositPercent(3_000)).toBe('30%');
    expect(formatDepositPercent(10_000)).toBe('100%');
    expect(formatDepositPercent(3_025)).toBe('30.25%');
    expect(formatDepositPercent(3_050)).toBe('30.5%');
  });

  it('⚠️ every accepted value survives the round trip', () => {
    for (const raw of ['1', '30', '30.25', '30.5', '99.99', '100']) {
      const parsed = parseDepositPercent(raw);
      expect(parsed.ok, raw).toBe(true);
      if (!parsed.ok) continue;
      expect(parseDepositPercent(formatDepositPercent(parsed.bp))).toStrictEqual(parsed);
    }
  });
});

describe('when the box is offered at all', () => {
  it('⭐ while the quotation is being negotiated, and not after', () => {
    expect(mayEditDeposit('awaiting_confirmation')).toBe(true);
    expect(mayEditDeposit('awaiting_payment')).toBe(true);

    for (const status of ['draft', 'production_confirmed', 'in_production', 'delivered', 'cancelled']) {
      expect(mayEditDeposit(status), status).toBe(false);
    }
  });

  it('⚠️ decides what to draw and never what is permitted', () => {
    /*
     * The API refuses the write itself, and money closes it there — a fact this screen cannot
     * see. An unknown status therefore draws nothing rather than guessing.
     */
    expect(mayEditDeposit('a_status_from_a_newer_api')).toBe(false);
  });
});
