import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db/client';
import { and, asc, desc, eq, inArray, sql } from '@wewin/db/sql';
import {
  approvals,
  authorityLimits,
  groups,
  orderDocuments,
  orderInstalments,
  orders,
  quoteLines,
  quoteOverrides,
  users,
  APPROVAL_STATUSES,
  VAT_TREATMENTS,
  type ApprovalDimension,
  type OrderStatus,
} from '@wewin/db/schema';

import { DRIZZLE } from '../../database/database.tokens';
import type { PlannedInstalment } from '../../payments/schedule';
import { quoteRevision } from '../revision';
import type { OverrideFacts, QuoteLineFacts } from './concession';

/**
 * Every statement this module reads or writes, and nothing about when it runs.
 *
 * The split `src/orders` and `src/payments` both make: each method takes a transaction handle
 * it did not open, so the ordering rules — lock the order, measure, compare, decide — are
 * readable in one place instead of distributed across a dozen methods each with a private
 * opinion about whether it is atomic.
 *
 * ── What this reads that it does not own ─────────────────────────────────────────
 *
 * `quote_lines` and `quote_overrides` are 5c's editing surface and belong to another file this
 * round. This module reads them and never writes them, deliberately: the concession is
 * measured **from the rows**, in the same transaction as the submit that is being gated, so
 * there is no window in which a caller could hand this module a smaller figure than the
 * document actually grants. A gate that trusts a number passed to it is a gate with a
 * parameter for getting past it.
 */

export type AuthorityTx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Derived from the list rather than imported: `packages/db` exports `APPROVAL_STATUSES` and no
 * type alias beside it, and inventing a second literal union here is how the two drift apart.
 */
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
type VatTreatment = (typeof VAT_TREATMENTS)[number];

export interface OrderFacts {
  readonly id: string;
  readonly orderNo: string | null;
  readonly status: OrderStatus;
  /** NULL until submit pins it — `orders_submitted_shape` ties the two together. */
  readonly grandTotalThbMinor: bigint | null;
  readonly documentId: string | null;
}

/** The VAT rule a concession is grossed up with: the document's, once there is a document. */
export interface PinnedVat {
  readonly rateBp: number;
  readonly treatment: VatTreatment;
}

export interface ApprovalRow {
  readonly id: string;
  readonly orderId: string;
  readonly orderNo: string | null;
  /** Evidence of which pinned revision the approver was looking at. NULL before any submit. */
  readonly orderDocumentId: string | null;
  readonly documentRevision: number | null;
  /** ⭐ The subject: the quote this decision was measured against. See `AuthorityService.judge`. */
  readonly quoteRevision: string;
  readonly dimension: ApprovalDimension;
  readonly status: ApprovalStatus;
  readonly concessionThbMinor: bigint;
  readonly reasonTh: string;
  readonly requestedByUserId: string;
  readonly requestedByName: string | null;
  readonly decidedByUserId: string | null;
  readonly decidedAt: Date | null;
  readonly decisionNoteTh: string | null;
  /** The decider's own ceiling when they approved. NULL on `pending` and on `rejected`. */
  readonly decidedCeilingThbMinor: bigint | null;
  readonly createdAt: Date;
}

export interface AuthorityLimitRow {
  readonly groupId: string;
  readonly groupCode: string;
  readonly groupNameTh: string;
  readonly dimension: ApprovalDimension;
  readonly maxConcessionThbMinor: bigint;
  readonly grantedByUserId: string;
  readonly updatedAt: Date;
  readonly noteTh: string | null;
}

@Injectable()
export class AuthorityRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** For the read paths, which have nothing to be atomic about. */
  private executor(tx?: AuthorityTx): AuthorityTx {
    return tx ?? (this.db as unknown as AuthorityTx);
  }

  async transaction<T>(run: (tx: AuthorityTx) => Promise<T>): Promise<T> {
    return this.db.transaction(run);
  }

  /* ---------------------------------------------------------------- *
   * The facts a measurement is made from
   * ---------------------------------------------------------------- */

  /**
   * The order, locked.
   *
   * `FOR UPDATE` and not a plain read, for the reason plan 7.4 trap 4 gives about submit: two
   * people editing one quote must not both measure a concession against a document that the
   * other is about to replace. The lock is taken on `orders` — the row every 5c write already
   * takes — rather than on the lines, so this module queues behind the editor instead of
   * racing it.
   */
  async lockOrder(tx: AuthorityTx, orderId: string): Promise<OrderFacts | undefined> {
    const [row] = await tx
      .select({
        id: orders.id,
        orderNo: orders.orderNo,
        status: orders.status,
        grandTotalThbMinor: orders.grandTotalThbMinor,
        documentId: orders.documentId,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
      .for('update');

    return row;
  }

  /** The same row without the lock, for the read-only assessment endpoint. */
  async readOrder(orderId: string, tx?: AuthorityTx): Promise<OrderFacts | undefined> {
    const [row] = await this.executor(tx)
      .select({
        id: orders.id,
        orderNo: orders.orderNo,
        status: orders.status,
        grandTotalThbMinor: orders.grandTotalThbMinor,
        documentId: orders.documentId,
      })
      .from(orders)
      .where(eq(orders.id, orderId));

    return row;
  }

  /**
   * The VAT rule the concession is grossed up with.
   *
   * From the pinned document when there is one, because a concession measured at 7% against a
   * document pinned at 0% is a number about a quote that does not exist. Before submit there is
   * no document and the caller supplies the current default — plan 13's, which is a default and
   * not a decision.
   */
  async pinnedVat(orderDocumentId: string, tx?: AuthorityTx): Promise<PinnedVat | undefined> {
    const [row] = await this.executor(tx)
      .select({
        rateBp: orderDocuments.pinnedVatRateBp,
        treatment: orderDocuments.pinnedVatTreatment,
      })
      .from(orderDocuments)
      .where(eq(orderDocuments.id, orderDocumentId));

    return row;
  }

  /** Live lines only. A removed line concedes nothing — it is not on the quote. */
  async liveLines(orderId: string, tx?: AuthorityTx): Promise<readonly QuoteLineFacts[]> {
    return this.executor(tx)
      .select({
        id: quoteLines.id,
        kind: quoteLines.kind,
        isVatApplicable: quoteLines.isVatApplicable,
        computedTotalThbMinor: quoteLines.computedTotalThbMinor,
        chargeTotalThbMinor: quoteLines.chargeTotalThbMinor,
      })
      .from(quoteLines)
      .where(and(eq(quoteLines.orderId, orderId), sql`${quoteLines.removedAt} is null`))
      .orderBy(asc(quoteLines.seq));
  }

  /**
   * Live overrides only — `superseded_at IS NULL`, the same predicate the two partial unique
   * indexes partition on. A superseded row is what the company promised last week; it is
   * history, and history is not conceded twice.
   */
  async liveOverrides(orderId: string, tx?: AuthorityTx): Promise<readonly OverrideFacts[]> {
    return this.executor(tx)
      .select({
        id: quoteOverrides.id,
        anchor: quoteOverrides.anchor,
        quoteLineId: quoteOverrides.quoteLineId,
        computedThbMinor: quoteOverrides.computedThbMinor,
        overrideThbMinor: quoteOverrides.overrideThbMinor,
        reasonCode: quoteOverrides.reasonCode,
      })
      .from(quoteOverrides)
      .where(and(eq(quoteOverrides.orderId, orderId), sql`${quoteOverrides.supersededAt} is null`))
      .orderBy(asc(quoteOverrides.createdAt));
  }

  /**
   * ⭐ The digest of the live quote — the subject an approval is attached to.
   *
   * `quoteRevision` from `../revision` and not a second digest: the token a client echoes on
   * every write, the token an approval names, and the token `judge` compares must be the same
   * function over the same fields, or an approval could cover a quote the editor considers
   * different (or fail to cover one it considers identical). Two spellings of "is this the same
   * quote?" is plan 7.13's opening finding in the module written to stop it.
   *
   * The columns are therefore the ones `RevisionLine`/`RevisionOverride` name, and no others.
   */
  async quoteRevision(orderId: string, tx?: AuthorityTx): Promise<string> {
    const executor = this.executor(tx);

    const [lines, overrides] = await Promise.all([
      executor
        .select({
          id: quoteLines.id,
          seq: quoteLines.seq,
          kind: quoteLines.kind,
          productVersionId: quoteLines.productVersionId,
          skuCode: quoteLines.skuCode,
          selections: quoteLines.selections,
          measures: quoteLines.measures,
          qty: quoteLines.qty,
          computedTotalThbMinor: quoteLines.computedTotalThbMinor,
          chargeTotalThbMinor: quoteLines.chargeTotalThbMinor,
          isVatApplicable: quoteLines.isVatApplicable,
          customerDescriptionTh: quoteLines.customerDescriptionTh,
        })
        .from(quoteLines)
        .where(and(eq(quoteLines.orderId, orderId), sql`${quoteLines.removedAt} is null`)),
      executor
        .select({
          id: quoteOverrides.id,
          anchor: quoteOverrides.anchor,
          quoteLineId: quoteOverrides.quoteLineId,
          computedThbMinor: quoteOverrides.computedThbMinor,
          overrideThbMinor: quoteOverrides.overrideThbMinor,
          computedDays: quoteOverrides.computedDays,
          overrideDays: quoteOverrides.overrideDays,
        })
        .from(quoteOverrides)
        .where(
          and(eq(quoteOverrides.orderId, orderId), sql`${quoteOverrides.supersededAt} is null`),
        ),
    ]);

    return quoteRevision(lines, overrides);
  }

  /** The schedule, in the shape `payments/schedule` measures the gated prefix from. */
  async instalments(orderId: string, tx?: AuthorityTx): Promise<readonly PlannedInstalment[]> {
    return this.executor(tx)
      .select({
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
  }

  /* ---------------------------------------------------------------- *
   * Authority — the ceilings, which do not exist yet
   * ---------------------------------------------------------------- */

  /**
   * The largest ceiling any of these groups carries in this dimension, or `undefined`.
   *
   * `undefined` is **not zero** and the difference is the whole of plan 13's fail-closed rule:
   * no row means no authority, a row of `0` means a role that may record a concession and
   * approve none of its own. Both end in "this needs an approval"; they end in different
   * sentences, and the schema comment says the difference is exactly that.
   *
   * The maximum and not the sum: being in two roles is being trusted with the larger of two
   * authorities, never with their total. A sum would make group membership a way of
   * manufacturing authority nobody granted.
   */
  async ceiling(
    groupIds: readonly string[],
    dimension: ApprovalDimension,
    tx?: AuthorityTx,
  ): Promise<bigint | undefined> {
    if (groupIds.length === 0) return undefined;

    const [row] = await this.executor(tx)
      .select({ ceiling: sql<string>`max(${authorityLimits.maxConcessionThbMinor})` })
      .from(authorityLimits)
      .where(
        and(
          eq(authorityLimits.dimension, dimension),
          inArray(authorityLimits.groupId, [...groupIds]),
        ),
      );

    /* `max()` over no rows is one row holding NULL, which is the no-authority case. */
    if (row === undefined || row.ceiling === null) return undefined;
    return BigInt(row.ceiling);
  }

  async listLimits(tx?: AuthorityTx): Promise<readonly AuthorityLimitRow[]> {
    return this.executor(tx)
      .select({
        groupId: authorityLimits.groupId,
        groupCode: groups.code,
        groupNameTh: groups.nameTh,
        dimension: authorityLimits.dimension,
        maxConcessionThbMinor: authorityLimits.maxConcessionThbMinor,
        grantedByUserId: authorityLimits.grantedByUserId,
        updatedAt: authorityLimits.updatedAt,
        noteTh: authorityLimits.noteTh,
      })
      .from(authorityLimits)
      .innerJoin(groups, eq(groups.id, authorityLimits.groupId))
      .orderBy(asc(groups.code), asc(authorityLimits.dimension));
  }

  async setLimit(
    input: {
      readonly groupId: string;
      readonly dimension: ApprovalDimension;
      readonly maxConcessionThbMinor: bigint;
      readonly grantedByUserId: string;
      readonly noteTh: string | null;
    },
    tx?: AuthorityTx,
  ): Promise<void> {
    await this.executor(tx)
      .insert(authorityLimits)
      .values({
        groupId: input.groupId,
        dimension: input.dimension,
        maxConcessionThbMinor: input.maxConcessionThbMinor,
        grantedByUserId: input.grantedByUserId,
        noteTh: input.noteTh,
      })
      .onConflictDoUpdate({
        target: [authorityLimits.groupId, authorityLimits.dimension],
        set: {
          maxConcessionThbMinor: input.maxConcessionThbMinor,
          /* Raising a ceiling is an act with a name on it, so the name moves with the number. */
          grantedByUserId: input.grantedByUserId,
          noteTh: input.noteTh,
          updatedAt: new Date(),
        },
      });
  }

  async deleteLimit(
    groupId: string,
    dimension: ApprovalDimension,
    tx?: AuthorityTx,
  ): Promise<boolean> {
    const removed = await this.executor(tx)
      .delete(authorityLimits)
      .where(
        and(eq(authorityLimits.groupId, groupId), eq(authorityLimits.dimension, dimension)),
      )
      .returning({ groupId: authorityLimits.groupId });

    return removed.length > 0;
  }

  /* ---------------------------------------------------------------- *
   * Approvals — the existing table, and no fifth mechanism
   * ---------------------------------------------------------------- */

  private approvalColumns() {
    return {
      id: approvals.id,
      orderId: approvals.orderId,
      orderNo: orders.orderNo,
      orderDocumentId: approvals.orderDocumentId,
      documentRevision: orderDocuments.revision,
      quoteRevision: approvals.quoteRevision,
      dimension: approvals.dimension,
      status: approvals.status,
      concessionThbMinor: approvals.concessionThbMinor,
      reasonTh: approvals.reasonTh,
      requestedByUserId: approvals.requestedByUserId,
      requestedByName: users.displayName,
      decidedByUserId: approvals.decidedByUserId,
      decidedAt: approvals.decidedAt,
      decisionNoteTh: approvals.decisionNoteTh,
      decidedCeilingThbMinor: approvals.decidedCeilingThbMinor,
      createdAt: approvals.createdAt,
    };
  }

  async approvalById(approvalId: string, tx?: AuthorityTx): Promise<ApprovalRow | undefined> {
    const [row] = await this.executor(tx)
      .select(this.approvalColumns())
      .from(approvals)
      .innerJoin(orders, eq(orders.id, approvals.orderId))
      /*
       * LEFT, and it is load-bearing: `order_document_id` is nullable now that the subject of
       * an approval is the quote revision rather than the document, and an inner join would
       * make every request raised before a submit invisible to the inbox, to `judge` and to
       * the requester — which is silent fail-*open*, because a `covering` row that cannot be
       * read is a row that cannot cover.
       */
      .leftJoin(orderDocuments, eq(orderDocuments.id, approvals.orderDocumentId))
      .innerJoin(users, eq(users.id, approvals.requestedByUserId))
      .where(eq(approvals.id, approvalId));

    return row;
  }

  /** The same row, locked, so two approvers cannot both decide one request. */
  async lockApproval(tx: AuthorityTx, approvalId: string): Promise<ApprovalRow | undefined> {
    const [locked] = await tx
      .select({ id: approvals.id })
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .for('update');

    if (locked === undefined) return undefined;
    return this.approvalById(approvalId, tx);
  }

  /**
   * The approver's inbox — plan 7.13's *"กล่องขาเข้าของผู้อนุมัติ"*, which the design produced
   * requests for and never gave anywhere to arrive.
   *
   * Oldest first, because the thing an approver has to notice is the request that has been
   * waiting longest, and because `approvals_pending_idx` is `(created_at) WHERE status =
   * 'pending'` — a queue ordered the other way would read the same index backwards for a
   * screen nobody wants.
   */
  async inbox(
    filter: { readonly status: ApprovalStatus; readonly orderId?: string | undefined },
    limit: number,
    tx?: AuthorityTx,
  ): Promise<readonly ApprovalRow[]> {
    const where =
      filter.orderId === undefined
        ? eq(approvals.status, filter.status)
        : and(eq(approvals.status, filter.status), eq(approvals.orderId, filter.orderId));

    return this.executor(tx)
      .select(this.approvalColumns())
      .from(approvals)
      .innerJoin(orders, eq(orders.id, approvals.orderId))
      /*
       * LEFT, and it is load-bearing: `order_document_id` is nullable now that the subject of
       * an approval is the quote revision rather than the document, and an inner join would
       * make every request raised before a submit invisible to the inbox, to `judge` and to
       * the requester — which is silent fail-*open*, because a `covering` row that cannot be
       * read is a row that cannot cover.
       */
      .leftJoin(orderDocuments, eq(orderDocuments.id, approvals.orderDocumentId))
      .innerJoin(users, eq(users.id, approvals.requestedByUserId))
      .where(where)
      .orderBy(filter.status === 'pending' ? asc(approvals.createdAt) : desc(approvals.createdAt))
      .limit(limit);
  }

  /**
   * Every decision taken on this order, in either dimension.
   *
   * Read per **order** and not per document on purpose — see `AuthorityService.gate`, which
   * explains why an approval taken against an earlier revision may still cover a later one and
   * what that costs.
   */
  async approvalsForOrder(orderId: string, tx?: AuthorityTx): Promise<readonly ApprovalRow[]> {
    return this.executor(tx)
      .select(this.approvalColumns())
      .from(approvals)
      .innerJoin(orders, eq(orders.id, approvals.orderId))
      /*
       * LEFT, and it is load-bearing: `order_document_id` is nullable now that the subject of
       * an approval is the quote revision rather than the document, and an inner join would
       * make every request raised before a submit invisible to the inbox, to `judge` and to
       * the requester — which is silent fail-*open*, because a `covering` row that cannot be
       * read is a row that cannot cover.
       */
      .leftJoin(orderDocuments, eq(orderDocuments.id, approvals.orderDocumentId))
      .innerJoin(users, eq(users.id, approvals.requestedByUserId))
      .where(eq(approvals.orderId, orderId))
      .orderBy(desc(approvals.createdAt));
  }

  async insertApproval(
    tx: AuthorityTx,
    input: {
      readonly orderId: string;
      readonly orderDocumentId: string | null;
      readonly quoteRevision: string;
      readonly dimension: ApprovalDimension;
      readonly concessionThbMinor: bigint;
      readonly reasonTh: string;
      readonly requestedByUserId: string;
    },
  ): Promise<string> {
    const [row] = await tx
      .insert(approvals)
      .values({
        orderId: input.orderId,
        orderDocumentId: input.orderDocumentId,
        quoteRevision: input.quoteRevision,
        dimension: input.dimension,
        concessionThbMinor: input.concessionThbMinor,
        reasonTh: input.reasonTh,
        requestedByUserId: input.requestedByUserId,
      })
      .returning({ id: approvals.id });

    if (row === undefined) throw new Error('approvals insert returned nothing');
    return row.id;
  }

  /**
   * Record the decision.
   *
   * The `status = 'pending'` in the WHERE is not decoration: the row is locked above, but this
   * makes a second decision on an already-decided request update **zero rows** rather than
   * overwrite the first answer, even if a future caller forgets the lock.
   */
  async recordDecision(
    tx: AuthorityTx,
    input: {
      readonly approvalId: string;
      readonly status: Exclude<ApprovalStatus, 'pending'>;
      readonly decidedByUserId: string;
      readonly decisionNoteTh: string | null;
      /** The decider's ceiling, pinned. NULL on a rejection — saying no needs no authority. */
      readonly decidedCeilingThbMinor: bigint | null;
    },
  ): Promise<boolean> {
    const updated = await tx
      .update(approvals)
      .set({
        status: input.status,
        decidedByUserId: input.decidedByUserId,
        decidedAt: new Date(),
        decisionNoteTh: input.decisionNoteTh,
        decidedCeilingThbMinor: input.decidedCeilingThbMinor,
        updatedAt: new Date(),
      })
      .where(and(eq(approvals.id, input.approvalId), eq(approvals.status, 'pending')))
      .returning({ id: approvals.id });

    return updated.length > 0;
  }
}
