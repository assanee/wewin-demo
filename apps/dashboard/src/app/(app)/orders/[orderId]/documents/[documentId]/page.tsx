import { TaxDocumentSheet } from '@/components/documents/tax-document-sheet';

/**
 * A tax document, ready to print.
 *
 * ⚠️ Under `/orders/:id/` rather than a top-level `/documents/:id`, because a document is only
 * ever reached through the order it was raised against — that is where the API scopes it, and a
 * route that suggested otherwise would invite a screen that lists documents across orders
 * without asking who may see them.
 */
export default async function TaxDocumentPrintPage({
  params,
}: {
  readonly params: Promise<{ readonly orderId: string; readonly documentId: string }>;
}) {
  const { orderId, documentId } = await params;

  return <TaxDocumentSheet orderId={orderId} documentId={documentId} />;
}
