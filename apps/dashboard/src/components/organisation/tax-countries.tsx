'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, History, Loader2, Pencil } from 'lucide-react';
import type { TaxCountryWire } from '@wewin/contract/tax';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SelectField, TextField } from '@/components/products/form-field';
import { vatLabelTh } from '@/components/quotes/quote-alerts';
import { failureMessage } from '@/lib/api/errors';

import { listTaxCountryChanges, patchTaxCountry, setTaxCountryAvailability, type TaxCountryChangeRow } from './organisation-api';
import {
  basisLabelTh,
  fieldsFromTaxCountry,
  isTaxCountryCreation,
  rateEditable,
  readRateBp,
  taxCountryChangedFields,
  taxCountryFormErrors,
  taxCountryFormReady,
  taxCountryPatchRequest,
  treatmentOptions,
  type TaxCountryFields,
} from './tax-country-fields';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The destinations a quotation may tax, and the one rule per destination.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Read-only for anyone with `organisation.read` — the withdrawn rows included, same as the
 * bank-account list, so an administrator auditing "which destinations did we stop selling
 * VAT-registered to, and when" can see the row and not just the active ones. Editing,
 * withdrawing and restoring are each gated by `editable`, exactly the pattern
 * `organisation-screen.tsx`'s `AccountsCard` already sets for its own three write controls.
 *
 * ⚠️ **No "add a country" control here.** `0029_tax_countries.sql`'s own seed comment says
 * why: "a foreign rate is a tax registration somebody has to actually hold — seeding one would
 * put an unverified number where it looks verified." A new destination is a real tax
 * registration a person somewhere has to hold before this screen may say it exists; that is
 * not a form. `organisation-api.ts`'s own header repeats this for the same reason it matters
 * to a reader of *that* file too.
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
  const [editing, setEditing] = useState<TaxCountryWire | null>(null);
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
        <CardTitle>ประเทศปลายทางและภาษีมูลค่าเพิ่ม</CardTitle>
        <CardDescription>
          อัตราภาษี ประเภทการคำนวณ และฐานราคาของแต่ละประเทศปลายทาง — ใบเสนอราคาใช้ค่าเหล่านี้คำนวณภาษีให้อัตโนมัติตามปลายทางที่ลูกค้าเลือก
        </CardDescription>
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
                          <Button variant="ghost" size="sm" onClick={() => setEditing(country)}>
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

      {editing !== null && (
        <TaxCountryDialog
          country={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
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

/* ------------------------------------------------------------------ *
 * Editing one destination's tax settings
 * ------------------------------------------------------------------ */

function TaxCountryDialog({
  country,
  onClose,
  onSaved,
}: {
  readonly country: TaxCountryWire;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const [fields, setFields] = useState<TaxCountryFields>(() => fieldsFromTaxCountry(country));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const errors = taxCountryFormErrors(fields);
  const ready = taxCountryFormReady(fields);
  const editableRate = rateEditable(fields.treatment);
  const liveRateBp = readRateBp(fields.ratePercent) ?? 0;

  const setNameTh = (value: string) => setFields((current) => ({ ...current, nameTh: value }));
  const setRatePercent = (value: string) => setFields((current) => ({ ...current, ratePercent: value }));

  /*
   * The treatment/rate pairing, decided rather than left to the server's 409 — see
   * `tax-country-fields.ts`'s header. Picking anything but `standard` clears the rate box and
   * disables it in the same click, so the request `taxCountryPatchRequest` builds can never be
   * the pair `tax_countries_rate_matches_treatment` refuses.
   */
  const setTreatment = (value: string) => {
    setFields((current) => ({
      ...current,
      treatment: value,
      ratePercent: rateEditable(value) ? current.ratePercent : '0',
    }));
  };

  const setPricesIncludeTax = (checked: boolean) =>
    setFields((current) => ({ ...current, pricesIncludeTax: checked }));

  async function submit(): Promise<void> {
    if (!ready) return;
    setBusy(true);
    setProblem(null);
    try {
      await patchTaxCountry(country.code, taxCountryPatchRequest(fields));
      onSaved();
    } catch (cause) {
      setProblem(failureMessage(cause));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>แก้ไขภาษี — {country.nameTh}</DialogTitle>
          <DialogDescription>
            รหัสประเทศ {country.code} — การแก้ไขจะถูกบันทึกไว้ในประวัติของประเทศนี้ พร้อมผู้แก้และเวลาที่แก้
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {problem !== null && (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle>บันทึกไม่สำเร็จ</AlertTitle>
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          )}

          <TextField label="ชื่อประเทศ" value={fields.nameTh} onChange={setNameTh} disabled={busy} />

          <SelectField
            label="ประเภทภาษี"
            value={fields.treatment}
            onChange={setTreatment}
            options={treatmentOptions(liveRateBp)}
            disabled={busy}
          />

          <TextField
            label="อัตราภาษี"
            description={
              editableRate
                ? 'เปอร์เซ็นต์ ทศนิยมไม่เกิน 2 ตำแหน่ง เช่น 7 หรือ 7.5'
                : 'ล็อกไว้ที่ 0% เพราะประเภทภาษีนี้ต้องมีอัตราภาษีเป็น 0 เสมอ'
            }
            value={fields.ratePercent}
            onChange={setRatePercent}
            error={errors.ratePercent}
            suffix="%"
            mono
            disabled={busy || !editableRate}
          />

          <div className="flex items-start gap-3">
            <Checkbox
              id="prices-include-tax"
              checked={fields.pricesIncludeTax}
              onCheckedChange={(next) => setPricesIncludeTax(next === true)}
              disabled={busy}
            />
            <div className="flex flex-col gap-1">
              <Label htmlFor="prices-include-tax">ราคาที่ลูกค้าเห็นรวมภาษีแล้ว</Label>
              <p className="text-muted-foreground text-sm">{basisLabelTh(fields.pricesIncludeTax)}</p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !ready}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            บันทึก
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ *
 * The change history — same reader shape `BankAccountHistoryDialog` renders
 * ------------------------------------------------------------------ */

const at = (iso: string): string =>
  new Date(iso).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

type HistoryState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly problem: string }
  | { readonly status: 'ready'; readonly changes: readonly TaxCountryChangeRow[] };

function TaxCountryHistoryDialog({
  country,
  onClose,
}: {
  readonly country: TaxCountryWire;
  readonly onClose: () => void;
}) {
  const [state, setState] = useState<HistoryState>({ status: 'loading' });

  useEffect(() => {
    let live = true;

    void (async () => {
      try {
        const changes = await listTaxCountryChanges(country.code);
        if (live) setState({ status: 'ready', changes });
      } catch (cause) {
        if (live) setState({ status: 'failed', problem: failureMessage(cause) });
      }
    })();

    return () => {
      live = false;
    };
  }, [country.code]);

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>ประวัติการแก้ไข — {country.nameTh}</DialogTitle>
          <DialogDescription>
            รหัสประเทศ {country.code} — บันทึกทุกครั้งที่มีการแก้ไข พร้อมผู้แก้และเวลา แก้ไขหรือลบภายหลังไม่ได้
          </DialogDescription>
        </DialogHeader>

        {state.status === 'loading' && (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}

        {state.status === 'failed' && (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" />
            <AlertTitle>โหลดประวัติไม่สำเร็จ</AlertTitle>
            <AlertDescription>{state.problem}</AlertDescription>
          </Alert>
        )}

        {state.status === 'ready' && state.changes.length === 0 && (
          <p className="text-muted-foreground text-sm">ยังไม่มีประวัติการแก้ไขของประเทศนี้</p>
        )}

        {state.status === 'ready' && state.changes.length > 0 && (
          <ol className="flex flex-col gap-3">
            {state.changes.map((change) => {
              const creation = isTaxCountryCreation(change);
              return (
                <li key={change.id} className="border-border/60 rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{creation ? 'เพิ่มประเทศ' : 'แก้ไขข้อมูลภาษี'}</span>
                    <span className="text-muted-foreground text-xs">{at(change.changedAt)}</span>
                  </div>

                  <p className="text-muted-foreground mt-0.5 text-xs">
                    โดย{' '}
                    {change.changedByUserId === null
                      ? 'ระบบ'
                      : `ผู้ใช้ ${change.changedByUserId.slice(0, 8)}`}
                  </p>

                  <dl className="mt-2 flex flex-col gap-1">
                    {taxCountryChangedFields(change).map((field) => (
                      <div key={field.key} className="flex flex-wrap items-baseline gap-2">
                        <dt className="text-muted-foreground w-24 shrink-0">{field.labelTh}</dt>
                        <dd className="flex flex-wrap items-baseline gap-1.5 font-mono text-xs">
                          {!creation && (
                            <>
                              <span className="text-muted-foreground">
                                จาก <span className="line-through">{field.beforeText}</span>
                              </span>
                              <span aria-hidden>→</span>
                              <span className="text-muted-foreground">เป็น</span>
                            </>
                          )}
                          <span>{field.afterText}</span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </li>
              );
            })}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}
