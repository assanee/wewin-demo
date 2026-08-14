import { MediaLibrary } from '@/components/media/media-library';
import { PageHeader } from '@/components/page-header';

/** The image library. Client-side for the reason `option-groups/page.tsx` gives. */
export default function MediaPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="คลังรูปภาพ" description="รูปสินค้าและรูปประกอบตัวเลือก" />

      <MediaLibrary />
    </div>
  );
}
