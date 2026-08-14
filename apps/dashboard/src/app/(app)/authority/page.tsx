import { AuthorityScreen } from '@/components/authority/authority-screen';
import { PageHeader } from '@/components/page-header';

/**
 * `groups.read` — the same code `authority.controller.ts` asks for on both of this screen's
 * reads, and the whole reason it is a page rather than a tab on `/users`: that route requires
 * `users.read`, which is the entire staff directory, and `groups.write` could not be delegated
 * without it. See `components/authority/authority-screen.tsx`.
 */
export default function AuthorityPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="เพดานอำนาจอนุมัติ"
        description="บทบาทใดลดราคาให้ลูกค้าเองได้เท่าไรต่อหนึ่งใบเสนอราคา — เกินเพดานต้องให้คนอื่นอนุมัติ"
      />

      <AuthorityScreen />
    </div>
  );
}
