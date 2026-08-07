import { ReviewQueue } from '@/components/reviews/review-queue';

/** `reviews.moderate` — the same code `reviews-admin.controller.ts` and the overview ask for. */
export default function ReviewsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">รีวิวรอกลั่นกรอง</h1>
        <p className="text-muted-foreground">
          ไม่ทำอะไรก็เผยแพร่เอง — รายการนี้คือสิ่งที่กำลังจะขึ้นหน้าเว็บ ไม่ใช่สิ่งที่รออนุมัติ
        </p>
      </div>

      <ReviewQueue />
    </div>
  );
}
