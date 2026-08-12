import { Injectable } from '@nestjs/common';
import { encodeThb } from '@wewin/contract/order';

import { encodeProfile } from '../organisation/encode';
import { OrganisationRepository } from '../organisation/organisation.repository';
import { systemScope } from '../rbac';
import { gone, type LinkedDocumentWire } from './document-link';
import { OrderRepository } from './order.repository';
import { ScopedOrderRepository } from './scope';

/**
 * The one read behind an emailed quotation link.
 *
 * ⚠️ **`systemScope` here is not a widening of anybody's reach.** The caller's reach is
 * exactly one order and it was fixed before this method was entered: `DocumentLinkController`
 * verified an HMAC over `orderId`, and the id passed in came out of that signature. Applying
 * an ownership filter on top would ask "which browser is this?", which is the question that
 * has no answer on the phone somebody reads their email on — and is the whole reason this path
 * exists.
 *
 * ⚠️ It serves the **current** pinned document, not the revision that existed when the link
 * was minted. That is deliberate and `order.quote_revised.customer` depends on it: the message
 * tells a customer their quotation has changed, and the link in it has to show the change
 * rather than the version they have already seen.
 *
 * Every refusal is the same 404 — `gone()` says why.
 */
@Injectable()
export class DocumentLinkReader {
  constructor(
    private readonly scoped: ScopedOrderRepository,
    private readonly orders: OrderRepository,
    /**
     * Fix round 1: the same read `OrdersService.getDocument` makes through the same
     * repository, for the same reason — `seller` is beside the pinned document and is read
     * live, on every call, never pinned. See `document-link.module.ts` for why importing
     * `OrganisationModule` here is safe: it is a plain `@Module`, already imported from two
     * other places in this graph, and Nest deduplicates a static module by class reference
     * rather than instantiating it again — there is no `forRoot` here to collide with.
     */
    private readonly organisation: OrganisationRepository,
  ) {}

  async byLink(orderId: string): Promise<LinkedDocumentWire> {
    const order = await this.scoped.find(systemScope('emailed quotation link'), orderId, 'read');
    if (!order || order.documentId === null) throw gone();

    const [document, [profile]] = await Promise.all([
      this.orders.findDocumentById(order.documentId),
      this.organisation.profile(),
    ]);
    /*
     * ⚠️ `gone()` for both, on purpose — the class-level rule above ("every refusal is the
     * same 404") is stricter here than in `OrdersService.getDocument`, because that route is
     * `RequirePrincipal()`-gated and this one is anonymous. A distinct message for "the
     * profile row is missing" would be a second, differently-worded 404 an anonymous caller
     * could use to tell two failure modes apart — the exact oracle this class exists to deny.
     * Unreachable in practice either way: `organisation_profile_block_delete` forbids the row
     * ever being gone.
     */
    if (!document || profile === undefined) throw gone();

    return {
      orderNo: order.orderNo,
      status: order.status,
      contactName: order.contactName,
      submittedAt: order.submittedAt?.toISOString() ?? null,
      document: document.document,
      /*
       * Live off the order row, like `contactName` and `submittedAt` above — the deposit is a
       * payment fact, not part of what was priced, so it is not in the frozen document. See
       * `LinkedDocumentWire.scheduledDepositThbMinor`.
       */
      scheduledDepositThbMinor:
        order.scheduledDepositThbMinor === null
          ? null
          : encodeThb(order.scheduledDepositThbMinor),
      seller: encodeProfile(profile),
    };
  }
}
