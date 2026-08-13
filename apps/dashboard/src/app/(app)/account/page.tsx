import { AccountSettings } from '@/components/account/account-settings';
import { PageHeader } from '@/components/page-header';
import { PrincipalCard } from '@/components/principal-card';

/** Your own account. Inside `(app)` — it needs a session, which is what the shell provides. */
export default function AccountPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="ตั้งค่าบัญชีของฉัน"
        description="รหัสผ่าน บัญชีที่เชื่อมไว้ และอุปกรณ์ที่เข้าสู่ระบบอยู่"
      />

      <AccountSettings />

      {/*
       * `GET /me`, printed — moved here from the overview.
       *
       * It is a diagnostic, and a good one: "why can I not see สินค้า?" is answered by
       * reading whether the API thinks this account holds `catalog.read`, and plan section 6
       * claims the menu *derives* from that list, which this is the way to check. It is also
       * a fact about the reader, so it belongs on the reader's own page rather than on the
       * one screen that should be about the company.
       *
       * Collapsed by default. Somebody managing their password does not need seventeen
       * permission codes in the way, and somebody debugging access knows to open it.
       */}
      <details className="group">
        <summary className="text-muted-foreground hover:text-foreground focus-visible:outline-ring type-body -mx-1 w-fit list-none rounded px-1 py-0.5 select-none focus-visible:outline-2 focus-visible:outline-offset-2">
          <span className="group-open:hidden">▸ ดูสิทธิ์ที่บัญชีนี้ถืออยู่</span>
          <span className="hidden group-open:inline">▾ สิทธิ์ที่บัญชีนี้ถืออยู่</span>
        </summary>
        <div className="pt-3">
          <PrincipalCard />
        </div>
      </details>
    </div>
  );
}
