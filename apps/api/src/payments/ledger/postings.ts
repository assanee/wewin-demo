import { LEDGER_ACCOUNTS, type LedgerAccount } from '@wewin/db/schema';

/**
 * What a movement of money looks like before it is a row — and the one arithmetic rule.
 *
 * Pure, and deliberately separate from the repository: every posting in this phase is built
 * here, so "does this entry balance?" is answerable by a unit test with no database, and the
 * shapes are reviewable as a list rather than scattered through six service methods.
 *
 * ── One signed column, not a direction word and a magnitude ──────────────────────
 *
 * `packages/db/src/schema/payment.ts` chose a single signed `amount_thb_minor` (debit
 * positive, credit negative) so that "this entry balances" is `sum = 0` — one expression a
 * constraint trigger can run, rather than a CASE that gets the sign wrong once. This file
 * keeps that convention and never inverts it: `debit()` and `credit()` exist so a caller
 * writes the accounting word and the sign follows, and so a reviewer reading a service
 * method sees the two ends of the movement side by side.
 *
 * ── Why the assertion is here as well as in Postgres ─────────────────────────────
 *
 * `ledger_entries_balance` is a DEFERRED constraint trigger, so an unbalanced entry fails at
 * COMMIT — several statements, and possibly several service methods, after the mistake. That
 * is the right place for the *guarantee* (nothing can get past it, including a future second
 * writer) and the wrong place for the *diagnosis*. `assertBalanced` fails on the spot, names
 * the legs, and costs one addition.
 *
 * It is not a substitute for the trigger and must never be treated as one: this function only
 * sees the entry the caller assembled, and the guarantee the ledger needs is about every row
 * in the table however it arrived.
 */

/** One end of a movement. Positive is a debit, negative is a credit. Never zero. */
export interface PostingLeg {
  readonly account: LedgerAccount;
  readonly amountThbMinor: bigint;
}

export const debit = (account: LedgerAccount, amountThbMinor: bigint): PostingLeg => ({
  account,
  amountThbMinor,
});

export const credit = (account: LedgerAccount, amountThbMinor: bigint): PostingLeg => ({
  account,
  amountThbMinor: -amountThbMinor,
});

/**
 * The whole arithmetic of double entry, in one function.
 *
 * Three refusals, and each one is a bug this phase could otherwise ship:
 *
 *   fewer than two legs   money appearing in an account with nowhere it came from. Every
 *                         account still looks plausible on its own; the only symptom is that
 *                         the trial balance does not.
 *   a zero leg            a line somebody has to reconcile that says nothing. Postgres
 *                         refuses it too (`ledger_postings_amount_nonzero`); this says why.
 *   a non-zero sum        the entry claims money changed size on the way between two
 *                         accounts.
 *
 * `amount` is checked against the *legs* rather than trusted from the caller, because the
 * caller is the thing being checked.
 */
export function assertBalanced(kind: string, legs: readonly PostingLeg[]): void {
  if (legs.length < 2) {
    throw new Error(`ledger: ${kind} has ${legs.length} leg(s); a movement of money has two ends`);
  }

  for (const leg of legs) {
    if (leg.amountThbMinor === 0n) {
      throw new Error(`ledger: ${kind} has a zero leg on ${leg.account}`);
    }
    if (!isLedgerAccount(leg.account)) {
      throw new Error(`ledger: ${kind} posts to '${String(leg.account)}', which is not an account`);
    }
  }

  const total = legs.reduce((sum, leg) => sum + leg.amountThbMinor, 0n);
  if (total !== 0n) {
    throw new Error(`ledger: ${kind} is out of balance by ${total}`);
  }
}

/**
 * A positive amount of money, refused at the edge rather than at the constraint.
 *
 * Everything this phase posts is a movement of a positive quantity between two accounts; the
 * *direction* carries the sign. A negative amount reaching `debit()` would silently become a
 * credit, which is a reversal nobody asked for — and reversals in this ledger are entries of
 * their own, with a memo saying so, because the tables are append-only.
 */
export function assertPositiveAmount(what: string, amountThbMinor: bigint): void {
  if (amountThbMinor <= 0n) {
    throw new Error(`ledger: ${what} must be a positive amount of money, not ${amountThbMinor}`);
  }
}

/** Narrowing rather than casting, so a string from anywhere cannot become an account. */
export function isLedgerAccount(value: string): value is LedgerAccount {
  return (LEDGER_ACCOUNTS as readonly string[]).includes(value);
}
