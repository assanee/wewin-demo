'use client';

import { useState } from 'react';
import { AlertTriangle, History, Loader2, Pencil, Plus } from 'lucide-react';
import type { TaxCountryWire } from '@wewin/contract/tax';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
 * `organisation-screen.tsx`'s `AccountsCard` already sets for its own three write controls —
 * `เพิ่มประเทศ` mirrors `AccountsCard`'s own `เพิ่มบัญชี` down to the `dialog: 'create' |
 * TaxCountryWire | null` state shape.
 *
 * Split the same way this feature's own precedent already splits: `bank-account-dialog.tsx`
 * (163 lines) and `bank-account-history.tsx` (160 lines) sit beside `organisation-screen.tsx`
 * rather than inside it. `TaxCountryDialog` (`./tax-country-dialog`, add *and* edit — see its
 * own header for why one dialog rather than two) and `TaxCountryHistoryDialog`
 * (`./tax-country-history`) are this table's siblings of those two.
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
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>ประเทศปลายทางและภาษีมูลค่าเพิ่ม</CardTitle>
            <CardDescription>
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
            </CardDescription>
          </div>
          {editable && (
            <Button size="sm" onClick={() => setDialog('create')}>
              <Plus className="size-4" />
              เพิ่มประเทศ
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
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
          <p className="text-muted-foreground text-sm">ยังไม่มีประเทศปลายทางที่ตั้งค่าไว้</p>
        )}

        {state.status === 'ready' && state.taxCountries.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>รหัส</TableHead>
                <TableHead>ประเทศ</TableHead>
                <TableHead>ภาษี</TableHead>
                <TableHead>ฐานราคา</TableHead>
                <TableHead>อัตราแลกเปลี่ยน</TableHead>
                <TableHead>สถานะ</TableHead>
                <TableHead className="text-right">การจัดการ</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.taxCountries.map((country) => (
                <TableRow key={country.code} className={country.isActive ? undefined : 'opacity-60'}>
                  <TableCell className="font-mono text-sm">{country.code}</TableCell>
                  <TableCell>{country.nameTh}</TableCell>
                  <TableCell>{vatLabelTh(country.rateBp, country.treatment)}</TableCell>
                  <TableCell>{basisLabelTh(country.pricesIncludeTax)}</TableCell>
                  <TableCell className="text-sm">{fxSummaryTh(country)}</TableCell>
                  <TableCell>
                    {country.isActive ? (
                      <Badge variant="outline">ใช้งาน</Badge>
                    ) : (
                      <Badge variant="destructive">ปิดใช้งาน</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
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
      </CardContent>

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
    </Card>
  );
}
