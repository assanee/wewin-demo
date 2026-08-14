import { PageHeader } from '@/components/page-header';
import { ReviewQueue } from '@/components/reviews/review-queue';

/**
 * `reviews.moderate` — the same code `reviews-admin.controller.ts` and the overview ask for.
 *
 * The description is the sentence that makes this screen legible, so it moves into `PageHeader`
 * rather than staying an unclassed `<p>` at 16px above a 14px list.
 */
export default function ReviewsPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="รีวิวรอกลั่นกรอง"
        description="ไม่ทำอะไรก็เผยแพร่เอง — รายการนี้คือสิ่งที่กำลังจะขึ้นหน้าเว็บ ไม่ใช่สิ่งที่รออนุมัติ"
      />

      <ReviewQueue />
    </div>
  );
}
