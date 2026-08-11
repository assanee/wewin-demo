'use client';

import { FileText } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

import { baht, daysText } from './amounts';
import { vatLabelTh } from './quote-alerts';
import { thbMinorOf } from './quote-wire';
import type { QuoteView } from './quote-model';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * What the customer sees. A different document, not a different skin.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The brief asks for this to be separate from the editing surface *because they are not the
 * same thing*, and the difference is not cosmetic:
 *
 *   **No provenance anywhere.** Not one struck-through baseline, not one "แก้ราคาแล้ว" badge,
 *   no concession, no name, no reason code. A customer who was quoted ฿8,500 was quoted
 *   ฿8,500; showing them it was ฿8,791 an hour ago discloses an internal negotiation, and it
 *   is also simply not what a quotation is. The contract makes the same split at the wire —
 *   the whole `sales` block is nested behind one nullable field so that "did I remember to
 *   strip this?" is one question with one answer.
 *
 *   **No sku, no selection codes, no product version.** The customer-facing description is the
 *   sales prose — which is exactly the text plan 7.9(ค) forbids from reaching a works order.
 *   The two documents draw from opposite sides of that line, which is why they are two
 *   components and not one with a `mode` prop: a boolean is one wrong default away from
 *   printing "กระจกเทมเปอร์ 8 มม." onto a cutting list for a 6 mm sku.
 *
 *   **No control of any kind.** There is not one button, input or handler in this file.
 *
 * ### This is a preview, and it says so
 *
 * The frozen JSONB document with its hash — plan 7.9(ก)'s third layer — is written at
 * `submit_for_payment` and lives on the order, not on the quote. Until then these figures move
 * whenever anybody touches the quote, so the badge says ตัวอย่าง rather than implying that what
 * is on screen is what somebody was sent. "What the customer saw" and "what the customer would
 * see if we sent it now" are different claims, and only one of them is evidence.
 */
export function CustomerDocument({ view }: { readonly view: QuoteView }) {
  const { money, effectiveLeadTimeDays, destination } = view.wire;
  /*
   * The frozen document (`quotation-sheet.tsx`, `QuotationIsland.tsx`) says whether VAT is
   * already folded into the price — "(รวมอยู่ในราคาแล้ว)" beside the rate — and this preview
   * is what staff negotiate against before that freeze. Leaving the suffix off here left the
   * numbers agreeing with the frozen document while the *story* did not: on an inclusive
   * destination this card said "VAT 9%" with nothing distinguishing it from an exclusive
   * quote where 9% is added on top, right up until submit added the parenthetical.
   */
  const vatSuffix = destination.basis === 'inclusive' ? ' (รวมอยู่ในราคาแล้ว)' : '';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <FileText className="size-4" />
          ใบเสนอราคาที่ลูกค้าเห็น
          <Badge variant="outline">ตัวอย่าง — ยังไม่ได้แช่แข็ง</Badge>
        </CardTitle>
        <CardDescription>
          ตัวเลขจะเปลี่ยนตามการแก้ไข จนกว่าจะยืนยันการชำระเงิน ซึ่งเป็นจุดที่ระบบแช่แข็งเอกสารพร้อม hash
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">#</TableHead>
                <TableHead>รายการ</TableHead>
                <TableHead className="w-20 text-end">จำนวน</TableHead>
                <TableHead className="w-36 text-end">ยอดรวม</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.lines.map((line, index) => (
                <TableRow key={line.line.id}>
                  <TableCell className="tabular-nums text-muted-foreground">{index + 1}</TableCell>
                  <TableCell>
                    {/*
                      The customer's own words for the line. Nothing here comes from the sku or
                      the selections: this is the "สำหรับลูกค้า" side of plan 7.9(ค)'s split, and
                      the works order renders the other side.
                    */}
                    {line.line.customerDescriptionTh ?? 'รายการ'}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">{line.line.qty}</TableCell>
                  <TableCell className="text-end font-mono tabular-nums">
                    {baht(line.effectiveThbMinor)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <Separator />

        <dl className="flex flex-col gap-1 self-end text-sm sm:w-80">
          <Line label="ยอดก่อนภาษี" value={baht(thbMinorOf(money.netThbMinor))} />
          <Line
            label={`${vatLabelTh(money.vat.rateBp, money.vat.treatment)}${vatSuffix}`}
            value={baht(thbMinorOf(money.vatThbMinor))}
          />
          <Separator className="my-1" />
          <Line label="ยอดที่ต้องชำระ" value={baht(thbMinorOf(money.grandTotalThbMinor))} strong />
          <Line label="ระยะเวลาส่งมอบ" value={daysText(effectiveLeadTimeDays)} />
        </dl>
      </CardContent>
    </Card>
  );
}

function Line({
  label,
  value,
  strong = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={strong ? 'font-semibold' : 'text-muted-foreground'}>{label}</dt>
      <dd className={`font-mono tabular-nums ${strong ? 'text-base font-semibold' : ''}`}>{value}</dd>
    </div>
  );
}
