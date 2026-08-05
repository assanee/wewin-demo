import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';
import {
  ledgerEntries,
  ledgerPostings,
  type LedgerAccount,
  type LedgerEntryKind,
} from '@wewin/db/schema';

import { DRIZZLE } from '../../database/database.tokens';
import { withTranslatedPaymentErrors } from './pg-errors';
import { assertBalanced, type PostingLeg } from './postings';

/**
 * Every statement that writes the ledger, and every read of a balance — and nothing else.
 *
 * ── A balance is a fold, and the fold is in Postgres ─────────────────────────────
 *
 * `packages/db/drizzle/0011_payment_guards.sql` defines `order_cash_thb_minor()`,
 * `order_held_thb_minor()`, `order_settled_thb_minor()`, `order_outstanding_thb_minor()`,
 * `order_settled_through()`, `order_forfeit_thb_minor()` and `order_payment_queue_bucket()`.
 * This file **calls them**. It does not reimplement any of them in TypeScript, and that is the
 * single most important rule in this module.
 *
 * Plan 7.13 found `scheduledDepositMinor` written three ways and answering ฿5,530 and ฿18,432
 * for the same 30/70 order — a ฿12,902 difference in what a customer gets back — and plan
 * 7.5(ค) found the frontier written as a MAX in one place and a COUNT in another. Both are the
 * same failure: a second implementation that agrees with the first on the examples somebody
 * happened to try. A TypeScript `sum(postings)` here would be a fourth `held`, and it would
 * agree with the SQL one until the day a carried allocation or a reversing entry made it not.
 *
 * The cost is a round trip per balance, and it is the right price.
 *
 * ── `::text`, deliberately ───────────────────────────────────────────────────────
 *
 * The folds return `bigint` (int8). The application's pool installs `bigintAwareTypes` and
 * hands int8 back as a JavaScript `bigint`; a pool built by `@wewin/db/client` — which is what
 * the test suites use — does not, and hands back a string. A reader that assumed either one
 * would be right in one process and silently wrong in the other, and "silently wrong about
 * money" is the whole subject of this phase. Casting to `text` in the statement makes the wire
 * type the same everywhere and `BigInt()` the only conversion.
 */

/** Drizzle names the transaction type nowhere public, so it is read off the callback. */
export type LedgerTx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** A forfeit policy, identified. The rules behind it are read by `order_forfeit_thb_minor()`. */
export interface ForfeitPolicyRow {
  readonly id: string;
  readonly code: string;
}

export interface LedgerEntryInput {
  readonly orderId: string;
  readonly kind: LedgerEntryKind;
  /** Required by `ledger_entries_slip_required` for `slip_accepted` and `remittance_landed`. */
  readonly slipId?: string | undefined;
  /** The event on the order's spine that caused it — so "why is ฿5,530 in `forfeited`?" joins. */
  readonly eventId?: string | undefined;
  readonly varianceKind?: 'fx_spread' | 'bank_fee' | 'refund_fx' | undefined;
  readonly memoTh: string;
  readonly legs: readonly PostingLeg[];
}

export interface OrderMoney {
  /** `paidMinor` — cash received. Folds `bank_thb`. */
  readonly cashThbMinor: bigint;
  /** Money in hand. Folds `deposit_held`, and is NOT cash — a carried revision has no cash leg. */
  readonly heldThbMinor: bigint;
  /** `settledMinor` — the fold of allocations from accepted slips. Diverges from cash on a fee. */
  readonly settledThbMinor: bigint;
  readonly outstandingThbMinor: bigint;
  readonly refundPayableThbMinor: bigint;
  readonly remittanceInTransitThbMinor: bigint;
  /** `terminal_holding_money` · `settled` · `awaiting_review` · `awaiting_customer_transfer` · `closed`. */
  readonly queueBucket: string;
}

@Injectable()
export class LedgerRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Inside the caller's transaction when there is one, on the pool when there is not. */
  private executor(tx?: LedgerTx): LedgerTx {
    return tx ?? (this.db as unknown as LedgerTx);
  }

  async transaction<T>(run: (tx: LedgerTx) => Promise<T>): Promise<T> {
    return withTranslatedPaymentErrors(() => this.db.transaction(run));
  }

  /**
   * Write one movement of money: the header, then its legs.
   *
   * The id is chosen here rather than read back from a `RETURNING`, for the same reason
   * `OrderRepository.createDraft` chooses the event's: the legs name the entry and the entry's
   * composite key ties them to one order, so both statements need the id before either runs.
   *
   * `leg_no` is the position in the array. Not a column the caller supplies — a caller that
   * numbered its own legs would be a caller that can number two of them 1, and
   * `ledger_postings_entry_leg_key` would report that as a duplicate key rather than as what it
   * is.
   */
  async post(tx: LedgerTx, input: LedgerEntryInput): Promise<string> {
    assertBalanced(input.kind, input.legs);

    const entryId = randomUUID();

    return withTranslatedPaymentErrors(async () => {
      await tx.insert(ledgerEntries).values({
        id: entryId,
        orderId: input.orderId,
        kind: input.kind,
        slipId: input.slipId ?? null,
        eventId: input.eventId ?? null,
        varianceKind: input.varianceKind ?? null,
        memoTh: input.memoTh,
      });

      await tx.insert(ledgerPostings).values(
        input.legs.map((leg, index) => ({
          entryId,
          orderId: input.orderId,
          legNo: index + 1,
          account: leg.account,
          amountThbMinor: leg.amountThbMinor,
        })),
      );

      return entryId;
    });
  }

  /** One account's balance, signed as the postings are. Debits positive, credits negative. */
  async accountBalance(orderId: string, account: LedgerAccount, tx?: LedgerTx): Promise<bigint> {
    const result = await this.executor(tx).execute(
      sql`select order_account_thb_minor(${orderId}::uuid, ${account})::text as amount`,
    );
    return bigintOf(firstRow(result)['amount']);
  }

  /**
   * Every number a money screen needs, in one round trip, each from its own SQL fold.
   *
   * They are read together and named apart. Plan 7.13's finding was not that any one of these
   * was wrong — it was that four designs used three of them interchangeably, so a screen said
   * "paid" and showed allocations, and a decision asked "have we been paid?" and folded cash on
   * an order whose money was carried and whose cash is therefore zero forever.
   */
  async money(orderId: string, tx?: LedgerTx): Promise<OrderMoney> {
    const result = await this.executor(tx).execute(sql`
      select order_cash_thb_minor(${orderId}::uuid)::text                          as cash,
             order_held_thb_minor(${orderId}::uuid)::text                          as held,
             order_settled_thb_minor(${orderId}::uuid)::text                       as settled,
             coalesce(order_outstanding_thb_minor(${orderId}::uuid), 0)::text      as outstanding,
             order_account_thb_minor(${orderId}::uuid, 'refund_payable')::text     as refund_payable,
             order_account_thb_minor(${orderId}::uuid, 'remittance_in_transit')::text
                                                                                   as in_transit,
             order_payment_queue_bucket(${orderId}::uuid)                          as bucket
    `);

    const row = firstRow(result);

    return {
      cashThbMinor: bigintOf(row['cash']),
      heldThbMinor: bigintOf(row['held']),
      settledThbMinor: bigintOf(row['settled']),
      outstandingThbMinor: bigintOf(row['outstanding']),
      /* Credited, therefore negative in the fold. Negated so a payable reads as a positive debt. */
      refundPayableThbMinor: -bigintOf(row['refund_payable']),
      remittanceInTransitThbMinor: bigintOf(row['in_transit']),
      queueBucket: stringOf(row['bucket']) ?? 'unknown',
    };
  }

  /**
   * What this policy says is forfeit on this cancellation — computed by Postgres, never here.
   *
   * `order_forfeit_thb_minor()` is `least(received, scheduled_deposit) × bp`, clamped to money
   * held, and it **raises** when the (status × fault) cell is missing rather than returning
   * zero. Both halves are the point, and neither is re-expressible here without becoming a
   * second answer: bounding by cash instead of by the pinned obligation forfeits ฿18,432 on a
   * ฿5,530 obligation when somebody pays in full up front, and a missing cell that reads as
   * zero is a policy nobody wrote being applied to somebody's money.
   */
  async forfeitThbMinor(
    orderId: string,
    fromStatus: string,
    fault: string,
    policyId: string,
    tx?: LedgerTx,
  ): Promise<bigint> {
    const result = await withTranslatedPaymentErrors(() =>
      this.executor(tx).execute(
        sql`select order_forfeit_thb_minor(
              ${orderId}::uuid, ${fromStatus}, ${fault}, ${policyId}::uuid
            )::text as amount`,
      ),
    );
    return bigintOf(firstRow(result)['amount']);
  }

  /**
   * The forfeit policy in force right now — the one an order **pins at submit**.
   *
   * It lives beside `forfeitThbMinor` above because they are two halves of one question and
   * they were in two modules. Plan 7.13's whole finding is mechanisms written twice under two
   * names; a `RefundsRepository` that chose the policy and a `LedgerRepository` that priced
   * with it is the same shape one file earlier.
   *
   * Three properties, and each is a real failure that was considered:
   *
   *   - the newest **already effective** policy wins, so a future-dated policy cannot take
   *     effect early;
   *   - two policies effective at the same instant is an error, not a coin toss — `limit 1`
   *     over an ambiguous ordering is how a system quietly applies a different rate on
   *     Tuesday;
   *   - nothing effective at all is `undefined` and never a default. `order_forfeit_thb_minor`
   *     raises on a missing cell for the same reason: a policy nobody wrote, applied silently
   *     to somebody's money, is worse than a refusal.
   *
   * ⚠️ THE CALLER THAT MATTERS IS THE SUBMIT PATH, NOT THE CANCELLATION. Since
   * `0012_payment_closure.sql` the answer is pinned onto `orders.forfeit_policy_id`, because
   * publishing a policy between the contract and the cancellation otherwise changed what that
   * customer got back.
   */
  async effectiveForfeitPolicy(tx?: LedgerTx): Promise<ForfeitPolicyRow | undefined> {
    const result = await this.executor(tx).execute(sql`
      select id::text as id, code, effective_from
        from forfeit_policies
       where effective_from is not null and effective_from <= now()
       order by effective_from desc, code asc
       limit 2
    `);

    const rows = recordsOf(result);
    const newest = rows[0];
    const runnerUp = rows[1];
    if (newest === undefined) return undefined;

    if (runnerUp !== undefined && sameInstant(newest['effective_from'], runnerUp['effective_from'])) {
      throw new Error(
        `payments/ledger: forfeit policies '${String(newest['code'])}' and '${String(runnerUp['code'])}' ` +
          'became effective at the same instant; which one applies is not a question this module may answer by sorting',
      );
    }

    const id = stringOf(newest['id']);
    const code = stringOf(newest['code']);
    if (id === undefined || code === undefined) {
      throw new Error('ledger: a forfeit policy row is missing its id or code');
    }

    return { id, code };
  }

  /** The cell, for the memo. The *amount* comes from `order_forfeit_thb_minor()` and not here. */
  async forfeitBp(
    policyId: string,
    fromStatus: string,
    fault: string,
    tx?: LedgerTx,
  ): Promise<number | undefined> {
    const result = await this.executor(tx).execute(sql`
      select forfeit_bp
        from forfeit_policy_rules
       where policy_id = ${policyId}::uuid and from_status = ${fromStatus} and fault = ${fault}
    `);

    const row = recordsOf(result)[0];
    if (row === undefined) return undefined;

    const bp = row['forfeit_bp'];
    if (typeof bp === 'number') return bp;
    if (typeof bp === 'string') return Number(bp);
    return undefined;
  }

  /**
   * Does `ancestorId` appear in `descendantId`'s supersedes chain?
   *
   * `order_is_ancestor_of()` in SQL, called and not re-walked. The chain decides whose money a
   * carried payment is, and plan 7.13's finding is what happens when two implementations of
   * one question each agree with the other on the cases somebody tried.
   */
  async isAncestorOf(tx: LedgerTx, ancestorId: string, descendantId: string): Promise<boolean> {
    const result = await this.executor(tx).execute(
      sql`select order_is_ancestor_of(${ancestorId}::uuid, ${descendantId}::uuid) as yes`,
    );
    return firstRow(result)['yes'] === true;
  }

  /** Has this order already had an entry of this kind? The idempotence guard on a forfeit. */
  async hasEntryOfKind(orderId: string, kind: LedgerEntryKind, tx?: LedgerTx): Promise<boolean> {
    const result = await this.executor(tx).execute(
      sql`select 1 from ledger_entries where order_id = ${orderId}::uuid and kind = ${kind} limit 1`,
    );
    return rowsOf(result).length > 0;
  }
}

/* ------------------------------------------------------------------------- *
 * Row parsing.
 *
 * `execute` hands back `unknown` rows — a raw statement has no schema to infer from — so every
 * field is checked rather than cast, exactly as `notifications.repository.ts` decided. A
 * `as OrderMoney` here would be the one place in this module where a column rename becomes a
 * runtime `undefined` instead of a compile error, and the columns being renamed decide how
 * much money goes back to a customer.
 * ------------------------------------------------------------------------- */

function rowsOf(result: unknown): readonly unknown[] {
  if (typeof result !== 'object' || result === null || !('rows' in result)) return [];
  const { rows } = result as { rows: unknown };
  return Array.isArray(rows) ? rows : [];
}

/** The same rows, each proved to be an object before anything indexes into it. */
function recordsOf(result: unknown): readonly Record<string, unknown>[] {
  return rowsOf(result).filter(
    (row): row is Record<string, unknown> => typeof row === 'object' && row !== null,
  );
}

/**
 * Two `effective_from` values that name the same moment.
 *
 * `timestamptz` arrives as a `Date` from the application pool and as a string from a pool
 * built without the type parsers — the same split the `::text` note at the top describes — so
 * both are handled rather than one being assumed. Anything else is not a timestamp and cannot
 * be equal to one.
 */
function sameInstant(left: unknown, right: unknown): boolean {
  const at = (value: unknown): number | undefined => {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    return undefined;
  };

  const leftAt = at(left);
  const rightAt = at(right);
  return leftAt !== undefined && rightAt !== undefined && leftAt === rightAt;
}

function firstRow(result: unknown): Record<string, unknown> {
  const [row] = rowsOf(result);
  if (typeof row !== 'object' || row === null) {
    throw new Error('ledger: a fold returned no row, which cannot happen for an aggregate');
  }
  return row as Record<string, unknown>;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * `bigint`, `string` or `number` in; `bigint` out; anything else is a bug that says so.
 *
 * All three arrive in practice — see the `::text` note at the top of the file — and the one
 * thing that must never happen is a `Number()` on the way past, which is exact only up to
 * 2^53 and is therefore exact for every amount anybody will test with.
 */
function bigintOf(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new Error(`ledger: expected a money amount, received ${typeof value}`);
}
