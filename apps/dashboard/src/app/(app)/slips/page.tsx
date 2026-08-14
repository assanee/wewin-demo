import { PageHeader } from '@/components/page-header';
import { RecordedWithoutSlipList } from '@/components/slips/recorded-list';
import { SlipQueue } from '@/components/slips/slip-queue';

/**
 * Slips waiting for a person.
 *
 * `payments.read` + `orders.read` — both, matching `slip-review.controller.ts` and matching
 * the overview's card, which asks for the same pair for the same reason: a count of this
 * queue is a summary of this queue.
 *
 * The title was a hand-rolled `text-2xl font-semibold` above an unclassed `<p>`, and that `<p>`
 * inherited the browser's 16px — *larger* than the 14px table underneath it. `PageHeader` is
 * where `type-page` lives and the only place it is allowed to live.
 */
export default function SlipsPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="สลิปรอตรวจ"
        description="สลิปที่ลูกค้าส่งเข้ามาและยังไม่มีใครยืนยัน — ยังไม่ถือเป็นเงินจนกว่าจะรับ"
      />

      <SlipQueue />

      {/*
       * ⭐ The audit surface, below the queue and not beside it.
       *
       * The queue is what somebody opened this screen to work through; this is what an auditor
       * opens it to read, which is a rarer visit and a lower rank. Its own `type-section` heading
       * makes it a second region rather than more of the table above — the queue is สลิปรอตรวจ and
       * this is every evidence-free entry whatever became of it, including the rejected ones.
       *
       * ⚠️ Not permission-gated in this file. It needs `payments.read` + `orders.read`, which is
       * exactly what the route this page sits behind already requires — an extra `can()` here would
       * be a second gate that can disagree with the first.
       */}
      <RecordedWithoutSlipList />
    </div>
  );
}
