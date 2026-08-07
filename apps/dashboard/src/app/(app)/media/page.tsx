import { MediaLibrary } from '@/components/media/media-library';

/** The image library. Client-side for the reason `option-groups/page.tsx` gives. */
export default function MediaPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">คลังรูปภาพ</h1>
        <p className="text-muted-foreground">รูปสินค้าและรูปประกอบตัวเลือก</p>
      </div>

      <MediaLibrary />
    </div>
  );
}
