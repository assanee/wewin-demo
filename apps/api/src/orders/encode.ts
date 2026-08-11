import {
  POST_FREEZE_STATUSES_WIRE,
  encodeThb,
  type AvailableTransitionWire,
  type ChangeRequestWire,
  type OrderDocumentResponseWire,
  type OrderDocumentWire,
  type OrderEventWire,
  type OrderSummaryWire,
  type OrderWire,
} from '@wewin/contract/order';
import type { OrganisationProfileWire } from '@wewin/contract/organisation';

import type { ChangeRequestRow, OrderEventRow } from './order.repository';
import type { ScopedOrder } from './scope';
import type { TransitionRow } from './transitions';

/**
 * Rows to the wire, in one place.
 *
 * Every response leaves through here for the reason `catalog.controller.ts` gives about its
 * own encoders: it is what puts a unit on every amount — `{"unit":"THB.satang","digits":
 * "940637"}` rather than a bare number a client is free to read as baht — and it is why a
 * `bigint` never reaches `JSON.stringify`, which throws on one.
 *
 * `isFrozen` is computed here from `frozenAt` and never from the status, and that is a rule
 * rather than a shortcut: `cancelled` and `superseded` are reachable from both sides of the
 * freeze, so after the fact the status cannot answer "had aluminium been committed?" — which
 * is the question the cancellation report and the forfeit table both ask.
 */

const POST_FREEZE = new Set<string>(POST_FREEZE_STATUSES_WIRE);

/** A cross-check on the two facts, so a row that disagrees with itself is loud rather than served. */
function isFrozen(row: ScopedOrder): boolean {
  const frozen = row.frozenAt !== null;

  if (!frozen && POST_FREEZE.has(row.status)) {
    /*
     * `orders_post_freeze_requires_frozen_at` makes this unrepresentable, so reaching it
     * means the constraint was dropped or this build's mirror of the status list has drifted
     * from `order_status_is_post_freeze()`. Either way the number a forfeit is computed from
     * would be wrong, so it is an error and not a warning.
     */
    throw new Error(
      `orders: order ${row.id} is ${row.status} with no frozen_at; the freeze invariant is broken`,
    );
  }

  return frozen;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

export function encodeOrderSummary(row: ScopedOrder): OrderSummaryWire {
  return {
    id: row.id,
    orderNo: row.orderNo,
    status: row.status,
    isFrozen: isFrozen(row),
    frozenAt: iso(row.frozenAt),
    submittedAt: iso(row.submittedAt),
    grandTotalThbMinor: row.grandTotalThbMinor === null ? null : encodeThb(row.grandTotalThbMinor),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface OrderContext {
  readonly transitions: readonly TransitionRow[];
  readonly documentRevision: number | null;
  readonly supersededByOrderId: string | null;
  readonly openChangeRequest: ChangeRequestRow | undefined;
}

export function encodeOrder(row: ScopedOrder, context: OrderContext): OrderWire {
  /*
   * `orders_money_shape` is "three columns or none", so one null answer covers all three.
   * Reading each column separately here would produce a partial money object on a row the
   * database has already made impossible — and a partial one is the shape a client would add
   * up wrongly.
   */
  const money =
    row.netThbMinor === null ||
    row.vatThbMinor === null ||
    row.grandTotalThbMinor === null ||
    row.scheduledDepositThbMinor === null
      ? null
      : {
          netThbMinor: encodeThb(row.netThbMinor),
          vatThbMinor: encodeThb(row.vatThbMinor),
          grandTotalThbMinor: encodeThb(row.grandTotalThbMinor),
          scheduledDepositThbMinor: encodeThb(row.scheduledDepositThbMinor),
        };

  return {
    ...encodeOrderSummary(row),
    createdAt: row.createdAt.toISOString(),
    contact: {
      email: row.contactEmail,
      name: row.contactName,
      phone: row.contactPhone,
      locale: row.contactLocale,
      /* `ScopedOrder.destinationCountry` — already selected by `ORDER_COLUMNS` (Task 8). */
      destinationCountry: row.destinationCountry,
    },
    money,
    documentRevision: context.documentRevision,
    supersedesOrderId: row.supersedesOrderId,
    supersededByOrderId: context.supersededByOrderId,
    availableTransitions: context.transitions.map(encodeTransition),
    openChangeRequest:
      context.openChangeRequest === undefined
        ? null
        : encodeChangeRequest(context.openChangeRequest),
  };
}

export const encodeTransition = (row: TransitionRow): AvailableTransitionWire => ({
  toStatus: row.toStatus,
  eventType: row.eventType,
  payloadKind: row.payloadKind,
  descriptionTh: row.descriptionTh,
});

/**
 * Who is reading the spine. Not "may they read it" — that was answered by the scoped load.
 *
 * `staff` sees the row as stored. `customer` — which is the customer *and* the guest, since
 * both are the party the order is about — sees it with two things withheld.
 */
export type EventAudience = 'staff' | 'customer';

/**
 * Free prose written by staff, on the events where staff write it.
 *
 * These are the keys a human types. Everything else in a payload is derived by this module —
 * `fault`, `absorbed_delta_thb_minor`, `document_hash`, revision numbers — and those are
 * precisely the numbers a customer is entitled to see the basis of, so none of them is here.
 */
const STAFF_PROSE_KEYS = ['reason', 'note_th'] as const;

export function encodeEvent(row: OrderEventRow, audience: EventAudience = 'staff'): OrderEventWire {
  const stored = isRecord(row.payload) ? row.payload : {};

  return {
    id: row.id,
    seq: row.seq,
    eventType: row.eventType,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    actorKind: row.actorKind,
    /*
     * Which member of staff, withheld from the customer.
     *
     * A uuid is not obviously personal data until it is the stable identifier of a named
     * employee across every order they touched — at which point a customer in a dispute can
     * assemble "who handled what" for the whole company. The customer's legitimate question
     * is *what happened and when*, and `actorKind` answers "the company did this" without
     * naming a person who has not been told they are named. Staff keep the full row: an
     * append-only spine that cannot attribute its own writes is not an audit trail.
     */
    actorUserId: audience === 'staff' ? row.actorUserId : null,
    /*
     * The payload is served as it was stored — with one subtraction for the customer.
     *
     * It is written by this module and checked against `required_payload_keys` on the way
     * in, so there is nothing here to re-derive, and re-deriving it would produce a *second*
     * account of what a cancellation carried, which is what an append-only spine exists to
     * prevent. What *is* removed is staff prose: the `reason` typed on a bounce or a
     * cancellation reached the customer verbatim, which is the mirror image of plan 7.9(ค)
     * ("sales prose must not reach the production sheet") and had the same cause — one
     * field doing duty as both an internal note and a customer-facing sentence.
     *
     * Note what this is *not*: it is not a decision that the customer may not be told why.
     * It is a decision that they must not be told by accident. A message written *for* them
     * needs its own field, and until there is one this endpoint says nothing rather than
     * quoting an internal note. SEAM: `reason_th_for_customer` on the transition payloads.
     */
    payload: audience === 'staff' ? stored : withoutStaffProse(stored),
    createdAt: row.createdAt.toISOString(),
  };
}

function withoutStaffProse(payload: Record<string, unknown>): Record<string, unknown> {
  const visible: Record<string, unknown> = { ...payload };
  for (const key of STAFF_PROSE_KEYS) delete visible[key];
  return visible;
}

/**
 * ⚠️ Beside the pinned document, never merged into it.
 *
 * `document` passes through exactly as `order.repository.ts` decoded it — this function adds
 * nothing to it and removes nothing from it, because either would be a shape the stored
 * `documentSchemaVersion` literal does not describe. `seller` is the one thing on this
 * response read live rather than pinned: see `OrderDocumentResponseWire`.
 */
export const encodeDocumentResponse = (
  document: OrderDocumentWire,
  seller: OrganisationProfileWire,
): OrderDocumentResponseWire => ({ document, seller });

export const encodeChangeRequest = (row: ChangeRequestRow): ChangeRequestWire => ({
  id: row.id,
  noteTh: row.noteTh,
  openedAt: row.createdAt.toISOString(),
  resolution: row.resolution as ChangeRequestWire['resolution'],
  resolvedAt: iso(row.resolvedAt),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
