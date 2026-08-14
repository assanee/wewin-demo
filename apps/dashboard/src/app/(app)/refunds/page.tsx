import { PageHeader } from '@/components/page-header';
import { RefundQueue } from '@/components/refunds/refund-queue';

/** `payments.read` — matching `refunds.controller.ts` and the overview's refunds card. */
export default function RefundsPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="คืนเงิน"
        description="ตัดสินใจ แล้วบันทึกว่าเงินออกจริง — คำขอที่อนุมัติแล้วแต่ยังไม่จ่ายคือหมวดแรก"
      />

      <RefundQueue />
    </div>
  );
}
