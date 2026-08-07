import { Injectable } from '@nestjs/common';

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
  ) {}

  async byLink(orderId: string): Promise<LinkedDocumentWire> {
    const order = await this.scoped.find(systemScope('emailed quotation link'), orderId, 'read');
    if (!order || order.documentId === null) throw gone();

    const document = await this.orders.findDocumentById(order.documentId);
    if (!document) throw gone();

    return {
      orderNo: order.orderNo,
      status: order.status,
      contactName: order.contactName,
      submittedAt: order.submittedAt?.toISOString() ?? null,
      document: document.document,
    };
  }
}
