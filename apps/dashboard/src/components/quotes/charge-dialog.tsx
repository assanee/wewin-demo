'use client';

import { useState } from 'react';

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
import { TextField } from '@/components/products/form-field';

import { baht, readCharge } from './amounts';

/**
 * A line that maps to no product: delivery, installation, a site survey, a goodwill credit.
 *
 * ### Why this is not the override dialog with a different title
 *
 * A free-form charge has **no computed baseline**. There was never a machine figure to concede
 * against, so the amount here is a baseline in its own right — `charge_total_thb_minor` in the
 * schema, deliberately not stored in the column called "computed", and a route of its own in
 * apps/api rather than a `kind` flag. `quote-model.ts` renders it as its own provenance
 * (`typed`) for exactly this reason: counting a ฿2,000 delivery charge as a discount taken
 * against ฿0 is the arithmetic that follows from treating the two as one thing.
 *
 * ### The amount goes up as text, and the number below the box is a preview
 *
 * `amountText` is what the request carries — verbatim, the same way an override's
 * `enteredValueText` is — and the server parses it. `readCharge` runs here so a person sees
 * ฿2,000 rather than a 400, and so a typo is caught under the box; it is not what gets stored.
 *
 * ### A negative amount is allowed and is the interesting case
 *
 * "ส่วนลดพิเศษ −฿1,000" is a legitimate line, and plan 7.13 names it: a negative charge is one
 * of the things the `margin` dimension has to catch, because it is a discount wearing a
 * different hat. So the box accepts a minus sign and the preview says which way the money
 * goes. What it refuses is ฿0 — mirroring `quote_lines_charge_nonzero`, whose own comment is
 * that a line for nothing is noise somebody still has to read.
 */
export function ChargeDialog({
  open,
  onOpenChange,
  busy,
  onSave,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly busy: boolean;
  readonly onSave: (charge: {
    readonly customerDescriptionTh: string;
    readonly amountText: string;
    readonly isVatApplicable: boolean;
  }) => Promise<boolean>;
}) {
  const [amount, setAmount] = useState('');
  const [descriptionTh, setDescriptionTh] = useState('');
  /*
   * ⚠️ `true` is plan 13's DEFAULT, not a decision. Whether delivery and installation are
   * taxable is on the owner's open list, and the schema column defaults the same way for the
   * same reason. The checkbox is here so that the day the answer arrives it is a click rather
   * than a migration — and so somebody who knows the answer today can already apply it.
   */
  const [isVatApplicable, setIsVatApplicable] = useState(true);

  const parsed = amount.trim() === '' ? null : readCharge(amount);
  const value = parsed !== null && parsed.ok ? parsed.value : null;
  const error = parsed !== null && !parsed.ok ? parsed.reasonTh : undefined;
  const ready = value !== null && descriptionTh.trim() !== '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>เพิ่มรายการอิสระ</DialogTitle>
          <DialogDescription>
            ค่าขนส่ง ค่าติดตั้ง ค่าสำรวจหน้างาน หรือส่วนลดพิเศษ — รายการที่ไม่ผูกกับสินค้าในแคตตาล็อก
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <TextField
            label="คำอธิบายที่ลูกค้าเห็น"
            value={descriptionTh}
            disabled={busy}
            onChange={setDescriptionTh}
            placeholder="เช่น ค่าติดตั้งหน้างาน"
            description="จำเป็น — ค่าใช้จ่าย ฿2,000 ที่ไม่มีคำอธิบายคือยอดที่อธิบายให้ลูกค้าไม่ได้ตอนถูกถาม"
          />
          <TextField
            label="จำนวนเงิน"
            value={amount}
            disabled={busy}
            onChange={setAmount}
            mono
            prefix="฿"
            placeholder="2000 หรือ -1000"
            description="ใส่เครื่องหมายลบเพื่อทำเป็นส่วนลด — ระบบจะนับรวมในเพดานอำนาจอนุมัติเหมือนส่วนลดอื่น"
            {...(error === undefined ? {} : { error })}
          />

          {value === null ? null : (
            <p className="rounded-md bg-muted px-3 py-2 text-sm">
              {value < 0n ? 'ใบนี้จะลดลง' : 'ใบนี้จะเพิ่มขึ้น'}{' '}
              <strong className="font-mono tabular-nums">{baht(value < 0n ? -value : value)}</strong>
              <span className="ms-2 text-xs text-muted-foreground">
                (ตัวอย่าง — เซิร์ฟเวอร์เป็นผู้ตีความข้อความที่กรอก)
              </span>
            </p>
          )}

          <label className="flex flex-wrap items-center gap-2 text-sm">
            <Checkbox
              checked={isVatApplicable}
              disabled={busy}
              onCheckedChange={(checked) => setIsVatApplicable(checked === true)}
            />
            คิด VAT กับรายการนี้
            <span className="text-xs text-muted-foreground">(ค่าตั้งต้น — ยังรอคำตอบจากเจ้าของกิจการ)</span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            ยกเลิก
          </Button>
          <Button
            disabled={!ready || busy}
            onClick={() => {
              void onSave({
                customerDescriptionTh: descriptionTh.trim(),
                /* Verbatim, exactly as `enteredValueText` is on an override. */
                amountText: amount.trim(),
                isVatApplicable,
              }).then((saved) => {
                if (saved) {
                  setAmount('');
                  setDescriptionTh('');
                  onOpenChange(false);
                }
              });
            }}
          >
            เพิ่มรายการ
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
