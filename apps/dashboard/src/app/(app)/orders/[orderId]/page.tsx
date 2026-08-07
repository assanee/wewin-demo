import { OrderDetail } from '@/components/orders/order-detail';

/**
 * One order.
 *
 * `params` is a promise in the App Router — awaited here rather than in the client component,
 * so the screen receives a plain string and stays testable without a router.
 */
export default async function OrderPage({
  params,
}: {
  readonly params: Promise<{ readonly orderId: string }>;
}) {
  const { orderId } = await params;

  return <OrderDetail orderId={orderId} />;
}
