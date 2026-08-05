import { QuoteEditorScreen } from '@/components/quotes/quote-editor';

export default async function QuotePage({
  params,
}: {
  readonly params: Promise<{ readonly orderId: string }>;
}) {
  const { orderId } = await params;
  return <QuoteEditorScreen orderId={orderId} />;
}
