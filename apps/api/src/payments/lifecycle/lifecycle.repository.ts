import { Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from '@wewin/db/sql';
import { orderInstalments, paymentSlips, slipAllocations } from '@wewin/db/schema';

import type { LedgerTx } from '../ledger';

/**
 * The three statements that move money between an order and its revision, and nothing else.
 *
 * ── Why this exists rather than a method on `SlipsRepository` ────────────────────
 *
 * `SlipsModule` imports `OrdersModule`; the carry happens inside a *submit*, which is
 * `OrdersService`'s transaction. Importing slips from orders would close the loop, and Nest's
 * answer to that (`forwardRef`) is a way of writing down a cycle rather than not having one.
 *
 * The duplication is three `SELECT`s and one `UPDATE`, and it is the honest cost. What is
 * deliberately **not** duplicated is any rule: the carry's legality is decided by
 * `slip_allocations_guard_write()`, which walks `order_is_ancestor_of` on every row this file
 * updates, so a second opinion here would be a second opinion the database overrules.
 */

/** One accepted payment, as it sits on the ancestor. */
export interface CarriedAllocation {
  readonly id: string;
  readonly amountThbMinor: bigint;
}

/** An instalment of the receiving order, with the room left in it. */
export interface InstalmentRoom {
  readonly id: string;
  readonly seq: number;
  readonly dueThbMinor: bigint;
}

@Injectable()
export class LifecycleRepository {
  /**
   * Every allocation on an accepted slip of this order, largest first.
   *
   * Largest first because the fit below is greedy and a carried allocation cannot be split —
   * `slip_allocations_guard_write()` refuses a change of amount, since the row is evidence of
   * a payment and not a working figure. Placing the big ones while every instalment is still
   * empty is the ordering that fails least often; when it does fail, it fails loudly.
   */
  async carriedAllocations(tx: LedgerTx, orderId: string): Promise<readonly CarriedAllocation[]> {
    const rows = await tx
      .select({ id: slipAllocations.id, amountThbMinor: slipAllocations.amountThbMinor })
      .from(slipAllocations)
      .innerJoin(orderInstalments, eq(orderInstalments.id, slipAllocations.instalmentId))
      .innerJoin(paymentSlips, eq(paymentSlips.id, slipAllocations.slipId))
      .where(and(eq(orderInstalments.orderId, orderId), eq(paymentSlips.status, 'accepted')))
      .orderBy(sql`${slipAllocations.amountThbMinor} desc`);

    return rows;
  }

  /** The receiving order's instalments in `seq` order. Freshly opened, so each is empty. */
  async instalments(tx: LedgerTx, orderId: string): Promise<readonly InstalmentRoom[]> {
    return tx
      .select({
        id: orderInstalments.id,
        seq: orderInstalments.seq,
        dueThbMinor: orderInstalments.dueThbMinor,
      })
      .from(orderInstalments)
      .where(eq(orderInstalments.orderId, orderId))
      .orderBy(asc(orderInstalments.seq));
  }

  /**
   * Move one allocation onto an instalment of the revision.
   *
   * An UPDATE and never an INSERT + DELETE, and never a second row. Plan 7.8 is emphatic that
   * carried money is *"an allocation referencing the ancestor, never a new instalment row"*,
   * and `slip_allocations_guard_write()` goes one further and refuses a second allocation
   * outright: two rows would double the sum against a slip whose allocations must foot to it
   * exactly, which is the same payment counted twice wearing a different table.
   */
  async moveAllocation(
    tx: LedgerTx,
    allocationId: string,
    toInstalmentId: string,
    fromOrderId: string,
  ): Promise<void> {
    await tx
      .update(slipAllocations)
      .set({ instalmentId: toInstalmentId, carriedFromOrderId: fromOrderId })
      .where(eq(slipAllocations.id, allocationId));
  }

  /** The pinned forfeit policy and the totals a cancellation needs, under the caller's lock. */
  async orderMoneyTerms(
    tx: LedgerTx,
    orderId: string,
  ): Promise<
    | {
        readonly grandTotalThbMinor: bigint | null;
        readonly forfeitPolicyId: string | null;
        readonly supersedesOrderId: string | null;
      }
    | undefined
  > {
    const result = await tx.execute(sql`
      select grand_total_thb_minor::text as total,
             forfeit_policy_id::text     as policy,
             supersedes_order_id::text   as supersedes
        from orders
       where id = ${orderId}::uuid
    `);

    const rows = (result as { rows?: unknown }).rows;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (typeof row !== 'object' || row === null) return undefined;

    const record = row as Record<string, unknown>;
    const total = record['total'];
    const policy = record['policy'];
    const supersedes = record['supersedes'];

    return {
      grandTotalThbMinor: typeof total === 'string' ? BigInt(total) : null,
      forfeitPolicyId: typeof policy === 'string' ? policy : null,
      supersedesOrderId: typeof supersedes === 'string' ? supersedes : null,
    };
  }

  /** Pin the forfeit policy at submit. Immutable thereafter — `orders_guard_forfeit_policy`. */
  async pinForfeitPolicy(tx: LedgerTx, orderId: string, policyId: string): Promise<void> {
    await tx.execute(
      sql`update orders set forfeit_policy_id = ${policyId}::uuid where id = ${orderId}::uuid`,
    );
  }
}
