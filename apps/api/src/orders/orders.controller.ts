import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
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
  type ChangeRequestWire,
  type CreateChangeRequestWire,
  type CreateOrderRequestWire,
  type OrderDocumentWire,
  type OrderEventListWire,
  type OrderListWire,
  type OrderWire,
  type ResolveChangeRequestWire,
} from '@wewin/contract/order';
import type { PaymentInstructionsWire } from '@wewin/contract/organisation';
import type { OrderStatus } from '@wewin/db/schema';

import { ZodBodyPipe } from '../admin/zod-body.pipe';
import { AppError } from '../common/errors/app-error';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import {
  AllowAnonymous,
  CurrentScope,
  RequirePrincipal,
  serialiseGuestCookie,
  type Scope,
} from '../rbac';
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

const listQuerySchema = z.object({
  /** Repeatable: `?status=draft&status=awaiting_payment`. Absent means every status. */
  status: z
    .union([z.literal(ORDER_STATUSES_WIRE), z.array(z.literal(ORDER_STATUSES_WIRE))])
    .optional(),
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

  /** What was frozen at submit — trap 3's pin, as the customer saw it. */
  @Get(':orderId/document')
  @contractVersion()
  @privateToTheCaller()
  @RequirePrincipal()
  async document(
    @CurrentScope() scope: Scope,
    @Param('orderId') orderId: string,
  ): Promise<OrderDocumentWire> {
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
