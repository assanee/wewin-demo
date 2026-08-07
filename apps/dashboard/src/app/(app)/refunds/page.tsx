import { RefundQueue } from '@/components/refunds/refund-queue';

/** `payments.read` — matching `refunds.controller.ts` and the overview's refunds card. */
export default function RefundsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">คืนเงิน</h1>
        <p className="text-muted-foreground">
          ตัดสินใจ แล้วบันทึกว่าเงินออกจริง — คำขอที่อนุมัติแล้วแต่ยังไม่จ่ายคือหมวดแรก
        </p>
      </div>

      <RefundQueue />
    </div>
  );
}
