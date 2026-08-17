'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { ArrowLeft, Printer, TriangleAlert } from 'lucide-react';
import { printableTaxDocument, type PrintableTaxDocument } from '@wewin/core/tax-document';
import type { TaxDocumentWire } from '@wewin/contract/forfeit';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { failureMessage } from '@/lib/api/errors';
import { getTaxDocuments } from '@/components/orders/order-api';

/**
 * ⭐ A tax document, ready to print.
 *
 * ── ⚠️ Why `window.print()` and not a generated PDF ──────────────────────────
 *
 * The same reason the quotation sheet gives: the print dialog already makes a PDF, and its
 * "Save as PDF" *is* the download. A server-side renderer would be a second layout to keep in
 * step with this one, and two layouts for one legal document is how they diverge.
 *
 * ── ⚠️ Everything on this page comes from the FROZEN body, with one exception ─
 *
 * The exception is the cancellation notice, and it is deliberate: `tax_documents_freeze()`
 * permits exactly one column to change — issued → voided — and freezes the jsonb, so a
 * cancellation can never be inside the body. A page rendered from `document` alone would
 * reprint a struck-out tax invoice as though it were live, which is the one mistake this
 * feature must never make. `printableTaxDocument` therefore takes the row and the body
 * together.
 *
 * ── ⚠️ ต้นฉบับ / สำเนา is not decided here ──────────────────────────────────
 *
 * The same frozen body is printed many times and every impression after the first is a
 * สำเนา, but which impression is the original is a fact about paper that this system does not
 * observe. Rather than let every reprint claim to be the original, the page carries a toggle
 * and the person printing states it. Whether that is enough is a question for the accountant.
 */
export function TaxDocumentSheet({
  orderId,
  documentId,
}: {
  readonly orderId: string;
  readonly documentId: string;
}) {
  const [state, setState] = useState<
    | { readonly status: 'loading' }
    | { readonly status: 'failed'; readonly problem: string }
    | { readonly status: 'missing' }
    | { readonly status: 'ready'; readonly page: PrintableTaxDocument }
  >({ status: 'loading' });
  const [isCopy, setIsCopy] = useState(false);

  useEffect(() => {
    void getTaxDocuments(orderId)
      .then((documents) => {
        const found = documents.find((document) => document.id === documentId);
        if (found === undefined) {
          setState({ status: 'missing' });
          return;
        }
        setState({ status: 'ready', page: printableTaxDocument(asSource(found)) });
      })
      .catch((cause: unknown) => setState({ status: 'failed', problem: failureMessage(cause) }));
  }, [orderId, documentId]);

  if (state.status === 'loading') return <Skeleton className="h-96 w-full" />;

  if (state.status === 'failed' || state.status === 'missing') {
    return (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>
          {state.status === 'missing' ? 'ไม่พบเอกสารนี้ในออเดอร์' : 'โหลดเอกสารไม่สำเร็จ'}
        </AlertTitle>
        <AlertDescription>
          {state.status === 'missing' ? 'เอกสารอาจถูกออกไว้กับออเดอร์อื่น' : state.problem}
        </AlertDescription>
      </Alert>
    );
  }

  const { page } = state;

  return (
    <div className="flex flex-col gap-4">
      {/* ── Hidden when printing ───────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <Link
          href={`/orders/${orderId}` as Route}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-4" /> กลับไปที่ออเดอร์
        </Link>
        <Button onClick={() => window.print()}>
          <Printer /> พิมพ์ / บันทึกเป็น PDF
        </Button>
        <div className="flex items-center gap-2">
          <Checkbox
            id="print-as-copy"
            checked={isCopy}
            onCheckedChange={(next) => setIsCopy(next === true)}
          />
          <Label htmlFor="print-as-copy" className="text-muted-foreground text-sm font-normal">
            พิมพ์เป็นสำเนา
          </Label>
        </div>
      </div>

      {page.footingProblemTh !== null && (
        <Alert variant="destructive" className="print:hidden">
          <TriangleAlert />
          <AlertTitle>ยอดบนเอกสารไม่ตรงกัน</AlertTitle>
          <AlertDescription>{page.footingProblemTh}</AlertDescription>
        </Alert>
      )}

      <article className="bg-background text-foreground mx-auto w-full max-w-[210mm] p-10 print:p-0 print:text-black">
        {/*
          ⛔ First thing on the page, before the letterhead. A cancelled document that looks
          live is worse than no document.
        */}
        {page.voidedNoticeTh !== null && (
          <p className="border-destructive text-destructive mb-6 border-2 px-4 py-3 text-center text-lg font-semibold print:border-black print:text-black">
            {page.voidedNoticeTh}
          </p>
        )}

        <header className="mb-8 flex items-start justify-between gap-8">
          <div>
            {/* The statutory caption, in the largest type on the page. */}
            <h1 className="text-2xl font-semibold tracking-tight">{page.captionTh}</h1>
            <p className="text-muted-foreground mt-1 text-sm print:text-black">
              {isCopy ? 'สำเนา' : 'ต้นฉบับ'}
            </p>
            <div className="text-muted-foreground mt-3 text-sm print:text-black">
              <p className="font-medium">{page.seller.legalName}</p>
              <p>{page.seller.addressText}</p>
              <p>
                {page.seller.branchText}
                {page.seller.taxIdText === null
                  ? null
                  : ` · เลขประจำตัวผู้เสียภาษี ${page.seller.taxIdText}`}
              </p>
            </div>
          </div>
          <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-right text-sm">
            <dt className="text-muted-foreground print:text-black">เลขที่</dt>
            <dd className="font-mono">{page.documentNo}</dd>
            <dt className="text-muted-foreground print:text-black">วันที่</dt>
            <dd>{page.issuedAtText}</dd>
            <dt className="text-muted-foreground print:text-black">อ้างอิงออเดอร์</dt>
            <dd className="font-mono">{page.orderNoText}</dd>
          </dl>
        </header>

        {page.buyer !== null && (
          <section className="border-foreground/15 mb-6 border-y py-4">
            <h2 className="text-muted-foreground mb-2 text-xs print:text-black">ผู้ซื้อ</h2>
            <p className="font-medium">{page.buyer.legalName}</p>
            <p className="text-sm">{page.buyer.addressText}</p>
            <p className="text-muted-foreground text-sm print:text-black">
              {page.buyer.branchText}
              {page.buyer.taxIdText === null
                ? null
                : ` · เลขประจำตัวผู้เสียภาษี ${page.buyer.taxIdText}`}
              {page.buyer.kindText === null ? null : ` · ${page.buyer.kindText}`}
            </p>
          </section>
        )}

        {page.citesText !== null && (
          <p className="mb-4 text-sm">
            {page.citesText}
            {page.reasonTh === null ? null : ` — ${page.reasonTh}`}
          </p>
        )}

        {/*
          ⛔ The four figures a ใบลดหนี้ must carry on its face: the value the original document
          stated, the value that is now correct, the difference, and the VAT on that difference.
          A reader has to see all four without consulting the document being reduced.
        */}
        {page.adjustment !== null && (
          <dl className="border-foreground/15 mb-6 grid grid-cols-[1fr_auto] gap-x-8 gap-y-1 border-y py-4 text-sm">
            <dt className="text-muted-foreground print:text-black">มูลค่าตามเอกสารเดิม</dt>
            <dd className="text-right tabular-nums">{page.adjustment.originalText}</dd>
            <dt className="text-muted-foreground print:text-black">มูลค่าที่ถูกต้อง</dt>
            <dd className="text-right tabular-nums">{page.adjustment.correctedText}</dd>
            <dt className="text-muted-foreground print:text-black">ผลต่าง</dt>
            <dd className="text-right tabular-nums">{page.adjustment.differenceText}</dd>
            <dt className="text-muted-foreground print:text-black">ภาษีมูลค่าเพิ่มของผลต่าง</dt>
            <dd className="text-right tabular-nums">{page.adjustment.vatOnDifferenceText}</dd>
          </dl>
        )}

        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-foreground/20 border-b text-left">
              <th className="py-2 pr-2 font-medium">รายการ</th>
              <th className="py-2 pr-2 text-right font-medium">จำนวน</th>
              <th className="py-2 pr-2 text-right font-medium">หน่วยละ</th>
              <th className="py-2 text-right font-medium">จำนวนเงิน</th>
            </tr>
          </thead>
          <tbody>
            {page.lines.map((line, index) => (
              <tr key={`${line.descriptionTh}-${index}`} className="border-foreground/10 border-b">
                <td className="py-3 pr-2">{line.descriptionTh}</td>
                <td className="py-3 pr-2 text-right tabular-nums">{line.quantityText}</td>
                <td className="py-3 pr-2 text-right tabular-nums">{line.unitText}</td>
                <td className="py-3 text-right tabular-nums">{line.amountText}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            {page.showsSeparatedVat ? (
              <>
                <tr>
                  <td className="pt-3 pr-2 text-right" colSpan={3}>
                    ก่อนภาษี
                  </td>
                  <td className="pt-3 text-right tabular-nums">{page.netText}</td>
                </tr>
                <tr>
                  <td className="pr-2 text-right" colSpan={3}>
                    ภาษีมูลค่าเพิ่ม {page.vatRateText}
                  </td>
                  <td className="text-right tabular-nums">{page.vatText}</td>
                </tr>
              </>
            ) : null}
            <tr className="border-foreground/20 border-t font-semibold">
              <td className="pt-3 pr-2 text-right" colSpan={3}>
                รวมทั้งสิ้น
              </td>
              <td className="pt-3 text-right tabular-nums">{page.grandTotalText}</td>
            </tr>
          </tfoot>
        </table>

        {/* ⚠️ Required wording on an abbreviated invoice, which shows no separated VAT line. */}
        {page.vatInclusiveNoteTh !== null && (
          <p className="mt-3 text-sm font-medium">{page.vatInclusiveNoteTh}</p>
        )}

        <footer className="text-muted-foreground mt-10 flex items-end justify-between gap-8 text-sm print:text-black">
          <p>{page.subjectText}</p>
          <div className="w-56 text-center">
            <div className="border-foreground/40 mb-1 border-b pt-10" />
            <p>ผู้รับเงิน / ผู้มีอำนาจลงนาม</p>
          </div>
        </footer>
      </article>
    </div>
  );
}

/**
 * ⚠️ The wire type and the printable module's input are declared separately on purpose.
 *
 * `packages/core` may not import `@wewin/contract` — the dependency runs the other way — so the
 * printable module states the shape it needs and this function is where the two meet. A field
 * added to one and not the other fails here, at compile time.
 */
function asSource(document: TaxDocumentWire): Parameters<typeof printableTaxDocument>[0] {
  return {
    kind: document.kind,
    status: document.status,
    documentNo: document.documentNo,
    issuedAt: document.issuedAt,
    voidedAt: document.voidedAt,
    voidReasonTh: document.voidReasonTh,
    netThbMinor: document.netThbMinor,
    vatThbMinor: document.vatThbMinor,
    grandTotalThbMinor: document.grandTotalThbMinor,
    body: document.body,
  };
}
