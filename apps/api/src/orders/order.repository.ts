import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db';
// Through @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { and, asc, desc, eq, sql } from '@wewin/db/sql';
import {
  ORDER_ACTOR_KINDS,
  ORDER_EVENT_TYPES,
  guests,
  orderChangeRequests,
  orderDocumentProductVersions,
  orderDocuments,
  orderEvents,
  orderStatusTransitions,
  orders,
  type OrderStatus,
} from '@wewin/db/schema';
import { orderDocumentWireSchema, type OrderDocumentWire } from '@wewin/contract/order';

import { DRIZZLE } from '../database/database.tokens';
import { guestSecretHash, mintGuestSecret, type GuestCookie } from '../rbac';
import { AppError } from '../common/errors/app-error';
import type { TransitionRow } from './transitions';
import { withTranslatedOrderErrors } from './pg-errors';

/**
 * Every statement the order lifecycle *writes*, and nothing about when it runs.
 *
 * The split from `orders.service.ts` is the same one `src/admin` makes and for the same
 * reason: **every method here takes a transaction handle it did not open**, so the ordering
 * rules — the row lock, then the event, then the document, then the order — are readable in
 * one place instead of being distributed across a dozen methods each with an opinion about
 * whether it is atomic.
 *
 * ── There is no `findOrder` here, and there must not be ──────────────────────────
 *
 * Loading an order is `ScopedOrderRepository`'s job (`./scope`), and this file deliberately
 * has no second way to do it. Plan 7.4 trap 2 is about ownership living in the query, and a
 * `select().from(orders).where(eq(orders.id, …))` in this file would be exactly the unscoped
 * loader that a future refactor hands to a transition handler. The scoped repository returns
 * a branded `ScopedOrder` that nothing else can construct, so the state machine below
 * physically cannot be handed a row that no filter ever ran against.
 *
 * What is here is everything that happens *to* a row already loaded that way, plus the two
 * inserts that create one.
 *
 * ── The insert order is forced by the schema, and is written down here once ──────
 *
 * An order names the event that set its status and an event names its order, both NOT NULL;
 * the cycle is broken by `orders_status_event_fk` being DEFERRABLE INITIALLY DEFERRED, which
 * costs exactly one thing — the caller must choose the event's id before inserting either
 * row. `createDraft` is the whole of that dance.
 */

/** Drizzle names the transaction type nowhere public, so it is read off the callback. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** The closed sets, as the schema declares them — so a `string` cannot reach a column. */
export type OrderEventType = (typeof ORDER_EVENT_TYPES)[number];
export type OrderActorKind = (typeof ORDER_ACTOR_KINDS)[number];

export interface OrderEventRow {
  readonly id: string;
  readonly seq: number;
  readonly eventType: OrderEventType;
  readonly fromStatus: OrderStatus | null;
  readonly toStatus: OrderStatus | null;
  readonly actorKind: OrderActorKind;
  readonly actorUserId: string | null;
  readonly payload: unknown;
  /**
   * `pg_current_xact_id()::text` — which transaction wrote this row.
   *
   * A `text` and not a `bigint` because a 64-bit xid8 does not survive a JSON number, and
   * because nothing arithmetic is ever done to it: it is only ever compared for equality with
   * the txid of the row beside it. Two rows sharing it were one atomic act.
   */
  readonly writeTxid: string;
  readonly createdAt: Date;
}

export interface OrderDocumentRow {
  readonly id: string;
  readonly revision: number;
  readonly documentHash: string;
  readonly document: OrderDocumentWire;
  readonly createdByEventId: string;
  readonly createdAt: Date;
}

export interface ChangeRequestRow {
  readonly id: string;
  readonly noteTh: string | null;
  readonly createdAt: Date;
  readonly resolution: string | null;
  readonly resolvedAt: Date | null;
}

export interface AppendEventInput {
  readonly orderId: string;
  readonly eventType: OrderEventType;
  readonly fromStatus: OrderStatus | null;
  readonly toStatus: OrderStatus | null;
  readonly actorKind: OrderActorKind;
  readonly actorUserId: string | null;
  readonly actorGuestId: string | null;
  readonly payload: Record<string, unknown>;
}

@Injectable()
export class OrderRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Inside a transaction when there is one, outside when there is not.
   *
   * The optional handle is not convenience: a read taken *inside* the transition's
   * transaction sees the rows that transaction has just written and is blocked by nobody
   * else's lock, and the same read from a controller assembling a response must not open a
   * transaction of its own to get an answer that is already committed.
   */
  private executor(tx?: Tx): Tx {
    return tx ?? (this.db as unknown as Tx);
  }

  /** The one door into a transaction, so a caller cannot forget to open one. */
  async transaction<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
    return withTranslatedOrderErrors(() => this.db.transaction(run));
  }

  /* ---------------------------------------------------------------- *
   * Reading
   * ---------------------------------------------------------------- */

  /** The order this one was replaced by, if it was. One row, by `orders_supersedes_order_key`. */
  async findSuccessorId(orderId: string, tx?: Tx): Promise<string | null> {
    /*
     * `tx` matters more than it looks: a supersede creates the successor and moves the
     * predecessor in one transaction, so the response is assembled while the successor is
     * still uncommitted. A read outside the transaction cannot see it and would answer
     * `supersededByOrderId: null` on the one request that is *about* the successor existing.
     */
    const [row] = await this.executor(tx)
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.supersedesOrderId, orderId))
      .limit(1);
    return row?.id ?? null;
  }

  async listEvents(orderId: string, tx?: Tx): Promise<OrderEventRow[]> {
    return this.executor(tx)
      .select({
        id: orderEvents.id,
        seq: orderEvents.seq,
        eventType: orderEvents.eventType,
        fromStatus: orderEvents.fromStatus,
        toStatus: orderEvents.toStatus,
        actorKind: orderEvents.actorKind,
        actorUserId: orderEvents.actorUserId,
        payload: orderEvents.payload,
        writeTxid: orderEvents.writeTxid,
        createdAt: orderEvents.createdAt,
      })
      .from(orderEvents)
      .where(eq(orderEvents.orderId, orderId))
      .orderBy(asc(orderEvents.seq));
  }

  /**
   * Has this order ever carried an event of this type?
   *
   * Two callers, and both are about a fact that a status cannot answer. `faultFor` asks
   * whether there was a real bounce, because `fault='company'` is settable only on an order
   * with one on record (plan 7.8). And plan 7.5(ค) needs "has this order ever been in
   * `production_confirmed`?" for the day a `remainder` instalment is recomputed upwards and a
   * gate that was open closes again — entitlement is `ever entered OR currently paid`, and
   * only the spine can answer the first half.
   */
  async hasEvent(tx: Tx, orderId: string, eventType: OrderEventType): Promise<boolean> {
    const [row] = await tx
      .select({ id: orderEvents.id })
      .from(orderEvents)
      .where(and(eq(orderEvents.orderId, orderId), eq(orderEvents.eventType, eventType)))
      .limit(1);
    return row !== undefined;
  }

  /**
   * Is there a bounce on this order that has **not** been answered yet?
   *
   * The question `faultFor` needs, and it is not the question `hasEvent` answers. "Has this
   * order ever bounced" is permanent: an order that was bounced in March, redesigned,
   * approved, built and delivered still answers yes in December — and that turned one
   * historical bounce into a standing licence for any member of staff to record
   * `fault = 'company'` on a cancellation the customer asked for. Plan 7.8 makes that number
   * the one that decides how much money goes back, so the licence is a refund authority
   * nobody granted.
   *
   * An approval closes a bounce: `redesign_approved` is the event that says the redesign was
   * accepted and the order went back to production. So the bounce is open exactly while the
   * latest `bounced_to_redesign` is more recent than the latest `redesign_approved`, compared
   * on `seq` — the append-only sequence, which is the only ordering on this table that cannot
   * be affected by two events sharing a timestamp.
   *
   * Note what stays true: a *second* bounce after an approval re-opens it, which is right —
   * that is a second failure to manufacture, and the fault claim is about it.
   */
  async hasUnresolvedBounce(tx: Tx, orderId: string): Promise<boolean> {
    const [row] = await tx
      .select({
        bounced: sql<number | null>`max(${orderEvents.seq}) filter (where ${orderEvents.eventType} = 'bounced_to_redesign')`,
        approved: sql<number | null>`max(${orderEvents.seq}) filter (where ${orderEvents.eventType} = 'redesign_approved')`,
      })
      .from(orderEvents)
      .where(eq(orderEvents.orderId, orderId));

    if (!row || row.bounced === null) return false;
    return row.approved === null || Number(row.bounced) > Number(row.approved);
  }

  /**
   * How many objections this order has carried, answered or not.
   *
   * Counted rather than derived from the open one, because the abuse is a *cycle*: open,
   * staff reject, open again — each round legally, each round blocking entry to
   * `production_confirmed`, for ever. The partial unique index stops two being open at once
   * and says nothing about the tenth.
   */
  async countChangeRequests(tx: Tx, orderId: string): Promise<number> {
    const [row] = await tx
      .select({ n: sql<string>`count(*)` })
      .from(orderChangeRequests)
      .where(eq(orderChangeRequests.orderId, orderId));

    return Number(row?.n ?? 0);
  }

  /* ---------------------------------------------------------------- *
   * The transition table — the legal moves, as data
   * ---------------------------------------------------------------- */

  /**
   * What this order may do next, read from the database and not from a map in TypeScript.
   *
   * A hard-coded copy would be a second answer to "is this move legal", kept in step by
   * nobody, in a system whose status list has already grown once after being called final.
   */
  async transitionsFrom(fromStatus: OrderStatus): Promise<TransitionRow[]> {
    return this.db
      .select(TRANSITION_COLUMNS)
      .from(orderStatusTransitions)
      .where(eq(orderStatusTransitions.fromStatus, fromStatus))
      .orderBy(asc(orderStatusTransitions.toStatus));
  }

  async findTransition(
    tx: Tx,
    fromStatus: OrderStatus,
    toStatus: OrderStatus,
  ): Promise<TransitionRow | undefined> {
    const [row] = await tx
      .select(TRANSITION_COLUMNS)
      .from(orderStatusTransitions)
      .where(
        and(
          eq(orderStatusTransitions.fromStatus, fromStatus),
          eq(orderStatusTransitions.toStatus, toStatus),
        ),
      )
      .limit(1);
    return row;
  }

  /* ---------------------------------------------------------------- *
   * Writing
   * ---------------------------------------------------------------- */

  /**
   * Mint the anonymous visitor a referent.
   *
   * `guests` is a real table because plan 6's fourth scope variant needs something a cart row
   * can hold a foreign key to. The row is created *here*, on the request that first needed
   * one, and not in the guard: a guard that wrote on every request would fill the table with
   * rows for crawlers, one per request, forever.
   *
   * The secret is minted here and returned once. Only its hash is stored, so this return
   * value is the sole moment the plaintext exists on the server — the controller turns it
   * straight into a `Set-Cookie` and nothing else ever sees it. That is what makes the guest
   * cookie a capability that has to be *held* rather than an id anybody who has read a log
   * line can present (`rbac/guest-cookie.ts`).
   */
  async createGuest(tx: Tx): Promise<GuestCookie> {
    const secret = mintGuestSecret();
    const [row] = await tx
      .insert(guests)
      .values({ secretHash: guestSecretHash(secret) })
      .returning({ id: guests.id });

    if (!row) throw new Error('orders: could not create a guest');
    return { guestId: row.id, secret };
  }

  /**
   * An order and the event that says it exists — trap 1, in four statements.
   *
   * The event id is chosen here rather than by the database, which is the price of the
   * deferred FK and the whole of it: `orders.status_event_id` is NOT NULL and points at a row
   * that does not exist yet, so the constraint is checked at COMMIT and both rows are there
   * by then. Inserting the order alone, in autocommit or without the event, fails — which is
   * the proof that the cycle was real rather than avoided.
   */
  async createDraft(
    tx: Tx,
    input: {
      readonly customerUserId: string | null;
      readonly guestId: string | null;
      readonly contactEmail: string | null;
      readonly contactName: string | null;
      readonly contactPhone: string | null;
      readonly contactLocale: string;
      /**
       * Where the goods are going, if the cart already knows — `null` on a cart that does not.
       *
       * ⚠️ Written *here* and not only at submit, because `orderContactRequestSchema` accepts
       * the field on `POST /orders` and a strict-object schema that accepts a field the write
       * discards is a lie the type system endorses. It was cosmetic while nothing read the
       * column; it stopped being cosmetic when the submit began pricing from it, because a
       * draft created with `SG` and submitted without repeating it would have priced at Thai
       * 7% while the row recorded Singapore.
       */
      readonly destinationCountry: string | null;
      readonly actorKind: OrderActorKind;
      readonly actorUserId: string | null;
      readonly actorGuestId: string | null;
      /** Set only when this order is a post-freeze revision of another — plan 7.2. */
      readonly supersedesOrderId: string | null;
    },
  ): Promise<string> {
    const orderId = randomUUID();
    const eventId = randomUUID();

    await tx.insert(orders).values({
      id: orderId,
      statusEventId: eventId,
      customerUserId: input.customerUserId,
      guestId: input.guestId,
      contactEmail: input.contactEmail,
      contactName: input.contactName,
      contactPhone: input.contactPhone,
      contactLocale: input.contactLocale,
      destinationCountry: input.destinationCountry,
      supersedesOrderId: input.supersedesOrderId,
    });

    await tx.insert(orderEvents).values({
      id: eventId,
      orderId,
      eventType: 'created',
      /* Genesis: no `from`, and the guard refuses anything but `created → draft` at seq 1. */
      toStatus: 'draft',
      actorKind: input.actorKind,
      actorUserId: input.actorUserId,
      actorGuestId: input.actorGuestId,
      payload: {},
    });

    return orderId;
  }

  /**
   * Append to the spine.
   *
   * `seq` is not passed: the trigger assigns it from `max(seq) + 1` under the row lock the
   * caller is already holding. A caller that picked its own would eventually pick one twice,
   * and `created_at` cannot break the tie — two events in one transaction share a `now()`.
   *
   * This is also the seam 5c writes `quote_revised` through, and 5b writes its payment events
   * through. There is one way onto the spine and it is this method, because the outbox is a
   * consumer of that table and of nothing else (plan 10.1): an event written by some other
   * path is a notification nobody receives.
   */
  async appendEvent(tx: Tx, input: AppendEventInput): Promise<string> {
    const [row] = await tx
      .insert(orderEvents)
      .values({
        orderId: input.orderId,
        eventType: input.eventType,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        actorKind: input.actorKind,
        actorUserId: input.actorUserId,
        actorGuestId: input.actorGuestId,
        payload: input.payload,
      })
      .returning({ id: orderEvents.id });

    if (!row) throw new Error('orders: could not append to the spine');
    return row.id;
  }

  /**
   * Move the order, naming the event that moved it.
   *
   * `frozen_at` is deliberately never in this SET clause. It is stamped by
   * `orders_guard_update()` on entry to `production_confirmed`, so the freeze point is a fact
   * the database owns — a second entry after a redesign does not re-stamp it, and no caller
   * can thaw an order by writing a null.
   */
  async moveStatus(
    tx: Tx,
    input: {
      readonly orderId: string;
      readonly toStatus: OrderStatus;
      readonly statusEventId: string;
    },
  ): Promise<void> {
    await tx
      .update(orders)
      .set({ status: input.toStatus, statusEventId: input.statusEventId, updatedAt: new Date() })
      .where(eq(orders.id, input.orderId));
  }

  /**
   * The submit: the contract, the number, and the money, in one statement.
   *
   * `orders_submitted_shape` requires `submitted_at`, `order_no`, `document_id` and the two
   * totals to arrive together or not at all, so they do. `order_no` comes from a sequence
   * rather than from the application because a number generated in TypeScript is a number two
   * concurrent submits can generate twice.
   */
  async applySubmission(
    tx: Tx,
    input: {
      readonly orderId: string;
      readonly statusEventId: string;
      readonly documentId: string;
      /**
       * ⚠️ Nullable since a telephone number became a channel.
       *
       * `orders_submitted_has_a_contact_channel` still refuses an order with *neither*, so a
       * null here is only legal beside a number — and the database, not this signature, is
       * what enforces that. `orderContactRequestSchema` refuses the pair upstream.
       */
      readonly contactEmail: string | null;
      readonly contactName: string | null;
      readonly contactPhone: string | null;
      readonly contactLocale: string;
      /** Chosen by the customer at submit, or carried over from a cart that already had one. */
      readonly destinationCountry: string | null;
      readonly netThbMinor: bigint;
      readonly vatThbMinor: bigint;
      readonly grandTotalThbMinor: bigint;
      readonly scheduledDepositThbMinor: bigint;
      /**
       * ⭐ The `cashflow` approval floor this contract is judged against, in basis points.
       *
       * The same `organisation_profile.deposit_bp` the schedule above was planned from, pinned
       * here so that re-reading the order next month measures the concession the gate measured
       * at submit rather than one against today's policy. Required, not optional: an order
       * submitted without it would be a new row carrying the historical defect, and the caller
       * has the value in hand — it read it to plan the schedule.
       */
      readonly depositFloorBp: number;
    },
  ): Promise<void> {
    await tx
      .update(orders)
      .set({
        status: 'awaiting_payment',
        statusEventId: input.statusEventId,
        /*
         * The database's clock, not this process's.
         *
         * `orders_frozen_after_submitted` checks this column against `frozen_at`, which a
         * trigger stamps with Postgres's `now()`. Two containers, two clocks: whenever this
         * one runs ahead, an order confirmed for production before the database catches up
         * violates the CHECK and the transition is refused outright. `now()` here is the
         * transaction's own start time, so it cannot be later than a freeze in any
         * transaction that begins afterwards, whatever either clock says.
         */
        submittedAt: sql`now()`,
        orderNo: sql`'WW-' || nextval('order_no_seq')`,
        documentId: input.documentId,
        contactEmail: input.contactEmail,
        contactName: input.contactName,
        contactPhone: input.contactPhone,
        contactLocale: input.contactLocale,
        destinationCountry: input.destinationCountry,
        netThbMinor: input.netThbMinor,
        vatThbMinor: input.vatThbMinor,
        grandTotalThbMinor: input.grandTotalThbMinor,
        scheduledDepositThbMinor: input.scheduledDepositThbMinor,
        depositFloorBp: input.depositFloorBp,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, input.orderId));
  }

  /**
   * Freeze one revision of the quote — trap 3.
   *
   * Written before `orders` is updated and after the event is appended, and the order is not
   * a preference: the document names the event that produced it and the order names the
   * document. It is also exactly why the notification fan-out is a *deferred* constraint
   * trigger — an immediate one would resolve the recipient from the order as it was before
   * the submit, which is how "who did we tell?" comes to depend on statement order inside a
   * service.
   */
  async pinDocument(
    tx: Tx,
    input: {
      readonly orderId: string;
      readonly revision: number;
      readonly document: OrderDocumentWire;
      readonly documentHash: string;
      readonly pinnedCoreVersion: string;
      readonly pinnedVatRateBp: number;
      readonly pinnedVatTreatment: 'standard' | 'zero_rated' | 'exempt' | 'out_of_scope';
      readonly pinnedLocale: string;
      readonly netThbMinor: bigint;
      readonly vatThbMinor: bigint;
      readonly grandTotalThbMinor: bigint;
      readonly createdByEventId: string;
      readonly productVersionIds: readonly string[];
    },
  ): Promise<string> {
    const [row] = await tx
      .insert(orderDocuments)
      .values({
        orderId: input.orderId,
        revision: input.revision,
        document: input.document,
        documentHash: input.documentHash,
        pinnedCoreVersion: input.pinnedCoreVersion,
        pinnedVatRateBp: input.pinnedVatRateBp,
        pinnedVatTreatment: input.pinnedVatTreatment,
        pinnedLocale: input.pinnedLocale,
        netThbMinor: input.netThbMinor,
        vatThbMinor: input.vatThbMinor,
        grandTotalThbMinor: input.grandTotalThbMinor,
        createdByEventId: input.createdByEventId,
      })
      .returning({ id: orderDocuments.id });

    if (!row) throw new Error('orders: could not pin the document');

    if (input.productVersionIds.length > 0) {
      /*
       * The other half of trap 3, and the half a JSONB blob cannot do: a real foreign key
       * with ON DELETE RESTRICT, so a catalogue version a contract cites cannot be removed
       * from under it, and "which contracts cite this version?" is answerable when a
       * catalogue mistake is found.
       */
      await tx.insert(orderDocumentProductVersions).values(
        input.productVersionIds.map((productVersionId) => ({
          orderDocumentId: row.id,
          productVersionId,
        })),
      );
    }

    return row.id;
  }

  /* ---------------------------------------------------------------- *
   * Documents
   * ---------------------------------------------------------------- */

  async findDocumentById(documentId: string, tx?: Tx): Promise<OrderDocumentRow | undefined> {
    const [row] = await this.executor(tx)
      .select(DOCUMENT_COLUMNS)
      .from(orderDocuments)
      .where(eq(orderDocuments.id, documentId))
      .limit(1);
    return row === undefined ? undefined : decodeDocumentRow(row);
  }

  async latestRevision(tx: Tx, orderId: string): Promise<number> {
    const [row] = await tx
      .select({ revision: orderDocuments.revision })
      .from(orderDocuments)
      .where(eq(orderDocuments.orderId, orderId))
      .orderBy(desc(orderDocuments.revision))
      .limit(1);
    return row?.revision ?? 0;
  }

  /**
   * The document the customer last *agreed* to, which is not always the current one.
   *
   * Plan 7.2's scope guard has to compare a revision against what was contracted, and the
   * contract is the document that was in force when the money gate opened — the last
   * `payment_confirmed`. Later revisions are proposals until somebody accepts them, so
   * comparing a proposal with itself would make the guard vacuous the moment 5c starts
   * writing revisions.
   *
   * Expressed as "the highest revision whose creating event is at or before the freeze
   * event", because revisions and events are both ordered by `seq` on the same spine, and a
   * timestamp comparison between two rows written in one transaction cannot separate them.
   */
  async contractedDocument(tx: Tx, orderId: string): Promise<OrderDocumentRow | undefined> {
    const [gate] = await tx
      .select({ seq: orderEvents.seq })
      .from(orderEvents)
      .where(and(eq(orderEvents.orderId, orderId), eq(orderEvents.eventType, 'payment_confirmed')))
      .orderBy(desc(orderEvents.seq))
      .limit(1);

    if (!gate) return undefined;

    const [row] = await tx
      .select(DOCUMENT_COLUMNS)
      .from(orderDocuments)
      .innerJoin(orderEvents, eq(orderEvents.id, orderDocuments.createdByEventId))
      .where(and(eq(orderDocuments.orderId, orderId), sql`${orderEvents.seq} <= ${gate.seq}`))
      .orderBy(desc(orderDocuments.revision))
      .limit(1);

    return row === undefined ? undefined : decodeDocumentRow(row);
  }

  /* ---------------------------------------------------------------- *
   * Change requests — trap 5, plan 10.4
   * ---------------------------------------------------------------- */

  async findOpenChangeRequest(orderId: string, tx?: Tx): Promise<ChangeRequestRow | undefined> {
    const [row] = await this.executor(tx)
      .select(CHANGE_REQUEST_COLUMNS)
      .from(orderChangeRequests)
      .where(
        and(
          eq(orderChangeRequests.orderId, orderId),
          sql`${orderChangeRequests.resolvedEventId} is null`,
        ),
      )
      .limit(1);
    return row;
  }

  async findChangeRequest(
    tx: Tx,
    orderId: string,
    changeRequestId: string,
  ): Promise<ChangeRequestRow | undefined> {
    const [row] = await tx
      .select(CHANGE_REQUEST_COLUMNS)
      .from(orderChangeRequests)
      .where(
        and(
          eq(orderChangeRequests.orderId, orderId),
          eq(orderChangeRequests.id, changeRequestId),
        ),
      )
      .limit(1);
    return row;
  }

  async openChangeRequest(
    tx: Tx,
    input: { readonly orderId: string; readonly openedEventId: string; readonly noteTh: string },
  ): Promise<string> {
    const [row] = await tx
      .insert(orderChangeRequests)
      .values({
        orderId: input.orderId,
        openedEventId: input.openedEventId,
        noteTh: input.noteTh,
      })
      .returning({ id: orderChangeRequests.id });

    if (!row) throw new Error('orders: could not open a change request');
    return row.id;
  }

  /**
   * The half of trap 5 that makes the partial unique index a fix rather than the bug.
   *
   * `order_change_requests_one_open` alone *is* the trap: the first request would block every
   * later one for the lifetime of the order. This is the path that clears it, and the WHERE
   * clause requires the row to still be open so two people resolving at once produce one
   * resolution and one 409 rather than a silent overwrite of the first answer.
   */
  async resolveChangeRequest(
    tx: Tx,
    input: {
      readonly changeRequestId: string;
      readonly resolvedEventId: string;
      readonly resolution: 'accepted' | 'rejected' | 'withdrawn' | 'superseded';
    },
  ): Promise<boolean> {
    const updated = await tx
      .update(orderChangeRequests)
      .set({
        resolvedEventId: input.resolvedEventId,
        resolution: input.resolution,
        resolvedAt: new Date(),
      })
      .where(
        and(
          eq(orderChangeRequests.id, input.changeRequestId),
          sql`${orderChangeRequests.resolvedEventId} is null`,
        ),
      )
      .returning({ id: orderChangeRequests.id });

    return updated.length === 1;
  }
}

const TRANSITION_COLUMNS = {
  fromStatus: orderStatusTransitions.fromStatus,
  toStatus: orderStatusTransitions.toStatus,
  eventType: orderStatusTransitions.eventType,
  payloadKind: orderStatusTransitions.payloadKind,
  requiredPayloadKeys: orderStatusTransitions.requiredPayloadKeys,
  allowedActorKinds: orderStatusTransitions.allowedActorKinds,
  descriptionTh: orderStatusTransitions.descriptionTh,
} as const;

const DOCUMENT_COLUMNS = {
  id: orderDocuments.id,
  revision: orderDocuments.revision,
  documentHash: orderDocuments.documentHash,
  document: orderDocuments.document,
  createdByEventId: orderDocuments.createdByEventId,
  createdAt: orderDocuments.createdAt,
} as const;

const CHANGE_REQUEST_COLUMNS = {
  id: orderChangeRequests.id,
  noteTh: orderChangeRequests.noteTh,
  createdAt: orderChangeRequests.createdAt,
  resolution: orderChangeRequests.resolution,
  resolvedAt: orderChangeRequests.resolvedAt,
} as const;

interface RawDocumentRow {
  readonly id: string;
  readonly revision: number;
  readonly documentHash: string;
  readonly document: unknown;
  readonly createdByEventId: string;
  readonly createdAt: Date;
}

/**
 * A stored document is validated on the way out, not cast.
 *
 * Plan 4.5 is a list of payloads whose version field and content drifted apart in silence,
 * and the lesson it draws is that a stored shape this build does not recognise must not be
 * interpreted anyway. A document written under a later `documentSchemaVersion` fails here —
 * loudly, naming the order — rather than being read with whichever fields happen to match.
 */
function decodeDocumentRow(row: RawDocumentRow): OrderDocumentRow {
  const parsed = orderDocumentWireSchema.safeParse(row.document);

  if (!parsed.success) {
    throw AppError.databaseUnavailable(
      'เอกสารที่ตรึงไว้ของออร์เดอร์นี้อยู่ในรูปแบบที่ระบบรุ่นนี้อ่านไม่ได้',
      { documentId: row.id, revision: row.revision },
    );
  }

  return {
    id: row.id,
    revision: row.revision,
    documentHash: row.documentHash,
    document: parsed.data,
    createdByEventId: row.createdByEventId,
    createdAt: row.createdAt,
  };
}
