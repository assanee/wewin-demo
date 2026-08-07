'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { AlertTriangle, ArrowLeft, Printer } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { failureMessage } from '@/lib/api/errors';
import { getOrder, type OrderDetail } from '@/components/orders/order-api';
import { getPinnedDocument } from './quote-api';
import {
  printableQuotation,
  quotationProblem,
  pinnedDocumentFrom,
  type PinnedDocument,
  type PrintableQuotation,
} from '@wewin/core/quotation';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE QUOTATION, ON PAPER.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── Why this is `window.print()` and not a generated PDF ─────────────────────
 *
 * A server-side PDF needs either a headless browser — a browser, shipped, to render the page
 * a browser is already rendering — or a layout engine written by hand. Both to produce
 * something the print dialog already makes, with a "Save as PDF" that *is* the download.
 *
 * The trade is real and worth stating: this cannot be attached to an email by the server,
 * and the page footer is the browser's. The day a quotation has to be *sent* rather than
 * handed over, that is the reason to revisit it — not before.
 *
 * ── ⚠️ What prints is the pinned document, never the editor ──────────────────
 *
 * `printable-quotation.ts` argues it: before `submit_for_payment` there is no quotation,
 * there is a cart, and on paper the two are indistinguishable. `GET /orders/:id/document`
 * 404s for a draft and this screen says why rather than rendering an editable price as
 * though it were a commitment.
 *
 * ── ⚠️ The print date is beside the document, not inside it ──────────────────
 *
 * It is in the footer, outside everything `documentHash` covers, and it says
 * "พิมพ์เมื่อ" so nobody reads it as the quotation's date. Folding it in would make two
 * prints of one quotation differ, which is exactly what plan 10.6 forbids.
 */

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly sheet: PrintableQuotation }
  | { readonly status: 'no-quotation'; readonly order: OrderDetail }
  | { readonly status: 'failed'; readonly problem: string };

/**
 * ⚠️ The mapping lives in `@wewin/core/quotation`, beside the renderer, and not here.
 *
 * It was here first, and the storefront's copy was written from an assumption about the wire
 * rather than from a captured response — money is `{unit, digits}`, lines carry no `options`
 * — so its tests passed against its own fixture and its page failed on the first real
 * payload. Two decoders are two documents before either renders a character, which is the
 * same argument plan 10.6 makes about two renderers.
 */
const pin = (document: Record<string, unknown>, order: OrderDetail): PinnedDocument =>
  pinnedDocumentFrom(document, {
    orderNo: order.orderNo,
    contactName: order.contact.name,
    submittedAt: order.submittedAt,
  });

export function QuotationSheet({ orderId }: { readonly orderId: string }) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let live = true;

    void (async () => {
      try {
        const order = await getOrder(orderId);

        if (quotationProblem({ hasDocument: order.documentRevision !== null, status: order.status })) {
          if (live) setState({ status: 'no-quotation', order });
          return;
        }

        const document = await getPinnedDocument(orderId);
        if (live) setState({ status: 'ready', sheet: printableQuotation(pin(document, order)) });
      } catch (error) {
        if (live) setState({ status: 'failed', problem: failureMessage(error) });
      }
    })();

    return () => {
      live = false;
    };
  }, [orderId]);

  if (state.status === 'loading') return <Skeleton className="h-96 w-full" />;

  if (state.status === 'failed') {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>เปิดใบเสนอราคาไม่ได้</AlertTitle>
        <AlertDescription>{state.problem}</AlertDescription>
      </Alert>
    );
  }

  if (state.status === 'no-quotation') {
    return (
      <div className="flex flex-col gap-4">
        <Alert>
          <AlertTriangle />
          <AlertTitle>ออเดอร์นี้ยังไม่มีใบเสนอราคา</AlertTitle>
          <AlertDescription>
            {/*
             * The distinction that matters, said plainly. A cart printed as a quotation is a
             * price the company never committed to, in a form the customer cannot tell apart.
             */}
            ใบเสนอราคาเกิดขึ้นตอนส่งออเดอร์ให้ลูกค้า — ก่อนหน้านั้นเป็นตะกร้าที่ยังแก้ราคาได้
            พิมพ์ออกมาแล้วลูกค้าจะแยกไม่ออกว่าไม่ใช่ราคาที่บริษัทผูกพัน
          </AlertDescription>
        </Alert>
        <Link
          href={`/quotes/${orderId}` as Route}
          className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-4" /> กลับไปแก้ใบเสนอราคา
        </Link>
      </div>
    );
  }

  const { sheet } = state;

  return (
    <div className="flex flex-col gap-4">
      {/* ── Everything here is hidden when printing ──────────────────── */}
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <Link
          href={`/quotes/${orderId}` as Route}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-4" /> กลับ
        </Link>
        <Button onClick={() => window.print()}>
          <Printer /> พิมพ์ / บันทึกเป็น PDF
        </Button>
        <span className="text-muted-foreground text-xs">
          เลือก “บันทึกเป็น PDF” ในกล่องพิมพ์เพื่อดาวน์โหลด
        </span>
      </div>

      {sheet.localeDegraded && (
        <Alert variant="destructive" className="print:hidden">
          <AlertTriangle />
          <AlertTitle>ภาษาที่ตรึงไว้ไม่รองรับในรุ่นนี้</AlertTitle>
          <AlertDescription>
            เอกสารนี้ถูกตรึงไว้เป็นภาษาที่ระบบรุ่นปัจจุบันเรนเดอร์ไม่ได้ จึงแสดงเป็นภาษาไทยแทน —
            ฉบับที่พิมพ์ออกมาจะไม่ตรงกับที่ลูกค้าเห็นตอนแรก
          </AlertDescription>
        </Alert>
      )}

      {/* ── ⭐ The document. Everything below is what the hash covers. ── */}
      <article className="bg-background text-foreground mx-auto w-full max-w-[210mm] p-10 print:p-0 print:text-black">
        <header className="mb-8 flex items-start justify-between gap-8">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">ใบเสนอราคา</h1>
            <p className="text-muted-foreground mt-1 text-sm print:text-black">
              WEWIN — อะลูมิเนียมสั่งทำ
            </p>
          </div>
          <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-right text-sm">
            <dt className="text-muted-foreground print:text-black">เลขที่</dt>
            <dd className="font-mono">{sheet.orderNoText}</dd>
            <dt className="text-muted-foreground print:text-black">ฉบับที่</dt>
            <dd className="font-mono">{sheet.revisionText}</dd>
            <dt className="text-muted-foreground print:text-black">วันที่</dt>
            <dd>{sheet.submittedAtText}</dd>
          </dl>
        </header>

        {sheet.contactName !== null && (
          <p className="mb-6 text-sm">
            <span className="text-muted-foreground print:text-black">เรียน </span>
            {sheet.contactName}
          </p>
        )}

        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-foreground/20 border-b text-left">
              <th className="py-2 pr-2 font-medium">รายการ</th>
              <th className="py-2 pr-2 text-right font-medium">จำนวน</th>
              <th className="py-2 text-right font-medium">ราคา</th>
            </tr>
          </thead>
          <tbody>
            {sheet.lines.map((line) => (
              <tr key={line.lineNo} className="border-foreground/10 border-b align-top">
                <td className="py-3 pr-2">
                  <div className="font-medium">{line.nameTh}</div>
                  {line.customerDescriptionTh !== null && (
                    <div className="text-muted-foreground text-xs print:text-black">
                      {line.customerDescriptionTh}
                    </div>
                  )}
                  <div className="text-muted-foreground mt-1 text-xs print:text-black">
                    {line.detail.join(' · ')}
                  </div>
                  <div className="text-muted-foreground mt-0.5 font-mono text-[10px] print:text-black">
                    {line.skuCode}
                  </div>
                </td>
                <td className="py-3 pr-2 text-right tabular-nums">{line.qtyText}</td>
                <td className="py-3 text-right tabular-nums">{line.netText}</td>
              </tr>
            ))}

            {sheet.charges.map((charge) => (
              <tr key={charge.labelTh} className="border-foreground/10 border-b">
                <td className="py-2 pr-2" colSpan={2}>
                  {charge.labelTh}
                </td>
                <td className="py-2 text-right tabular-nums">{charge.amountText}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="pt-3 pr-2 text-right" colSpan={2}>
                ก่อนภาษี
              </td>
              <td className="pt-3 text-right tabular-nums">{sheet.netText}</td>
            </tr>
            <tr>
              <td className="pr-2 text-right" colSpan={2}>
                ภาษีมูลค่าเพิ่ม {sheet.vatRateText}
              </td>
              <td className="text-right tabular-nums">{sheet.vatText}</td>
            </tr>
            <tr className="border-foreground/20 border-t font-semibold">
              <td className="pt-2 pr-2 text-right" colSpan={2}>
                ยอดรวม
              </td>
              <td className="pt-2 text-right tabular-nums">{sheet.grandTotalText}</td>
            </tr>
          </tfoot>
        </table>

        <p className="text-muted-foreground mt-6 text-xs print:text-black">
          ระยะเวลาส่งมอบโดยประมาณ {sheet.leadTimeText} วันนับจากวันที่ยืนยันการผลิต
        </p>

        {/*
         * ⭐ The hash, on the paper.
         *
         * Two copies of one quotation can be compared without trusting either — which is the
         * point of pinning the document at all, and costs one line to make usable.
         */}
        <p className="text-muted-foreground mt-8 font-mono text-[10px] print:text-black">
          เอกสารอ้างอิง {sheet.documentHash}
        </p>
      </article>

      {/*
       * ⚠️ Outside the <article>, and outside everything the hash covers.
       *
       * The date this copy came off a printer is not part of the quotation. Inside the
       * document it would make two prints differ, which is exactly what plan 10.6 forbids —
       * so it is here, after the closing tag, labelled as what it is.
       */}
      <PrintedAt />
    </div>
  );
}

/**
 * The one thing on this page that is different every time.
 *
 * A separate component so the boundary is visible in the tree as well as in the comment: it
 * renders `Date.now()`, and it sits outside the `<article>` the document lives in.
 */
function PrintedAt() {
  const [now, setNow] = useState<string | null>(null);

  /*
   * In an effect, not during render. The server has no business stamping a client's print
   * time, and a value that differed between the server render and the hydration would be a
   * hydration mismatch — reported as a React warning about a document that is supposed to
   * be stable.
   */
  useEffect(() => {
    setNow(
      new Date().toLocaleString('th-TH', {
        timeZone: 'Asia/Bangkok',
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    );
  }, []);

  if (now === null) return null;

  return (
    <p className="text-muted-foreground mx-auto w-full max-w-[210mm] px-10 text-[10px] print:px-0 print:text-black">
      พิมพ์เมื่อ {now} — วันที่นี้ไม่ใช่ส่วนหนึ่งของเอกสาร
    </p>
  );
}
