import { Body, Controller, Get, Header, HttpCode, Param, Post } from '@nestjs/common';
import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from '@wewin/contract/version';
import type { QuoteWire } from '@wewin/contract/quote';

import { CurrentScope, RequirePermissions, RequirePrincipal, type Scope } from '../rbac';
import { QuotesService } from './quotes.service';

/**
 * The sales-editable quote over HTTP — phase 5c.
 *
 * The URL space is the model, and it is worth reading as one thing before any handler:
 *
 *     GET    /orders/:id/quote                                  the effective quote
 *     POST   /orders/:id/quote/lines                            add a configured line
 *     POST   /orders/:id/quote/charges                          add a free-form line
 *     POST   /orders/:id/quote/lines/:lineId/revision           change what a line IS
 *     POST   /orders/:id/quote/lines/:lineId/presentation       change what the customer READS
 *     POST   /orders/:id/quote/lines/:lineId/removal            take it off the quote
 *     POST   /orders/:id/quote/overrides                        set a figure a human decided
 *     POST   /orders/:id/quote/overrides/:id/revocation         withdraw one
 *     POST   /orders/:id/quote/verification                     the submit gate, as a screen
 *
 * ── `revision` and `presentation` are two routes, and that is plan 7.9(ค)'s ⚠️ ────
 *
 * One writes the fields a works order renders from — quantity, options, measurements, and the
 * sku they derive. The other writes the sentence the customer reads. Sales can put "กระจก
 * เทมเปอร์ 8 มม." on a line whose sku says T6, and that is *allowed*; what must never happen
 * is that sentence reaching the factory. Two routes make the boundary something a reviewer can
 * see in a diff, and they are two different things to grant a permission over on the day
 * somebody wants a junior who may reword a quote but not re-measure it.
 *
 * ── `removal` and `revocation` are POSTs, not DELETEs ────────────────────────────
 *
 * Neither deletes anything. A line on a submitted quote is stamped, not removed, and an
 * override is *never* deleted — `quote_overrides` is append-only and supersession is the one
 * exception. A `DELETE` verb over an append-only table is a verb somebody will eventually
 * implement literally. It also lets both carry a body, which they must: every write in this
 * feature carries the precondition (plan 7.9(จ)), and a `DELETE` with a body is a request half
 * the intermediaries on the path are entitled to mangle.
 *
 * ── Why the bodies arrive as `unknown` ───────────────────────────────────────────
 *
 * Same reason as `OrdersController.transition`, and it is plan 7.4 trap 4: the body is parsed
 * inside the service, *after* the order has been loaded and locked. Moving the parse up here
 * with a `@Body(new ZodBodyPipe(…))` would be the habit that trap punishes — and there is one
 * request here where the shape of the *write* really does depend on the locked row, namely
 * whether a removal is a `DELETE` or a stamp.
 *
 * ── Why the writes ask for three permissions ─────────────────────────────────────
 *
 * `quotes.write` is the feature. `orders.read` + `orders.write` are what `orderReach` requires
 * before a member of staff reaches an order that is not their own — and without them the
 * scoped load answers **404**, correctly and unhelpfully, because a 404 is the only honest
 * answer to "an order you cannot see". Naming all three on the route turns that into a 403
 * that says which grant is missing, which is the difference between an administrator adding a
 * permission and a support thread that starts with "it says not found".
 */

const contractVersion = (): MethodDecorator =>
  Header(CONTRACT_VERSION_HEADER, String(CONTRACT_VERSION));

/**
 * Never stored by anything between here and the browser.
 *
 * Every response here is scoped to one principal and every one of them carries prices for one
 * customer. A cached quote is somebody else's negotiation served to the next person through
 * the proxy — and on the sales view, somebody else's *concession* and the ceiling it was
 * measured against.
 */
const privateToTheCaller = (): MethodDecorator => Header('Cache-Control', 'no-store');

/** The three grants a quote write needs. Written once so no route can carry a shorter list. */
const RequireQuoteWrite = (): MethodDecorator =>
  RequirePermissions('quotes.write', 'orders.read', 'orders.write');

@Controller('orders/:orderId/quote')
export class QuotesController {
  constructor(private readonly quotes: QuotesService) {}

  /**
   * The quote as it stands, with the money `applyOverrides` produces.
   *
   * `RequirePrincipal` and not `quotes.read`, because a customer is entitled to see what they
   * are being quoted — the same decision `GET /orders/:id/events` makes about the spine. What
   * a customer does **not** get is the `sales` block: the overrides, their reason codes and
   * notes, the concession and the authority ceiling. That is derived from `quotes.read`, which
   * is a permission the caller demonstrably holds, and never from anything on the request.
   */
  @Get()
  @contractVersion()
  @privateToTheCaller()
  @RequirePrincipal()
  async quote(@CurrentScope() scope: Scope, @Param('orderId') orderId: string): Promise<QuoteWire> {
    return this.quotes.getQuote(scope, orderId);
  }

  @Post('lines')
  @HttpCode(201)
  @contractVersion()
  @privateToTheCaller()
  @RequireQuoteWrite()
  async addLine(
    @CurrentScope() scope: Scope,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
  ): Promise<QuoteWire> {
    return this.quotes.addCatalogLine(scope, orderId, body);
  }

  /**
   * Delivery, installation, a survey, a goodwill credit — plan 7.9(ค)'s "แถวใหม่".
   *
   * A route of its own rather than a `kind` field on the one above, because the two requests
   * have nothing in common: one carries a catalogue handle and no money, the other carries
   * money and no catalogue handle. A single endpoint would need a discriminated union whose
   * only purpose was to be split again immediately.
   */
  @Post('charges')
  @HttpCode(201)
  @contractVersion()
  @privateToTheCaller()
  @RequireQuoteWrite()
  async addCharge(
    @CurrentScope() scope: Scope,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
  ): Promise<QuoteWire> {
    return this.quotes.addFreeformLine(scope, orderId, body);
  }

  /** What the line *is*. The works order renders from these fields and from no others. */
  @Post('lines/:lineId/revision')
  @HttpCode(200)
  @contractVersion()
  @privateToTheCaller()
  @RequireQuoteWrite()
  async reviseLine(
    @CurrentScope() scope: Scope,
    @Param('orderId') orderId: string,
    @Param('lineId') lineId: string,
    @Body() body: unknown,
  ): Promise<QuoteWire> {
    return this.quotes.reviseLine(scope, orderId, lineId, body);
  }

  /** 📣 What the customer *reads*. Never rendered onto a production sheet — plan 7.9(ค). */
  @Post('lines/:lineId/presentation')
  @HttpCode(200)
  @contractVersion()
  @privateToTheCaller()
  @RequireQuoteWrite()
  async presentLine(
    @CurrentScope() scope: Scope,
    @Param('orderId') orderId: string,
    @Param('lineId') lineId: string,
    @Body() body: unknown,
  ): Promise<QuoteWire> {
    return this.quotes.presentLine(scope, orderId, lineId, body);
  }

  @Post('lines/:lineId/removal')
  @HttpCode(200)
  @contractVersion()
  @privateToTheCaller()
  @RequireQuoteWrite()
  async removeLine(
    @CurrentScope() scope: Scope,
    @Param('orderId') orderId: string,
    @Param('lineId') lineId: string,
    @Body() body: unknown,
  ): Promise<QuoteWire> {
    return this.quotes.removeLine(scope, orderId, lineId, body);
  }

  /**
   * ⭐ Set a figure a human decided.
   *
   * The body carries what was typed and the box it was typed into, and **no money the server
   * would otherwise have computed**. Replacing an existing promise is this same request again.
   */
  @Post('overrides')
  @HttpCode(201)
  @contractVersion()
  @privateToTheCaller()
  @RequireQuoteWrite()
  async setOverride(
    @CurrentScope() scope: Scope,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
  ): Promise<QuoteWire> {
    return this.quotes.setOverride(scope, orderId, body);
  }

  @Post('overrides/:overrideId/revocation')
  @HttpCode(200)
  @contractVersion()
  @privateToTheCaller()
  @RequireQuoteWrite()
  async revokeOverride(
    @CurrentScope() scope: Scope,
    @Param('orderId') orderId: string,
    @Param('overrideId') overrideId: string,
    @Body() body: unknown,
  ): Promise<QuoteWire> {
    return this.quotes.revokeOverride(scope, orderId, overrideId, body);
  }

  /**
   * Re-verify every promise against today's catalogue — plan 7.9(จ), as a screen.
   *
   * 200 with the quote when it is clean, `409` listing every affected line when it is not.
   * ⚠️ This is the *same check* the submit has to make and is not a substitute for it: a
   * publish can land in the seconds between this call and the submit, and a gate a client can
   * choose not to call is not a gate. See the seam in `index.ts`.
   */
  @Post('verification')
  @HttpCode(200)
  @contractVersion()
  @privateToTheCaller()
  @RequireQuoteWrite()
  async verify(
    @CurrentScope() scope: Scope,
    @Param('orderId') orderId: string,
  ): Promise<QuoteWire> {
    return this.quotes.verify(scope, orderId);
  }
}
