'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { AdminProductSummaryWire } from '@wewin/contract/admin';
import type { ProductWire } from '@wewin/contract/catalog';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SelectField, TextField } from '@/components/products/form-field';
import {
  createProduct,
  failureMessage,
  getProduct,
  getPublishedDocumentOf,
} from '@/components/products/catalog-api';

import { createRequestFrom, identityProblems, inheritanceSummaryTh } from './new-product';

/**
 * เพิ่มสินค้า — the screen that was missing while both ends of the wire were finished.
 *
 * `POST /admin/catalog/products` and `createProduct` have both existed for as long as the
 * catalogue has; nothing imported the second. See `new-product.ts` for why the form starts
 * from an existing product rather than a blank page — in short, the contract has no concept
 * of a sparse product, so a blank form would have to ask for sixteen fields including the
 * elevation before it could ask for a name.
 */
export function CreateProductDialog({
  products,
  onClose,
  onCreated,
}: {
  readonly products: readonly AdminProductSummaryWire[];
  readonly onClose: () => void;
  readonly onCreated: (productId: string) => void;
}) {
  const [sourceId, setSourceId] = useState('');
  const [source, setSource] = useState<ProductWire | null>(null);
  const [loadingSource, setLoadingSource] = useState(false);

  const [id, setId] = useState('');
  const [slug, setSlug] = useState('');
  const [skuPrefix, setSkuPrefix] = useState('');
  const [nameTh, setNameTh] = useState('');

  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /*
   * ⚠️ Published first, draft only as a fallback. A draft is somebody's work in progress —
   * copying it would silently propagate a half-finished change into a second product, and
   * the person copying has no way to see that is what happened. A product that has never
   * been published has nothing else to offer, so it is still allowed, and the dialog says
   * which of the two it used.
   */
  async function chooseSource(nextId: string): Promise<void> {
    setSourceId(nextId);
    setSource(null);
    setProblem(null);
    if (nextId === '') return;

    const row = products.find((product) => product.id === nextId);
    if (row === undefined) return;

    setLoadingSource(true);
    try {
      const published = await getPublishedDocumentOf(row.id, row.slug);
      if (published !== null) {
        setSource(published.product);
      } else {
        const full = await getProduct(row.id);
        setSource(full.draft?.product ?? null);
      }
    } catch (cause) {
      setProblem(failureMessage(cause));
    } finally {
      setLoadingSource(false);
    }
  }

  async function submit(): Promise<void> {
    if (source === null) return;
    setBusy(true);
    setProblem(null);
    try {
      const request = createRequestFrom(source, { id, slug, skuPrefix, nameTh });
      await createProduct(request);
      onCreated(request.id);
    } catch (cause) {
      setProblem(failureMessage(cause));
      setBusy(false);
    }
  }

  const problems = identityProblems({ id, slug, skuPrefix, nameTh }, products);
  /*
   * Nothing is shown as an error until the field has been touched — an empty form is not a
   * form full of mistakes. `problems` still gates the button, so the person cannot submit
   * an empty one; they simply are not shouted at for not having started.
   */
  const started = id !== '' || slug !== '' || skuPrefix !== '' || nameTh !== '';
  const ready = source !== null && problems.length === 0;

  const sourceOptions = products
    .filter((product) => product.published !== null || product.draft !== null)
    .map((product) => ({ value: product.id, labelTh: `${product.nameTh} · ${product.id}` }));

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>เพิ่มสินค้า</DialogTitle>
          <DialogDescription>
            สินค้าใหม่เริ่มจากสินค้าที่มีอยู่ — หมวดหมู่ ชุดตัวเลือก ขนาด ราคาต่อ ตร.ม. และกฎ จะถูกคัดลอกมาให้
            แล้วแก้ต่อในฉบับร่างได้
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {problem !== null && (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle>สร้างไม่สำเร็จ</AlertTitle>
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          )}

          <SelectField
            label="เริ่มจากสินค้า"
            description="เลือกตัวที่รูปทรงและชุดตัวเลือกใกล้เคียงที่สุด"
            value={sourceId}
            onChange={(next) => void chooseSource(next)}
            options={sourceOptions}
            disabled={busy}
            placeholder="เลือกสินค้าต้นแบบ"
          />

          {loadingSource && (
            <p className="text-muted-foreground type-caption flex items-center gap-2">
              <Loader2 className="size-3 animate-spin" /> กำลังอ่านสินค้าต้นแบบ…
            </p>
          )}

          {source !== null && (
            <Alert>
              <AlertTitle>จะคัดลอกมา: {inheritanceSummaryTh(source)}</AlertTitle>
              <AlertDescription>
                {/*
                  ⚠️ Said here because it cannot be undone from any screen. The draft editor can
                  change fields, but `putOption` and `deleteOption` are in the client with no
                  caller — so the option groups a product is born with are the ones it keeps.
                */}
                ชุดตัวเลือกที่ติดมาจะแก้ทีหลังจากหน้าจอไม่ได้ — ถ้าชุดตัวเลือกไม่ตรงกับที่ต้องการ ให้เลือกต้นแบบอื่น
              </AlertDescription>
            </Alert>
          )}

          <TextField
            label="รหัสสินค้า"
            description="ตัวพิมพ์เล็ก ตัวเลข และขีดกลาง เช่น lvr-hang-double"
            value={id}
            onChange={setId}
            mono
            disabled={busy}
            placeholder="lvr-hang-double"
          />

          <TextField
            label="สลัก"
            description="ส่วนท้ายของลิงก์หน้าสินค้าที่ลูกค้าเห็น"
            value={slug}
            onChange={setSlug}
            mono
            disabled={busy}
            placeholder="lvr-hang-double"
          />

          <TextField
            label="คำนำหน้า SKU"
            description="ตัวพิมพ์ใหญ่และตัวเลข — ถูกประกอบเป็นรหัส SKU ที่พิมพ์บนใบเสนอราคา"
            value={skuPrefix}
            onChange={setSkuPrefix}
            mono
            disabled={busy}
            placeholder="LVH2"
          />

          <TextField
            label="ชื่อสินค้า"
            value={nameTh}
            onChange={setNameTh}
            disabled={busy}
            placeholder="บานแขวน คู่ - ระแนงปรับได้"
          />

          {started && problems.length > 0 && (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle>ยังสร้างไม่ได้</AlertTitle>
              <AlertDescription>
                <ul className="flex list-disc flex-col gap-1 pl-4">
                  {problems.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </Button>
          <Button onClick={() => void submit()} disabled={!ready || busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            สร้างเป็นฉบับร่าง
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
