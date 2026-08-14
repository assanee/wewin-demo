import { OrganisationScreen } from '@/components/organisation/organisation-screen';
import { PageHeader } from '@/components/page-header';

/**
 * The company's own profile and the bank accounts it is paid into.
 *
 * A server component that renders one client component, matching `option-groups/page.tsx`:
 * the data is behind a bearer token held in memory by `SessionProvider`, so there is nothing
 * this layer could usefully fetch — and a page that tried would be a page that renders the
 * company's bank accounts for whoever asks.
 *
 * ⚠️ **The title stays `ข้อมูลบริษัท` and the *section* under it was renamed.** The two were the
 * same six characters about twenty pixels apart — `<h1>` at 24px over a `<CardTitle>` at 16px,
 * which reads as one heading accidentally rendered twice. The page keeps the name because it is
 * what the sidebar calls this route (`navigation.ts`), and a screen whose title disagrees with the
 * link that opened it is a worse problem than the one being fixed. See `organisation-screen.tsx`.
 */
export default function OrganisationPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="ข้อมูลบริษัท"
        /* Was an unclassed `<p>`, which inherits the browser's 16px — larger than every heading
           on the screen below it. `PageHeader` puts it at `type-body`. */
        description="อัตราแลกเปลี่ยน ประเทศปลายทาง บัญชีธนาคารที่รับเงิน และโปรไฟล์ที่พิมพ์บนใบเสนอราคา"
      />

      <OrganisationScreen />
    </div>
  );
}
