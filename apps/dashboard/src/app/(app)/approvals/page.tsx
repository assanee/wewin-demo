import { ApprovalInbox } from '@/components/approvals/approval-inbox';

/**
 * ⭐ `quotes.read` **and** `quotes.approve` — the pair `GET /quotes/approvals/queue` asks for.
 *
 * `quotes.read` because the page reads `approvals` rows and the request detail; `quotes.approve`
 * because the queue is filtered to what the reader may decide, so serving it to somebody who may
 * decide nothing would be a list whose every row is a claim that is false. Both codes are in the
 * nav entry as well, and `@RequirePermissions` means *every* listed code — see
 * `apps/dashboard/src/lib/nav/navigation.ts` and `approvals.controller.ts`.
 *
 * ⚠️ `quotes.approve` is held by **nobody at boot**, deliberately (plan 13: a rubber-stamped rule
 * is worse than none). So this page is invisible until an administrator grants the code, and the
 * grant is a decision somebody makes rather than a default.
 */
export default function ApprovalsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">คำขออนุมัติส่วนลด</h1>
        <p className="text-muted-foreground">
          ส่วนลดที่เกินอำนาจของฝ่ายขาย รอให้ผู้มีอำนาจตัดสิน — อนุมัติได้เท่าที่เพดานของคุณครอบคลุม
          และไม่อนุมัติได้ทุกคำขอ
        </p>
      </div>

      <ApprovalInbox />
    </div>
  );
}
