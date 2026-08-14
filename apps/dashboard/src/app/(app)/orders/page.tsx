import { OrderList } from '@/components/orders/order-list';
import { PageHeader } from '@/components/page-header';

/** Every order in the company. `orders.read` — the sidebar entry carries the same code. */
export default function OrdersPage() {
  return (
    <div className="flex flex-col gap-8">
      {/*
       * The description used to be an unclassed `<p>`, which inherits the browser's 16px —
       * *larger* than every section heading and card title on the screens it sat above.
       * `PageHeader` puts it at `type-body`, below the title rather than competing with it.
       */}
      {/*
        ⚠️ Two axes now, so the description names both. It said "กรองตามสถานะได้" while the
        filter row had gained a ค้างชำระ toggle beside the statuses — a heading that undersells
        what the screen does is how a feature nobody asked twice for goes unused.
      */}
      <PageHeader title="ออเดอร์" description="งานทั้งหมดในระบบ กรองตามสถานะและยอดค้างชำระได้" />

      <OrderList />
    </div>
  );
}
