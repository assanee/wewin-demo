'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { TaxCountryWire } from '@wewin/contract/tax';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
import { SelectField, TextField } from '@/components/products/form-field';
import { failureMessage } from '@/lib/api/errors';

import { createTaxCountry, patchTaxCountry } from './organisation-api';
import {
  basisLabelTh,
  fieldsFromTaxCountry,
  fxCurrencyOptions,
  rateEditable,
  readRateBp,
  taxCountryCreateFormErrors,
  taxCountryCreateFormReady,
  taxCountryCreateRequest,
  taxCountryFormErrors,
  taxCountryFormReady,
  taxCountryPatchRequest,
  treatmentOptions,
  type TaxCountryCreateFields,
  type TaxCountryCreateFormErrors,
} from './tax-country-fields';

const EMPTY: TaxCountryCreateFields = {
  code: '',
  nameTh: '',
  ratePercent: '',
  treatment: 'standard',
  pricesIncludeTax: false,
  fxCurrency: '',
  fxSpreadPercent: '0',
  fxManualRate: '',
};

/**
 * Adding or editing one destination's tax settings.
 *
 * `country === null` to add — the same shape `BankAccountDialog` uses for `account`, and for
 * the same reason: one form, whichever request it ends up sending, rather than two dialogs
 * that would drift the moment a field is added to one and not the other. The state is always
 * shaped as `TaxCountryCreateFields` (edit fields plus `code`), and `code` simply rides along
 * unused while editing — `taxCountryPatchRequest` never reads it, and it is never shown once a
 * row exists.
 *
 * ⚠️ **`code` is validated but not specially confirmed, on purpose.** It is the primary key,
 * an ISO 3166-1 alpha-2 pair, and can never be deleted — see the header of
 * `tax-country-fields.ts`. A typo here is not undone by anything but `ปิดใช้งาน`. I still did
 * not add a type-twice or an "are you sure" step: `bank_accounts` has the identical
 * shape (no delete route, only availability) and `BankAccountDialog` creates one with a plain
 * validated text box and no extra ceremony. What this dialog adds instead is the one thing
 * that precedent does not need — a sentence naming the consequence next to the field — because
 * a stray bank account is invisible to a customer and a stray, *activated* tax-country code is
 * something `GET /destinations` would show them.
 */
export function TaxCountryDialog({
  country,
  onClose,
  onSaved,
}: {
  /** `null` to add a new destination. */
  readonly country: TaxCountryWire | null;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const creating = country === null;
  const [fields, setFields] = useState<TaxCountryCreateFields>(() =>
    country === null ? EMPTY : { code: country.code, ...fieldsFromTaxCountry(country) },
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // Always the create shape — `TaxCountryFormErrors` has no `code`, and this way every access
  // below reads `errors.code` without narrowing on `creating` a second time.
  const errors: TaxCountryCreateFormErrors = creating
    ? taxCountryCreateFormErrors(fields)
    : taxCountryFormErrors(fields);
  const ready = creating ? taxCountryCreateFormReady(fields) : taxCountryFormReady(fields);
  const editableRate = rateEditable(fields.treatment);
  const liveRateBp = readRateBp(fields.ratePercent) ?? 0;

  const setCode = (value: string) => setFields((current) => ({ ...current, code: value }));
  const setNameTh = (value: string) => setFields((current) => ({ ...current, nameTh: value }));
  const setRatePercent = (value: string) => setFields((current) => ({ ...current, ratePercent: value }));

  /*
   * The treatment/rate pairing, decided rather than left to the server's 409 — see
   * `tax-country-fields.ts`'s header. Picking anything but `standard` clears the rate box and
   * disables it in the same click, so the request built below can never be the pair
   * `tax_countries_rate_matches_treatment` refuses — true for a create exactly as for an edit,
   * and arguably more likely here: a fresh row with `zero_rated` picked and a rate still
   * showing whatever the box last held is the single most likely way to hit that 409.
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

  const setFxSpreadPercent = (value: string) =>
    setFields((current) => ({ ...current, fxSpreadPercent: value }));
  const setFxManualRate = (value: string) =>
    setFields((current) => ({ ...current, fxManualRate: value }));

  /*
   * Dropping the currency clears the override in the same click, the same shape `setTreatment`
   * above clears the rate box — and for the same reason. `tax_countries_fx_manual_rate_needs_
   * currency` refuses an override with no currency, and a box left holding "35.90" under a
   * picker that now says "ไม่แปลงสกุลเงิน" is the single most likely way to meet that 409. The
   * spread is deliberately *not* cleared: it is inert without a currency, not wrong, and
   * keeping it means choosing a currency again restores the policy that was already decided.
   */
  const setFxCurrency = (value: string) => {
    setFields((current) => ({
      ...current,
      fxCurrency: value,
      fxManualRate: value === '' ? '' : current.fxManualRate,
    }));
  };

  const convertsCurrency = fields.fxCurrency !== '';

  async function submit(): Promise<void> {
    if (!ready) return;
    setBusy(true);
    setProblem(null);
    try {
      if (country === null) {
        await createTaxCountry(taxCountryCreateRequest(fields));
      } else {
        await patchTaxCountry(country.code, taxCountryPatchRequest(fields));
      }
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
          <DialogTitle>
            {country === null ? 'เพิ่มประเทศปลายทาง' : `แก้ไขภาษี — ${country.nameTh}`}
          </DialogTitle>
          <DialogDescription>
            {country === null
              ? 'ประเทศนี้จะปรากฏเป็นตัวเลือกปลายทางทันทีที่เปิดใช้งาน — ตรวจรหัสประเทศให้ถูกต้องก่อนบันทึก เพราะแก้ไขและลบไม่ได้ในภายหลัง'
              : `รหัสประเทศ ${country.code} — การแก้ไขจะถูกบันทึกไว้ในประวัติของประเทศนี้ พร้อมผู้แก้และเวลาที่แก้`}
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

          {creating && (
            <TextField
              label="รหัสประเทศ"
              description="ตัวอักษร A-Z สองตัวตามมาตรฐาน ISO 3166-1 เช่น SG, VN — เปลี่ยนและลบไม่ได้หลังบันทึก ทำได้แต่ปิดใช้งาน"
              value={fields.code}
              onChange={setCode}
              error={errors.code}
              mono
              disabled={busy}
              placeholder="SG"
            />
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

          {/*
            The exchange-rate settings. Nothing converts a quotation yet — the arithmetic lives
            in `@wewin/core/fx` and is unwired on purpose — so these are settings being decided
            ahead of the screen that will use them, which is why the descriptions say what each
            one *means* rather than what it will look like.
          */}
          <div className="border-border/60 flex flex-col gap-4 border-t pt-4">
            <SelectField
              label="สกุลเงินปลายทาง"
              description="สกุลเงินที่ใช้เสนอราคาลูกค้าประเทศนี้ — เลือก “ไม่แปลงสกุลเงิน” หากเสนอราคาเป็นบาทเท่านั้น"
              value={fields.fxCurrency}
              onChange={setFxCurrency}
              options={fxCurrencyOptions()}
              disabled={busy}
            />

            <TextField
              label="ส่วนต่างอัตราแลกเปลี่ยน"
              description={
                convertsCurrency
                  ? 'อัตรากลางตลาดไม่ใช่อัตราที่ธนาคารให้จริง — ส่วนต่างนี้จะถูกหักออกจากอัตรากลางก่อนคำนวณ เช่น 2% ทำให้ 36.50 กลายเป็น 35.77 บาท/USD'
                  : 'เลือกสกุลเงินปลายทางก่อน จึงจะมีผล'
              }
              value={fields.fxSpreadPercent}
              onChange={setFxSpreadPercent}
              error={errors.fxSpreadPercent}
              suffix="%"
              mono
              disabled={busy || !convertsCurrency}
            />

            <TextField
              label="อัตราแลกเปลี่ยนกำหนดเอง"
              description={
                convertsCurrency
                  ? `บาทต่อ 1 ${fields.fxCurrency} เช่น 35.90 — เว้นว่างไว้เพื่อใช้อัตรากลางตลาด ⚠️ หากกรอกช่องนี้ ระบบจะใช้อัตรานี้ตรง ๆ และจะไม่หักส่วนต่างข้างบนอีก เพราะอัตราที่ธนาคารเสนอรวมส่วนต่างของธนาคารไว้แล้ว`
                  : 'เลือกสกุลเงินปลายทางก่อน จึงจะกรอกได้'
              }
              value={fields.fxManualRate}
              onChange={setFxManualRate}
              error={errors.fxManualRate}
              mono
              disabled={busy || !convertsCurrency}
              placeholder="35.90"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !ready}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {creating ? 'เพิ่มประเทศ' : 'บันทึก'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
