'use client';

import { useState } from 'react';
import { AlertTriangle, History, Loader2, Pencil, Plus } from 'lucide-react';
import type { TaxCountryWire } from '@wewin/contract/tax';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { vatLabelTh } from '@/components/quotes/quote-alerts';
import { failureMessage } from '@/lib/api/errors';

import { setTaxCountryAvailability } from './organisation-api';
import { basisLabelTh, fxSummaryTh } from './tax-country-fields';
import { TaxCountryDialog } from './tax-country-dialog';
import { TaxCountryHistoryDialog } from './tax-country-history';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The destinations a quotation may tax, and the one rule per destination.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Read-only for anyone with `organisation.read` — the withdrawn rows included, same as the
 * bank-account list, so an administrator auditing "which destinations did we stop selling
 * VAT-registered to, and when" can see the row and not just the active ones. Adding, editing,
 * withdrawing and restoring are each gated by `editable`, exactly the pattern
 * `organisation-screen.tsx`'s `AccountsSection` already sets for its own three write controls —
 * `เพิ่มประเทศ` mirrors `AccountsSection`'s own `เพิ่มบัญชี` down to the `dialog: 'create' |
 * TaxCountryWire | null` state shape.
 *
 * Split the same way this feature's own precedent already splits: `bank-account-dialog.tsx`
 * (163 lines) and `bank-account-history.tsx` (160 lines) sit beside `organisation-screen.tsx`
 * rather than inside it. `TaxCountryDialog` (`./tax-country-dialog`, add *and* edit — see its
 * own header for why one dialog rather than two) and `TaxCountryHistoryDialog`
 * (`./tax-country-history`) are this table's siblings of those two.
 *
 * ── ⚠️ The `Card` is gone, and this one was the easiest of the four to decide ─
 *
 * The section's whole content is a `<Table>`. A table is already a grid of rules — it has every
 * edge it needs — so a ring around it draws a border around a border, which the README states as
 * a rule rather than a preference. What is left is the same rows on the page ground, tighter
 * (`px-2 py-1.5` cells, `h-8 type-caption` heads), under a `type-section` heading carrying the
 * sentence that used to be the `CardDescription`.
 *
 * ⚠️ **Its position on the page moved, and that was not cosmetic.** It sits directly under the
 * exchange-rate band because `fxHealthRemedyTh` sends a reader to *this table* by name — the way
 * out of a stale rate is `อัตราแลกเปลี่ยนกำหนดเอง` on a destination row here. See
 * `organisation-screen.tsx`'s header.
 */

export type TaxCountriesState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly problem: string }
  | { readonly status: 'ready'; readonly taxCountries: readonly TaxCountryWire[] };

export default function TaxCountriesSection({
  state,
  editable,
  onChanged,
}: {
  readonly state: TaxCountriesState;
  readonly editable: boolean;
  readonly onChanged: () => Promise<void>;
}) {
  const [dialog, setDialog] = useState<'create' | TaxCountryWire | null>(null);
  const [historyOf, setHistoryOf] = useState<TaxCountryWire | null>(null);
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function toggle(country: TaxCountryWire): Promise<void> {
    setPendingCode(country.code);
    setProblem(null);
    try {
      await setTaxCountryAvailability(country.code, !country.isActive);
      await onChanged();
    } catch (cause) {
      setProblem(failureMessage(cause));
    } finally {
      setPendingCode(null);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="type-section">ประเทศปลายทางและภาษีมูลค่าเพิ่ม</h2>
          <p className="text-muted-foreground type-body max-w-3xl">
            {/*
              ⚠️ The second sentence used to read *"ส่วนการตั้งค่าอัตราแลกเปลี่ยนบันทึกไว้แล้วแต่ยังไม่
              ถูกนำไปใช้กับใบเสนอราคา"* — the fx settings are recorded but not yet applied to
              quotations. That was true when the columns were added ahead of a consumer and false
              from the moment `QuotationRateService` started pricing with them. It was the most
              misleading sentence on the page: a member of staff reading it would take
              `fxManualRate` for a note-to-self, when it is in fact the field that decides what a
              customer is charged — and, since this round, the only way to issue a foreign-currency
              quotation while the rate feed is stale.
            */}
            อัตราภาษี ประเภทการคำนวณ และฐานราคาของแต่ละประเทศปลายทาง — ใบเสนอราคาใช้ค่าเหล่านี้คำนวณภาษีให้อัตโนมัติตามปลายทางที่ลูกค้าเลือก
            ส่วนการตั้งค่าอัตราแลกเปลี่ยนถูกนำไปใช้จริงกับใบเสนอราคาที่เสนอเป็นสกุลเงินต่างประเทศ และ &ldquo;อัตราแลกเปลี่ยนกำหนดเอง&rdquo;
            จะใช้แทนอัตรากลางตลาดทันทีโดยไม่ติดเงื่อนไขความเก่าของอัตรา
          </p>
        </div>
        {editable && (
          <Button size="sm" onClick={() => setDialog('create')}>
            <Plus className="size-4" />
            เพิ่มประเทศ
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-3">
        {problem !== null && (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" />
            <AlertTitle>ทำรายการไม่สำเร็จ</AlertTitle>
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        )}

        {state.status === 'loading' && <Skeleton className="h-40 w-full" />}

        {state.status === 'failed' && (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" />
            <AlertTitle>โหลดข้อมูลประเทศปลายทางไม่สำเร็จ</AlertTitle>
            <AlertDescription>{state.problem}</AlertDescription>
          </Alert>
        )}

        {state.status === 'ready' && state.taxCountries.length === 0 && (
          <p className="text-muted-foreground type-body">ยังไม่มีประเทศปลายทางที่ตั้งค่าไว้</p>
        )}

        {state.status === 'ready' && state.taxCountries.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="type-caption h-8">รหัส</TableHead>
                <TableHead className="type-caption h-8">ประเทศ</TableHead>
                <TableHead className="type-caption h-8">ภาษี</TableHead>
                <TableHead className="type-caption h-8">ฐานราคา</TableHead>
                <TableHead className="type-caption h-8">อัตราแลกเปลี่ยน</TableHead>
                <TableHead className="type-caption h-8">สถานะ</TableHead>
                {/* `w-full` on the last column so the slack lands in the button column rather than
                    being shared out between the six data ones. See `order-list.tsx`. */}
                <TableHead className="type-caption h-8 w-full text-right">การจัดการ</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.taxCountries.map((country) => (
                <TableRow key={country.code} className={country.isActive ? undefined : 'opacity-60'}>
                  <TableCell className="type-body px-2 py-1.5 font-mono">{country.code}</TableCell>
                  <TableCell className="type-body px-2 py-1.5">{country.nameTh}</TableCell>
                  <TableCell className="type-body px-2 py-1.5">
                    {vatLabelTh(country.rateBp, country.treatment)}
                  </TableCell>
                  <TableCell className="type-body px-2 py-1.5">
                    {basisLabelTh(country.pricesIncludeTax)}
                  </TableCell>
                  <TableCell className="type-body px-2 py-1.5">{fxSummaryTh(country)}</TableCell>
                  <TableCell className="px-2 py-1.5">
                    {country.isActive ? (
                      <Badge variant="outline">ใช้งาน</Badge>
                    ) : (
                      <Badge variant="destructive">ปิดใช้งาน</Badge>
                    )}
                  </TableCell>
                  <TableCell className="px-2 py-1.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setHistoryOf(country)}>
                        <History className="size-4" />
                        ประวัติ
                      </Button>

                      {editable && (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => setDialog(country)}>
                            <Pencil className="size-4" />
                            แก้ไข
                          </Button>
                          <Button
                            variant={country.isActive ? 'destructive' : 'secondary'}
                            size="sm"
                            disabled={pendingCode === country.code}
                            onClick={() => void toggle(country)}
                          >
                            {pendingCode === country.code && <Loader2 className="size-4 animate-spin" />}
                            {country.isActive ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}
                          </Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {dialog !== null && (
        <TaxCountryDialog
          country={dialog === 'create' ? null : dialog}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void onChanged();
          }}
        />
      )}

      {historyOf !== null && (
        <TaxCountryHistoryDialog country={historyOf} onClose={() => setHistoryOf(null)} />
      )}
    </section>
  );
}
