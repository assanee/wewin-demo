import {
  POST_FREEZE_STATUSES_WIRE,
  encodeThb,
  type AvailableTransitionWire,
  type BalanceReminderWire,
  type CancellationPreviewWire,
  type ChangeRequestWire,
  type OrderDocumentResponseWire,
  type OrderDocumentWire,
  type OrderEventWire,
  type OrderSummaryWire,
  type OrderWire,
} from '@wewin/contract/order';
import type { OrganisationProfileWire } from '@wewin/contract/organisation';
import type { OrderStatus } from '@wewin/db/schema';

import { isLiveOrder } from './live-order';
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
  /*
   * ⚠️ One question asked once, for all three money fields.
   *
   * `orders_money_shape` is "three columns or none", so a null grand total *is* "this order has
   * no contract yet" — and the two folds beside it are total: they answer ฿0.00 for a cart, which
   * is arithmetically right and reads on a queue as *settled*. Deciding each field separately
   * would be three chances to disagree about the same fact; deciding it here, once, is the same
   * arrangement `encodeOrder`'s `money` block already uses one line down.
   *
   * Note what is *not* happening: no number is being computed, chosen between, or adjusted. The
   * figures are Postgres's, unaltered — this only says whether there is yet an order for them to
   * be about.
   */
  const contracted = row.grandTotalThbMinor !== null;

  /*
   * ⚠️ AND ONE MORE QUESTION, ASKED IN THE SAME PLACE AND FOR THE SAME REASON.
   *
   * `order_outstanding_thb_minor()` is total: it answers about any order in any status, and on
   * a `cancelled` or `superseded` one it answers with the whole unpaid remainder. That is the
   * correct answer to the question the function asks and the wrong number to put in a
   * ค้างชำระ column — a cancelled order owes nobody anything, and its residue is a refund
   * question belonging to `src/payments/refunds`, not a debt. Before this line the list
   * printed ฿14,791.68 against an order the customer had cancelled, on a screen whose own
   * money card (which filters with the overview's `LIVE_ORDERS`) said ฿0.
   *
   * ── Why *here* and not in the query, and not in each client ──────────────────
   *
   * `ORDER_COLUMNS` is the one shape every scoped load returns, and the row is deliberately
   * the whole order rather than a projection — the write path reads these two figures inside
   * its transaction, and a refund is priced from the very residue this hides. Teaching the
   * select to null them would take the number away from callers who need it in order to fix a
   * screen. Teaching each client to check the status would put the definition of "live" in
   * three bundles at once. The encoder is where "does this order have a figure to state?" is
   * already decided once per row, one line above, so it is where the second half of that
   * question belongs.
   *
   * ── Why null, and not 0 ─────────────────────────────────────────────────────
   *
   * The same argument the line above makes about a cart, and it is the whole reason these
   * fields are nullable at all: ฿0.00 in a ค้างชำระ column is how a screen says **settled**,
   * and a cancelled order has not settled — it has stopped. Neither "owing" nor "settled" is
   * true of it, so the wire states neither and the clients render a dash. `isLiveOrder` reads
   * the one list `overview.repository.ts`'s `LIVE_ORDERS` is built from, so the total on the
   * money card and the figure on the row cannot come to disagree about which orders count.
   *
   * `contracted` is kept as its own term rather than folded in: `orders_money_shape` is why
   * all three fields go null together on a cart, and `isLiveOrder` is a different fact about a
   * different set of orders. Two reasons, stated as two.
   */
  const owesLive = contracted && isLiveOrder(row.status);

  return {
    id: row.id,
    orderNo: row.orderNo,
    status: row.status,
    isFrozen: isFrozen(row),
    frozenAt: iso(row.frozenAt),
    submittedAt: iso(row.submittedAt),
    grandTotalThbMinor: row.grandTotalThbMinor === null ? null : encodeThb(row.grandTotalThbMinor),
    outstandingThbMinor: owesLive ? encodeThb(row.outstandingThbMinor) : null,
    nextDueThbMinor: owesLive ? encodeThb(row.nextDueThbMinor) : null,
    /*
     * ⭐ Nulled on the same fact as the two above, and that is a decision rather than symmetry.
     *
     * A forgiven balance is history and it really did happen on a cancelled order too, so there
     * was an argument for always stating it. It loses: this field exists to tell a ฿0.00
     * outstanding apart from a ฿0.00 outstanding, and where the wire states **no** outstanding
     * there is nothing to tell apart — a client that read a write-off figure beside a dash would
     * be reading a debt reduction with no debt on the screen. `owesLive` therefore governs all
     * three, one question asked once, and *"how much did we write off?"* is answered by the
     * approval inbox's decided list (`approvals_write_off_idx`), which is where an auditor asks it.
     */
    writtenOffThbMinor: owesLive ? encodeThb(row.writtenOffThbMinor) : null,
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
    /*
     * Which transaction wrote the row — withheld from the customer, and the reasoning is on
     * `OrderEventWire.writeTxid` rather than repeated here.
     *
     * The short of it: it is not personal data and not a secret, but it is monotonic across the
     * whole database, so a difference between two of them is a count of the company's write
     * transactions. Staff hold `orders.read` over the whole table and can see that traffic
     * anyway; a customer holding two of their own orders' spines could not, until this field.
     *
     * ⚠️ Note what it is *for*, because it is not decoration. `created_at` defaults to `now()`,
     * which is the transaction's start time — so it cannot distinguish "three things a person
     * did" from "one act that wrote three rows", and neither can a minute-precision clock on a
     * screen. This can. It is the audit trail's own answer to what was atomic.
     */
    writeTxid: audience === 'staff' ? row.writeTxid : null,
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

/**
 * A priced cancellation, onto the wire.
 *
 * `fromStatus` is carried through rather than re-read from the order, because the figures were
 * priced *for that status* and a response that paired them with a freshly-read one would be
 * describing a cancellation nobody priced.
 */
export const encodeCancellationPreview = (input: {
  readonly fromStatus: OrderStatus;
  readonly heldThbMinor: bigint;
  readonly forfeitThbMinor: bigint;
  readonly refundThbMinor: bigint;
}): CancellationPreviewWire => ({
  fromStatus: input.fromStatus,
  heldThbMinor: encodeThb(input.heldThbMinor),
  forfeitThbMinor: encodeThb(input.forfeitThbMinor),
  refundThbMinor: encodeThb(input.refundThbMinor),
});

export const encodeChangeRequest = (row: ChangeRequestRow): ChangeRequestWire => ({
  id: row.id,
  noteTh: row.noteTh,
  openedAt: row.createdAt.toISOString(),
  resolution: row.resolution as ChangeRequestWire['resolution'],
  resolvedAt: iso(row.resolvedAt),
});

/**
 * ⭐ แจ้งเตือนยอดค้างชำระ — the ask, and what became of it.
 *
 * Two facts from two places, and the split is the point:
 *
 *   **the event** — id, `seq`, `created_at` — is the row this transaction wrote to the spine.
 *   Every field of it is the database's: `seq` is assigned by `order_events_guard_insert()` and
 *   `created_at` by a column default, so none of it could be known before the insert.
 *
 *   **the fan-out** — how many outbox rows were queued, and why none was — is read *after* the
 *   commit, because the trigger that writes those rows is `DEFERRABLE INITIALLY DEFERRED`.
 *
 * ⛔ `outstandingThbMinor` is `order_outstanding_thb_minor()`'s answer inside the transaction,
 * carried here from the event's own payload rather than recomputed: the response and the audit
 * row must state the same figure, and re-reading the fold to build a response is how they come
 * to differ by one accepted slip.
 *
 * ⚠️ `suppressedReason` is the database's own string, unchanged and untranslated. It is
 * `no_contact_channel` / `recipient_erased` — machine words the dashboard maps to a Thai
 * sentence — and translating it here would put the vocabulary of the outbox in two places.
 */
export const encodeBalanceReminder = (input: {
  readonly event: OrderEventRow;
  readonly outstandingThbMinor: bigint;
  readonly fanOut: readonly { readonly status: string; readonly suppressedReason: string | null }[];
}): BalanceReminderWire => {
  const queued = input.fanOut.filter((row) => row.status !== 'suppressed').length;

  return {
    eventId: input.event.id,
    seq: input.event.seq,
    remindedAt: input.event.createdAt.toISOString(),
    outstandingThbMinor: encodeThb(input.outstandingThbMinor),
    queued,
    /*
     * The reason only when there is nothing on its way. A partially-suppressed fan-out is not a
     * shape one rule can produce today — there is one customer rule for this event — but if a
     * second recipient is ever added, "some of it went" must not read as "none of it did".
     */
    suppressedReason:
      queued > 0 ? null : (input.fanOut.find((row) => row.suppressedReason !== null)?.suppressedReason ?? null),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
