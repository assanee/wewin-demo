import { PrincipalCard } from '@/components/principal-card';

/**
 * The landing page, and the one screen the shell owns outright.
 *
 * It shows the signed-in principal exactly as `GET /me` returned it — the permission codes,
 * the group ids, the user id. That is not filler. "Permissions are the single source of
 * truth and the menu derives from them" (plan section 6) is a claim about this application,
 * and a screen that prints the input to that derivation is how somebody checks it in ten
 * seconds instead of reading the sidebar's source. When a person says "I cannot see
 * สินค้า", this page answers whether the API thinks they hold `catalog.read`.
 */
export default function OverviewPage() {
  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">ภาพรวม</h1>
        <p className="text-muted-foreground text-sm">
          ระบบจัดการภายในของ WEWIN — เมนูด้านซ้ายแสดงเฉพาะส่วนที่บัญชีนี้มีสิทธิ์เข้าถึง
        </p>
      </div>
      <PrincipalCard />
    </>
  );
}
