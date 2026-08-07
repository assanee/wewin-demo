import { OptionGroupList } from '@/components/option-groups/option-group-list';

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
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">ชุดตัวเลือก</h1>
        <p className="text-muted-foreground">
          กลุ่มตัวเลือกและค่าของตัวเลือก ที่สินค้าแต่ละเวอร์ชันหยิบไปใช้
        </p>
      </div>

      <OptionGroupList />
    </div>
  );
}
