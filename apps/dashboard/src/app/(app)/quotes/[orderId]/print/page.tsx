import { QuotationSheet } from '@/components/quotes/quotation-sheet';

/**
 * The quotation, ready to print.
 *
 * `quotes.read` through the sidebar entry that leads here — the same code the editor needs,
 * because a person who may see a quotation may print the one that was pinned.
 */
export default async function QuotationPrintPage({
  params,
}: {
  readonly params: Promise<{ readonly orderId: string }>;
}) {
  const { orderId } = await params;

  return <QuotationSheet orderId={orderId} />;
}
