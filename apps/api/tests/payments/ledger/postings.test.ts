import { describe, expect, it } from 'vitest';

import {
  assertBalanced,
  assertPositiveAmount,
  credit,
  debit,
  isLedgerAccount,
} from '../../../src/payments/ledger/postings';

/**
 * The arithmetic of double entry, with no database in the room.
 *
 * `ledger_entries_balance` is a DEFERRED constraint trigger, so every unbalanced entry fails at
 * COMMIT — correct as a guarantee and useless as a diagnosis, because by then the statement that
 * made the mistake is several methods behind. These tests are about the other half: that the
 * mistake is refused where it is made, with the numbers in the message.
 *
 * Which means they are NOT evidence that the ledger balances. That evidence is in
 * `ledger.pg.test.ts`, against Postgres, with the trigger doing the refusing.
 */
describe('a posting is two ends of one movement', () => {
  it('signs a debit positive and a credit negative, and nothing else decides that', () => {
    expect(debit('bank_thb', 100n)).toEqual({ account: 'bank_thb', amountThbMinor: 100n });
    expect(credit('deposit_held', 100n)).toEqual({
      account: 'deposit_held',
      amountThbMinor: -100n,
    });
  });

  it('accepts an entry whose legs sum to zero', () => {
    expect(() =>
      assertBalanced('slip_accepted', [debit('bank_thb', 552_960n), credit('deposit_held', 552_960n)]),
    ).not.toThrow();
  });

  /*
   * The specific failure this catches: money appears in one account with nowhere it came from.
   * Every account still looks plausible on its own and the only symptom is that the trial
   * balance does not — which is a symptom nobody reads until the quarter ends.
   */
  it('refuses a one-legged entry', () => {
    expect(() => assertBalanced('revenue_recognised', [debit('revenue', 100n)])).toThrow(
      /1 leg\(s\)/u,
    );
  });

  it('refuses an entry that does not balance, and says by how much', () => {
    expect(() =>
      assertBalanced('refund_disbursed', [debit('refund_payable', 552_960n), credit('bank_thb', 500_000n)]),
    ).toThrow(/out of balance by 52960/u);
  });

  it('refuses a zero leg — a line somebody has to reconcile that says nothing', () => {
    expect(() =>
      assertBalanced('variance', [debit('settlement_variance', 0n), credit('deposit_held', 0n)]),
    ).toThrow(/zero leg/u);
  });

  /*
   * A negative amount reaching `debit()` would silently become a credit — a reversal nobody
   * asked for. Reversals in this ledger are entries of their own with a memo saying so, because
   * the tables are append-only.
   */
  it('refuses a negative or zero amount at the edge', () => {
    expect(() => assertPositiveAmount('a refund', -1n)).toThrow(/positive/u);
    expect(() => assertPositiveAmount('a refund', 0n)).toThrow(/positive/u);
    expect(() => assertPositiveAmount('a refund', 1n)).not.toThrow();
  });

  it('knows the nine accounts and nothing else', () => {
    for (const account of [
      'bank_thb',
      'remittance_in_transit',
      'deposit_held',
      'refund_payable',
      'credit_clearing',
      'trade_receivable',
      'revenue',
      'forfeited',
      'settlement_variance',
    ]) {
      expect(isLedgerAccount(account)).toBe(true);
    }

    expect(isLedgerAccount('cash')).toBe(false);
    expect(isLedgerAccount('deposits_held')).toBe(false);
    expect(isLedgerAccount('')).toBe(false);
  });
});
