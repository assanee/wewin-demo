import { z } from 'zod';
import {
  type CatalogRef,
  type ProductDocument,
  type ProductDocumentWire,
  catalogRefSchema,
  encodeProductDocument,
  productDocumentWireSchema,
} from './catalog.js';

/**
 * The one error this contract has to name.
 *
 * Plan 5 point 5: a customer configures for five minutes, a new version is published
 * underneath them, and the price they are quoted comes from a document they never saw.
 * The close is a handle sent out with the document and required back on every priced
 * request — and a 409 carrying the fresh document when the two disagree.
 *
 * The endpoints are phase 3b and later. The shape is here now because the alternative
 * is each of them inventing its own, and a staleness protocol that differs between
 * `/price` and `/orders` is a staleness protocol that is wrong on one of them.
 */

export const CATALOG_STALE = 'catalog_stale';

/**
 * 409, not 412 and not 400.
 *
 * The request was well-formed and the client was not wrong to send it — the document
 * moved. 409 is the status whose retry is "here is the current state, reconcile and
 * try again", which is exactly what the body below carries.
 */
export const CATALOG_STALE_STATUS = 409;

export interface CatalogStaleBodyWire {
  readonly error: typeof CATALOG_STALE;
  /** Echoed back, so a log line explains itself without joining two records. */
  readonly sent: CatalogRef;
  /**
   * The fresh document, whole.
   *
   * Answering with only the new `documentHash` would send every client straight back
   * for the document, and it would do so at the moment a publish has just made every
   * open configurator ask at once. The refusal and the answer travel together.
   */
  readonly current: ProductDocumentWire;
}

export const catalogStaleBodySchema: z.ZodType<CatalogStaleBodyWire> = z.object({
  error: z.literal(CATALOG_STALE),
  sent: catalogRefSchema,
  current: productDocumentWireSchema,
});

export const catalogStaleBody = (
  sent: CatalogRef,
  current: ProductDocument,
): CatalogStaleBodyWire => ({
  error: CATALOG_STALE,
  sent: { productVersionId: sent.productVersionId, documentHash: sent.documentHash },
  current: encodeProductDocument(current),
});

/**
 * Whether a failed response is the staleness case.
 *
 * A client needs this before it can decide between "re-render and retry" and "show the
 * customer an error", and the decision has to be made on the body: a 409 from a proxy
 * is not this.
 */
export const isCatalogStaleBody = (body: unknown): body is CatalogStaleBodyWire =>
  catalogStaleBodySchema.safeParse(body).success;
