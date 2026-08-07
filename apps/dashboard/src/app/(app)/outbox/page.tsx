import { OutboxScreen } from '@/components/outbox/outbox-screen';

/**
 * ⚠️ `orders.read` — borrowed, and named as a borrow.
 *
 * `notifications.controller.ts` records why: there is no `notifications.*` permission and
 * there should be. The honest split is `notifications.read` / `notifications.retry`, because
 * re-sending a message to a customer is a customer-facing act and the people who should be
 * able to take it are not obviously the people who may edit an order.
 */
export default function OutboxPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">แจ้งเตือน</h1>
        <p className="text-muted-foreground">
          ข้อความที่ระบบเชื่อว่าส่งไปแล้ว — และรายการที่ลูกค้าไม่เคยได้รับ
        </p>
      </div>

      <OutboxScreen />
    </div>
  );
}
