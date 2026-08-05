import { Injectable } from '@nestjs/common';
// Through @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { asc, eq, inArray, sql } from '@wewin/db/sql';
import { orderInstalments, orderPaymentSchedules, slipAllocations } from '@wewin/db/schema';

import type { Tx } from '../../orders/order.repository';
import type { PlannedInstalment, ScheduleRow } from './plan';

/**
 * Every statement the instalment schedule writes, and nothing about when it runs.
 *
 * ── There is no order loader here, and there must not be ─────────────────────────
 *
 * This file never reads `orders`. Not the status, not the total, not the owner. Plan 7.4
 * trap 2 is that ownership belongs in the query, and `OrderRepository` already says why it
 * refuses to have a `findOrder`: a second unscoped loader is the one a future refactor hands
 * to a handler that had a scoped row a moment ago. So the caller passes the status and the
 * grand total it read under its own `SELECT … FOR UPDATE`, and this module cannot be handed
 * an order nothing filtered.
 *
 * The one thing it does read from outside its own tables is `order_settled_through()`, and
 * that is a function call rather than a query for the reason plan 7.5(ค) gives: the frontier
 * has one implementation, it is that function, and a `SELECT max(seq) …` here would be the
 * second one.
 *
 * ── Where the schedule's own assertion fires ─────────────────────────────────────
 *
 * `assert_order_schedule()` is wired to three DEFERRED constraint triggers, so left alone it
 * fires at COMMIT — in the caller's transaction, long after this module returned, with a
 * message naming a trigger. `verifySchedule` calls the same function directly instead, so
 * the database's own rule is checked *inside* the service call that broke it and the error
 * can be translated. The triggers stay: they are what makes the rule true for every writer,
 * including the ones that do not go through this file.
 */

/** An instalment as stored, with its id and its settled money. */
export interface StoredInstalment extends ScheduleRow {
  readonly id: string;
}

@Injectable()
export class ScheduleRepository {
  /**
   * The schedule header, created if it is not there.
   *
   * One row per order, and its only reason to exist is `closed_at` — which cannot live on
   * `orders` (that file is 5a's) and cannot live on the instalments, because closing is a
   * property of the set and not of any member.
   */
  async ensureSchedule(tx: Tx, orderId: string): Promise<void> {
    await tx
      .insert(orderPaymentSchedules)
      .values({ orderId })
      .onConflictDoNothing({ target: orderPaymentSchedules.orderId });
  }

  /**
   * The instalments of one order, in `seq` order, with what has been allocated to each.
   *
   * Two queries and a merge rather than one grouped join: the fold has to be `LEFT`-shaped
   * (an instalment with no allocation is zero, not absent) and drizzle's aggregate typing
   * over an outer join returns `string | null` per row anyway. Two statements that each say
   * one thing beat one that needs a comment about what `null` means.
   */
  async load(tx: Tx, orderId: string): Promise<readonly StoredInstalment[]> {
    const rows = await tx
      .select({
        id: orderInstalments.id,
        seq: orderInstalments.seq,
        basis: orderInstalments.basis,
        percentBp: orderInstalments.percentBp,
        fixedThbMinor: orderInstalments.fixedThbMinor,
        gatesEntryTo: orderInstalments.gatesEntryTo,
        dueThbMinor: orderInstalments.dueThbMinor,
      })
      .from(orderInstalments)
      .where(eq(orderInstalments.orderId, orderId))
      .orderBy(asc(orderInstalments.seq));

    if (rows.length === 0) return [];

    /*
     * Every allocation, not only those on accepted slips — see `ScheduleRow.allocatedThbMinor`.
     * This is the fold `order_instalments_guard_write()` performs before it refuses an UPDATE,
     * and a module that reads a laxer number than the guard it is about to meet is a module
     * that reports success and then fails at COMMIT.
     */
    const sums = await tx
      .select({
        instalmentId: slipAllocations.instalmentId,
        allocated: sql<string>`sum(${slipAllocations.amountThbMinor})::text`,
      })
      .from(slipAllocations)
      .where(
        inArray(
          slipAllocations.instalmentId,
          rows.map((row) => row.id),
        ),
      )
      .groupBy(slipAllocations.instalmentId);

    const allocated = new Map(sums.map((sum) => [sum.instalmentId, BigInt(sum.allocated)]));

    return rows.map((row) => ({
      id: row.id,
      seq: row.seq,
      basis: row.basis,
      percentBp: row.percentBp,
      fixedThbMinor: row.fixedThbMinor,
      gatesEntryTo: row.gatesEntryTo,
      dueThbMinor: row.dueThbMinor,
      allocatedThbMinor: allocated.get(row.id) ?? 0n,
    }));
  }

  async insertAll(
    tx: Tx,
    orderId: string,
    instalments: readonly PlannedInstalment[],
  ): Promise<void> {
    if (instalments.length === 0) return;

    await tx.insert(orderInstalments).values(
      instalments.map((instalment) => ({
        orderId,
        seq: instalment.seq,
        basis: instalment.basis,
        percentBp: instalment.percentBp,
        fixedThbMinor: instalment.fixedThbMinor,
        gatesEntryTo: instalment.gatesEntryTo,
        dueThbMinor: instalment.dueThbMinor,
      })),
    );
  }

  /**
   * Move one instalment's `due`.
   *
   * The only column a recompute writes. Not the basis, not the gate — those are the author's
   * statement of intent and re-deriving them from an amount is how "30% of the total" turns
   * into "฿2,822" and stops following the price.
   */
  async updateDue(tx: Tx, instalmentId: string, dueThbMinor: bigint): Promise<void> {
    await tx
      .update(orderInstalments)
      .set({ dueThbMinor, updatedAt: new Date() })
      .where(eq(orderInstalments.id, instalmentId));
  }

  /** Only ever called for a schedule no money has touched; the DB refuses the rest. */
  async deleteAll(tx: Tx, orderId: string): Promise<void> {
    await tx.delete(orderInstalments).where(eq(orderInstalments.orderId, orderId));
  }

  /**
   * Stamp the schedule closed, which is what exempts it from having to foot.
   *
   * Plan 7.5(ก): without the exemption, cancelling an order that already holds money
   * violates the footing assertion and is unrepresentable — unfixable without a migration,
   * on the day somebody needs to cancel. The stamp must land in the same transaction as the
   * move to `cancelled` or `superseded`, and `assert_order_schedule` refuses both halves of
   * the drift: a terminal order with an open schedule, and a live order with a closed one.
   */
  async close(tx: Tx, orderId: string, reason: 'cancelled' | 'superseded'): Promise<void> {
    await tx
      .update(orderPaymentSchedules)
      .set({ closedAt: new Date(), closedReason: reason, updatedAt: new Date() })
      .where(eq(orderPaymentSchedules.orderId, orderId));
  }

  async closedState(
    tx: Tx,
    orderId: string,
  ): Promise<{ closedAt: Date | null; closedReason: 'cancelled' | 'superseded' | null } | null> {
    const [row] = await tx
      .select({
        closedAt: orderPaymentSchedules.closedAt,
        closedReason: orderPaymentSchedules.closedReason,
      })
      .from(orderPaymentSchedules)
      .where(eq(orderPaymentSchedules.orderId, orderId))
      .limit(1);

    return row ?? null;
  }

  /**
   * `MAX(seq)` over the settled prefix — from `order_settled_through()` and from nowhere else.
   *
   * `null` when the order has no schedule at all. `MIN(seq) - 1`, so `0` on a dense schedule,
   * when nothing is settled yet. Those are different answers and this module does not tidy
   * one into the other.
   */
  async settledThrough(tx: Tx, orderId: string): Promise<number | null> {
    const result = await tx.execute(
      sql`select order_settled_through(${orderId}::uuid) as seq`,
    );

    const value = firstRow(result)['seq'];
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return Number.parseInt(value, 10);

    throw new TypeError(`order_settled_through returned ${typeof value}`);
  }

  /**
   * Run the database's own schedule assertion now, instead of at COMMIT.
   *
   * The three constraint triggers are DEFERRED so that a recompute may renumber, delete and
   * re-insert freely inside its transaction and be judged only on what it leaves behind. That
   * is right, and it means a violation surfaces to whoever called `commit()` — which is not
   * this module. Calling the function directly at the end of a write puts the failure back
   * where it was caused.
   */
  async verifySchedule(tx: Tx, orderId: string): Promise<void> {
    await tx.execute(sql`select assert_order_schedule(${orderId}::uuid)`);
  }
}

/**
 * `execute` hands back rows with no schema to infer from, so the shape is checked here
 * rather than asserted — the same treatment `notifications.repository.ts` gives its raw
 * statements, and for the same reason: a cast would turn a renamed column into `undefined`
 * flowing onward as if it were data.
 */
function firstRow(result: unknown): Record<string, unknown> {
  if (typeof result !== 'object' || result === null || !('rows' in result)) return {};

  const { rows } = result as { rows: unknown };
  if (!Array.isArray(rows)) return {};

  const [row] = rows as unknown[];
  return typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : {};
}
