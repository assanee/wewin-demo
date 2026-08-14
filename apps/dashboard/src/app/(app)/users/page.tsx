import { PageHeader } from '@/components/page-header';
import { UserAdmin } from '@/components/users/user-admin';

/**
 * Who works here. Client-side for the reason `products/page.tsx` gives.
 *
 * ⚠️ The title used to be a hand-rolled `text-2xl` `h1` above an **unclassed** `<p>` — which
 * inherits the browser's 16px, so the description outranked every heading and every row of body
 * copy beneath it. `PageHeader` is the one place `type-page` exists, and it puts the description
 * at `type-body` underneath rather than competing with the title.
 */
export default function UsersPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="ผู้ใช้และสิทธิ์" description="บัญชีพนักงาน กลุ่ม และสิทธิ์ที่แต่ละกลุ่มให้" />

      <UserAdmin />
    </div>
  );
}
