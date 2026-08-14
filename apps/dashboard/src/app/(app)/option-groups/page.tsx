import { OptionGroupList } from '@/components/option-groups/option-group-list';
import { PageHeader } from '@/components/page-header';

/**
 * The shared option vocabulary.
 *
 * A server component that renders one client component, matching `products/page.tsx`: the
 * data is behind a bearer token held in memory by `SessionProvider`, so there is nothing
 * this layer could usefully fetch — and a page that tried would be a page that renders the
 * catalogue for whoever asks.
 */
export default function OptionGroupsPage() {
  return (
    <div className="flex flex-col gap-8">
      {/*
       * The title was a hand-rolled `text-2xl font-semibold` and the description an unclassed
       * `<p>` — 16px, which is *larger* than the 14px body copy under it and larger than every
       * group heading on the screen. `PageHeader` is the only place `type-page` exists.
       */}
      <PageHeader
        title="ชุดตัวเลือก"
        description="กลุ่มตัวเลือกและค่าของตัวเลือก ที่สินค้าแต่ละเวอร์ชันหยิบไปใช้"
      />

      <OptionGroupList />
    </div>
  );
}
