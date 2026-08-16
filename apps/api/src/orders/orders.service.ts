import { Inject, Injectable } from '@nestjs/common';
import type { OrderStatus } from '@wewin/db/schema';
import { encodeThb } from '@wewin/contract/order';
/*
 * ⚠️ The formatter, not a hand-rolled `toLocaleString`. `formatDateTime` defaults to
 * `BUSINESS_TIME_ZONE` (Asia/Bangkok) and to the locale's own calendar, which is how every
 * other date a member of staff reads is drawn — see the cooldown refusal in `remindBalance`.
 */
import { formatDateTime } from '@wewin/i18n/format';
import {
  type BalanceReminderWire,
  type CancellationPreviewWire,
  type ChangeRequestWire,
  type CreateChangeRequestWire,
  type CreateOrderRequestWire,
  type OrderDocumentResponseWire,
  type OrderEventListWire,
  type OrderListWire,
  type OrderWire,
  type ResolveChangeRequestWire,
} from '@wewin/contract/order';
import type { PaymentInstructionsWire } from '@wewin/contract/organisation';
import { reissueQuoteRequestSchema } from '@wewin/contract/quote';
import { setOrderDepositRequestSchema } from '@wewin/contract/order';

import { AppError } from '../common/errors/app-error';
import { parseAfterLock } from '../common/parse-after-lock';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { message } from '../i18n';
import { CatalogRepository } from '../catalog/catalog.repository';
import { QuotationRateService } from '../fx/quotation-rate.service';
import { encodeAccountPublic, encodeProfile } from '../organisation/encode';
import { OrganisationRepository } from '../organisation/organisation.repository';
import { TaxCountryService } from '../organisation/tax-country.service';
import { PaymentLifecycleService } from '../payments/lifecycle';
/*
 * ⚠️ `acceptsPayment` from `../payments/slips/attachable` used to be imported here, for the
 * wire field of the same name. `0046_slips_after_delivery.sql` made it answer identically to
 * `isLiveOrder` on every status, the wire dropped it, and this import went with it — so
 * `src/orders` no longer reaches into the slips feature at all. Should a reader ever need it
 * back, take it from the list file and not from `../payments/slips`: the barrel exports
 * `SlipsModule`, and reaching it from here pulls a module that already imports `src/orders`
 * back through this file.
 */
import { isLiveOrder } from './live-order';
import { AuthorityService } from '../quotes/authority';
/* The port file and not the barrel — see `organisation.module.ts` on the require cycle. */
import { DEPOSIT_POLICY, type DepositPolicyPort } from '../quotes/authority/deposit-policy.port';
import { QuotesService } from '../quotes/quotes.service';
import { guestScope, systemScope, type GuestCookie, type Scope } from '../rbac';
/*
 * `DEFAULT_VAT_RULE` is deliberately no longer imported here. Every rate this file pins now
 * comes from `TaxCountryService.resolveDestination`, which returns the default itself when an
 * order names no destination — one fallback, in the place that owns the question, rather than
 * a second copy of it inside the submit.
 */
import {
  BALANCE_REMINDER_COOLDOWN_HOURS_DEFAULT,
  DEFAULT_LOCALE,
  MAX_CHANGE_REQUESTS_PER_ORDER_DEFAULT,
} from './defaults';
import {
  encodeBalanceReminder,
  encodeCancellationPreview,
  encodeChangeRequest,
  encodeDocumentResponse,
  encodeEvent,
  encodeOrder,
  encodeOrderSummary,
  iso,
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
    /**
     * Task 10's other read: the accounts to pay into. `activeAccounts()` is the same query
     * `admin/organisation` would use for its own list, filtered to `is_active = true` — see
     * `OrganisationRepository`'s own note on why that filter lives in the repository rather
     * than in this service.
     */
    private readonly organisation: OrganisationRepository,
    /**
     * ⭐ Where the goods are going, turned into the tax rule the document is priced with.
     *
     * One call site: the first statement of `submit` that needs a rate, before
     * `priceOrderDocument`. This service never reads `tax_countries` itself and never decides
     * what a code means — `resolveDestination` is the single place a destination becomes a
     * rate, a treatment and a basis (spec §3), which is what stops a second interpretation of
     * "withdrawn" or "unknown" growing here.
     *
     * Injectable only because `OrganisationModule` exports it. It did not until this task, and
     * the failure mode is the good one: a missing export is a "cannot resolve dependencies"
     * error at boot, not a silent fallback at runtime.
     */
    private readonly taxCountries: TaxCountryService,
    /**
     * ⭐ …and, for a destination that is quoted in something other than baht, the rate it is
     * quoted at.
     *
     * One call site, one line below `resolveDestination` and inside the same transaction: the
     * argument to `priceOrderDocument`. The split between the two is deliberate and is argued in
     * `DestinationTax`'s own comment — the tax envelope stays exactly what it was, and the fx
     * settings reach pricing through a service that owns the cache rule and the refusal rather
     * than by being added as three more fields nothing was asking for.
     *
     * This service never reads `fx_rates`, never decides which observation counts, and never
     * decides what to do when there is not one. `forDestination` answers `null` for a baht
     * quotation and throws for a destination configured for a currency it cannot price — see its
     * header for why silence is not among the options.
     *
     * Injectable only because `FxModule` exports `QuotationRateService`; it exported nothing at
     * all until this round. Same good failure mode as `TaxCountryService` above: a missing export
     * is "cannot resolve dependencies" at boot, not a silent fallback at runtime.
     */
    private readonly fxRate: QuotationRateService,
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
    /**
     * The company's deposit percentage — one method, one number, and no way to write anything.
     *
     * One call site: `submit`, immediately before `pinsForSubmit`. It is the *same* provider
     * `AuthorityService` injects to measure the `cashflow` floor, which is the point — a submit
     * that planned its schedule from one reading of `organisation_profile.deposit_bp` while the
     * gate judged it against another would be plan 7.13's ฿12,902 seam reopened in a new column.
     *
     * The token rather than `OrganisationService`: that class also holds `putProfile`, and an
     * order handler able to rewrite the company's profile is a capability nothing here needs.
     */
    @Inject(DEPOSIT_POLICY) private readonly depositPolicy: DepositPolicyPort,
  ) {}

  /* ---------------------------------------------------------------- *
   * Reading
   * ---------------------------------------------------------------- */

  async getOrder(scope: Scope, orderId: string): Promise<OrderWire> {
    const order = await this.scoped.findOrFail(scope, orderId, 'read');
    return this.decorate(scope, order);
  }

  /**
   * The caller's own orders, or the staff queue — and what each one owes.
   *
   * ⚠️ **One statement, whatever the page size.** `outstandingThbMinor` and `nextDueThbMinor`
   * ride back as columns on `ScopedOrderRepository.list`'s own select
   * (`order_outstanding_thb_minor(o.id)` / `order_next_due_thb_minor(o.id)`, the same shape
   * `overview.repository.ts` uses), so fifty orders are fifty rows and not fifty-one queries.
   * A `Promise.all` over the rows calling `PaymentLifecycleService.customerFigures` per order
   * would produce identical output and is the version this must never become.
   *
   * Nothing here widens what a caller may see. The figures are computed *per returned row*,
   * and which rows are returned was already decided by `ownershipFilter(reach)` inside that
   * same query — a customer's list is `customer_user_id = me`, so there is no row on which a
   * stranger's balance could be evaluated in the first place.
   *
   * ── ⚠️ `owing` filters in the query, and this method is the proof of that ────────
   *
   * The whole of the money filter is one term appended to that query's WHERE (`OWING_ORDERS`).
   * Nothing here reads `outstandingThbMinor` and nothing here drops a row: this body is a
   * pass-through and a `map`, and it must stay that way. A `.filter()` on `rows` would be the
   * exact bug the constraint names — it would compute nothing, but it would make `limit` mean
   * "up to N rows, of which an unknown number owe", so a company with 200 unpaid orders would
   * see a page whose size depended on how many *settled* orders happened to sort above them.
   */
  async listOrders(
    scope: Scope,
    filter: {
      readonly statuses?: readonly OrderStatus[];
      readonly owing?: boolean;
      readonly limit: number;
    },
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

  /**
   * ⚠️ `seller` is a sibling of `document`, never a field on it — see
   * `OrderDocumentResponseWire`. `document` is exactly what `findDocumentById` decoded
   * against the pinned `documentSchemaVersion`, passed through this function unchanged;
   * `seller` is read fresh from `organisation_profile` on every call, the same read Task
   * 10's `paymentInstructions` above makes through the same `OrganisationRepository`. A
   * price is frozen at submit; a letterhead is not, so this is the one field on the
   * response that answers "today", not "back then".
   */
  async getDocument(scope: Scope, orderId: string): Promise<OrderDocumentResponseWire> {
    const order = await this.scoped.findOrFail(scope, orderId, 'read');

    if (order.documentId === null) {
      throw AppError.notFound('ออร์เดอร์นี้ยังไม่มีเอกสารที่ตรึงไว้ — ยังไม่ได้ส่งใบเสนอราคา');
    }

    const [document, [profile]] = await Promise.all([
      this.orders.findDocumentById(order.documentId),
      this.organisation.profile(),
    ]);
    if (!document) throw notFound();
    if (profile === undefined) {
      throw AppError.notFound(message('error.organisation.profile_missing'));
    }

    return encodeDocumentResponse(document.document, encodeProfile(profile));
  }

  /**
   * How much this order owes, and where to send it — task 10.
   *
   * Ownership-scoped through `this.scoped.findOrFail`, the same door and the same 404 as every
   * other read on this controller: a missing order and somebody else's order are answered
   * identically, so a caller cannot use the difference to learn which order ids exist.
   *
   * `outstandingThbMinor` comes from `PaymentLifecycleService.outstandingThbMinor`, which is
   * the same SQL fold the staff slip-review wire reads (`order_outstanding_thb_minor()`,
   * summing every instalment's accepted allocations) — never `grandTotal` minus a sum this
   * service assembles itself, which is wrong the moment a slip carries `unallocated_thb_minor`
   * or the order has more than one instalment.
   *
   * `grandTotalThbMinor` reads ฿0.00 for an order that has never been submitted: the ledger
   * fold already treats a null total that way (`coalesce(grand_total_thb_minor, 0)`), and a
   * cart with nothing priced yet owes nothing.
   */
  async paymentInstructions(scope: Scope, orderId: string): Promise<PaymentInstructionsWire> {
    const order = await this.scoped.findOrFail(scope, orderId, 'read');

    /*
     * ⭐ `nextDueThbMinor` beside `outstandingThbMinor` — the owner's rule for the amount field.
     *
     * *"ถ้าเป็นเคสที่ระบุว่าต้องมัดจำ จึงจะมัดจำ ถ้าไม่ได้ระบุให้ใช้ยอดเต็มเลย"*. Outstanding is what
     * the screen *states* is still owed; next-due is what its amount field *opens on*, and on a
     * 30/70 order those differ by the balance. Both come from `LedgerRepository.money`'s single
     * round trip — `nextDueThbMinor` is another column on the same select, so this costs no
     * extra query despite being a second question.
     */
    const [money, accounts] = await Promise.all([
      this.payments.customerFigures(order.id),
      this.organisation.activeAccounts(),
    ]);

    return {
      grandTotalThbMinor: encodeThb(order.grandTotalThbMinor ?? 0n),
      outstandingThbMinor: encodeThb(money.outstandingThbMinor),
      nextDueThbMinor: encodeThb(money.nextDueThbMinor),
      /*
       * ⭐ WHY THE OUTSTANDING IS ZERO, WHEN IT IS ZERO — the field that stops this screen saying
       * "ออเดอร์นี้ชำระครบแล้ว" to somebody who did not pay.
       *
       * Since 0048 an approved ตัดยอดค้างทิ้ง makes `outstandingThbMinor` fall, and
       * `describePaymentPanel` decided `payment.settled` from `outstanding <= 0` alone. Without
       * this figure the screen has one number for two facts and no way to tell them apart. See
       * `PaymentInstructionsWire.writtenOffThbMinor`, where the argument is written out.
       */
      writtenOffThbMinor: encodeThb(money.writtenOffThbMinor),
      /*
       * ⭐ WHETHER THIS ORDER IS STILL A LIVE COMMITMENT — asked here because the screen cannot.
       *
       * This route does not go through `encodeOrderSummary`, so the live-order predicate that
       * fix closed `GET /orders` and `GET /orders/:id` with never reached it: the storefront's
       * payment page read ฿10,354.18 outstanding and ฿10,354.18 due on an order the customer
       * had **cancelled**, and rendered the upload form under it, at the same moment
       * `GET /orders` answered `null` for the same order. The slip would then have been
       * refused 409 — so no money was ever taken; what was taken was the customer's belief
       * that they owed it.
       *
       * ── ⚠️ There used to be a second boolean here, and it has gone ─────────────────
       *
       * `acceptsPayment` shipped beside this one because the two disagreed about exactly one
       * status: a `delivered` order was live (the debt real) and closed to slips (the upload
       * refused). `0046_slips_after_delivery.sql` opened `delivered` to slips, and with that
       * the two predicates answer identically on all nine statuses —
       * `tests/payments/slips/attachable.test.ts` enumerates them and holds it. Two names for
       * one question is a client deciding which of them to believe, so the wire carries the
       * one it has always meant: *is this a commitment anybody still owes?* The upload route
       * keeps its own guard (`SLIP_ATTACHABLE_STATUSES`, the trigger's mirror) — the screen
       * simply no longer restates it.
       *
       * ── The figures are still stated, and that is deliberate ────────────────────────
       *
       * They are not nulled the way `encodeOrderSummary` nulls a cancelled row's, because
       * this response has one reader and it is a screen that must be able to show what has
       * already been paid on an order that is closed. Nulling them would be a second, wider
       * change to a shape three tests compare against `GET /orders` figure for figure; the
       * screen decides what to *print*, and `PaymentIsland` prints no owed figure at all when
       * this is `false`.
       */
      orderIsLive: isLiveOrder(order.status),
      /*
       * ⭐ "Not payable yet" is a different sentence from "not payable any more", and one
       * boolean cannot carry both — see `PaymentInstructionsWire.awaitingConfirmation`.
       */
      awaitingConfirmation: order.status === 'awaiting_confirmation',
      accounts: accounts.map(encodeAccountPublic),
    };
  }

  /**
   * What cancelling this order right now would cost — asked before it is done.
   *
   * ── Why this route exists at all ─────────────────────────────────────────────────
   *
   * Because the storefront now has a cancel button, and a cancel button that forfeits money
   * without saying how much is the worst version of this feature. The customer has to be told
   * the figure *before* they confirm, and the figure has to be the real one: `forfeit_bp` comes
   * from the policy the order pinned at submit and `held` is a fold of ledger postings, so there
   * is no arithmetic a browser could do to arrive at it. It is asked for, or it is guessed.
   *
   * ── Why it cannot disagree with the cancellation ─────────────────────────────────
   *
   * It calls `PaymentLifecycleService.priceCancellation`, which is what the cancellation itself
   * calls. Not the same formula written twice — the same method. See its comment for the
   * plan-7.13 history that makes this the only acceptable arrangement.
   *
   * ── `'read'`, and no lock ────────────────────────────────────────────────────────
   *
   * A preview is a read: it must not take `FOR UPDATE` on a row because a caller asked what
   * something would cost. The money is read inside one transaction so `held`, the pinned policy
   * and the priced forfeit are one consistent snapshot, and `fromStatus` rides back on the
   * response so a client can see which status it describes.
   *
   * ⚠️ Availability is decided by `order_status_transitions` through `assertActorMayMove` — the
   * same function the transition itself is gated by — and not by a list of cancellable statuses
   * retyped here. An order that cannot be cancelled from where it stands has no cancellation to
   * price, and saying so is a 409; an actor whose kind may not make the move gets the 403 they
   * would get from attempting it.
   */
  async previewCancellation(scope: Scope, orderId: string): Promise<CancellationPreviewWire> {
    const actor = requireActor(scope);
    const order = await this.scoped.findOrFail(scope, orderId, 'read');

    const row = (await this.orders.transitionsFrom(order.status)).find(
      (candidate) => candidate.toStatus === 'cancelled',
    );

    if (row === undefined) {
      throw AppError.conflict(message('error.order.not_cancellable_from_status'), {
        status: order.status,
      });
    }

    assertActorMayMove(row, actor);

    /*
     * 🔒 `'customer'`, and it is not a parameter this route accepts.
     *
     * `faultFor` gives every non-staff actor `'customer'`, and `CancelOrderRequestWire` has no
     * field through which a customer could claim otherwise — so for the caller this route is
     * built for, this is not one of two possible answers, it is the answer. Taking `fault` from
     * the query string would be the request-body hole plan 7.8 closed, reopened on a GET.
     */
    const price = await this.orders.transaction((tx) =>
      this.payments.priceCancellation(tx, {
        orderId: order.id,
        fromStatus: order.status,
        fault: 'customer',
      }),
    );

    return encodeCancellationPreview({ fromStatus: order.status, ...price });
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

      /*
       * ⭐ WHO THE ORDER BELONGS TO, WHICH IS NOT ALWAYS WHO IS TYPING.
       *
       * A walk-in customer at the shop has no account and no browser in this transaction: a
       * member of staff opens the order for them at the counter. Written the obvious way —
       * `customerUserId: actor.actorUserId` — that order is recorded as belonging to **the
       * salesperson**, which works until somebody asks what this customer has bought before,
       * or that salesperson leaves and their account is closed.
       *
       * So a staff-opened order is owned by a freshly minted `guests` row: an anonymous
       * customer, which is exactly what a walk-in is. Nobody is handed its secret, so nobody
       * can authenticate as it — only staff can reach the order, through `orderReach`, which
       * is the correct reach for an order taken at a counter. If that customer later signs
       * up, plan 6's claim path is the same one a browser cart uses.
       *
       * ⚠️ The *actor* is still the staff member, and the `created` event still says so. The
       * spine records who acted; `orders` records whose order it is. Conflating the two is the
       * defect this comment is about.
       */
      const belongsTo =
        actor.actorKind === 'staff'
          ? { customerUserId: null, guestId: (await this.orders.createGuest(tx)).guestId }
          : { customerUserId: actor.actorUserId, guestId: actor.actorGuestId };

      const orderId = await this.orders.createDraft(tx, {
        /*
         * Both ids when there are both. Signing in *adds* `customer_user_id` and leaves the
         * guest in place (plan 6's claim path), so a cart started in this browser stays
         * findable by the browser and becomes findable by the account.
         */
        customerUserId: belongsTo.customerUserId,
        guestId: belongsTo.guestId,
        contactEmail: body.contact?.email ?? null,
        contactName: body.contact?.name ?? null,
        contactPhone: body.contact?.phone ?? null,
        contactLocale: body.contact?.locale ?? DEFAULT_LOCALE,
        /*
         * ⚠️ Forwarded, where it used to be dropped on the floor.
         *
         * `createOrderRequestSchema` reuses `orderContactRequestSchema`, so a `POST /orders`
         * carrying `contact.destinationCountry` validated and answered 201 while this method
         * never passed the value on. That was cosmetic for exactly as long as nothing read the
         * column. It stopped being cosmetic when `submit` began pricing from it: a draft
         * created with `SG` and submitted without repeating the country resolved `null`, priced
         * at Thai 7%, and pinned a document that disagreed with its own order row.
         *
         * The country is *not* validated here. `resolveDestination` is the one place a code
         * becomes a rule, and it runs at submit — refusing an unknown code at create would put
         * a second interpretation of `tax_countries` on the anonymous cart-creation path, and
         * would refuse a cart for a country the company is about to add.
         */
        destinationCountry: body.contact?.destinationCountry ?? null,
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

      /*
       * ② The move, as data. Not found means this order cannot go there from where it is.
       *
       * ⭐ …with one rewrite, for one pair, for one release. `0056_retire_direct_submit.sql`
       * deleted `draft → awaiting_payment`: a quotation request now lands in
       * `awaiting_confirmation` and a member of staff decides when the customer may pay. But
       * `apps/web/src/lib/quote/submit.ts` posts the destination **by name**, so a browser tab
       * loaded before the deploy asks for the old one — and would get a 409 about statuses on
       * the customer's primary action, having filled in the form.
       *
       * The rewrite is here rather than a second transition row on purpose: a row would be a
       * second way for an order to arrive in `awaiting_payment` without ever being confirmed,
       * which is precisely what this round removes. This is a compatibility shim with an end
       * date and a test (`submit-lands-unconfirmed.pg.test.ts`), not a supported alias.
       */
      const requested =
        order.status === 'draft' && toStatus === 'awaiting_payment'
          ? ('awaiting_confirmation' as OrderStatus)
          : toStatus;

      const row = await this.orders.findTransition(tx, order.status, requested);
      if (!row) {
        throw AppError.conflict('ออร์เดอร์นี้ไปยังสถานะที่ขอไม่ได้จากสถานะปัจจุบัน', {
          from: order.status,
          to: requested,
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
          /*
           * Carried forward with the other five, and for the same reason they are: the
           * successor is the *same sale* re-quoted after the freeze. A successor that lost the
           * destination would silently re-price a Singapore order at Thai 7% — and would do it
           * on the one path where the customer is being asked to approve a new number.
           */
          destinationCountry: order.destinationCountry,
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

      case 'authorise_unpaid':
        /*
         * ⛔ THE SAME FREEZE POINT, REACHED WITH NOTHING RECEIVED — and said so.
         *
         * The owner asks for this move ("ยังไม่ต้องชำระก็ได้ ... ข้ามไปที่ขั้นตอนเริ่มผลิตเลยแล้ว
         * ค่อยชำระทีเดียว"), so what was wrong was never that it happened. It was that it went
         * onto the spine as `payment_confirmed` and mailed the customer that their payment had
         * been verified when ฿0 had arrived.
         *
         * ⚠️ No money check here, deliberately: this branch *is* the unpaid case, and refusing
         * it would remove the thing the owner asked for. What guards the other side — an order
         * in `awaiting_payment` being confirmed as paid when nothing came in — belongs on
         * `confirm_payment`, where the claim being made is about money.
         *
         * `reason` is required by `order_status_transitions.required_payload_keys` and checked
         * in `order_events_guard_insert()`, so it is on the row for every writer rather than
         * only for this one. It goes on the payload verbatim; nothing parses it later.
         */
        return this.record(tx, {
          order,
          row,
          actor,
          payload: { reason: parsed.body.reason },
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

    /*
     * ⭐ THE DESTINATION BECOMES A TAX RULE HERE, AND BEFORE EVERYTHING THAT USES IT.
     *
     * ⚠️ It moved **above** `assertSubmittable`, which is not cosmetic. That gate recomputes
     * the whole quote — `applyOverrides`, the coherence refusals, and the re-verification of a
     * `grand_total` promise's stored baseline — and every one of those is now basis-dependent.
     * Resolving afterwards and handing the result only to `priceOrderDocument` would have the
     * submit *approve* one document and *pin* a different one, on a code path whose entire
     * purpose is that those two are the same document.
     *
     * One resolution for the whole request, passed to both. `QuotesService` never resolves for
     * itself here, which is what makes "the figure the gate approved" and "the figure that got
     * frozen" the same arithmetic over the same row rather than two reads of a mutable table.
     *
     * Resolution comes before pricing, and therefore before the order row that records the
     * country is written by `applySubmission` below. The document is priced a few lines down
     * and pinned after that; a resolution placed after either of those would pin a document
     * that never saw it. The expression is `body.contact.destinationCountry ??
     * order.destinationCountry` — the identical `??` the write itself uses, so the country the
     * document is priced for and the country the row records are one decision read twice, not
     * two decisions that could differ.
     *
     * `tx`, not a bare call. `TaxCountryRepository.byCode` threads it through
     * `executor(tx) ?? this.db`, and it was *measured* to arrive: `select pg_backend_pid(),
     * txid_current()` run on this `tx` and again inside `byCode` reports the same backend and
     * the same transaction id (pid 96517, xid 1629137); with the argument dropped they diverge
     * every run (pid 96581/96580, xid 1629191/1629192) — a second pooled connection in a
     * transaction of its own.
     *
     * ⚠️ **What that does and does not buy, stated honestly**, because the first version of
     * this comment claimed a concurrency guarantee it does not have. This database runs at
     * READ COMMITTED (verified: `show transaction_isolation` → `read committed`), where every
     * *statement* takes a fresh snapshot — so a rate committed by a concurrent
     * `PATCH /admin/organisation/tax-countries/:code` is equally visible to a read on this
     * transaction and to one on another connection. Threading `tx` does **not** make this read
     * snapshot-consistent with the pin today.
     *
     * What it buys is: one connection instead of two for the same work; a read that sees
     * whatever this transaction has already written, which is the property that keeps holding
     * as `submit` grows; and the only version of this call that is still correct if the
     * isolation level is ever raised to REPEATABLE READ, where a separate connection would
     * definitively be reading a different instant from the document it is about to freeze.
     *
     * ⚠️ **No runtime test can fail on any of that**, which is why the parameter is a required
     * `Tx | undefined` on `resolveDestination` rather than an optional one — dropping it is
     * `TS2554: Expected 2 arguments, but got 1`. A one-connection pool does not distinguish
     * them either; that was measured too, and the reason is one line below.
     *
     * A code naming no row is refused with `reason: 'unknown_destination_country'` rather than
     * quietly falling back to `DEFAULT_VAT_RULE` — see `TaxCountryService.resolveDestination`.
     * A *withdrawn* country resolves normally, on purpose: `is_active` governs what a new
     * customer is offered, not whether a cart already carrying it may still be submitted.
     */
    /*
     * ⭐ ONE read of `tax_countries`, not two. `resolveForSubmit` returns both halves of the
     * same row — the tax envelope and the fx settings — because this is the only path that
     * wants both, and reading it twice meant a second round-trip inside a transaction already
     * holding a row lock on the order. See that method for the measurement.
     */
    const resolved = await this.taxCountries.resolveForSubmit(
      body.contact.destinationCountry ?? order.destinationCountry,
      tx,
    );
    const destination = resolved.tax;

    const { document } = await this.quotes.assertSubmittable(tx, order, destination);

    const priced = priceOrderDocument({
      lines: document.lines,
      charges: document.charges,
      overrides: document.overrides,
      leadTimeDays: document.leadTimeDays,
      /*
       * ⚠️ This takes a **second pooled connection while the transaction holds a first**:
       * `CatalogRepository.findAll()` reads `this.db` and has no `tx` parameter at all. It
       * predates this task and is left alone here, but it is why a `max: 1` pool cannot be used
       * to prove the `tx` above arrives — the submit needs two connections either way — and it
       * is worth knowing before anybody sizes a pool by counting transactions.
       */
      catalog: await this.catalogIndex(),
      vat: destination.rule,
      destinationCountry: destination.code,
      taxBasis: destination.basis,
      /*
       * ⭐ The rate the document is quoted at, resolved from the same `tx` and beside the
       * destination it belongs to — `null` for a baht quotation, which is most of them.
       *
       * `tx`, and it matters more here than it does for `resolveDestination` above. That call's
       * own note is honest that threading `tx` buys no snapshot consistency at READ COMMITTED;
       * this one reads a *second* table (`fx_rates`) that a concurrent daily sync appends to, and
       * running it on a pooled connection of its own would mean the document could be priced
       * against a snapshot that was not the newest one when the destination was read. One
       * transaction, one connection, one instant — and the only version that is still correct if
       * the isolation level is ever raised.
       *
       * Resolved *inside* the transaction and not before it for the plainer reason too: this
       * throws for a destination configured for a currency with no usable rate, and a refusal
       * that lands here rolls the whole submit back rather than leaving a half-written order.
       */
      fx: await this.fxRate.fromSettings(resolved.fx, tx),
      locale: body.contact.locale ?? order.contactLocale,
      coreVersion: this.env.SERVICE_VERSION,
      revision: (await this.orders.latestRevision(tx, order.id)) + 1,
    });

    const eventId = await this.orders.appendEvent(tx, {
      orderId: order.id,
      eventType: row.eventType,
      fromStatus: order.status,
      /*
       * ⭐ From the transition row, not a literal, and that is the whole of the flip.
       *
       * A submit used to land in `awaiting_payment` — the customer was asked to transfer money
       * against a figure no member of staff had seen. It now lands in `awaiting_confirmation`,
       * and this line stopped naming either: the destination is a column of the row this
       * transition was loaded from, so moving it again is a migration and not a search for
       * string literals. There were three of them, in two files, and the third was invisible to
       * every test because it only reached a status *assertion*.
       */
      toStatus: row.toStatus,
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
      /*
       * ⚠️ From the resolution, and from the same object the document was priced with.
       *
       * `orders_totals_match_document()` foots the *totals* and never looks at the rate, so a
       * column saying 700 beside a document saying 900 passes every constraint in the database
       * — and the two are read by different screens. `destination.rule` is the one source both
       * halves come from; mutation-tested by reverting this line to `DEFAULT_VAT_RULE.rateBp`
       * and watching `destination-pinning.pg.test.ts` go red on the column alone.
       */
      pinnedVatRateBp: destination.rule.rateBp,
      pinnedVatTreatment: destination.rule.treatment,
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
     *
     * ── ⭐ AND THE SHARE COMES FROM THE COMPANY'S OWN SETTING ────────────────────
     *
     * `organisation_profile.deposit_bp`, read here — inside this transaction, through the same
     * one-method port `AuthorityService` measures the `cashflow` floor with, so the schedule this
     * submit writes and the floor the gate judges it against come from **one definition**. They
     * came from two for a whole round: the schedule was planned `payInFullTerms()`
     * unconditionally while the floor was a module constant at 10 000 bp, and the day somebody
     * used the admin screen the setting would have changed nothing at all.
     *
     * ⚠️ **One definition is now also one read, and it was not always.**
     *
     * There used to be two reads of that row in a submit — this one, and
     * `AuthorityService.measureFor`'s at the `gate` call below. `OrganisationRepository.profile()`
     * is a plain unlocked `SELECT`, this database runs at READ COMMITTED (verified: `show
     * transaction_isolation` → `read committed`), and every *statement* there takes a fresh
     * snapshot — so a `PUT /admin/organisation` committing between the two was visible to the
     * second and not the first, and the two could genuinely disagree. Raising the policy
     * mid-submit (3 000 bp, then 10 000) planned a schedule gating 30% and then judged it against
     * a floor of 100%: a 70% `cashflow` concession, no row in `authority_limits` to cover it, the
     * gate refuses, and the whole submit rolls back with a 409 about approval authority for an
     * order nobody conceded anything on.
     *
     * That window is closed, and not by a lock. This value is now **pinned onto the order** by
     * `applySubmission` below (`orders.deposit_floor_bp`), and `measureFor` reads the pin rather
     * than the setting whenever there is one — so the gate a few lines down judges this schedule
     * against the floor it was planned from, by construction, whatever an admin does in between.
     * The pin exists for a different reason (an order re-read next month must report the
     * concession it was measured for, not one against today's policy — see the schema note on the
     * column); closing this window is a consequence of it, and a `FOR SHARE` on this read, which
     * was the alternative and would have made every submit hold a shared lock on one singleton row
     * for its whole duration, is not needed and was not taken.
     *
     * `tx` is still threaded, for the reasons the destination resolution above gives at length: it
     * buys one connection instead of two, a read that sees what this transaction has already
     * written, and the only version still correct if the isolation level is ever raised.
     */
    const depositBp = await this.depositPolicy.depositBp(tx);
    const pins = await this.payments.pinsForSubmit(tx, priced.grandTotalThbMinor, depositBp);

    await this.orders.applySubmission(tx, {
      orderId: order.id,
      statusEventId: eventId,
      documentId,
      /* Where this transition says it goes — see the event above. */
      status: row.toStatus,
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
      /* Same `??` shape as the three contact fields above: a submit naming no destination must not erase one the cart already had. */
      destinationCountry: body.contact.destinationCountry ?? order.destinationCountry,
      contactLocale: priced.document.pinnedLocale,
      netThbMinor: priced.netThbMinor,
      vatThbMinor: priced.vatThbMinor,
      grandTotalThbMinor: priced.grandTotalThbMinor,
      scheduledDepositThbMinor: pins.scheduledDepositThbMinor,
      /*
       * ⭐ The floor the schedule above was planned from, pinned beside the deposit it will be
       * compared against. The same `depositBp` — the variable, not a second read — so the two
       * halves of the comparison can never come from two different instants of the setting.
       */
      depositFloorBp: depositBp,
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
      /*
       * ⚠️ The status the order was actually just moved to — the third literal, and the one that
       * would not have failed a test. It becomes `ScheduleContext.status`, which
       * `assertEditable` compares against `SCHEDULE_EDITABLE_STATUSES`; both statuses are on
       * that list, so a stale literal here would have gone on passing while telling the schedule
       * module something untrue about the order it was writing.
       */
      status: row.toStatus,
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
   * ⭐ ออกใบเสนอราคาใหม่ — carrying an edited quote to the customer
   * ---------------------------------------------------------------- */

  /**
   * Re-pin the document, the totals and the schedule from the quote as it now stands.
   *
   * ── The bug this closes ─────────────────────────────────────────────────────────
   *
   * Every write in `QuotesService` moves `quote_lines` and `quote_overrides`. **None of them
   * moves what the customer is asked for**: that is `orders.grand_total_thb_minor`, and until
   * this method existed only a submit ever wrote it. So sales could take ฿20,000 off an order
   * in `awaiting_payment`, watch the editor agree, and the customer's payment page would go on
   * asking for the old figure — with the order's own timeline saying nothing had happened. The
   * discount was real in one table and invisible in every other.
   *
   * ── Why it is a separate request and not a consequence of the edit ──────────────
   *
   * Sending a customer a new contract is a decision, and it is not the same decision as
   * changing a number in an editor. Sales usually make several edits and then send once; a
   * re-issue on every write would send three versions of a negotiation that had one outcome,
   * and each one appends to the spine and mails the customer.
   *
   * ── The sequence, which is `submit`'s and deliberately so ───────────────────────
   *
   * Price → append `quote_revised` → pin → move the order row → replace the schedule → gate.
   * Every ordering constraint `submit` documents applies here for the same reasons: the
   * destination is resolved before pricing, the event exists before the document that names it,
   * the totals are on the row before the instalments that foot against them, and the gate runs
   * last because a concession can only be measured once the revision exists.
   *
   * ── What it deliberately does NOT touch ─────────────────────────────────────────
   *
   * `submitted_at`, `order_no`, `status_event_id` and `depositFloorBp` — see `applyReissue`.
   * The order does not move status, does not get a second number, and is not re-pinned to a
   * policy floor it was not measured against.
   */
  async reissueQuote(scope: Scope, orderId: string, rawBody: unknown): Promise<OrderWire> {
    return this.orders.transaction(async (tx) => {
      const actor = requireActor(scope);
      const order = await this.scoped.lockOrFail(tx, scope, orderId, 'act');

      /* Parsed after the lock, like every quote write's body — see `parseAfterLock`. */
      const body = parseAfterLock(reissueQuoteRequestSchema, rawBody);

      /*
       * ⛔ The two statuses in which a quotation is a live document nobody has been paid for.
       *
       * A `draft` has never been quoted — the route for that is a submit, which does more than
       * this (an order number, `submitted_at`, the forfeit policy, the customer's first mail).
       * Anything past `awaiting_payment` has money on it or is in production, and re-pricing a
       * contract being built is not a re-issue but a change order.
       *
       * ⭐ `awaiting_confirmation` joined it with the flip, and it is now the *ordinary* case:
       * staff edit the quotation before anybody is asked to pay, and pressing send there is what
       * carries the new figures onto the order the customer is looking at. Re-issuing from
       * `awaiting_payment` — after the customer has been asked — is the exceptional one.
       */
      if (order.status !== 'awaiting_payment' && order.status !== 'awaiting_confirmation') {
        throw AppError.conflict(message('error.quote.not_awaiting_payment'), {
          reason: 'order_not_awaiting_payment',
          status: order.status,
        });
      }

      /*
       * The two refusals, from `QuotesService` so that they are the same two refusals every
       * quote write makes: a baseline somebody else has moved, and money already received.
       * Money first would be the wrong order — a stale editor is the more likely mistake and
       * the cheaper one to explain.
       */
      await this.quotes.assertRevision(tx, order.id, body.expect.quoteRevision);
      await this.quotes.assertNoMoney(tx, order.id);

      const previousGrandTotal = order.grandTotalThbMinor;

      /* From here down, `submit`'s own sequence — see that method for every "why this order". */
      const resolved = await this.taxCountries.resolveForSubmit(order.destinationCountry, tx);
      const destination = resolved.tax;

      const { document } = await this.quotes.assertSubmittable(tx, order, destination);

      const priced = priceOrderDocument({
        lines: document.lines,
        charges: document.charges,
        overrides: document.overrides,
        leadTimeDays: document.leadTimeDays,
        catalog: await this.catalogIndex(),
        vat: destination.rule,
        destinationCountry: destination.code,
        taxBasis: destination.basis,
        fx: await this.fxRate.fromSettings(resolved.fx, tx),
        locale: order.contactLocale,
        coreVersion: this.env.SERVICE_VERSION,
        revision: (await this.orders.latestRevision(tx, order.id)) + 1,
      });

      /*
       * ⚠️ Status-less, like `change_requested`: the order stays exactly where it is and the
       * re-issue is the fact. `quote_revised` has been a permitted event type and a customer
       * mail template since 0051 with **no producer at all** — this is the producer.
       *
       * Both totals on the payload, because "what changed?" is the first question anybody asks
       * of this row, and reconstructing the old one means reading the previous document.
       */
      const eventId = await this.orders.appendEvent(tx, {
        orderId: order.id,
        eventType: 'quote_revised',
        fromStatus: null,
        toStatus: null,
        actorKind: actor.actorKind,
        actorUserId: actor.actorUserId,
        actorGuestId: actor.actorGuestId,
        payload: {
          document_hash: priced.documentHash,
          line_count: priced.document.lines.length,
          grand_total_thb_minor: priced.grandTotalThbMinor.toString(),
          previous_grand_total_thb_minor: previousGrandTotal?.toString() ?? null,
        },
      });

      const documentId = await this.orders.pinDocument(tx, {
        orderId: order.id,
        revision: priced.document.revision,
        document: priced.document,
        documentHash: priced.documentHash,
        pinnedCoreVersion: this.env.SERVICE_VERSION,
        pinnedVatRateBp: destination.rule.rateBp,
        pinnedVatTreatment: destination.rule.treatment,
        pinnedLocale: priced.document.pinnedLocale,
        netThbMinor: priced.netThbMinor,
        vatThbMinor: priced.vatThbMinor,
        grandTotalThbMinor: priced.grandTotalThbMinor,
        createdByEventId: eventId,
        productVersionIds: priced.productVersionIds,
      });

      /*
       * ⚠️ THE DEPOSIT COMES FROM THE SCHEDULE THAT WAS ACTUALLY WRITTEN — the same rule, and
       * the same reason, as the submit twenty lines up: two spellings of "what a 30% deposit
       * means" is how a revision comes to owe a different shape from the contract it replaces.
       *
       * ⚠️ The order row is updated **before** the schedule is replaced, because
       * `assert_order_schedule()` foots the instalments against the total on the row. The
       * deposit that goes on the row therefore has to be planned first and pinned in the same
       * statement as the totals — which is why the schedule is planned by `replaceScheduleForReissue`
       * from the new total and its answer written a statement later.
       */
      /*
       * ⛔ THE ORDER'S OWN SHARE FIRST, and the company setting only when nobody chose one.
       *
       * Reading the policy unconditionally here is how a deposit staff had authored would be
       * silently reverted — along with the forfeit ceiling derived from it — the next time
       * anybody edited the quotation and pressed send. `null` means nobody chose, which is a
       * different fact from 0%.
       */
      const depositBp = order.depositBpAuthored ?? (await this.depositPolicy.depositBp(tx));
      const pins = this.payments.pinsForReissue(priced.grandTotalThbMinor, depositBp);

      await this.orders.applyReissue(tx, {
        orderId: order.id,
        documentId,
        netThbMinor: priced.netThbMinor,
        vatThbMinor: priced.vatThbMinor,
        grandTotalThbMinor: priced.grandTotalThbMinor,
        scheduledDepositThbMinor: pins.scheduledDepositThbMinor,
      });

      await this.payments.replaceScheduleForReissue(tx, {
        orderId: order.id,
        status: order.status,
        grandTotalThbMinor: priced.grandTotalThbMinor,
        instalments: pins.instalments,
      });

      await this.authority.gate(tx, { orderId: order.id, scope });

      const reissued = await this.scoped.lock(
        tx,
        systemScope('order re-read after re-issue'),
        orderId,
        'act',
      );
      if (!reissued) throw new Error('orders: the order could not be read back after re-issue');

      return this.decorate(scope, reissued, tx);
    });
  }

  /* ---------------------------------------------------------------- *
   * ⭐ การระบุยอดมัดจำ — the deposit for one order
   * ---------------------------------------------------------------- */

  /**
   * Set the deposit share for this order, and re-cut the schedule to match.
   *
   * The other half of what the owner asked staff to be able to do while a quotation is
   * unconfirmed: *"การระบุยอดมัดจำ, การระบุส่วนลด"*. The discount was already possible — it is an
   * override on the quote — and this was not: the deposit came from one company-wide number
   * applied to every order at submit, with no route that could move it on a single one.
   *
   * ── The three refusals ──────────────────────────────────────────────────────────
   *
   * ⓵ Only while the order is still negotiable: `awaiting_confirmation` (the ordinary case) and
   *    `awaiting_payment` (the customer has been asked but has not paid). A draft has no
   *    contract to attach a share to — `orders_deposit_bp_authored_needs_a_contract` says so in
   *    the schema — and anything later is being built.
   *
   * ⓶ Not once money has arrived, through `QuotesService.assertNoMoney`, the same call every
   *    quote write makes. `ScheduleService.replacePlanned` would refuse an allocated schedule
   *    anyway; this refusal comes first because it says *why* in the customer's terms and names
   *    the amount held.
   *
   * ⓷ ⭐ Below the company standard only when the company has said staff may. That is the
   *    owner's own decision — a setting rather than a rule in code — and the asymmetry is real:
   *    asking a customer for *more* of their own money up front concedes nothing, while asking
   *    for less is the company financing the difference. When it is permitted the gap goes
   *    through `AuthorityService.gate` as a `cashflow` concession like any other.
   */
  async setDeposit(scope: Scope, orderId: string, rawBody: unknown): Promise<OrderWire> {
    return this.orders.transaction(async (tx) => {
      requireActor(scope);
      const order = await this.scoped.lockOrFail(tx, scope, orderId, 'act');
      const body = parseAfterLock(setOrderDepositRequestSchema, rawBody);

      if (order.status !== 'awaiting_confirmation' && order.status !== 'awaiting_payment') {
        throw AppError.conflict(message('error.deposit.not_editable'), {
          reason: 'deposit_not_editable',
          status: order.status,
        });
      }

      await this.quotes.assertNoMoney(tx, order.id);

      const [profile] = await this.organisation.profile(tx);
      if (!profile) throw new Error('orders: the organisation profile is missing');

      if (body.depositBp < profile.depositBp && !profile.depositBelowFloorAllowed) {
        throw AppError.conflict(message('error.deposit.below_company_floor'), {
          reason: 'deposit_below_company_floor',
          companyDepositBp: profile.depositBp,
          requestedDepositBp: body.depositBp,
        });
      }

      /*
       * ⚠️ The grand total the schedule foots against is the one on the row, not a re-priced
       * one: this endpoint changes how the money is *split*, never how much of it there is.
       * A null total would mean an order with no contract, which ⓵ has already refused.
       */
      const grandTotal = order.grandTotalThbMinor;
      if (grandTotal === null) throw new Error('orders: a contracted order has a grand total');

      const pins = this.payments.pinsForReissue(grandTotal, body.depositBp);

      await this.orders.applyDeposit(tx, {
        orderId: order.id,
        depositBpAuthored: body.depositBp,
        scheduledDepositThbMinor: pins.scheduledDepositThbMinor,
      });

      await this.payments.replaceScheduleForReissue(tx, {
        orderId: order.id,
        status: order.status,
        grandTotalThbMinor: grandTotal,
        instalments: pins.instalments,
      });

      /*
       * ⭐ Last, and only measurable now: a `cashflow` concession is the gap between what this
       * schedule gates and the floor the order was pinned to at submit, and neither the new
       * schedule nor the new obligation existed until the two statements above.
       *
       * ⚠️ With `authority_limits` empty — how this ships — a deposit at or above the floor
       * concedes nothing and passes, and one below it is refused for want of a ceiling nobody
       * has granted. That is fail-closed and is the intended behaviour, not an oversight: the
       * setting says staff *may* ask, the ceiling says who may agree.
       */
      await this.authority.gate(tx, { orderId: order.id, scope });

      const updated = await this.scoped.lock(
        tx,
        systemScope('order re-read after a deposit change'),
        orderId,
        'act',
      );
      if (!updated) throw new Error('orders: the order could not be read back');
      return this.decorate(scope, updated, tx);
    });
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

  /**
   * ─────────────────────────────────────────────────────────────────────────
   * ⭐ แจ้งเตือนยอดค้างชำระ — ask the customer for the outstanding balance.
   * ─────────────────────────────────────────────────────────────────────────
   *
   * Five rounds made the balance payable, visible, recordable and forgivable. This is the one
   * that opens the software's mouth.
   *
   * ── ⚠️ WHO FIRES IT: A PERSON, AND ONLY A PERSON ───────────────────────────
   *
   * Asked when their business collects the balance, the owner answered *"แล้วแต่งาน ไม่ตายตัว"*.
   * There is also **no due-date column anywhere in this schema**, so nothing is ever overdue and
   * a scheduler would have nothing to fire from. Both halves point the same way: the person who
   * knows what was agreed for *this* job decides when to ask, from the order screen where
   * ค้างชำระ already is. A reminder that fired on a rule nobody agreed to is how a customer
   * learns to ignore the messages that matter.
   *
   * `actorKind: 'staff'` is therefore checked here **and** by `order_events_guard_insert()`,
   * which refuses a `balance_reminded` row written by anybody else. Two enforcements because
   * this service is not the only writer — and the database's is the one that would stop a
   * future cron, which would arrive as `system` and be refused.
   *
   * ── The four refusals, and why each is a 409 rather than a silent no-op ────
   *
   *   **not staff** → 403. The company asks for its money; an order cannot ask itself.
   *   **not a live obligation** → 409. A cart has agreed to nothing, and a cancelled or
   *     superseded order's remainder is a refund or a carry-forward — `isLiveOrder` is the one
   *     definition of that and it is mirrored by `order_status_is_live()`.
   *   **nothing outstanding** → 409. Chasing a customer who has paid is the worst thing this
   *     feature can do, and it is the case a stale screen produces: the button was rendered
   *     against a balance a slip settled thirty seconds ago. Hence the lock, then the read.
   *   **too soon** → 409, naming when the next one may go. See
   *     `BALANCE_REMINDER_COOLDOWN_HOURS_DEFAULT` for why there is a cooldown at all and why it
   *     is a refusal a person can read rather than a coalescing window that swallows the press.
   *
   * ── ⛔ Money ───────────────────────────────────────────────────────────────
   *
   * `order.outstandingThbMinor` is `order_outstanding_thb_minor()` computed by Postgres on the
   * row `lockOrFail` locked, inside this transaction. Nothing here adds, subtracts or compares
   * anything to arrive at a second figure; the only arithmetic in this method is `> 0n`.
   *
   * ── What sends the message ─────────────────────────────────────────────────
   *
   * Not this method. It appends one row to `order_events`; `order_events_fan_out_notifications()`
   * turns that into an outbox row in the same transaction, and the worker delivers it. That is
   * plan 10.1's rule and it is why the amount in the *message* is read again at send time — the
   * balance can move between the ask and the delivery, and the customer must be quoted the
   * figure the payment page will show them.
   */
  async remindBalance(scope: Scope, orderId: string): Promise<BalanceReminderWire> {
    const asked = await this.orders.transaction(async (tx) => {
      const actor = requireActor(scope);
      const order = await this.scoped.lockOrFail(tx, scope, orderId, 'act');

      if (actor.actorKind !== 'staff') {
        throw new AppError(
          'FORBIDDEN',
          403,
          'การแจ้งเตือนยอดค้างชำระเป็นสิทธิ์ของเจ้าหน้าที่',
          { actorKind: actor.actorKind },
        );
      }

      /*
       * A cart, a cancellation and a supersession, in one sentence each — the same three the
       * write-off refuses, for the same reason, through the same predicate.
       */
      if (!isLiveOrder(order.status)) {
        throw AppError.conflict('ออเดอร์นี้ไม่มียอดที่ลูกค้าต้องชำระแล้ว จึงแจ้งเตือนไม่ได้', {
          status: order.status,
        });
      }

      const outstandingThbMinor = order.outstandingThbMinor;
      if (outstandingThbMinor <= 0n) {
        throw AppError.conflict('ออเดอร์นี้ไม่มียอดค้างชำระ จึงไม่ต้องแจ้งเตือน', {
          status: order.status,
        });
      }

      /*
       * ⚠️ Read under the row lock taken two lines above, so two clerks pressing at the same
       * moment serialise: the second one sees the first one's event and is refused, rather than
       * both reading "never reminded" and the customer receiving two identical emails.
       */
      const cooldown = await this.orders.balanceReminderCooldown(
        tx,
        order.id,
        BALANCE_REMINDER_COOLDOWN_HOURS_DEFAULT,
      );

      if (cooldown.blocked) {
        /*
         * ─────────────────────────────────────────────────────────────────────
         * ⚠️ TWO SPELLINGS OF ONE INSTANT, AND EACH READER GETS THE RIGHT ONE.
         * ─────────────────────────────────────────────────────────────────────
         *
         * This sentence used to interpolate the column as Postgres printed it —
         * `2026-08-15 19:05:21.28587+00`. Microseconds, a space instead of a `T`, and **UTC**,
         * shown to staff who read Asia/Bangkok: the time on the screen was seven hours before
         * the moment they could actually press the button again, which is a refusal that lies
         * about its own condition. The dashboard's `remindedRecently` branch had been rendering
         * the same fact correctly all along; the API path was the one that had not.
         *
         *   **the sentence** — `formatDateTime`, Thai, `Asia/Bangkok`, Buddhist calendar and a
         *   short time. `@wewin/i18n`'s formatter, defaulting to `BUSINESS_TIME_ZONE`, so this
         *   reads the way every other date a member of staff sees does — and it is formatted
         *   *here* rather than left to the client because this sentence is what the dashboard
         *   shows verbatim (`failureMessage(error)`), and a curl or a log gets it too.
         *
         *   **`details`** — ISO 8601 through `iso()`, the same call every other timestamp on
         *   this API's wire goes through. A client that would rather render for itself now can:
         *   before this, `details.nextAllowedAt` was the one field in the envelope that
         *   `new Date()` could not be trusted with.
         *
         * ⛔ `nextAllowedAt` cannot be null here — `blocked` is true only when Postgres compared
         * a real timestamp against its own `now()` — but it is typed nullable, so the fallback
         * drops the *whole clause* rather than the value inside it. A trailing "หลัง" with
         * nothing after it would be the same defect in a smaller font.
         */
        const when = cooldown.nextAllowedAt;
        const retryClause =
          when === null ? '' : ` — แจ้งซ้ำได้อีกครั้งหลัง ${formatDateTime('th', when)}`;

        throw AppError.conflict(
          `เพิ่งแจ้งเตือนยอดค้างชำระของออเดอร์นี้ไปแล้ว${retryClause}`,
          {
            lastRemindedAt: iso(cooldown.lastAt),
            nextAllowedAt: iso(when),
            cooldownHours: BALANCE_REMINDER_COOLDOWN_HOURS_DEFAULT,
          },
        );
      }

      const eventId = await this.orders.appendEvent(tx, {
        orderId: order.id,
        eventType: 'balance_reminded',
        /* Not a status change: the order stays exactly where it is and the ask is the fact. */
        fromStatus: null,
        toStatus: null,
        actorKind: actor.actorKind,
        actorUserId: actor.actorUserId,
        actorGuestId: actor.actorGuestId,
        /*
         * ⭐ What was owed **when we asked**, stored so it can be read next year.
         *
         * A bare digit string in satang, named `_thb_minor` — the convention every payload
         * amount on this spine follows (`slip_amount_thb_minor`), where the unit is carried by
         * the field name and the dashboard's `SATANG_READERS` is the single place that decides
         * a payload number is money. `order_events_guard_insert()` requires this key, so a
         * reminder with no figure on it is a failed INSERT rather than an unauditable row.
         */
        payload: { outstanding_thb_minor: outstandingThbMinor.toString() },
      });

      const event = await this.orders.findEvent(tx, order.id, eventId);
      if (!event) throw new Error('orders: the reminder event could not be read back');

      return { event, outstandingThbMinor };
    });

    /*
     * ⚠️ After the commit, never inside it. `order_events_fan_out_notifications()` is a
     * DEFERRABLE INITIALLY DEFERRED constraint trigger — it runs at COMMIT — so a read taken
     * inside the transaction above would find nothing and report every reminder as suppressed.
     */
    const fanOut = await this.orders.fanOutFor(asked.event.id);

    return encodeBalanceReminder({
      event: asked.event,
      outstandingThbMinor: asked.outstandingThbMinor,
      fanOut,
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

