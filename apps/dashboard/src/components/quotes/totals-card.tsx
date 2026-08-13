'use client';

import { CalendarClock, Coins, TriangleAlert, Undo2, UserPen } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

import { daysText } from './amounts';
import {
  FX_PREVIEW_BADGE_TH,
  FX_PREVIEW_NOT_BINDING_TH,
  FX_STALE_POINTS_TH,
  fxAmountTh,
  fxRateTh,
  fxStaleTitleTh,
  fxUnavailableNoteTh,
} from './fx-preview';
import { concessionText, type OverrideContext } from './override-entry';
import { Figure, overrideTitle } from './provenance';
import { vatLabelTh } from './quote-alerts';
import { revokeOverride } from './quote-api';
import { thbMinorOf, type QuoteFxPreviewWire } from './quote-wire';
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
 *
 * ### The destination-currency figure is an annotation on the baht total, not a second total
 *
 * `sales.fxPreview` is rendered below the grand total and deliberately *beneath* it in every
 * visual sense: smaller, muted, monospace but never bold, and never in the primary colour. The
 * paragraph above is why — the baht grand total is the one figure the rest of the system refers
 * to, and a foreign figure that looked equally settled would be a second candidate for
 * "the price" on the one screen where somebody is deciding what to promise. The pinned quotation
 * inverts this (there the destination currency *is* the document and baht is the settlement
 * note); until submit freezes a rate there is nothing to invert for, so the annotation says so
 * in as many words.
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
        <CardTitle className="type-section">ยอดรวม</CardTitle>
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
          /*
           * ⚠️ The rate beside a figure is a claim about *whose* rate it is, and on an order
           * naming a country the server could not resolve that claim is false — the money came
           * back at the default rule. Said here rather than by changing `vatLabelTh`, which the
           * customer's own document renders too: a staff warning must not reach that page.
           */
          hint={
            view.unrecognisedDestination === null
              ? 'คำนวณจากฐานภาษี ไม่มีช่องให้กรอก'
              : 'อัตราเริ่มต้น ไม่ใช่อัตราของประเทศปลายทางที่ระบุไว้ — ดูคำเตือนด้านบน'
          }
          value={<Figure minor={vatMinor} provenance={{ kind: 'computed' }} />}
        />

        <Separator />

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col">
            <span className="type-body font-semibold">ยอดรวมสุทธิ (รวม VAT)</span>
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

        {/*
         * Read straight off the wire rather than folded into `QuoteView`. `quote-model.ts`'s
         * header swears it *"joins and compares, it does not price"*, and a conversion is
         * pricing — so the one thing that would have to happen there is the one thing it says it
         * does not do. `null` for a customer audience (`sales` is null) and for every domestic
         * quotation (`fxPreview` is null), and the component renders nothing in both cases.
         */}
        <FxPreviewNote preview={view.wire.sales?.fxPreview ?? null} />

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

/**
 * ⭐ Roughly what the customer pays in their own money — and, when there is no usable rate,
 * why there is no figure.
 *
 * ### Everything about this is quieter than the baht total, on purpose
 *
 * The grand total above renders through `Figure` at `text-lg`; this renders at `text-sm` in
 * `text-muted-foreground` with no box, no strike-through and no fill. `provenance.tsx` spends
 * `variant="default"` — the primary colour — exactly once on this screen, on the override badge,
 * and says why: *"primary is spent once, on the thing the screen exists for"*. An indicative
 * conversion is emphatically not that thing, so the badge here is `outline`, the same variant
 * `customer-document.tsx` uses for its own ตัวอย่าง marker.
 *
 * ### The stale arm shows the figure **and** the refusal
 *
 * `stale: true` is the server saying the submit will refuse this quotation. Both facts are shown
 * because a salesperson needs both: hiding the figure leaves them unable to answer *"roughly how
 * much?"*, and hiding the refusal lets them promise a price that cannot be issued. The treatment
 * is `UnrecognisedDestinationBanner`'s — a destructive alert for a 422 that has **not happened
 * yet** — because it is the same class of fact seen at the same moment, and giving it a second
 * visual language would make one of the two look less real than the other.
 *
 * Nothing here disables a control. The refusal lives in apps/api, and a gate computed on this
 * screen is what `QuoteView.hasStaleBaselines`' own note forbids.
 */
function FxPreviewNote({ preview }: { readonly preview: QuoteFxPreviewWire | null }) {
  /* No destination currency at all — the ordinary domestic quotation. Nothing to annotate. */
  if (preview === null) return null;

  if (!preview.available) {
    const note = fxUnavailableNoteTh(preview.currency, preview.reason);

    /*
     * `undefined` rather than the literal `'default'` on the non-blocking arm. `Alert`'s default
     * variant is `bg-card` and carries no primary colour, so nothing here competes with the
     * override badge — but `provenance.tsx`'s house rule about spending primary exactly once is
     * checked by reading for `variant="default"`, and a spelling that trips that read costs a
     * reviewer the time to work out it was a different component's variant.
     */
    return (
      <Alert variant={note.blocking ? 'destructive' : undefined}>
        <Coins />
        <AlertTitle>{note.titleTh}</AlertTitle>
        <AlertDescription>{note.detailTh}</AlertDescription>
      </Alert>
    );
  }

  const amount = fxAmountTh(preview.currency, preview.grandTotalMinor);
  const rate = fxRateTh(preview);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="inline-flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Coins className="size-4" />
            ยอดโดยประมาณสกุล {preview.currency}
            <Badge variant="outline">{FX_PREVIEW_BADGE_TH}</Badge>
          </span>
          {rate === null ? null : <span className="text-xs text-muted-foreground">{rate}</span>}
        </div>
        {/*
         * A dash rather than nothing when the amount will not render: `available: true` with a
         * `grandTotalMinor` this build cannot scale — a currency with no exponent here, a field
         * that is not digits — is a disagreement with the server worth seeing, and the rate line
         * beside it still tells a person what to ask about.
         */}
        <span className="font-mono text-sm text-muted-foreground tabular-nums">
          {amount ?? '—'}
        </span>
      </div>

      <span className="text-xs text-muted-foreground">{FX_PREVIEW_NOT_BINDING_TH}</span>

      {!preview.stale ? null : (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>{fxStaleTitleTh(preview.currency, preview.ageHours)}</AlertTitle>
          <AlertDescription>
            <ul className="flex list-disc flex-col gap-1 ps-4">
              {FX_STALE_POINTS_TH.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
    </div>
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
