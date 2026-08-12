import { AuthorityScreen } from '@/components/authority/authority-screen';

/**
 * `groups.read` — the same code `authority.controller.ts` asks for on both of this screen's
 * reads, and the whole reason it is a page rather than a tab on `/users`: that route requires
 * `users.read`, which is the entire staff directory, and `groups.write` could not be delegated
 * without it. See `components/authority/authority-screen.tsx`.
 */
export default function AuthorityPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">เพดานอำนาจอนุมัติ</h1>
        <p className="text-muted-foreground">
          บทบาทใดลดราคาให้ลูกค้าเองได้เท่าไรต่อหนึ่งใบเสนอราคา — เกินเพดานต้องให้คนอื่นอนุมัติ
        </p>
      </div>

      <AuthorityScreen />
    </div>
  );
}
