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
  type PinnedDocument,
  type PrintableQuotation,
} from './printable-quotation';

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

/** Ids and satang out of the pinned JSON. The unit is checked, never assumed. */
const satang = (value: unknown, what: string): bigint => {
  if (typeof value !== 'object' || value === null) throw new TypeError(`${what}: ไม่ใช่จำนวนเงิน`);
  const money = value as { unit?: unknown; digits?: unknown };
  if (money.unit !== 'THB.satang') throw new TypeError(`${what}: หน่วยไม่ใช่ THB.satang`);
  return BigInt(String(money.digits));
};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * The option labels a line was priced with, in the order the document holds them.
 *
 * `price.lines` is the breakdown: a `price.line.base` entry for the area, then one
 * `price.line.option` per selection **that changed the price**, each carrying `group` and
 * `option` as `catalogText`. Anything else — a rule surcharge, a rounding line — has no pair
 * of labels and is skipped rather than rendered as an empty row.
 *
 * ⚠️ **A known gap, and it belongs to the API rather than to this file.** A zero-delta
 * option — clear glass, no insect screen — produces no price line, so the pinned document
 * carries no Thai for it: `selections` has `glass_color: CLR` and nothing else. The
 * quotation therefore lists the options that cost something and omits the ones that did not.
 *
 * The alternative was falling back to `selections` for those, and it is worse: `CLR` on a
 * document a customer reads is not a specification, it is a warehouse code. Incomplete beats
 * unreadable.
 *
 * The real fix is upstream — `submit_for_payment` should pin a label for every selection,
 * not only for the priced ones — and it is a change to what the document *freezes*, which
 * this round does not own.
 */
function pinnedOptions(price: unknown): readonly { groupTh: string; valueTh: string }[] {
  const lines = (price as { lines?: unknown })?.lines;
  if (!Array.isArray(lines)) return [];

  return lines.flatMap((raw) => {
    const params = (raw as { label?: { params?: Record<string, unknown> } }).label?.params ?? {};
    const group = params['group'] as { th?: unknown } | undefined;
    const option = params['option'] as { th?: unknown } | undefined;

    return typeof group?.th === 'string' && typeof option?.th === 'string'
      ? [{ groupTh: group.th, valueTh: option.th }]
      : [];
  });
}

function pin(document: Record<string, unknown>, order: OrderDetail): PinnedDocument {
  const vat = (document['vat'] ?? {}) as { rateBp?: unknown };
  const lines = Array.isArray(document['lines']) ? document['lines'] : [];
  const charges = Array.isArray(document['charges']) ? document['charges'] : [];

  return {
    revision: typeof document['revision'] === 'number' ? document['revision'] : 0,
    documentHash: text(document['documentHash']),
    /* ⚠️ From the document, never from the browser. This is the whole of plan 10.6. */
    pinnedLocale: text(document['pinnedLocale']) || 'th',
    orderNo: order.orderNo,
    contactName: order.contact.name,
    submittedAt: order.submittedAt,
    vatRateBp: typeof vat.rateBp === 'number' ? vat.rateBp : 0,
    leadTimeDays: typeof document['leadTimeDays'] === 'number' ? document['leadTimeDays'] : 0,
    netThbMinor: satang(document['netThbMinor'], 'ยอดก่อนภาษี'),
    vatThbMinor: satang(document['vatThbMinor'], 'ภาษี'),
    grandTotalThbMinor: satang(document['grandTotalThbMinor'], 'ยอดรวม'),
    lines: lines.map((raw, index) => {
      const line = raw as Record<string, unknown>;
      const measures = (line['measures'] ?? {}) as Record<string, { unit?: string; digits?: string }>;

      return {
        lineNo: typeof line['lineNo'] === 'number' ? line['lineNo'] : index + 1,
        nameTh: text(line['nameTh']),
        skuCode: text(line['skuCode']),
        qty: typeof line['qty'] === 'number' ? line['qty'] : 1,
        customerDescriptionTh:
          typeof line['customerDescriptionTh'] === 'string' ? line['customerDescriptionTh'] : null,
        /*
         * ⭐ The pinned labels, out of `price.lines` — not the `selections` codes.
         *
         * `catalogText` carries the Thai the customer was shown, frozen at submit next to
         * the prices and the locale, with a `ref` back to the catalogue entry it came from.
         * Reading `selections` would print `DW` on a customer's document *and* would drift
         * the day somebody renames the option, which is the whole reason the document is
         * pinned at all.
         */
        options: pinnedOptions(line['price']),
        /*
         * Measures arrive as tagged lengths — micrometres. Rendered as millimetres here,
         * which is what a workshop drawing uses and what the customer was shown.
         */
        measures: Object.fromEntries(
          Object.entries(measures).map(([name, value]) => [
            name,
            `${(Number(value.digits ?? 0) / 1000).toLocaleString('th-TH')} mm`,
          ]),
        ),
        netMinor: satang(line['netMinor'], `บรรทัด ${String(index + 1)}`),
      };
    }),
    charges: charges.map((raw) => {
      const charge = raw as Record<string, unknown>;
      return {
        labelTh: text(charge['labelTh']) || text(charge['kind']),
        amountMinor: satang(charge['amountThbMinor'] ?? charge['amountMinor'], 'ค่าใช้จ่าย'),
      };
    }),
  };
}

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
