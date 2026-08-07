import { Inject, Injectable } from '@nestjs/common';
import type { OrderStatus } from '@wewin/db/schema';
import {
  type ChangeRequestWire,
  type CreateChangeRequestWire,
  type CreateOrderRequestWire,
  type OrderDocumentWire,
  type OrderEventListWire,
  type OrderListWire,
  type OrderWire,
  type ResolveChangeRequestWire,
} from '@wewin/contract/order';

import { AppError } from '../common/errors/app-error';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { CatalogRepository } from '../catalog/catalog.repository';
import { PaymentLifecycleService } from '../payments/lifecycle';
import { AuthorityService } from '../quotes/authority';
import { QuotesService } from '../quotes/quotes.service';
import { guestScope, systemScope, type GuestCookie, type Scope } from '../rbac';
import {
  DEFAULT_LOCALE,
  DEFAULT_VAT_RULE,
  MAX_CHANGE_REQUESTS_PER_ORDER_DEFAULT,
} from './defaults';
import {
  encodeChangeRequest,
  encodeEvent,
  encodeOrder,
  encodeOrderSummary,
  type EventAudience,
} from './encode';
import {
  absorbedDeltaMinor,
  assertScopeUnchanged,
  priceOrderDocument,
  type CatalogEntry,
} from './order-document';
import { OrderRepository, type Tx } from './order.repository';
import {
  ScopedOrderRepository,
  isOrderUuid,
  orderActor,
  orderReach,
  type ScopedOrder,
} from './scope';
import {
  assertActorMayMove,
  faultFor,
  parseTransitionBody,
  type OrderActor,
  type TransitionBody,
  type TransitionRow,
} from './transitions';

/**
 * The order lifecycle: every legal transition, who may make it, and what it writes.
 *
 * ── The shape of every mutation, and why it is always this shape ─────────────────
 *
 *     transaction
 *       → lock the order, scoped by ownership          ← trap 2, and the lock trap 4 needs
 *       → read the transition row for (from, to)       ← the legal moves are data, not code
 *       → check the actor kind against that row
 *       → *now* choose and parse the payload schema    ← trap 4
 *       → do the work: price, pin, derive fault, compare scope
 *       → append the event, then move the order        ← the spine, then the summary of it
 *
 * Nothing in this file departs from that order, and each step is where it is for a reason
 * somebody has already been caught by:
 *
 *   **The lock comes before the schema.** `cancel` has two rows, split at the freeze, and the
 *   post-freeze one carries `fault`. Choosing a schema by the name of the action gets the
 *   pre-freeze one and zod strips the field that decides how much money goes back to the
 *   customer. `from_status` is only knowable from the locked row (plan 7.4 trap 4).
 *
 *   **Ownership is in the query, not in a check after it.** `lockOrder` takes an
 *   `OrderReach` and an order that does not match it is *not found*. `actors:
 *   ['customer']` never meant "this customer" (trap 2).
 *
 *   **The event is written before the order moves.** The spine is where notifications,
 *   money reconciliation and "who did this" all come from. An order that moved without an
 *   event is a change nobody can date, attribute or notify anybody about — and the deferred
 *   FK would only notice at COMMIT, several statements from the cause.
 *
 * ── What this file does not do ───────────────────────────────────────────────────
 *
 * It never calls `sendEmail`. Notifications are a *consumer* of `order_events` (plan 10.1):
 * the fan-out is a deferred constraint trigger on that table, so appending the event is what
 * queues the messages, in the same transaction, with no call for this service to forget and
 * no rollback that can leave one behind. See `outbox/`.
 *
 * It never stamps `frozen_at`. The freeze point is entry to `production_confirmed` and the
 * database owns the stamp, so a second entry after a redesign cannot re-date the contract.
 *
 * SEAM 5b: `confirm_payment` is where the gate instalment is checked. Today it is a member of
 * staff asserting the slip is good, and the assertion is on the spine with their name on it;
 * 5b replaces the assertion with a fold over allocations and leaves everything else here
 * unchanged, because "which slip is the transition" is a question about instalments and not
 * about the lifecycle (plan 7.5(ข)).
 * SEAM 5c: `quote_revised` is appended through `OrderRepository.appendEvent` and pins a new
 * `order_documents` revision. The scope guard below already compares a proposal against the
 * contracted revision rather than against revision 1, so it starts working the day there is
 * more than one.
 */

/** Rejecting a slip is deliberately absent — plan 7.3, and see the note on `confirmPayment`. */
@Injectable()
export class OrdersService {
  constructor(
    private readonly orders: OrderRepository,
    /**
     * Every load of an order goes through this and through nothing else.
     *
     * Two repositories rather than one, and the boundary is the point: this one decides
     * *which rows this caller may touch* and returns a branded `ScopedOrder` that no other
     * query can produce; `OrderRepository` decides *what happens to a row already loaded that
     * way*. Plan 7.4 trap 2 stops being a rule people remember and becomes a type.
     */
    private readonly scoped: ScopedOrderRepository,
    private readonly catalog: CatalogRepository,
    @Inject(ENV) private readonly env: Env,
    /**
     * What happens to money when this order moves — 5b's closing seam.
     *
     * Four call sites and no others: the submit pins the schedule and the forfeit policy and
     * carries anything a superseded ancestor was holding; a cancellation closes the schedule
     * and posts the forfeit; a supersede closes the schedule; a delivery recognises the
     * revenue. Every one of them runs in *this* transaction, on the row this service has
     * already locked, which is the property that makes them safe to add here and would make
     * them unsafe anywhere else.
     *
     * This service never assembles a ledger posting and never names an account. Plan 7.13's
     * third seam is two modules deciding accounting independently; the direction of this
     * dependency is what stops that being possible.
     */
    private readonly payments: PaymentLifecycleService,
    /**
     * ⭐ The sales-editable quote — 5c's closing seam, and the reason `submit` prices at all.
     *
     * Two methods and no others: `adoptCart` turns a browser cart into the quote on the way in,
     * and `assertSubmittable` re-verifies every promise and hands back what to freeze. Both run
     * in *this* transaction on the row this service has already locked, which is the property
     * that makes them safe here and would make them unsafe anywhere else.
     *
     * This service never writes `quote_overrides` and never measures a concession. It asks the
     * two modules that own those questions and refuses when either says no.
     */
    private readonly quotes: QuotesService,
    /**
     * …and who was allowed to concede it — plan 7.13's single approvals surface.
     *
     * One call site: the last statement of `submit`. `gate` takes no amount and reads every
     * figure from the rows itself, so there is no parameter on this dependency that could make
     * a concession smaller than the document grants.
     */
    private readonly authority: AuthorityService,
  ) {}

  /* ---------------------------------------------------------------- *
   * Reading
   * ---------------------------------------------------------------- */

  async getOrder(scope: Scope, orderId: string): Promise<OrderWire> {
    const order = await this.scoped.findOrFail(scope, orderId, 'read');
    return this.decorate(scope, order);
  }

  async listOrders(
    scope: Scope,
    filter: { readonly statuses?: readonly OrderStatus[]; readonly limit: number },
  ): Promise<OrderListWire> {
    const rows = await this.scoped.list(scope, filter);
    return { orders: rows.map(encodeOrderSummary) };
  }

  async listEvents(scope: Scope, orderId: string): Promise<OrderEventListWire> {
    /*
     * The scoped read runs first and its only purpose is the 404: the events table has no
     * owner column of its own, so "does this person get to see this spine" is a question
     * about the order and has to be asked of the order.
     */
    await this.scoped.findOrFail(scope, orderId, 'read');

    /*
     * Served to the customer as well as to staff, and that is a decision: "what happened to
     * my order and when" is the question the company otherwise answers by telephone, and
     * every row here was written by the transition that caused it.
     *
     * What the customer does not get is the member of staff's id and the prose they typed —
     * see `encodeEvent`. The audience is derived from the reach and not from a flag on the
     * request: `orderReach(scope, 'read').kind === 'all'` is exactly "this caller holds
     * `orders.read` over the whole table", which is the same fact that let them load the
     * order at all. There is no way to ask for the staff view without holding it.
     */
    const audience: EventAudience = orderReach(scope, 'read').kind === 'all' ? 'staff' : 'customer';

    const events = await this.orders.listEvents(orderId);
    return { events: events.map((event) => encodeEvent(event, audience)) };
  }

  async getDocument(scope: Scope, orderId: string): Promise<OrderDocumentWire> {
    const order = await this.scoped.findOrFail(scope, orderId, 'read');

    if (order.documentId === null) {
      throw AppError.notFound('ออร์เดอร์นี้ยังไม่มีเอกสารที่ตรึงไว้ — ยังไม่ได้ส่งใบเสนอราคา');
    }

    const document = await this.orders.findDocumentById(order.documentId);
    if (!document) throw notFound();
    return document.document;
  }

  /* ---------------------------------------------------------------- *
   * Creating a cart
   * ---------------------------------------------------------------- */

  /**
   * Start an order. Anonymous by default, because anonymous is the funnel.
   *
   * A visitor with no session and no guest cookie is given a `guests` row here — this is the
   * "cart module mints the row and sets the cookie" that `rbac/identity.ts` describes, and
   * the controller turns the returned id into a `__Host-` cookie. Minting it in the guard
   * instead would create a row for every crawler.
   *
   * A signed-in visitor who is still carrying a guest cookie gets *both* ids on the order:
   * plan 6's claim path leaves the guest id in place, and a cart that stopped being findable
   * at the moment of login would be a cart lost exactly when it converted.
   */
  async createDraft(
    scope: Scope,
    body: CreateOrderRequestWire,
  ): Promise<{ readonly order: OrderWire; readonly mintedGuest: GuestCookie | null }> {
    return this.orders.transaction(async (tx) => {
      const { actor, mintedGuest } = await this.actorWithCart(tx, scope);

      const orderId = await this.orders.createDraft(tx, {
        /*
         * Both ids when there are both. Signing in *adds* `customer_user_id` and leaves the
         * guest in place (plan 6's claim path), so a cart started in this browser stays
         * findable by the browser and becomes findable by the account.
         */
        customerUserId: actor.actorUserId,
        guestId: actor.actorGuestId,
        contactEmail: body.contact?.email ?? null,
        contactName: body.contact?.name ?? null,
        contactPhone: body.contact?.phone ?? null,
        contactLocale: body.contact?.locale ?? DEFAULT_LOCALE,
        actorKind: actor.actorKind,
        actorUserId: actor.actorUserId,
        actorGuestId: actor.actorGuestId,
        supersedesOrderId: null,
      });

      /*
       * Read back as the principal that now owns it. When a guest was minted a moment ago the
       * request's own scope is still `public` — the cookie has not reached the browser yet —
       * so the scope used from here on is the one the caller *will* be on their next request.
       */
      const owner = mintedGuest === null ? scope : guestScope(mintedGuest.guestId);
      const order = await this.scoped.lockOrFail(tx, owner, orderId, 'act');

      return { order: await this.decorate(owner, order, tx), mintedGuest };
    });
  }

  /* ---------------------------------------------------------------- *
   * The one mutation door — plan 7.4 trap 4
   * ---------------------------------------------------------------- */

  /**
   * Move an order to `toStatus`, whatever that move happens to be.
   *
   * One endpoint rather than one per action, and that is the trap-4 fix made structural: a
   * route called `/cancel` invites a controller to pick a body schema from its own name,
   * which is exactly the mistake. Here the *only* thing the client names is the destination,
   * and everything else — which event this is, which body it takes, who may make it — comes
   * from a row that cannot be found without the order.
   */
  async transition(
    scope: Scope,
    orderId: string,
    toStatus: OrderStatus,
    rawBody: unknown,
  ): Promise<OrderWire> {
    return this.orders.transaction(async (tx) => {
      const actor = requireActor(scope);

      /* ① The lock, scoped by ownership. Everything below reads `order.status` from it. */
      const order = await this.scoped.lockOrFail(tx, scope, orderId, 'act');

      /* ② The move, as data. Not found means this order cannot go there from where it is. */
      const row = await this.orders.findTransition(tx, order.status, toStatus);
      if (!row) {
        throw AppError.conflict('ออร์เดอร์นี้ไปยังสถานะที่ขอไม่ได้จากสถานะปัจจุบัน', {
          from: order.status,
          to: toStatus,
        });
      }

      /* ③ A necessary condition, never a sufficient one. */
      assertActorMayMove(row, actor);

      /* ④ …and only now is there enough known to say what the body should look like. */
      const parsed = parseTransitionBody(row.payloadKind, actor, rawBody);

      await this.applyTransition(tx, { order, row, parsed, actor, scope });

      /*
       * Read back inside the same transaction, so the response describes the row as this
       * transaction left it — including `frozen_at`, which the database stamped and no caller
       * can predict. `systemScope` here is not a widening of anybody's reach: the row was
       * just loaded under the caller's own scope two statements ago, and re-applying the
       * customer filter would fail for a `superseded` order whose reach depends on columns
       * this transaction has just changed.
       */
      const moved = await this.scoped.lock(tx, systemScope('order re-read after transition'), orderId, 'act');
      if (!moved) throw new Error('orders: the order could not be read back after moving');

      return this.decorate(scope, moved, tx);
    });
  }

  /**
   * What each payload kind actually writes.
   *
   * Every branch ends the same way — append the event, then move the order — and the parts
   * that differ are the parts the plan argues about: what gets pinned, where `fault` comes
   * from, what the scope guard compares.
   */
  private async applyTransition(
    tx: Tx,
    input: {
      readonly order: ScopedOrder;
      readonly row: TransitionRow;
      readonly parsed: TransitionBody;
      readonly actor: OrderActor;
      /*
       * The principal, carried to `submit` and nowhere else. `AuthorityService.gate` compares
       * the concession against *this person's* ceiling, so the answer depends on who is
       * pressing send — which is the whole of plan 7.9's replacement question, and the reason
       * the scope has to travel rather than being re-derived from the order.
       */
      readonly scope: Scope;
    },
  ): Promise<string> {
    const { order, row, parsed, actor, scope } = input;

    switch (parsed.payloadKind) {
      case 'submit':
        return this.submit(tx, { order, row, actor, body: parsed.body, scope });

      case 'cancel_post_freeze': {
        /*
         * 🔒 `fault` is derived from the actor and from the spine, never from the body.
         * `hasEvent` is the evidence: a bounce that actually happened, recorded on an
         * append-only table before anybody started arguing about the refund.
         */
        const fault = faultFor({
          actor,
          requestedCompanyFault: parsed.body.attributeFaultToCompany === true,
          /*
           * An *unresolved* bounce, not "ever bounced". The difference is a refund: an order
           * bounced in March, redesigned, approved and delivered still had a
           * `bounced_to_redesign` row in December, and `hasEvent` turned that into permanent
           * authority to record `fault = 'company'` on a cancellation the customer asked for.
           * See `OrderRepository.hasUnresolvedBounce`.
           */
          hasBounceOnSpine: await this.orders.hasUnresolvedBounce(tx, order.id),
        });

        const eventId = await this.record(tx, {
          order,
          row,
          actor,
          payload: { reason: parsed.body.reason, fault },
        });

        /*
         * The money, in the same transaction as the cancellation and never in another one.
         *
         * `assert_order_schedule()` is deferred and runs both ways, so a cancelled order whose
         * schedule is still open fails at COMMIT and there is no ordering of separate requests
         * that fixes it — closing first fails too. Plan 7.5(ก) said the exemption had to be a
         * stamp; this is where the stamp is written. The forfeit rides along because keeping
         * part of a deposit is a consequence of *this* event, not of somebody later asking for
         * the rest back.
         */
        await this.payments.onCancelled(tx, {
          orderId: order.id,
          fromStatus: order.status,
          fault,
          eventId,
        });

        return eventId;
      }

      case 'cancel_pre_freeze':
      case 'bounce':
      case 'supersede': {
        const payload = { reason: parsed.body.reason };

        if (parsed.payloadKind === 'cancel_pre_freeze') {
          const eventId = await this.record(tx, { order, row, actor, payload });

          /*
           * The same close, from the other cancellation door. A pre-freeze cancellation
           * carries no `fault` key at all — `order_status_transitions` marks it
           * `required_payload_keys = {reason}` — and the absence is not ambiguity: only a
           * post-freeze cancellation by staff on an order with a recorded bounce may be the
           * company's fault, so this one is the customer's by construction. The forfeit table
           * has a cell for it, and `production_confirmed` is held at 0 bp by CHECK.
           */
          await this.payments.onCancelled(tx, {
            orderId: order.id,
            fromStatus: order.status,
            fault: 'customer',
            eventId,
          });

          return eventId;
        }

        if (parsed.payloadKind !== 'supersede') {
          return this.record(tx, { order, row, actor, payload });
        }

        /*
         * A successor before the supersede, in the same transaction. `orders_guard_update()`
         * refuses `superseded` without one — "a cancellation wearing a better word", and the
         * money already received would have nowhere to be carried to. Doing it here rather
         * than in a separate request also removes the window in which a successor draft
         * exists while its predecessor is still live.
         *
         * SEAM 5b: the money follows this pointer as an *allocation* carrying
         * `carried_from_order_id`, never as an instalment row on the new order (plan 7.8), so
         * one payment is not reported by two orders forever.
         */
        const successorId = await this.orders.createDraft(tx, {
          customerUserId: order.customerUserId,
          guestId: order.guestId,
          contactEmail: order.contactEmail,
          contactName: order.contactName,
          contactPhone: order.contactPhone,
          contactLocale: order.contactLocale,
          actorKind: actor.actorKind,
          actorUserId: actor.actorUserId,
          actorGuestId: actor.actorGuestId,
          supersedesOrderId: order.id,
        });

        /*
         * The successor's id travels on the event, and that is not bookkeeping.
         *
         * Plan 7.2 requires the customer to approve the new quote, and the message they get
         * is keyed to *this* event on the predecessor — the successor's own `created` event
         * is deliberately silent (a cart being made is not news). Without the id in this
         * payload the notification could say "your order was replaced" and name nothing to
         * go and look at, which is a message that generates a telephone call rather than
         * preventing one.
         */
        const eventId = await this.record(tx, {
          order,
          row,
          actor,
          payload: { ...payload, successor_order_id: successorId },
        });

        /*
         * Close the schedule and leave the money exactly where it is. Nothing is forfeited on
         * a supersede and nothing is refunded — the deposit belongs to the customer's new
         * contract and moves when that contract is submitted, as an allocation that keeps
         * pointing at the slip it came from (plan 7.8). Until then the ancestor reports
         * `terminal_holding_money`, which is the bucket that has to be visible.
         */
        await this.payments.onSuperseded(tx, order.id);

        return eventId;
      }

      case 'approve_redesign': {
        /*
         * Plan 7.2. The guard is at the **scope** and never at the price: a design that
         * cannot be manufactured is usually fixed with something more expensive, and a
         * price guard would block the case it was built for. What the company absorbs is
         * recorded rather than typed — see `absorbedDeltaMinor`.
         */
        const contracted = await this.orders.contractedDocument(tx, order.id);
        const current =
          order.documentId === null
            ? undefined
            : await this.orders.findDocumentById(order.documentId, tx);

        if (!contracted || !current) {
          throw AppError.conflict('ออร์เดอร์นี้ไม่มีเอกสารที่ตรึงไว้ให้เทียบขอบเขต', {
            reason: 'no_contracted_document',
          });
        }

        assertScopeUnchanged(contracted.document, current.document);

        return this.record(tx, {
          order,
          row,
          actor,
          payload: {
            /*
             * A string and not a JSON number: this is money in minor units, and
             * `JSON.parse` on a large integer is where a satang goes missing silently. The
             * same reason `@wewin/contract` writes digits as strings.
             */
            absorbed_delta_thb_minor: absorbedDeltaMinor(
              contracted.document,
              current.document,
            ).toString(),
            contracted_revision: contracted.revision,
            approved_revision: current.revision,
            ...(parsed.body.noteTh === undefined ? {} : { note_th: parsed.body.noteTh }),
          },
        });
      }

      case 'confirm_payment':
        /*
         * The freeze point (plan 7.5(ข)). Deposits changed the *condition* that opens it, not
         * where it is — so 5b changes what has to be true before this line and changes
         * nothing after it.
         *
         * An unanswered change request blocks entry to `production_confirmed`
         * (`orders_guard_update`), because plan 10.4's objection button is worthless if the
         * order freezes over it. That is checked in the database rather than here on purpose:
         * a request could be opened by the customer between this check and the write.
         */
        return this.record(tx, {
          order,
          row,
          actor,
          payload: parsed.body.noteTh === undefined ? {} : { note_th: parsed.body.noteTh },
        });

      case 'none': {
        const eventId = await this.record(tx, { order, row, actor, payload: {} });

        /*
         * Delivery is when the money stops being the customer's.
         *
         * Nothing recognised revenue before this round, and the shape of the omission is worth
         * keeping written down: a delivered, installed, fully paid job's entire ledger was
         * `bank_thb` +฿19,722.24 against `deposit_held` −฿19,722.24. Every account balanced,
         * `assert_ledger_entry_balances` passed, and the trial balance said the company owed
         * every customer it had ever delivered to. An empty account is not a visible bug.
         *
         * Keyed on the destination and not on the event name, for the same reason the whole
         * transition machinery is: the event type is a column of a row in
         * `order_status_transitions` that a migration may change, and the status is what the
         * accounting means.
         */
        if (row.toStatus === 'delivered') {
          await this.payments.onDelivered(tx, { orderId: order.id, eventId });
        }

        return eventId;
      }
    }
  }

  /** Append the event, then move the order. The two halves of every transition. */
  private async record(
    tx: Tx,
    input: {
      readonly order: ScopedOrder;
      readonly row: TransitionRow;
      readonly actor: OrderActor;
      readonly payload: Record<string, unknown>;
    },
  ): Promise<string> {
    const eventId = await this.orders.appendEvent(tx, {
      orderId: input.order.id,
      eventType: input.row.eventType,
      fromStatus: input.order.status,
      toStatus: input.row.toStatus,
      actorKind: input.actor.actorKind,
      actorUserId: input.actor.actorUserId,
      actorGuestId: input.actor.actorGuestId,
      payload: input.payload,
    });

    await this.orders.moveStatus(tx, {
      orderId: input.order.id,
      toStatus: input.row.toStatus,
      statusEventId: eventId,
    });

    return eventId;
  }

  /**
   * Submit — the transaction that pins, and the only one that prices.
   *
   * Statement order is forced by the schema and is the reason the fan-out is deferred: the
   * document names the event that produced it and the order names the document, so it can
   * only go event → document → order. An immediate fan-out trigger would resolve the
   * recipient from the order as it was *before* the submit, which is how "who did we tell?"
   * comes to depend on the order of statements inside a service.
   *
   * ── ⭐ WHAT THIS PRICES, AND WHAT IT USED TO PRICE ────────────────────────────────
   *
   * It prices **`quote_lines`**. For one whole round it priced `body.lines` — the cart the
   * browser was holding — and never read `quote_lines` at all, so the quote a salesperson had
   * edited, discounted and re-described was not the quote that got pinned. A red team measured
   * the gap on one order: ฿1.07 on the quote screen, ฿14,791.68 in
   * `orders.grand_total_thb_minor`, and the two kept diverging afterwards because
   * `awaiting_payment` is an editable status with a payment schedule built off one of them and
   * a customer screen built off the other.
   *
   * `body.lines` is now how a client that has never seen the quote editor hands its cart *in*:
   * it is adopted into `quote_lines` and priced from there, once, and refused outright if a
   * quote already exists.
   *
   * ── The three gates, in this order, and none of them is optional ─────────────────
   *
   *   1. `assertSubmittable`  plan 7.9(จ). Every promise re-verified against today's catalogue;
   *                           409 with each affected line when a publish landed underneath one,
   *                           and an integrity alarm — not a 409 — when `calcPrice` disagrees
   *                           with a frozen document that did not move.
   *   2. the pin              document, order row, schedule.
   *   3. `AuthorityService.gate`  plan 7.13. What the document concedes, measured from the rows
   *                           **after** the pin because the VAT rule it grosses up with is the
   *                           pinned one, and refused when nobody with the authority has said
   *                           yes. Its refusal rolls the pin back with it.
   *
   * Two calls and not one: a stale baseline must stop the pin, and an unapproved concession can
   * only be measured once the revision exists. They fail at different moments and mean different
   * things.
   */
  private async submit(
    tx: Tx,
    input: {
      readonly order: ScopedOrder;
      readonly row: TransitionRow;
      readonly actor: OrderActor;
      readonly body: Extract<TransitionBody, { payloadKind: 'submit' }>['body'];
      readonly scope: Scope;
    },
  ): Promise<string> {
    const { order, row, actor, body } = input;

    if (body.lines !== undefined) await this.quotes.adoptCart(tx, order, body.lines);

    const { document } = await this.quotes.assertSubmittable(tx, order);

    const priced = priceOrderDocument({
      lines: document.lines,
      charges: document.charges,
      overrides: document.overrides,
      leadTimeDays: document.leadTimeDays,
      catalog: await this.catalogIndex(),
      vat: DEFAULT_VAT_RULE,
      locale: body.contact.locale ?? order.contactLocale,
      coreVersion: this.env.SERVICE_VERSION,
      revision: (await this.orders.latestRevision(tx, order.id)) + 1,
    });

    const eventId = await this.orders.appendEvent(tx, {
      orderId: order.id,
      eventType: row.eventType,
      fromStatus: order.status,
      toStatus: 'awaiting_payment',
      actorKind: actor.actorKind,
      actorUserId: actor.actorUserId,
      actorGuestId: actor.actorGuestId,
      payload: {
        document_hash: priced.documentHash,
        line_count: priced.document.lines.length,
      },
    });

    const documentId = await this.orders.pinDocument(tx, {
      orderId: order.id,
      revision: priced.document.revision,
      document: priced.document,
      documentHash: priced.documentHash,
      pinnedCoreVersion: this.env.SERVICE_VERSION,
      pinnedVatRateBp: DEFAULT_VAT_RULE.rateBp,
      pinnedVatTreatment: DEFAULT_VAT_RULE.treatment,
      pinnedLocale: priced.document.pinnedLocale,
      netThbMinor: priced.netThbMinor,
      vatThbMinor: priced.vatThbMinor,
      grandTotalThbMinor: priced.grandTotalThbMinor,
      createdByEventId: eventId,
      productVersionIds: priced.productVersionIds,
    });

    /*
     * ⚠️ THE DEPOSIT OBLIGATION COMES FROM THE SCHEDULE, AND FROM NOWHERE ELSE — plan 7.13.
     *
     * This line used to be `divRoundHalfUp(grandTotal × SCHEDULED_DEPOSIT_BP_DEFAULT, 10000)`,
     * a second implementation of `scheduledDepositMinor` that agreed with the schedule's *only*
     * while plan 13's gate default was payment in full. The red team wrote a 30/70 with the
     * fixture the slips suite already ships and measured the disagreement live: the schedule
     * said the obligation was ฿5,916.67 and this line pinned ฿19,722.24, so a customer who paid
     * in full and cancelled from `in_production` was forfeited the entire order — ฿13,805.57
     * over plan 7.8's answer — and then the refund refused itself because nothing was left,
     * leaving the money in neither party's column. Plan 7.13's ฿12,902, VAT-inclusive.
     *
     * The schedule is planned before the order is written because the pin must be in the same
     * statement that stamps `submitted_at` (`orders_submitted_shape`), and the instalment rows
     * must be written after it because `assert_order_schedule()` foots them against the total
     * on the row. One evaluation, used twice, and no arithmetic in this file.
     */
    const pins = await this.payments.pinsForSubmit(tx, priced.grandTotalThbMinor);

    await this.orders.applySubmission(tx, {
      orderId: order.id,
      statusEventId: eventId,
      documentId,
      /*
       * ⚠️ `?? order.contactEmail`, like the other two, now that an address is optional.
       *
       * A submit that carries only a telephone number must not *erase* an address a cart
       * already had — a customer who typed one at `POST /orders` and gave a number at submit
       * has two channels, and dropping the first would silently move them to the one the
       * outbox cannot reach.
       */
      contactEmail: body.contact.email ?? order.contactEmail,
      contactName: body.contact.name ?? order.contactName,
      contactPhone: body.contact.phone ?? order.contactPhone,
      contactLocale: priced.document.pinnedLocale,
      netThbMinor: priced.netThbMinor,
      vatThbMinor: priced.vatThbMinor,
      grandTotalThbMinor: priced.grandTotalThbMinor,
      scheduledDepositThbMinor: pins.scheduledDepositThbMinor,
    });

    /*
     * And now the schedule exists, which is what makes every gate in this system mean
     * something. Without it `order_settled_through()` is NULL, so `order_gate_is_open()` is
     * true with ฿0.00 received and the freeze point is vacuous — the red team submitted an
     * order through the assembled application and found exactly that, along with zero
     * instalments for a slip to be allocated against, so no payment could ever be accepted.
     */
    await this.payments.onSubmitted(tx, {
      orderId: order.id,
      status: 'awaiting_payment',
      grandTotalThbMinor: priced.grandTotalThbMinor,
      instalments: pins.instalments,
      forfeitPolicyId: pins.forfeitPolicyId,
      supersedesOrderId: order.supersedesOrderId,
    });

    /*
     * ⭐ Last, and after the pin — plan 7.13's document-level evaluation.
     *
     * After, because the concession is grossed up with the *pinned* VAT rule and measured
     * against a schedule that does not exist until `onSubmitted` has written it: a cashflow
     * concession is the gap between the gated prefix and the floor, and before this line there
     * is no prefix. It throws rather than returning a flag, and the throw rolls back everything
     * above it — the document, the order row, the schedule and the event — which is why the
     * approval it demands is keyed to the quote revision and not to the document that has just
     * ceased to exist.
     *
     * With `authority_limits` empty, which is how this ships and what plan 13 documents, a quote
     * that concedes nothing passes here and one that concedes anything at all does not. That is
     * fail-closed, and plan 13's smoke path is the first half of it.
     */
    await this.authority.gate(tx, { orderId: order.id, scope: input.scope });

    return eventId;
  }

  /* ---------------------------------------------------------------- *
   * The customer's objection — trap 5, plan 10.4
   * ---------------------------------------------------------------- */

  /**
   * A customer asking for something to change.
   *
   * Plan 10.4 calls this the biggest gap of the "sales can edit anything" round: today a
   * customer's only way to withhold consent is to not transfer money, which strands the order
   * in `awaiting_payment` forever because there is no timeout. So this is a real event on the
   * spine, it reaches the sales queue through the outbox, and while it is open the order
   * cannot enter `production_confirmed`.
   *
   * Trap 5 is the other half: a request with nothing to clear it blocks every later one for
   * the life of the order. `resolveChangeRequest` below is that path, and the partial unique
   * index is only a fix while it exists.
   */
  async openChangeRequest(
    scope: Scope,
    orderId: string,
    body: CreateChangeRequestWire,
  ): Promise<ChangeRequestWire> {
    return this.orders.transaction(async (tx) => {
      const actor = requireActor(scope);
      const order = await this.scoped.lockOrFail(tx, scope, orderId, 'act');

      /*
       * The objection belongs to the party being objected to *about*.
       *
       * There was no actor check here at all, so a member of staff could open one — and
       * then answer it, which makes the block on entering production a thing the company
       * does to itself and calls consent. Plan 10.4 is explicit about whose button this is.
       */
      if (actor.actorKind === 'staff') {
        throw new AppError(
          'FORBIDDEN',
          403,
          'คำขอแก้ไขเป็นสิทธิ์ของลูกค้า เจ้าหน้าที่เปิดแทนไม่ได้',
          { actorKind: actor.actorKind },
        );
      }

      /*
       * ⚠️ A PLAN 13 DEFAULT, and it is a default because nobody has answered it.
       *
       * Each objection blocks entry to `production_confirmed` until somebody answers it, and
       * nothing stops the cycle open → rejected → open → rejected. Five rounds were
       * demonstrated; there is no reason the sixth would fail. The order then cannot be
       * frozen, and `awaiting_payment` has no timeout (plan 10.4 says so, and 5b owns it),
       * so the order is stuck for ever and it looks like the customer's right to object.
       *
       * The cap is on the *count over the life of the order* and not on a rate, because a
       * rate limit would only slow it down. It is deliberately generous: a real
       * negotiation over a made-to-measure window is two or three rounds, and the number
       * that matters to the business — how many times a customer may reopen before sales
       * has to pick up the telephone — is theirs to set, not this module's to invent.
       */
      const raised = await this.orders.countChangeRequests(tx, order.id);
      if (raised >= MAX_CHANGE_REQUESTS_PER_ORDER_DEFAULT) {
        throw AppError.conflict(
          'คำขอแก้ไขของออร์เดอร์นี้ถึงจำนวนสูงสุดแล้ว กรุณาติดต่อฝ่ายขายโดยตรง',
          { raised, limit: MAX_CHANGE_REQUESTS_PER_ORDER_DEFAULT },
        );
      }

      const eventId = await this.orders.appendEvent(tx, {
        orderId: order.id,
        eventType: 'change_requested',
        /* Not a status change: the order stays where it is and the objection is the fact. */
        fromStatus: null,
        toStatus: null,
        actorKind: actor.actorKind,
        actorUserId: actor.actorUserId,
        actorGuestId: actor.actorGuestId,
        payload: { note_th: body.noteTh },
      });

      const id = await this.orders.openChangeRequest(tx, {
        orderId: order.id,
        openedEventId: eventId,
        noteTh: body.noteTh,
      });

      const row = await this.orders.findChangeRequest(tx, order.id, id);
      if (!row) throw new Error('orders: the change request could not be read back');
      return encodeChangeRequest(row);
    });
  }

  async resolveChangeRequest(
    scope: Scope,
    orderId: string,
    changeRequestId: string,
    body: ResolveChangeRequestWire,
  ): Promise<ChangeRequestWire> {
    return this.orders.transaction(async (tx) => {
      const actor = requireActor(scope);
      const order = await this.scoped.lockOrFail(tx, scope, orderId, 'act');

      /*
       * `withdrawn` is the customer taking it back; the other two are answers, and answering
       * is staff work. Without this the objection would be clearable by the party it is an
       * objection against — which makes the block on entering production decorative.
       */
      if (body.resolution !== 'withdrawn' && actor.actorKind !== 'staff') {
        throw new AppError(
          'FORBIDDEN',
          403,
          'มีเพียงเจ้าหน้าที่เท่านั้นที่ตอบคำขอแก้ไขได้ — ลูกค้าถอนคำขอของตัวเองได้',
          { resolution: body.resolution },
        );
      }

      /*
       * A path segment reaches a `uuid` column here, and one that is not a uuid is SQLSTATE
       * 22P02 — which is neither an `AppError` nor an `HttpException`, so it fell through the
       * filter as a 500 with a logged stack. `POST …/change-requests/not-a-uuid/resolution`
       * was therefore a client-triggered page for the on-call engineer. `:orderId` was
       * already checked in `ScopedOrderRepository`; this is the same rule for the child id,
       * and the answer is the one a caller gets for any id that names nothing.
       */
      if (!isOrderUuid(changeRequestId)) throw AppError.notFound('ไม่พบคำขอแก้ไขนี้');

      const existing = await this.orders.findChangeRequest(tx, order.id, changeRequestId);
      if (!existing) throw AppError.notFound('ไม่พบคำขอแก้ไขนี้');
      if (existing.resolution !== null) {
        throw AppError.conflict('คำขอแก้ไขนี้ถูกตอบไปแล้ว', { resolution: existing.resolution });
      }

      const eventId = await this.orders.appendEvent(tx, {
        orderId: order.id,
        eventType: 'change_resolved',
        fromStatus: null,
        toStatus: null,
        actorKind: actor.actorKind,
        actorUserId: actor.actorUserId,
        actorGuestId: actor.actorGuestId,
        payload: {
          resolution: body.resolution,
          ...(body.noteTh === undefined ? {} : { note_th: body.noteTh }),
        },
      });

      const resolved = await this.orders.resolveChangeRequest(tx, {
        changeRequestId,
        resolvedEventId: eventId,
        resolution: body.resolution,
      });

      if (!resolved) {
        /* Somebody else answered it between the read and the write. */
        throw AppError.conflict('คำขอแก้ไขนี้ถูกตอบไปแล้ว', { reason: 'resolved_concurrently' });
      }

      const row = await this.orders.findChangeRequest(tx, order.id, changeRequestId);
      if (!row) throw new Error('orders: the change request could not be read back');
      return encodeChangeRequest(row);
    });
  }

  /* ---------------------------------------------------------------- *
   * Helpers
   * ---------------------------------------------------------------- */

  /**
   * The principal, plus a cart to hang an order on if they do not have one.
   *
   * Only `POST /orders` reaches this. Every other route needs an order that already exists,
   * and an order that exists already has an owner — `orders_has_an_owner` guarantees it.
   */
  private async actorWithCart(
    tx: Tx,
    scope: Scope,
  ): Promise<{ readonly actor: OrderActor; readonly mintedGuest: GuestCookie | null }> {
    const existing = orderActor(scope);
    if (existing) return { actor: existing, mintedGuest: null };

    /*
     * No principal at all — a first-time visitor. This is the one route in the module that
     * mints one, because a `guests` row is a write and a guard that wrote on every request
     * would fill the table with a row per crawler (`rbac/identity.ts` says so, and points
     * here). The controller turns the returned id into the `__Host-` cookie.
     */
    const minted = await this.orders.createGuest(tx);
    return {
      actor: { actorKind: 'guest', actorUserId: null, actorGuestId: minted.guestId },
      mintedGuest: minted,
    };
  }

  /**
   * Everything the order response needs that is not on the order row.
   *
   * `availableTransitions` is filtered by actor kind here rather than in the encoder because
   * "what may *I* do next" is a question about the principal, and a client that received the
   * unfiltered list would render buttons that 403.
   */
  private async decorate(scope: Scope, order: ScopedOrder, tx?: Tx): Promise<OrderWire> {
    const actor = orderActor(scope);
    const all = await this.orders.transitionsFrom(order.status);
    const transitions =
      actor === undefined
        ? []
        : all.filter((row) => row.allowedActorKinds.includes(actor.actorKind));

    const [documentRevision, supersededByOrderId, openChangeRequest] = await Promise.all([
      order.documentId === null
        ? Promise.resolve(null)
        : this.orders.findDocumentById(order.documentId, tx).then((row) => row?.revision ?? null),
      order.status === 'superseded' || order.supersedesOrderId !== null
        ? this.orders.findSuccessorId(order.id, tx)
        : Promise.resolve(null),
      this.orders.findOpenChangeRequest(order.id, tx),
    ]);

    return encodeOrder(order, {
      transitions,
      documentRevision,
      supersededByOrderId,
      openChangeRequest,
    });
  }

  /**
   * The published catalogue, indexed by product id.
   *
   * One read of the whole catalogue per submit, which is the honest cost of not owning
   * `CatalogRepository`: it serves the published set and finds one product by *slug*, and an
   * order line carries a product *id*. Eighty-one frozen documents with a memoised hash
   * check, on the one request in the funnel that is allowed to be slow. If order volume ever
   * makes that matter, the fix is a `findByIds` on the read repository — not a second query
   * path over `product_versions` in this module, which is exactly the second reader plan 5
   * warns about.
   */
  private async catalogIndex(): Promise<ReadonlyMap<string, CatalogEntry>> {
    const published = await this.catalog.findAll();
    return new Map(published.map((entry) => [entry.product.id, entry]));
  }
}

/**
 * 404 and not 403, always.
 *
 * An order that is not yours is an order you cannot be told about — including whether it
 * exists. Answering 403 for "exists but not yours" and 404 for "does not exist" is an oracle
 * for enumerating order ids, and the ids are uuids precisely so that they cannot be guessed.
 */
const notFound = (): AppError => AppError.notFound('ไม่พบออร์เดอร์นี้');

/**
 * The principal, or 401.
 *
 * `RequirePrincipal` on the route means this cannot be reached without one, so this is the
 * second lock rather than the first — and it is a `throw` and not a non-null assertion
 * because "the guard would have stopped them" is a claim about a decorator in another file.
 * Every event on the spine names an actor (`order_events_actor_shape`); there is no writing
 * one on behalf of nobody.
 */
function requireActor(scope: Scope): OrderActor {
  const actor = orderActor(scope);
  if (!actor) {
    throw AppError.unauthenticated('ต้องเริ่มตะกร้าหรือเข้าสู่ระบบก่อนจึงจะทำรายการนี้ได้');
  }
  return actor;
}

