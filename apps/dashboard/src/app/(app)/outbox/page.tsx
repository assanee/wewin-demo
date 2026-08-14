import { OutboxScreen } from '@/components/outbox/outbox-screen';
import { PageHeader } from '@/components/page-header';

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
    <div className="flex flex-col gap-8">
      {/*
       * The title was a hand-rolled `text-2xl font-semibold` over an unclassed `<p>`, which
       * inherits the browser's 16px — *larger* than the 14px body copy beneath it, and larger
       * than every section heading on the screen. `PageHeader` is the one place `type-page`
       * exists, and it puts the description at `type-body` below the title rather than in
       * competition with it.
       */}
      <PageHeader
        title="แจ้งเตือน"
        description="ข้อความที่ระบบเชื่อว่าส่งไปแล้ว — และรายการที่ลูกค้าไม่เคยได้รับ"
      />

      <OutboxScreen />
    </div>
  );
}
