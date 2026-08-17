import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from '@wewin/contract/version';
import {
  ORDER_STATUSES_WIRE,
  createChangeRequestSchema,
  createOrderRequestSchema,
  resolveChangeRequestSchema,
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
import { putOrderBillToSchema, type OrderBillToWire } from '@wewin/contract/forfeit';
import type { OrderStatus } from '@wewin/db/schema';

import { ZodBodyPipe } from '../admin/zod-body.pipe';
import { AppError } from '../common/errors/app-error';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import {
  AllowAnonymous,
  CurrentScope,
  RequirePermissions,
  RequirePrincipal,
  serialiseGuestCookie,
  type Scope,
} from '../rbac';
import { BillToService } from './bill-to.service';
import { OrdersService } from './orders.service';

/**
 * The order lifecycle over HTTP.
 *
 * The URL space is the model, and it is worth reading as one thing before any handler:
 *
 *     POST   /orders                                              start a cart
 *     GET    /orders                                              the ones you may see
 *     GET    /orders/:id                                          one of them
 *     GET    /orders/:id/events                                   the spine, in order
 *     GET    /orders/:id/document                                 what was pinned at submit
 *     GET    /orders/:id/cancellation-preview                     what cancelling would cost
 *     POST   /orders/:id/transitions/:toStatus                    **every** move
 *     POST   /orders/:id/change-requests                          the customer objects
 *     POST   /orders/:id/change-requests/:id/resolution           somebody answers
 *
 * ── One transition route, and it is the trap-4 fix ───────────────────────────────
 *
 * There is no `/cancel`, no `/confirm-payment`, no `/bounce`. A route named after an action
 * invites a controller to choose its body schema from its own name, and plan 7.4 trap 4 is
 * exactly that mistake: `cancel` has two rows, split at the freeze, and the pre-freeze schema
 * strips the `fault` the post-freeze one needs. Here the client names only the *destination*,
 * and which body it takes is read from a table row that cannot be found without loading the
 * order. The body is therefore untyped at this layer — `unknown` — and that is deliberate:
 * this controller has no business having an opinion about a shape it cannot yet know.
 *
 * ── There is no route that rejects a payment slip ────────────────────────────────
 *
 * Plan 7.3, and its absence is the design rather than a gap. Confirming the slip that closes
 * the gate instalment is a transition (`awaiting_payment → production_confirmed`); *rejecting*
 * one leaves the order exactly where it was, so making it a transition would require
 * inventing a status that means the same thing as the previous status — "which is poison",
 * in the plan's words. It is a payment-level event, and payments are 5b.
 *
 * ── Why the policies are what they are ───────────────────────────────────────────
 *
 * Every route except one is `RequirePrincipal`: an order belongs to a signed-in user *or* to
 * a guest, both of which can own rows, and neither `RequireAuthenticated` (which locks the
 * guest out of the funnel) nor `RequirePermissions` (a customer holds no permission over
 * their own order) can say that. Which rows a principal may reach is not a question a guard
 * can answer — it has never read the row — so it is answered in the query, by
 * `src/orders/scope`.
 *
 * The exception is `POST /orders`, which is the one route that has to admit somebody with no
 * principal at all: it is where a first-time visitor is given one.
 */

const contractVersion = (): MethodDecorator =>
  Header(CONTRACT_VERSION_HEADER, String(CONTRACT_VERSION));

/**
 * Never stored by anything between here and the browser.
 *
 * Every response on this controller is scoped to one principal, and two of the three ways a
 * caller identifies themselves — the guest cookie and the session cookie — are exactly what a
 * shared cache is entitled to ignore when deciding two requests are the same. A cached order
 * is somebody else's order served to the next person through the proxy.
 */
const privateToTheCaller = (): MethodDecorator => Header('Cache-Control', 'no-store');

/** The signed-in user's id, or `null` for a guest. An audit crumb on the bill-to row. */
const staffUserIdOf = (scope: Scope): string | null =>
  scope.kind === 'user' ? scope.userId : null;

/**
 * How long a cart survives in a browser. 180 days.
 *
 * ⚠️ Not a plan 13 number — the plan does not ask this one, and there is no policy to point
 * at. It is chosen to be longer than the sales cycle for a made-to-measure window (quote,
 * think, measure again, ask a spouse) and shorter than forever, because the cookie is a
 * bearer capability for a cart and an expiry is the only thing that ever revokes an
 * unclaimed one.
 */
const GUEST_COOKIE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

/**
 * The destination, validated before it can reach a query.
 *
 * `:toStatus` is a path segment from an anonymous request and it is compared against a
 * `text` column, so an unknown value must be a 400 here rather than a lookup that finds
 * nothing and reports it as a conflict. The list is the contract's, so a status added to one
 * package and not the other fails the drift test rather than this parse.
 */
const toStatusSchema = z.literal(ORDER_STATUSES_WIRE);

/**
 * `GET /orders`'s query — two filters on two axes, and a ceiling.
 *
 * ── ⭐ Why `payment` is its own parameter and not a ninth `status` ────────────────
 *
 * "Which orders still owe money" reads like a status and is not one. Three reasons, in the
 * order they bite:
 *
 *   ⓵ **`status`'s values are `ORDER_STATUSES_WIRE`, and that list is pinned.** It is the
 *     contract's copy of the Postgres enum, and `tests/orders/contract-drift.pg.test.ts`
 *     fails if the two disagree. A pseudo-value `owing` in this parameter would mean widening
 *     `z.literal(ORDER_STATUSES_WIRE)` to a list that is no longer that list — a second
 *     vocabulary inside the parameter whose whole virtue is having one.
 *
 *   ⓶ **They compose, and a repeatable parameter makes its values alternatives.**
 *     `?status=in_production&status=delivered` means *either*. "In production **and** owing" is
 *     the question a production manager actually asks, and it is unaskable if owing is one more
 *     value in the same OR. Two parameters are ANDed by the repository, so
 *     `?status=in_production&payment=outstanding` is a sentence.
 *
 *   ⓷ **They are answered by different things.** A status is a column; owing is a fold over
 *     `payment_slips` and `order_instalments`. Nothing about the money question is in
 *     `orders.status`, and putting it there in the URL is how it ends up there in the query.
 *
 * So: the *shape* is the status filter's, exactly as the brief requires — a named parameter of
 * declared values, absent (here: `all`) meaning no restriction, parsed by this schema, carried
 * as an option, turned into one more `and` term in the same single statement. What is not
 * borrowed is repeatability, which this axis has no use for.
 *
 * ── ⚠️ Named values, not a boolean ───────────────────────────────────────────────
 *
 * `?payment=outstanding`, never `?owing=true`. `slips.contract.ts` has the argument in full and
 * it was learned here: `z.coerce.boolean()` turns the *string* `"false"` into `true`, so a
 * boolean in a query string is the one flag that reliably means the opposite of what was typed.
 * Two named values cannot do that, and they leave room for the value nobody has asked for yet
 * (`settled`) without a second parameter appearing beside this one.
 */
const listQuerySchema = z.object({
  /** Repeatable: `?status=draft&status=awaiting_payment`. Absent means every status. */
  status: z
    .union([z.literal(ORDER_STATUSES_WIRE), z.array(z.literal(ORDER_STATUSES_WIRE))])
    .optional(),
  /**
   * `outstanding` keeps only the orders that still owe money — live, and folding above zero.
   *
   * Ordering comes with it rather than from a `sort` parameter: the answer arrives biggest debt
   * first. `ScopedOrderRepository.list` argues that out, and `OWING_ORDERS` defines "owes".
   */
  payment: z.enum(['all', 'outstanding']).default('all'),
  /** A ceiling rather than a page, until somebody needs a cursor. */
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

type ListQuery = z.infer<typeof listQuerySchema>;

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    /*
     * `COOKIE_SECURE` and not `RBAC_OPTIONS`: the guard's options are that module's private
     * wiring and are not exported, while the flag itself is one value across the whole
     * process (`app.module.ts` hands the same `env.COOKIE_SECURE` to `RbacModule`). Reading
     * it from the same place the reader was configured from is what stops the writer here
     * and the reader there drifting into two cookie profiles — which would silently disable
     * `__Host-`, since a sibling subdomain cannot set `__Host-wewin_guest` but can set the
     * bare name.
     */
    @Inject(ENV) private readonly env: Env,
    private readonly billToService: BillToService,
  ) {}

  /**
   * Start a cart.
   *
   * `AllowAnonymous` and not `RequirePrincipal`, and the reason is the one sentence that
   * justifies the whole policy split: **this is the route that mints the principal.** A
   * first-time visitor has no session and no guest cookie, and refusing them here would mean
   * the anonymous funnel could never start — plan section 6 calls that funnel the main path,
   * and plan 10.2 says the ask for a contact channel happens once, later, at submit.
   *
   * It is safe to be anonymous because of what it does: it creates a row *owned by the
   * caller* and reads nothing. There is no id in the request to point at somebody else's
   * order, which is what makes it different from every other route in this file.
   */
  @Post()
  @HttpCode(201)
  @contractVersion()
  @AllowAnonymous(
    'the funnel starts here: this route mints the guest that owns the cart, creates a row owned by the caller and reads none',
  )
  async create(
    @CurrentScope() scope: Scope,
    @Body(new ZodBodyPipe(createOrderRequestSchema)) body: CreateOrderRequestWire,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OrderWire> {
    const { order, mintedGuest } = await this.orders.createDraft(scope, body);

    if (mintedGuest !== null) {
      /*
       * Set only when one was minted. Re-issuing the cookie on every cart would refresh the
       * expiry of a capability the caller already holds, which is harmless, and would also
       * overwrite a *claimed* guest's cookie with itself — a row `isOpenGuest` now refuses,
       * so the browser would keep sending a credential that no longer works.
       */
      response.setHeader(
        'Set-Cookie',
        serialiseGuestCookie(mintedGuest, {
          cookieSecure: this.env.COOKIE_SECURE,
          maxAgeSeconds: GUEST_COOKIE_MAX_AGE_SECONDS,
        }),
      );
    }

    /* A cart is per-browser and per-principal; a shared cache serving one to somebody else is a cart handed over. */
    response.setHeader('Cache-Control', 'no-store');
    return order;
  }

  @Get()
  @contractVersion()
  @privateToTheCaller()
  @RequirePrincipal()
  async list(
    @CurrentScope() scope: Scope,
    @Query(new ZodBodyPipe(listQuerySchema)) query: ListQuery,
  ): Promise<OrderListWire> {
    const statuses = query.status === undefined ? undefined : [query.status].flat();
    return this.orders.listOrders(scope, {
      ...(statuses === undefined ? {} : { statuses: statuses as readonly OrderStatus[] }),
      /*
       * Spread-when-present, the same way `statuses` above is, because
       * `exactOptionalPropertyTypes` makes `owing: undefined` a different thing from an absent
       * key — and because the repository reads absence as "the caller did not ask".
       */
      ...(query.payment === 'outstanding' ? { owing: true } : {}),
      limit: query.limit,
    });
  }

  @Get(':orderId')
  @contractVersion()
  @privateToTheCaller()
  @RequirePrincipal()
  async byId(@CurrentScope() scope: Scope, @Param('orderId') orderId: string): Promise<OrderWire> {
    return this.orders.getOrder(scope, orderId);
  }

  /**
   * The spine, oldest first.
   *
   * Served to the customer as well as to staff, and that is a decision: "what happened to my
   * order and when" is the question the company otherwise answers by telephone, and every row
   * here was written by the transition that caused it. `fault` and `absorbed_delta_thb_minor`
   * are precisely the numbers a customer is entitled to see the basis of.
   *
   * ⚠️ The consequence, stated because it is a policy question and not a technical one: the
   * `reason` a member of staff types on a cancellation or a bounce is **visible to the
   * customer**. That is the symmetric case of plan 7.9(ค) — sales prose must not reach the
   * production sheet — and nobody has ruled on it. If internal notes are wanted, they need a
   * separate field that this endpoint filters, not a habit of writing them somewhere else.
   */
  @Get(':orderId/events')
  @contractVersion()
  @privateToTheCaller()
  @RequirePrincipal()
  async events(
    @CurrentScope() scope: Scope,
    @Param('orderId') orderId: string,
  ): Promise<OrderEventListWire> {
    return this.orders.listEvents(scope, orderId);
  }

  /**
   * What was frozen at submit — trap 3's pin, as the customer saw it — beside who is
   * offering it, read live.
   *
   * ⚠️ `seller` sits beside `document`, never inside it. See `OrderDocumentResponseWire`:
   * the pinned half's shape does not move, and the live half is a fresh read of
   * `organisation_profile` on every call.
   */
  @Get(':orderId/document')
  @contractVersion()
  @privateToTheCaller()
  @RequirePrincipal()
  async document(
    @CurrentScope() scope: Scope,
    @Param('orderId') orderId: string,
  ): Promise<OrderDocumentResponseWire> {
    return this.orders.getDocument(scope, orderId);
  }

  /**
   * How much is owed, and where to send it.
   *
   * ⚠️ Ownership-scoped rather than a public account list, for two reasons. There is no
   * reason to publish the company's account numbers to callers with no order — and P2 makes
   * the accounts vary by destination country, which this shape absorbs without changing the
   * endpoint.
   */
  @Get(':orderId/payment-instructions')
  @contractVersion()
  @privateToTheCaller()
  @RequirePrincipal()
  async paymentInstructions(
    @CurrentScope() scope: Scope,
    @Param('orderId') orderId: string,
  ): Promise<PaymentInstructionsWire> {
    return this.orders.paymentInstructions(scope, orderId);
  }

  /**
   * What cancelling would cost, before anybody cancels.
   *
   * A `GET` beside `payment-instructions` and for the same reason: it is an ownership-scoped
   * read *about* one order that is not a field of the order. It is deliberately **not** on
   * `OrderWire` — pricing a cancellation needs a pinned forfeit policy and raises without one,
   * so folding it into the order response would make every order read able to fail over a
   * question nobody asked. Here it fails only when a cancellation is actually being considered.
   *
   * Reachable by the customer and the guest whose order it is, which is the whole point: the
   * storefront's cancel button reads its figure from here.
   */
  @Get(':orderId/cancellation-preview')
  @contractVersion()
  @privateToTheCaller()
  @RequirePrincipal()
  async cancellationPreview(
    @CurrentScope() scope: Scope,
    @Param('orderId') orderId: string,
  ): Promise<CancellationPreviewWire> {
    return this.orders.previewCancellation(scope, orderId);
  }

  /**
   * Every legal move, through one door.
   *
   * The body arrives as `unknown` and is parsed inside the service, *after* the order has
   * been loaded and locked. That is not laziness about typing — it is the fix for plan 7.4
   * trap 4, and moving the parse up here with a `@Body(new ZodBodyPipe(…))` would reinstate
   * the trap in its original form: a schema chosen from the route, before the from-status is
   * known, silently stripping the field that decides a refund.
   */
  @Post(':orderId/transitions/:toStatus')
  /* 200 and not Nest's default 201: a transition changes an order that already exists. */
  @HttpCode(200)
  @contractVersion()
  @RequirePrincipal()
  async transition(
    @CurrentScope() scope: Scope,
    @Param('orderId') orderId: string,
    @Param('toStatus') toStatus: string,
    @Body() body: unknown,
  ): Promise<OrderWire> {
    const parsed = toStatusSchema.safeParse(toStatus);
    if (!parsed.success) {
      throw AppError.badRequest('ไม่รู้จักสถานะปลายทางที่ขอ', { toStatus });
    }

    return this.orders.transition(scope, orderId, parsed.data, body);
  }

  /**
   * ⭐ ออกใบเสนอราคาใหม่ — send the edited quote to the customer.
   *
   * Here rather than on `QuotesController`, whose prefix this path sits under, because the work
   * is `OrdersService`'s: it prices, pins a document, moves the order's totals and replaces the
   * schedule. Injecting `OrdersService` into that controller would close a module cycle —
   * `OrdersService` already depends on `QuotesService` — and the alternative, moving the pin
   * into the quotes module, would put two services in the business of writing `orders`.
   *
   * `quotes.write` and not just `orders.write`: this is the last step of an edit, and whoever
   * may not change a quote may not decide which version of it the customer is billed for.
   *
   * 200 and not 201 — the same order, re-quoted. Nothing is created that a client could go and
   * fetch at a new address.
   */
  @Post(':orderId/quote/reissue')
  @HttpCode(200)
  @contractVersion()
  @RequirePermissions('quotes.write', 'orders.read', 'orders.write')
  async reissueQuote(
    @CurrentScope() scope: Scope,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
  ): Promise<OrderWire> {
    return this.orders.reissueQuote(scope, orderId, body);
  }

  /**
   * ⭐ การระบุยอดมัดจำ — the deposit for this order.
   *
   * `PUT` rather than `POST`: the share is a property of the order and setting it twice leaves
   * the same order, which is what idempotent means here. The schedule is re-cut as a
   * consequence, and that is a consequence rather than a second request — one number decides
   * both, and two endpoints could disagree about which was authoritative.
   *
   * `quotes.write` alongside the order grants, like the re-issue: whoever may not change what
   * the customer is quoted may not change what they are asked for up front either.
   */
  @Put(':orderId/deposit')
  @HttpCode(200)
  @contractVersion()
  @RequirePermissions('quotes.write', 'orders.read', 'orders.write')
  async setDeposit(
    @CurrentScope() scope: Scope,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
  ): Promise<OrderWire> {
    return this.orders.setDeposit(scope, orderId, body);
  }

  /**
   * ⭐ ผู้ซื้อ — the name, address and tax id a tax document is made out to.
   *
   * `RequirePrincipal` and not a permission, because it is the customer's own detail as much as
   * staff's: somebody at the counter dictates it to a salesperson, and somebody at home types it
   * themselves. Which rows either may touch is `orderReach`'s answer, not a guard's.
   */
  @Get(':orderId/bill-to')
  @contractVersion()
  @privateToTheCaller()
  @RequirePrincipal()
  async billTo(
    @CurrentScope() scope: Scope,
    @Param('orderId') orderId: string,
  ): Promise<OrderBillToWire | null> {
    return this.billToService.read(scope, orderId);
  }

  @Put(':orderId/bill-to')
  @HttpCode(200)
  @contractVersion()
  @privateToTheCaller()
  @RequirePrincipal()
  async putBillTo(
    @CurrentScope() scope: Scope,
    @Param('orderId') orderId: string,
    @Body(new ZodBodyPipe(putOrderBillToSchema)) body: Omit<OrderBillToWire, 'updatedAt'>,
  ): Promise<OrderBillToWire> {
    /*
     * ⚠️ `null` for a guest, which is most walk-ins: the column records *which member of staff*
     * last touched it, and a guest is not one. It is an audit crumb, not an owner.
     */
    return this.billToService.write(scope, orderId, body, staffUserIdOf(scope));
  }

  /**
   * The customer objects — plan 10.4.
   *
   * Reachable by the customer and the guest because it is theirs to raise; while it is open
   * the order cannot enter `production_confirmed`, which is what makes it a button that does
   * something rather than a form that files a feeling.
   */
  @Post(':orderId/change-requests')
  @HttpCode(201)
  @contractVersion()
  @RequirePrincipal()
  async openChangeRequest(
    @CurrentScope() scope: Scope,
    @Param('orderId') orderId: string,
    @Body(new ZodBodyPipe(createChangeRequestSchema)) body: CreateChangeRequestWire,
  ): Promise<ChangeRequestWire> {
    return this.orders.openChangeRequest(scope, orderId, body);
  }

  /**
   * …and somebody answers it — the other half of trap 5.
   *
   * `accepted` and `rejected` are staff answers; `withdrawn` is the customer taking it back.
   * Without this route the partial unique index that allows one open request at a time *is*
   * the bug it was meant to prevent: the first objection would block every later one for the
   * life of the order.
   */
  /**
   * ⭐ แจ้งเตือนยอดค้างชำระ — ask the customer for the outstanding balance.
   *
   *     POST /orders/:orderId/balance-reminders
   *
   * ── Why a resource of its own and not a transition ────────────────────────────
   *
   * Because nothing moves. `POST /orders/:id/transitions/:toStatus` is keyed on a destination
   * status and answers with an `OrderWire` because the order is different afterwards; this
   * order is identical afterwards in every field. What it gains is a row on the spine, so the
   * response is that row (`BalanceReminderWire`) and not a re-read of an unchanged order.
   *
   * ── ⚠️ 201, and what was created ──────────────────────────────────────────────
   *
   * The `order_events` row. It is a real, citable, append-only record of an ask a member of
   * staff made, and it exists whether or not a message ever leaves the building — which is
   * exactly why the response also says whether one was queued.
   *
   * ── The permissions, and why no new code ──────────────────────────────────────
   *
   * `orders.read` + `orders.write` + `payments.read`.
   *
   *   `orders.write`   this **writes to an order** — a row on its append-only spine.
   *   `payments.read`  the message it causes **names a balance**, so somebody who may not read
   *                    ค้างชำระ must not be able to have it emailed to a customer on their
   *                    behalf. Same pairing the write-off request declares, for the same reason.
   *   `orders.read`    ⚠️ not redundant beside `orders.write`, and not belt-and-braces: it is
   *                    what the *row* reaches by. `order-reach.ts` widens a staff caller to
   *                    every order only when they hold **both** codes, having found that
   *                    `orders.write` alone produced "may act on every order in the company
   *                    while being unable to look at any of them". Without it here the route
   *                    would answer 404 on every order but the caller's own — a decorator
   *                    promising something the loader underneath it refuses.
   *
   * ⚠️ Deliberately **not** a new permission. A new code is warranted when an act carries an
   * authority nobody has granted — `payments.write_off` forgives cash, `quotes.approve`
   * decides. Asking a customer for money they already contracted to pay grants nobody anything:
   * it moves no balance, changes no status, and creates no obligation on anybody in this
   * company. Inventing a code for it would mean shipping a route that nobody can use until the
   * owner grants something, for an act that needs no permission the collections clerk chasing
   * the debt does not already hold.
   *
   * ⚠️ And it is **not** reachable by the customer, whatever token they hold: `remindBalance`
   * refuses a non-staff actor with a 403, and `order_events_guard_insert()` refuses the row
   * underneath it. `RequirePermissions` is the outer gate; neither of the two inner ones is
   * redundant, because this service is not the only writer to that table.
   */
  @Post(':orderId/balance-reminders')
  @HttpCode(201)
  @contractVersion()
  @privateToTheCaller()
  @RequirePermissions('orders.read', 'orders.write', 'payments.read')
  async remindBalance(
    @CurrentScope() scope: Scope,
    @Param('orderId') orderId: string,
  ): Promise<BalanceReminderWire> {
    /*
     * No body at all, and no schema for one. There is nothing to say: the amount is the
     * server's (`order_outstanding_thb_minor()`), the recipient is the order's, the language is
     * the recipient's and the wording is `notification_rules`'. A body would be a place for one
     * of those four to be overridden by a client — which is the shape
     * `authority.contract.ts` refuses at length for the amount on an approval request.
     */
    return this.orders.remindBalance(scope, orderId);
  }

  @Post(':orderId/change-requests/:changeRequestId/resolution')
  @HttpCode(200)
  @contractVersion()
  @RequirePrincipal()
  async resolveChangeRequest(
    @CurrentScope() scope: Scope,
    @Param('orderId') orderId: string,
    @Param('changeRequestId') changeRequestId: string,
    @Body(new ZodBodyPipe(resolveChangeRequestSchema)) body: ResolveChangeRequestWire,
  ): Promise<ChangeRequestWire> {
    return this.orders.resolveChangeRequest(scope, orderId, changeRequestId, body);
  }
}
