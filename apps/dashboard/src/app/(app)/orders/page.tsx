import { OrderList } from '@/components/orders/order-list';

/** Every order in the company. `orders.read` — the sidebar entry carries the same code. */
export default function OrdersPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">ออเดอร์</h1>
        <p className="text-muted-foreground">งานทั้งหมดในระบบ กรองตามสถานะได้</p>
      </div>

      <OrderList />
    </div>
  );
}
