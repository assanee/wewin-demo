import { UserAdmin } from '@/components/users/user-admin';

/** Who works here. Client-side for the reason `products/page.tsx` gives. */
export default function UsersPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">ผู้ใช้และสิทธิ์</h1>
        <p className="text-muted-foreground">
          บัญชีพนักงาน กลุ่ม และสิทธิ์ที่แต่ละกลุ่มให้
        </p>
      </div>

      <UserAdmin />
    </div>
  );
}
