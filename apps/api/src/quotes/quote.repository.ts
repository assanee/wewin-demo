import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db';
// Through @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { and, asc, eq, inArray, sql, type SQL } from '@wewin/db/sql';
import {
  productVersions,
  quoteLines,
  quoteOverrides,
  users,
  type OverrideAnchor,
  type OverrideEntryMode,
  type OverrideReason,
  type QuoteLineKind,
} from '@wewin/db/schema';

import { DRIZZLE } from '../database/database.tokens';

/**
 * Every statement the quote editor writes, and nothing about when it runs.
 *
 * The same split, for the same reason, as `OrderRepository`: **every method takes a
 * transaction handle it did not open**, so the ordering rules live in one readable place
 * instead of being distributed across a dozen methods each with an opinion about atomicity.
 *
 * ── There is no `findOrder` here, and there must not be ──────────────────────────
 *
 * Loading an order is `ScopedOrderRepository`'s job and this file has no second way to do it,
 * for the reason plan 7.4 trap 2 gives. Everything below takes an `orderId` that a
 * `ScopedOrder` has already proved the caller may act on — the type is what carries that
 * proof, and it cannot be manufactured in this module.
 *
 * ── The supersession dance, and why it is written here once ──────────────────────
 *
 * `0016_quote_guards.sql` found that the obvious order of statements is *impossible*:
 * `quote_overrides_one_active_per_line` is a PARTIAL unique index, so it is enforced per
 * statement and cannot be `DEFERRABLE` — only unique *constraints* can be, and a constraint
 * cannot carry a `WHERE`. Insert-then-stamp raises 23505 every time. The sequence that works
 * is
 *
 *     1. choose the successor's id here, in the caller
 *     2. UPDATE the predecessor: superseded_at, by-user, reason, and that id
 *     3. INSERT the successor with that id
 *     4. COMMIT                       ← `quote_overrides_successor_fk` is checked here
 *
 * and it is `product_versions`' "archive first, publish second" arriving a second time. It is
 * a single method (`replaceOverride`) precisely so that no caller can perform it in the order
 * that reads more naturally and fails.
 */

/**
 * `<column> is null`, as a predicate.
 *
 * `@wewin/db/sql` exports `and`, `asc`, `count`, `desc`, `eq`, `inArray`, `or` and `sql` and
 * deliberately not the whole ORM — its own note says the export map exists to keep the surface
 * small. `eq(column, null)` cannot express this (SQL's `= NULL` is never true), so the one
 * shape this feature needs is written once here rather than as a `sql` template inlined at six
 * call sites, each of which would be a place to write `!=` by accident. It is also the
 * definition of *live* in both tables — a line that has not been removed, an override that has
 * not been superseded — which is a concept worth having a name.
 */
const stillLive = (
  column: typeof quoteLines.removedAt | typeof quoteOverrides.supersededAt,
): SQL => sql`${column} is null`;

/** Drizzle names the transaction type nowhere public; read off the callback, as elsewhere. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface QuoteLineRow {
  readonly id: string;
  readonly seq: number;
  readonly kind: QuoteLineKind;
  readonly productVersionId: string | null;
  readonly skuCode: string | null;
  readonly selections: unknown;
  readonly measures: unknown;
  readonly configHash: string | null;
  readonly qty: number;
  readonly computedTotalThbMinor: bigint | null;
  readonly chargeTotalThbMinor: bigint | null;
  readonly isVatApplicable: boolean;
  readonly customerDescriptionTh: string | null;
}

export interface QuoteOverrideRow {
  readonly id: string;
  readonly anchor: OverrideAnchor;
  readonly quoteLineId: string | null;
  readonly computedThbMinor: bigint | null;
  readonly overrideThbMinor: bigint | null;
  readonly computedDays: number | null;
  readonly overrideDays: number | null;
  readonly enteredAs: OverrideEntryMode;
  readonly enteredValueText: string;
  readonly reasonCode: OverrideReason;
  readonly noteTh: string | null;
  readonly setByUserId: string;
  /** `users.display_name`, joined. Plan 7.9 asks *who* set this price; a uuid does not answer it. */
  readonly setByUserName: string | null;
  readonly createdAt: Date;
}

export interface NewCatalogLine {
  readonly orderId: string;
  readonly seq: number;
  readonly productVersionId: string;
  readonly skuCode: string;
  readonly selections: Record<string, string>;
  readonly measures: Record<string, string>;
  readonly configHash: string;
  readonly qty: number;
  readonly computedTotalThbMinor: bigint;
  readonly isVatApplicable: boolean;
  readonly customerDescriptionTh: string | null;
}

export interface NewFreeformLine {
  readonly orderId: string;
  readonly seq: number;
  readonly chargeTotalThbMinor: bigint;
  readonly isVatApplicable: boolean;
  readonly customerDescriptionTh: string;
}

export interface NewOverride {
  readonly orderId: string;
  readonly quoteLineId: string | null;
  readonly anchor: OverrideAnchor;
  readonly computedThbMinor: bigint | null;
  readonly overrideThbMinor: bigint | null;
  readonly computedDays: number | null;
  readonly overrideDays: number | null;
  readonly enteredAs: OverrideEntryMode;
  readonly enteredValueText: string;
  readonly reasonCode: OverrideReason;
  readonly noteTh: string | null;
  readonly setByUserId: string;
}

const LINE_COLUMNS = {
  id: quoteLines.id,
  seq: quoteLines.seq,
  kind: quoteLines.kind,
  productVersionId: quoteLines.productVersionId,
  skuCode: quoteLines.skuCode,
  selections: quoteLines.selections,
  measures: quoteLines.measures,
  configHash: quoteLines.configHash,
  qty: quoteLines.qty,
  computedTotalThbMinor: quoteLines.computedTotalThbMinor,
  chargeTotalThbMinor: quoteLines.chargeTotalThbMinor,
  isVatApplicable: quoteLines.isVatApplicable,
  customerDescriptionTh: quoteLines.customerDescriptionTh,
} as const;

const OVERRIDE_COLUMNS = {
  id: quoteOverrides.id,
  anchor: quoteOverrides.anchor,
  quoteLineId: quoteOverrides.quoteLineId,
  computedThbMinor: quoteOverrides.computedThbMinor,
  overrideThbMinor: quoteOverrides.overrideThbMinor,
  computedDays: quoteOverrides.computedDays,
  overrideDays: quoteOverrides.overrideDays,
  enteredAs: quoteOverrides.enteredAs,
  enteredValueText: quoteOverrides.enteredValueText,
  reasonCode: quoteOverrides.reasonCode,
  noteTh: quoteOverrides.noteTh,
  setByUserId: quoteOverrides.setByUserId,
  setByUserName: users.displayName,
  createdAt: quoteOverrides.createdAt,
} as const;

@Injectable()
export class QuoteRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Inside a transaction when there is one, outside when there is not. As `OrderRepository`. */
  private executor(tx?: Tx): Tx {
    return tx ?? (this.db as unknown as Tx);
  }

  /**
   * The one door into a transaction, so a caller cannot forget to open one.
   *
   * It deliberately does **not** translate driver errors, which is where `OrderRepository`
   * puts its own translation. The difference is that a quote guard's message depends on what
   * the caller was trying to do — `quote_lines_guard_write()` raises the same
   * `restrict_violation` for "reprice a promised line" and "remove a promised line", and the
   * two sentences a salesperson needs are different — so the translation happens one level
   * out, where the operation is known. See `pg-errors.ts`.
   */
  async transaction<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(run);
  }

  /* ---------------------------------------------------------------- *
   * Reading
   * ---------------------------------------------------------------- */

  /** The live quote, in display order. Removed lines are history and are not in it. */
  /**
   * Money the company holds against this order, in satang.
   *
   * ⚠️ `order_held_thb_minor()` and never `order_cash_thb_minor()` —
   * `0011_payment_guards.sql:44-52` is explicit that held is *"the branch every 'have we been
   * paid?' decision must ask"*, because a revision order carrying money forward from its
   * ancestor has no cash leg of its own and reports zero cash for ever.
   */
  async heldThbMinor(tx: Tx, orderId: string): Promise<bigint> {
    const result = await tx.execute(sql`select order_held_thb_minor(${orderId}::uuid) as held`);

    /*
     * Unwrapped the way every other raw fold in this codebase is: the driver hands back a
     * `QueryResult`, and `bigint` arrives as a string on a column this wide.
     */
    const rows = (result as { rows?: readonly Record<string, unknown>[] }).rows ?? [];
    const value = rows[0]?.['held'];
    if (value === null || value === undefined) return 0n;
    if (typeof value === 'bigint') return value;
    if (typeof value === 'string' || typeof value === 'number') return BigInt(value);

    throw new TypeError(`order_held_thb_minor returned ${typeof value}`);
  }

  async listLines(orderId: string, tx?: Tx): Promise<QuoteLineRow[]> {
    return this.executor(tx)
      .select(LINE_COLUMNS)
      .from(quoteLines)
      .where(and(eq(quoteLines.orderId, orderId), stillLive(quoteLines.removedAt)))
      .orderBy(asc(quoteLines.seq));
  }

  async findLine(orderId: string, lineId: string, tx?: Tx): Promise<QuoteLineRow | undefined> {
    const [row] = await this.executor(tx)
      .select(LINE_COLUMNS)
      .from(quoteLines)
      .where(
        and(
          eq(quoteLines.orderId, orderId),
          eq(quoteLines.id, lineId),
          stillLive(quoteLines.removedAt),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * Every live override on this quote, oldest first.
   *
   * The order is not cosmetic. `applyOverrides` keys line overrides by line, and
   * `quote_overrides_one_active_per_line` makes that at most one row — but if that index were
   * ever dropped, an ascending read means the *latest* promise is the one that survives the
   * map, which is the only defensible answer to a question the schema says cannot be asked.
   */
  async listLiveOverrides(orderId: string, tx?: Tx): Promise<QuoteOverrideRow[]> {
    return this.executor(tx)
      .select(OVERRIDE_COLUMNS)
      .from(quoteOverrides)
      /* `set_by_user_id` is NOT NULL and references `users`, so this drops nothing. */
      .innerJoin(users, eq(users.id, quoteOverrides.setByUserId))
      .where(and(eq(quoteOverrides.orderId, orderId), stillLive(quoteOverrides.supersededAt)))
      .orderBy(asc(quoteOverrides.createdAt), asc(quoteOverrides.id));
  }

  async findLiveOverride(
    orderId: string,
    overrideId: string,
    tx?: Tx,
  ): Promise<QuoteOverrideRow | undefined> {
    const [row] = await this.executor(tx)
      .select(OVERRIDE_COLUMNS)
      .from(quoteOverrides)
      .innerJoin(users, eq(users.id, quoteOverrides.setByUserId))
      .where(
        and(
          eq(quoteOverrides.orderId, orderId),
          eq(quoteOverrides.id, overrideId),
          stillLive(quoteOverrides.supersededAt),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * `product_version_id` → `product_id`, and nothing else.
   *
   * ⚠️ This is the one query in the feature that touches a catalogue table directly, so it is
   * worth saying what it is not. `CatalogModule`'s note forbids a *second reader of the
   * catalogue*: a query that recomposes a product from the normalised rows and prices from it,
   * disagreeing with the frozen document the customer was quoted from. This reads one foreign
   * key. It materialises no product, applies no availability overlay, verifies no hash and
   * prices nothing — it answers "which product is this archived version a version of", which
   * `CatalogRepository` cannot answer because it serves only what is published, and the whole
   * point of the question is that this version no longer is.
   *
   * The alternative was a `product_id` column on `quote_lines`, which is a migration in a
   * package this round does not put in one agent's hands, and which would be a second copy of
   * a fact `product_versions` already holds.
   */
  async productIdsForVersions(
    versionIds: readonly string[],
    tx?: Tx,
  ): Promise<ReadonlyMap<string, string>> {
    if (versionIds.length === 0) return new Map();

    const rows = await this.executor(tx)
      .select({ id: productVersions.id, productId: productVersions.productId })
      .from(productVersions)
      .where(inArray(productVersions.id, [...versionIds]));

    return new Map(rows.map((row) => [row.id, row.productId]));
  }

  /* ---------------------------------------------------------------- *
   * Writing — lines
   * ---------------------------------------------------------------- */

  /**
   * The next display position. `MAX(seq) + 1`, never `COUNT(*) + 1`.
   *
   * `quote_lines.seq` is deliberately not dense (see the schema): a removed line leaves its
   * number behind, because reusing it would make two different lines share a position in an
   * audit trail. `COUNT(*) + 1` would reuse it and collide with `quote_lines_order_seq_key`
   * the first time anybody removed a line and added another.
   */
  async nextSeq(tx: Tx, orderId: string): Promise<number> {
    const [row] = await tx
      .select({ highest: sql<number | null>`max(${quoteLines.seq})` })
      .from(quoteLines)
      .where(eq(quoteLines.orderId, orderId));
    return (row?.highest ?? 0) + 1;
  }

  async countLines(tx: Tx, orderId: string): Promise<number> {
    const [row] = await tx
      .select({ live: sql<number>`count(*)::int` })
      .from(quoteLines)
      .where(and(eq(quoteLines.orderId, orderId), stillLive(quoteLines.removedAt)));
    return row?.live ?? 0;
  }

  async insertCatalogLine(tx: Tx, line: NewCatalogLine): Promise<string> {
    const [row] = await tx
      .insert(quoteLines)
      .values({
        orderId: line.orderId,
        seq: line.seq,
        kind: 'catalog',
        productVersionId: line.productVersionId,
        skuCode: line.skuCode,
        selections: line.selections,
        measures: line.measures,
        configHash: line.configHash,
        qty: line.qty,
        computedTotalThbMinor: line.computedTotalThbMinor,
        isVatApplicable: line.isVatApplicable,
        customerDescriptionTh: line.customerDescriptionTh,
      })
      .returning({ id: quoteLines.id });

    if (!row) throw new Error('quotes: inserting a quote line returned nothing');
    return row.id;
  }

  async insertFreeformLine(tx: Tx, line: NewFreeformLine): Promise<string> {
    const [row] = await tx
      .insert(quoteLines)
      .values({
        orderId: line.orderId,
        seq: line.seq,
        kind: 'freeform',
        qty: 1,
        chargeTotalThbMinor: line.chargeTotalThbMinor,
        isVatApplicable: line.isVatApplicable,
        customerDescriptionTh: line.customerDescriptionTh,
      })
      .returning({ id: quoteLines.id });

    if (!row) throw new Error('quotes: inserting a quote line returned nothing');
    return row.id;
  }

  /**
   * Re-price a configured line: the fields a works order renders from, and the figure they
   * produced. `product_version_id` is not among them and never moves.
   */
  async reviseLine(
    tx: Tx,
    input: {
      readonly lineId: string;
      readonly skuCode: string;
      readonly selections: Record<string, string>;
      readonly measures: Record<string, string>;
      readonly configHash: string;
      readonly qty: number;
      readonly computedTotalThbMinor: bigint;
    },
  ): Promise<void> {
    await tx
      .update(quoteLines)
      .set({
        skuCode: input.skuCode,
        selections: input.selections,
        measures: input.measures,
        configHash: input.configHash,
        qty: input.qty,
        computedTotalThbMinor: input.computedTotalThbMinor,
        updatedAt: new Date(),
      })
      .where(eq(quoteLines.id, input.lineId));
  }

  /** The customer-facing half. Never reaches a production sheet — plan 7.9(ค). */
  async presentLine(
    tx: Tx,
    input: {
      readonly lineId: string;
      readonly customerDescriptionTh?: string | null;
      readonly isVatApplicable?: boolean;
    },
  ): Promise<void> {
    const patch: {
      customerDescriptionTh?: string | null;
      isVatApplicable?: boolean;
      updatedAt: Date;
    } = { updatedAt: new Date() };

    if (input.customerDescriptionTh !== undefined) {
      patch.customerDescriptionTh = input.customerDescriptionTh;
    }
    if (input.isVatApplicable !== undefined) patch.isVatApplicable = input.isVatApplicable;

    await tx.update(quoteLines).set(patch).where(eq(quoteLines.id, input.lineId));
  }

  /**
   * Before submit a line is a cart item and is deleted; afterwards it is history and is
   * stamped. `quote_lines_guard_write()` enforces exactly this split and would refuse the
   * wrong one, so the branch here is about producing the right error message rather than
   * about being the guard.
   */
  async deleteLine(tx: Tx, lineId: string): Promise<void> {
    await tx.delete(quoteLines).where(eq(quoteLines.id, lineId));
  }

  async removeLine(tx: Tx, lineId: string, removedByUserId: string): Promise<void> {
    await tx
      .update(quoteLines)
      .set({ removedAt: new Date(), removedByUserId, updatedAt: new Date() })
      .where(eq(quoteLines.id, lineId));
  }

  /* ---------------------------------------------------------------- *
   * Writing — overrides
   * ---------------------------------------------------------------- */

  /** The first promise on an anchor: nothing to supersede. */
  async insertOverride(tx: Tx, override: NewOverride): Promise<string> {
    const id = randomUUID();
    await tx.insert(quoteOverrides).values({ id, ...override });
    return id;
  }

  /**
   * ⭐ Replace a live override with a new one — in the order the partial unique index forces.
   *
   * Stamp, then insert. See the block comment at the top of this file and the ORDER OF
   * STATEMENTS block in `0016_quote_guards.sql`; doing it the other way round is 23505, every
   * time, and the deferrable `quote_overrides_successor_fk` is what makes this order legal.
   */
  async replaceOverride(
    tx: Tx,
    input: {
      readonly predecessorId: string;
      readonly supersededByUserId: string;
      readonly successor: NewOverride;
    },
  ): Promise<string> {
    const successorId = randomUUID();

    await tx
      .update(quoteOverrides)
      .set({
        supersededAt: new Date(),
        supersededByUserId: input.supersededByUserId,
        supersessionReason: 'replaced',
        supersededByOverrideId: successorId,
      })
      .where(eq(quoteOverrides.id, input.predecessorId));

    await tx.insert(quoteOverrides).values({ id: successorId, ...input.successor });

    return successorId;
  }

  /**
   * Withdraw one, leaving no successor.
   *
   * This is also how sales *confirms* a price after the catalogue moved (plan 7.9(จ)): an
   * override equal to today's computed figure is refused by `quote_overrides_value_differs`,
   * because agreeing with the machine is the absence of a promise rather than a new one.
   */
  async revokeOverride(tx: Tx, overrideId: string, supersededByUserId: string): Promise<void> {
    await tx
      .update(quoteOverrides)
      .set({
        supersededAt: new Date(),
        supersededByUserId,
        supersessionReason: 'revoked',
      })
      .where(eq(quoteOverrides.id, overrideId));
  }
}
