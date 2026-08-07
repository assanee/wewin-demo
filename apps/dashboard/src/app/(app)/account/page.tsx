import { AccountSettings } from '@/components/account/account-settings';

/** Your own account. Inside `(app)` — it needs a session, which is what the shell provides. */
export default function AccountPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">ตั้งค่าบัญชีของฉัน</h1>
        <p className="text-muted-foreground">รหัสผ่าน บัญชีที่เชื่อมไว้ และอุปกรณ์ที่เข้าสู่ระบบอยู่</p>
      </div>

      <AccountSettings />
    </div>
  );
}
