'use client';

import { CalendarClock, Undo2, UserPen } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

import { daysText } from './amounts';
import { concessionText, type OverrideContext } from './override-entry';
import { Figure, overrideTitle } from './provenance';
import { vatLabelTh } from './quote-alerts';
import { revokeOverride } from './quote-api';
import { thbMinorOf } from './quote-wire';
import type { QuoteView } from './quote-model';
import type { QuoteWriteFn } from './authority-panel';

/**
 * The document's own figures: subtotal, VAT, grand total, lead time.
 *
 * ### There is no box for the VAT amount, here or anywhere in this folder
 *
 * Plan 4.4 draws the line and this card is where a reader can see it drawn. Editable: the
 * rate, the treatment, and whether each line is taxable (that checkbox lives on the line).
 * Not editable: the **amount**, which is derived and never entered — because a VAT figure a
 * salesperson can type is a ภ.พ.30 filing base a salesperson can type. So VAT renders as a
 * plain computed figure with the rate spelled out beside it, and the only way to move it is to
 * move something it is derived from.
 *
 * ### One anchor for the document, and it is the grand total
 *
 * Plan 7.9(ข) collapses "document discount" and "document total" into one: two editable fields
 * with an arithmetic relationship produce "which one wins?" at every endpoint. Typing −5% is
 * still possible — it is an *entry mode*, recorded verbatim — and what gets stored is the
 * absolute grand total it produced. The net total is deliberately not an anchor either:
 * editing net while grand is the base would set the VAT amount by the back door, which is
 * exactly what the paragraph above forbids.
 *
 * ⚠️ `grand_total_thb_minor` is the single base for the whole system — instalments, the
 * deposit, forfeits, refunds and the ledger all refer to it and to nothing else (plan 7.13),
 * and it always includes VAT.
 */
export function TotalsCard({
  view,
  orderId,
  busy,
  mayWrite,
  onWrite,
  onOverride,
}: {
  readonly view: QuoteView;
  readonly orderId: string;
  readonly busy: boolean;
  readonly mayWrite: boolean;
  readonly onWrite: QuoteWriteFn;
  readonly onOverride: (context: OverrideContext, subjectTh: string) => void;
}) {
  const { money, computedLeadTimeDays, effectiveLeadTimeDays } = view.wire;
  const net = thbMinorOf(money.netThbMinor);
  const vatMinor = thbMinorOf(money.vatThbMinor);
  const grand = thbMinorOf(money.grandTotalThbMinor);
  const taxable = thbMinorOf(money.taxableNetThbMinor);
  const exempt = thbMinorOf(money.exemptNetThbMinor);

  const grandOverride = view.grandTotalOverride;
  const grandBaseline =
    grandOverride === null || grandOverride.computedThbMinor === null
      ? null
      : thbMinorOf(grandOverride.computedThbMinor);
  const leadOverride = view.leadTimeOverride;
  const disabled = !mayWrite || busy;

  return (
    <Card>
      <CardHeader>
        <CardTitle>ยอดรวม</CardTitle>
        <CardDescription>
          ยอดรวมสุทธิรวม VAT เสมอ — เป็นยอดเดียวที่งวดชำระ มัดจำ การริบ และการคืนเงินอ้างถึง
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-2">
        <Row label="ฐานภาษี (net)" value={<Figure minor={net} provenance={{ kind: 'computed' }} />} />
        {exempt === 0n ? null : (
          <>
            <Row
              label="ส่วนที่คิดภาษี"
              value={<Figure minor={taxable} provenance={{ kind: 'computed' }} />}
            />
            <Row
              label="ส่วนที่ไม่คิดภาษี"
              hint="รายการที่ปลดเครื่องหมาย “คิด VAT” ไว้"
              value={<Figure minor={exempt} provenance={{ kind: 'computed' }} />}
            />
          </>
        )}
        <Row
          label={vatLabelTh(money.vat.rateBp, money.vat.treatment)}
          hint="คำนวณจากฐานภาษี ไม่มีช่องให้กรอก"
          value={<Figure minor={vatMinor} provenance={{ kind: 'computed' }} />}
        />

        <Separator />

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col">
            <span className="text-base font-semibold">ยอดรวมสุทธิ (รวม VAT)</span>
            <span className="text-xs text-muted-foreground">ยอดที่ลูกค้าโอนจริง</span>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Figure
              minor={grand}
              className="text-lg"
              provenance={
                grandOverride === null
                  ? { kind: 'computed' }
                  : { kind: 'overridden', override: grandOverride }
              }
              {...(grandBaseline === null ? {} : { baselineMinor: grandBaseline })}
            />
            {grandOverride === null || grandBaseline === null ? null : (
              <span className="text-xs text-muted-foreground" title={overrideTitle(grandOverride)}>
                {concessionText(grandBaseline, grand)}
              </span>
            )}
            {!view.showsProvenance ? null : grandOverride === null ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => onOverride({ anchor: 'grand_total', computedThbMinor: grand }, 'ยอดรวมทั้งใบ')}
              >
                <UserPen data-icon="inline-start" />
                แก้ยอดรวม
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => {
                  void onWrite('ยกเลิกการแก้ยอดรวมแล้ว', (expect) =>
                    revokeOverride(orderId, grandOverride.id, expect),
                  );
                }}
              >
                <Undo2 data-icon="inline-start" />
                คืนยอดที่คำนวณ
              </Button>
            )}
          </div>
        </div>

        <Separator />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 text-sm">
            <CalendarClock className="size-4" />
            ระยะเวลาส่งมอบ
          </span>
          <div className="flex items-center gap-2">
            {leadOverride === null ? (
              <span className="font-mono tabular-nums">{daysText(effectiveLeadTimeDays)}</span>
            ) : (
              <span className="inline-flex items-baseline gap-2">
                <span className="font-mono text-muted-foreground line-through tabular-nums">
                  {daysText(computedLeadTimeDays)}
                </span>
                <span
                  className="rounded-sm bg-primary px-1.5 py-0.5 font-mono font-semibold text-primary-foreground tabular-nums"
                  title={overrideTitle(leadOverride)}
                >
                  {daysText(effectiveLeadTimeDays)}
                </span>
              </span>
            )}

            {!view.showsProvenance ? null : leadOverride === null ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() =>
                  onOverride(
                    { anchor: 'lead_time_days', computedDays: computedLeadTimeDays },
                    'ระยะเวลาส่งมอบ',
                  )
                }
              >
                <UserPen data-icon="inline-start" />
                แก้
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => {
                  void onWrite('ยกเลิกการแก้ระยะเวลาแล้ว', (expect) =>
                    revokeOverride(orderId, leadOverride.id, expect),
                  );
                }}
              >
                <Undo2 data-icon="inline-start" />
                คืนค่าเดิม
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Row({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly hint?: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3 text-sm">
      <span className="text-muted-foreground">
        {label}
        {hint === undefined ? null : <span className="ms-2 text-xs">{hint}</span>}
      </span>
      {value}
    </div>
  );
}
