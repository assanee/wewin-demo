import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Construction } from 'lucide-react';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SEAM, made visible. Delete these pages as the real screens land.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The shell owns the route *structure*; the screens are being written in parallel. Each
 * section therefore ships with a page that exists and says nothing, for one narrow reason:
 * `typedRoutes` makes `src/lib/nav/navigation.ts` fail to compile if it names a route with
 * no `page.tsx`, and that check is worth more than the ten lines it costs. A placeholder is
 * how the check can be switched on before the screens arrive.
 *
 * Replacing one is a whole-file overwrite. Nothing else imports it.
 */
export function SectionPlaceholder({
  titleTh,
  descriptionTh,
}: {
  readonly titleTh: string;
  readonly descriptionTh: string;
}) {
  return (
    <Empty className="border-border/60 rounded-lg border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Construction />
        </EmptyMedia>
        <EmptyTitle>{titleTh}</EmptyTitle>
        <EmptyDescription>{descriptionTh}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <p className="text-muted-foreground text-sm">หน้านี้ยังไม่ถูกสร้าง — กำลังพัฒนาในเฟส 4</p>
      </EmptyContent>
    </Empty>
  );
}
