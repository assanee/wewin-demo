import { ApprovalInbox } from '@/components/approvals/approval-inbox';
import { PageHeader } from '@/components/page-header';

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
    <div className="flex flex-col gap-8">
      {/*
       * ⚠️ The hand-rolled pair this replaces was a `text-2xl` `h1` above an **unclassed** `<p>`,
       * which inherits the browser's 16px — so the description was *larger* than every piece of
       * body copy under it and read as the more important of the two. `PageHeader` is 30/14.
       */}
      {/*
        ⚠️ "คำขออนุมัติ", not "คำขออนุมัติส่วนลด". This queue took a second kind of request when
        write-offs landed — forgiving a balance a customer already owes, which is not a discount
        and is decided against a different ceiling. A heading naming only one of the two makes
        the other look like it arrived here by mistake, and a screen nobody trusts the title of
        is a screen people stop opening.
      */}
      <PageHeader
        title="คำขออนุมัติ"
        description="ส่วนลดที่เกินอำนาจของฝ่ายขาย และคำขอตัดยอดค้างทิ้ง รอให้ผู้มีอำนาจตัดสิน — อนุมัติได้เท่าที่เพดานของคุณครอบคลุม และไม่อนุมัติได้ทุกคำขอ"
      />

      <ApprovalInbox />
    </div>
  );
}
