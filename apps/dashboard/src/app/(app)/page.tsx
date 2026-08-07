import { OverviewScreen } from '@/components/overview/overview-screen';

/**
 * The landing page.
 *
 * It used to print `GET /me` — the caller's user id, group ids and permission codes — which
 * was a real diagnostic ("why can I not see สินค้า?" answered in ten seconds) and the wrong
 * thing to open the day with: a page about the *reader*, in the place that should be about
 * the *company*. That card now lives at `/account`, where a fact about you belongs, and this
 * page answers what is waiting for somebody and where the work is.
 *
 * Every number comes from `GET /overview`, which returns only the cards this account
 * is entitled to. There is no permission logic here and there must not be: the sidebar
 * derives from `/me`, this screen derives from what the overview endpoint chose to send, and
 * in both cases the API is the single source of truth rather than a thing the client copies.
 */
export default function OverviewPage() {
  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">ภาพรวม</h1>
        <p className="text-muted-foreground text-sm">
          งานที่รอดำเนินการและสถานะปัจจุบันของ WEWIN — แสดงเฉพาะส่วนที่บัญชีนี้มีสิทธิ์เข้าถึง
        </p>
      </div>
      <OverviewScreen />
    </>
  );
}
