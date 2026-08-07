import { SlipQueue } from '@/components/slips/slip-queue';

/**
 * Slips waiting for a person.
 *
 * `payments.read` + `orders.read` — both, matching `slip-review.controller.ts` and matching
 * the overview's card, which asks for the same pair for the same reason: a count of this
 * queue is a summary of this queue.
 */
export default function SlipsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">สลิปรอตรวจ</h1>
        <p className="text-muted-foreground">
          สลิปที่ลูกค้าส่งเข้ามาและยังไม่มีใครยืนยัน — ยังไม่ถือเป็นเงินจนกว่าจะรับ
        </p>
      </div>

      <SlipQueue />
    </div>
  );
}
