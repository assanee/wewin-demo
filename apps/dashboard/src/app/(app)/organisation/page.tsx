import { OrganisationScreen } from '@/components/organisation/organisation-screen';

/**
 * The company's own profile and the bank accounts it is paid into.
 *
 * A server component that renders one client component, matching `option-groups/page.tsx`:
 * the data is behind a bearer token held in memory by `SessionProvider`, so there is nothing
 * this layer could usefully fetch — and a page that tried would be a page that renders the
 * company's bank accounts for whoever asks.
 */
export default function OrganisationPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">ข้อมูลบริษัท</h1>
        <p className="text-muted-foreground">โปรไฟล์บริษัทและบัญชีธนาคารที่รับเงินจากลูกค้า</p>
      </div>

      <OrganisationScreen />
    </div>
  );
}
