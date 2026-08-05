import { describe, expect, it } from 'vitest';

import { deriveOriginalAccount } from '../../../src/payments/refunds/payee';

/**
 * *"Please send it to a different account"* is what a fraudster says — plan 7.12.
 *
 * Every case below is about one property: **the flag is derived, never supplied**. There is no
 * input to `deriveOriginalAccount` that a requester could set to make an unrecognised account
 * report as the original one, and that is what makes the separate approval and the report
 * downstream worth having. A flag on the request body would be set to `yes` by exactly the
 * person the control is against, and the queue would be permanently empty.
 */
describe('where a refund is allowed to go', () => {
  const slips = [
    { slipId: 'slip-newest', payerName: 'สมชาย ใจดี', payerAccountLast4: '4821' },
    { slipId: 'slip-older', payerName: 'SOMCHAI JAIDEE', payerAccountLast4: '9003' },
  ];

  it('defaults to the account that paid, with no approval to give', () => {
    const derived = deriveOriginalAccount({ onRecord: slips });

    expect(derived).toEqual({
      name: 'สมชาย ใจดี',
      bankCode: '',
      accountLast4: '4821',
      isOriginalAccount: 'yes',
      matchedSlipId: 'slip-newest',
    });
  });

  /*
   * Fails closed. The alternative — defaulting to whatever the customer types next — is the
   * fraud path with the control removed, and it is the shape the feature takes if nobody
   * decides otherwise, because "there is no account on file" reads like a missing default.
   */
  it('returns nothing when no accepted slip carries an account', () => {
    expect(
      deriveOriginalAccount({
        onRecord: [{ slipId: 'slip-blank', payerName: null, payerAccountLast4: null }],
      }),
    ).toBeUndefined();

    expect(deriveOriginalAccount({ onRecord: [] })).toBeUndefined();
  });

  it('recognises the account that paid however the name was capitalised or spaced', () => {
    const derived = deriveOriginalAccount({
      onRecord: slips,
      requested: { name: '  somchai   jaidee ', bankCode: 'BBL', accountLast4: '9003' },
    });

    expect(derived?.isOriginalAccount).toBe('yes');
    expect(derived?.matchedSlipId).toBe('slip-older');
    /* The bank code is kept as typed: the slip has none to compare against. See payee.ts. */
    expect(derived?.bankCode).toBe('BBL');
  });

  it('accepts any account that paid, not only the most recent one', () => {
    const derived = deriveOriginalAccount({
      onRecord: slips,
      requested: { name: 'สมชาย ใจดี', bankCode: 'KBANK', accountLast4: '4821' },
    });

    expect(derived?.isOriginalAccount).toBe('yes');
    expect(derived?.matchedSlipId).toBe('slip-newest');
  });

  /* The sentence the whole file is about. */
  it('flags an account nobody paid from, and names no slip', () => {
    const derived = deriveOriginalAccount({
      onRecord: slips,
      requested: { name: 'สมหญิง อื่นไกล', bankCode: 'SCB', accountLast4: '7777' },
    });

    expect(derived?.isOriginalAccount).toBe('no');
    expect(derived?.matchedSlipId).toBeNull();
  });

  /*
   * The same four digits under a different name is the interesting near-miss: it is what a
   * transposed keystroke looks like AND what a substituted payee looks like, so it must be
   * flagged rather than accepted on the strength of the digits.
   */
  it('refuses to match on the digits alone', () => {
    const derived = deriveOriginalAccount({
      onRecord: slips,
      requested: { name: 'someone else entirely', bankCode: 'SCB', accountLast4: '4821' },
    });

    expect(derived?.isOriginalAccount).toBe('no');
  });

  it('refuses to match on the name alone', () => {
    const derived = deriveOriginalAccount({
      onRecord: slips,
      requested: { name: 'สมชาย ใจดี', bankCode: 'SCB', accountLast4: '0000' },
    });

    expect(derived?.isOriginalAccount).toBe('no');
  });

  /*
   * A slip whose payer name was never recorded must not match an empty-ish request. Without
   * the length guard in `sameName`, two blanks compare equal and a refund to a nameless account
   * reports as going back where it came from.
   */
  it('does not let two blanks match each other', () => {
    const derived = deriveOriginalAccount({
      onRecord: [{ slipId: 'slip-blank-name', payerName: '   ', payerAccountLast4: '4821' }],
      requested: { name: ' ', bankCode: 'SCB', accountLast4: '4821' },
    });

    expect(derived?.isOriginalAccount).toBe('no');
  });
});
