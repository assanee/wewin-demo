import Link from 'next/link';

import { CreateProductScreen } from '@/components/products/create-product-screen';
import { PageHeader } from '@/components/page-header';

/**
 * เพิ่มสินค้า — a route rather than a dialog.
 *
 * The screen it renders asks for around thirty things when a product is built from nothing,
 * which is more than a modal can hold without becoming a page that cannot be linked to,
 * reloaded, or opened in a second tab. `create-product-screen.tsx` carries the rest of the
 * argument, including why the copy flow it replaces survives as a mode.
 *
 * A server component around one client component, matching every other screen here: the data
 * sits behind a bearer token held in memory by `SessionProvider`, so there is nothing this
 * layer could fetch that would not be fetching the catalogue for whoever asks.
 */
export default function NewProductPage() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Link href="/products" className="text-muted-foreground type-caption w-fit hover:underline">
          ← สินค้าทั้งหมด
        </Link>
        <PageHeader
          title="เพิ่มสินค้า"
          description="สร้างสินค้าใหม่เป็นฉบับร่าง — คัดลอกจากสินค้าที่มีอยู่ หรือกรอกเองทั้งหมด"
        />
      </div>

      <CreateProductScreen />
    </div>
  );
}
