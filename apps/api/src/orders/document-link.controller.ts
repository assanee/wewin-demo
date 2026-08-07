import { Controller, Get, Header, Inject, Param } from '@nestjs/common';
import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from '@wewin/contract/version';

import { AllowAnonymous, RequirePermissions } from '../rbac';
import { AppError } from '../common/errors/app-error';
import { message } from '../i18n';
import {
  DocumentLinkService,
  WEB_BASE_URL,
  documentLinkUrl,
  gone,
  type LinkedDocumentWire,
} from './document-link';
import { DocumentLinkReader } from './document-link.reader';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The emailed quotation link — the **only** place a document token is honoured.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * One route, its own file, its own module. `document-link.ts` promises that the token is
 * read-only and names one order; both properties are true only for as long as nothing else
 * verifies one. A grep for `DocumentLinkService` should find the issuer, the worker that puts
 * a link in an email, this file, and nothing else.
 *
 * ⚠️ The read-only half is **structural** rather than a promise: `DocumentLinkModule` cannot
 * reach `OrdersService`, so there is no transition, no price and no cancellation within reach
 * of a handler somebody adds here next year. See that module's note for what the first
 * attempt got wrong and how the route audit caught it.
 *
 * ── Why the reply is always 404 ──────────────────────────────────────────────
 *
 * Bad signature, expired, unknown order, an order with no pinned document: one answer. The
 * reasoning is `scoped-order.repository.ts`'s, applied to a stranger instead of a logged-in
 * caller — distinguishable failures would let somebody holding one valid link learn things
 * about ids they do not hold, and "your link has expired" versus "no such order" is exactly
 * that oracle in a friendly voice.
 *
 * ⚠️ The cost is a worse support conversation than the one this feature fixes, and it is
 * accepted with open eyes: a customer whose link is six months old sees the same page as one
 * whose link was mistyped. Staff hold `orders.read` and can see which it is.
 */
@Controller('orders/documents')
export class DocumentLinkController {
  constructor(
    private readonly links: DocumentLinkService,
    private readonly reader: DocumentLinkReader,
  ) {}

  /**
   * The pinned quotation, for whoever holds the link.
   *
   * ⚠️ **`verified.orderId`, never a parameter.** The id comes out of the signature and out
   * of nothing else. A handler that took `:orderId` from the path and merely *checked* a
   * signature beside it would serve any order to anybody holding one valid token, and the
   * two shapes read almost identically in a diff.
   */
  @Get(':token')
  @AllowAnonymous(
    'the customer we email has no account and no cookie on the device they read mail on; ' +
      'the signed token in the link is the authorisation, it names exactly one order, and ' +
      'this is the only route that honours one',
  )
  @Header(CONTRACT_VERSION_HEADER, String(CONTRACT_VERSION))
  /*
   * ⚠️ `private` and not `public`, though there is no cookie. The URL *is* the credential, so
   * a shared cache keyed on it would hand one customer's quotation to the next person behind
   * the same proxy. `no-store` would be tidier still and would also stop the browser's own
   * back button from working on a page somebody is reading.
   */
  @Header('Cache-Control', 'private, no-cache')
  /* A quotation link in a customer's inbox has no business being followed by a crawler. */
  @Header('X-Robots-Tag', 'noindex, nofollow')
  async byLink(@Param('token') token: string): Promise<LinkedDocumentWire> {
    const verified = this.links.verify(token);
    if (!verified.ok) throw gone();

    return this.reader.byLink(verified.orderId);
  }

}

/** What the dashboard shows beside "copy". */
export interface CustomerLinkWire {
  readonly url: string;
  /** ISO 8601. Six months out — see `DOCUMENT_LINK_TTL_SECONDS`. */
  readonly expiresAt: string;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE SAME LINK, FOR A MEMBER OF STAFF TO SEND BY HAND.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * An order carrying a telephone number and no address satisfies
 * `orders_submitted_has_a_contact_channel` and still receives **nothing**: the fan-out
 * resolves recipients for email alone and files every other channel as `channel_disabled`.
 *
 * This is how that gap is survived rather than hidden. Staff copy the link and paste it into
 * LINE — which is where Thai customers read things anyway (plan 10.2) — and the customer gets
 * the same quotation, opened the same way, verified by the same signature.
 *
 * ⚠️ It is a **separate controller with a separate policy**, and the split is the point.
 * `orders/documents/:token` is `AllowAnonymous` because the token is the credential; this
 * route mints one from an id, so it must be the other thing entirely.
 */
@Controller('orders')
export class CustomerLinkController {
  constructor(
    private readonly links: DocumentLinkService,
    private readonly reader: DocumentLinkReader,
    @Inject(WEB_BASE_URL) private readonly webBaseUrl: string | undefined,
  ) {}

  /**
   * ⚠️ `orders.read`, and not `RequirePrincipal`.
   *
   * A principal policy would be wrong in a way that is easy to miss: it would admit the
   * customer — harmless, they already hold the link — *and* every other signed-in person,
   * because the token is minted from whatever id is in the path rather than from anything
   * about the caller. That is one authenticated stranger away from every quotation the
   * company has issued.
   */
  @Get(':orderId/customer-link')
  @RequirePermissions('orders.read')
  @Header(CONTRACT_VERSION_HEADER, String(CONTRACT_VERSION))
  @Header('Cache-Control', 'no-store')
  async customerLink(@Param('orderId') orderId: string): Promise<CustomerLinkWire> {
    if (this.webBaseUrl === undefined) {
      throw AppError.conflict(message('error.order.storefront_not_configured'));
    }

    /*
     * ⚠️ Loaded before the token is minted, so an unsubmitted or unknown order answers 404
     * rather than handing back a working-looking URL that resolves to nothing. A link that
     * looks right and 404s at the customer is worse than a refusal at the desk.
     */
    const linked = await this.reader.byLink(orderId);

    const { token, expiresAt } = this.links.issue(orderId);

    return {
      /*
       * The document's **pinned** locale, not the reader's. The member of staff copying this
       * is Thai and the customer may not be — and it is the customer who opens it.
       */
      url: documentLinkUrl(this.webBaseUrl, linked.document.pinnedLocale, token),
      expiresAt: expiresAt.toISOString(),
    };
  }
}
