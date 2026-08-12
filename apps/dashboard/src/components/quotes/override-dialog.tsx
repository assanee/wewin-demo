'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SelectField, TextField } from '@/components/products/form-field';

import { baht, bahtInput, daysText } from './amounts';
import {
  ANCHOR_LABEL_TH,
  ENTRY_MODE_LABEL_TH,
  concessionText,
  preview,
  unitPriceOf,
  type EntryPreview,
  type OverrideContext,
} from './override-entry';
import { REASON_LABEL_TH } from './provenance';
import { setOverride } from './quote-api';
import {
  ENTRY_MODES_BY_ANCHOR,
  OVERRIDE_REASONS_WIRE,
  type OverrideEntryModeWire,
  type OverrideReasonWire,
} from './quote-wire';
import type { QuoteWriteFn } from './authority-panel';

/**
 * The box a person types a price into, and the only place that box exists.
 *
 * ### The per-unit field is offered, and what it writes is the line total
 *
 * The brief says the per-unit box may exist. Plan 7.9(ข) says what happens if it becomes a
 * second *anchor*: qty 2 with a unit price of ฿9,000 and a line total of ฿18,432 set at the
 * same time leaves the quote ฿432 short and makes a 30% deposit wrong from whichever end you
 * take it. So the selector chooses **which box is being typed into**, never how many are
 * written — and the request carries one `enteredAs` and one `enteredValueText`, which is the
 * same constraint expressed in the contract's discriminated union.
 *
 * ### What is sent is the text, not the number under the box
 *
 * The preview is computed here so that "ลด 5%" and "฿8,351.45" are visibly the same act before
 * anybody presses save — which is what makes plan 7.9(ก)'s "absolute, never a delta"
 * self-evident rather than a paragraph somebody has to be told. But the request carries the
 * characters that were typed, and the server resolves them against a baseline it computed
 * itself. If the two disagree, the server is right and the next render says so.
 *
 * ### Everything here refuses before the database has to
 *
 * A value equal to the baseline, a negative price, a percentage over 100, a reason of `other`
 * with no note — each mirrors a CHECK in `packages/db/src/schema/quote.ts` and each is refused
 * under the box in Thai. `override-entry.ts`'s header explains which direction that
 * duplication is allowed to drift in.
 */
export function OverrideDialog({
  open,
  onOpenChange,
  orderId,
  context,
  subjectTh,
  busy,
  onWrite,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly orderId: string;
  readonly context: OverrideContext;
  /** What is being priced, for the dialog subtitle — a description, a sku, or the document. */
  readonly subjectTh: string;
  readonly busy: boolean;
  readonly onWrite: QuoteWriteFn;
}) {
  const modes: readonly OverrideEntryModeWire[] = ENTRY_MODES_BY_ANCHOR[context.anchor];
  const [enteredAs, setEnteredAs] = useState<OverrideEntryModeWire>(modes[0] ?? 'line_total');
  const [text, setText] = useState('');
  const [reasonCode, setReasonCode] = useState<OverrideReasonWire>('price_match');
  const [noteTh, setNoteTh] = useState('');

  /*
   * ⚠️ **No touched-tracking, so a wrong entry is red as it is typed rather than at save.**
   *
   * This read `text.trim() === '' ? null : preview(...)`, which meant an empty box showed nothing
   * and a mistyped one only turned red once something parseable had been in it. The owner's
   * instruction is that anything outside the accepted format goes red immediately —
   * *"ถ้าใส่ผิดให้ขึ้นแดงเลย"* — and discovering the format at submit is the thing being fixed.
   *
   * `organisation/bank-account-dialog.tsx` is the precedent and states the same reasoning: it reads
   * every field out of state "rather than tracking which one the person actually touched", so an
   * empty new-account form opens red with Save already disabled. That is what caught a bad
   * PromptPay id. `ready` is null for every refusal, and the Save button below is disabled on it.
   */
  const parsed = preview(context, enteredAs, text);
  const ready: EntryPreview | null = parsed.ok ? parsed.value : null;
  const error = parsed.ok ? undefined : parsed.reasonTh;
  /* `other` is a prompt for a sentence, not a way past the vocabulary — mirrors the CHECK. */
  const noteMissing = reasonCode === 'other' && noteTh.trim() === '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>แก้{ANCHOR_LABEL_TH[context.anchor]}</DialogTitle>
          <DialogDescription>
            {subjectTh} · ค่าที่ระบบคำนวณได้คือ{' '}
            {context.anchor === 'lead_time_days'
              ? daysText(context.computedDays)
              : baht(context.computedThbMinor)}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {modes.length === 1 ? null : (
            <SelectField
              label="กรอกเป็น"
              description="เลือกช่องที่จะพิมพ์ — ระบบบันทึกเป็นยอดจริงเสมอ แล้วจำไว้ว่าคุณพิมพ์แบบไหน"
              value={enteredAs}
              disabled={busy}
              onChange={(value) => {
                /*
                 * Narrowed against the anchor's own list rather than cast. The select can only
                 * render these values, so a value outside them means somebody changed the list
                 * without changing this — and silently keeping the old mode is what leaves an
                 * entry mode that does not fit its anchor.
                 */
                const next = modes.find((mode) => mode === value);
                if (next !== undefined) setEnteredAs(next);
                setText('');
              }}
              options={modes.map((mode) => ({ value: mode, labelTh: ENTRY_MODE_LABEL_TH[mode] }))}
            />
          )}

          <TextField
            label={ENTRY_MODE_LABEL_TH[enteredAs]}
            value={text}
            disabled={busy}
            onChange={setText}
            mono
            description={DESCRIPTION_TH[enteredAs]}
            {...(enteredAs === 'percent_discount'
              ? /*
                 * The placeholder shows the discount it is: `5` in this box means five percent
                 * *off*, and typing it is now enough — the `%` is appended on the way out. It used
                 * to read `เช่น 5 หรือ 7.5` while the server refused a bare `5` and its 422 replied
                 * `เช่น "-15%"`, which is how a salesperson got talked into the one input that
                 * previewed a surcharge and stored a discount.
                 */
                { suffix: '%', placeholder: 'เช่น 5 = ลด 5% หรือ 7.5 = ลด 7.5%' }
              : enteredAs === 'lead_time_days'
                ? { suffix: 'วัน', placeholder: 'เช่น 30' }
                : { prefix: '฿', placeholder: hintFor(context, enteredAs) })}
            {...(error === undefined ? {} : { error })}
          />

          {ready === null ? null : <Preview context={context} entry={ready} />}

          <SelectField
            label="เหตุผล"
            value={reasonCode}
            disabled={busy}
            onChange={(value) => {
              const next = OVERRIDE_REASONS_WIRE.find((reason) => reason === value);
              if (next !== undefined) setReasonCode(next);
            }}
            options={OVERRIDE_REASONS_WIRE.map((reason) => ({
              value: reason,
              labelTh: REASON_LABEL_TH[reason],
            }))}
          />

          <TextField
            label={reasonCode === 'other' ? 'บันทึกเพิ่มเติม (จำเป็นเมื่อเลือก "อื่นๆ")' : 'บันทึกเพิ่มเติม'}
            value={noteTh}
            disabled={busy}
            multiline
            onChange={setNoteTh}
            description="อยู่ในประวัติการแก้ราคา ไม่ได้ขึ้นบนใบเสนอราคาที่ลูกค้าเห็น"
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            ยกเลิก
          </Button>
          <Button
            disabled={ready === null || noteMissing || busy}
            onClick={() => {
              if (ready === null) return;
              void onWrite('บันทึกการแก้ราคาแล้ว', (expect) =>
                setOverride(orderId, expect, {
                  anchor: ready.anchor,
                  quoteLineId: context.anchor === 'line_total' ? context.quoteLineId : null,
                  enteredAs: ready.enteredAs,
                  /*
                   * No money goes up — not the preview, not a baseline. What goes up is the text,
                   * normalised by `@wewin/core/discount` into the form the server parses: a
                   * percentage carries the `%` the box above only *draws*. The dialog does not do
                   * that itself on purpose — patching the string here, after the preview had been
                   * computed from the unpatched one, is precisely the two-readers shape that made
                   * `-5%` preview a surcharge and store a discount.
                   */
                  enteredValueText: ready.enteredValueText,
                  reasonCode,
                  noteTh: noteTh.trim() === '' ? null : noteTh.trim(),
                }),
              ).then((saved) => {
                if (saved) {
                  setText('');
                  setNoteTh('');
                  onOpenChange(false);
                }
              });
            }}
          >
            บันทึก
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const DESCRIPTION_TH: Readonly<Record<OverrideEntryModeWire, string>> = {
  line_total: 'ยอดที่ลูกค้าจ่ายสำหรับบรรทัดนี้ทั้งบรรทัด',
  unit_price: 'ระบบจะคูณด้วยจำนวนแล้วบันทึกเป็นยอดรวมบรรทัด — ราคาต่อหน่วยเป็นค่าที่ใช้แสดงผล บวกกันไม่ได้',
  grand_total: 'ยอดรวมทั้งใบ รวม VAT แล้ว — เป็นยอดที่ลูกค้าโอนจริง',
  percent_discount: 'บันทึกเป็นยอดจริงที่คำนวณได้ ไม่ใช่เก็บเป็นเปอร์เซ็นต์ ราคาจึงไม่ขยับตามแคตตาล็อกภายหลัง',
  discount_amount: 'บันทึกเป็นยอดจริงหลังหักแล้ว ไม่ใช่เก็บเป็นส่วนต่าง',
  lead_time_days: 'จำนวนวันนับจากวันที่ยืนยันการผลิต',
};

function hintFor(context: OverrideContext, enteredAs: OverrideEntryModeWire): string {
  if (context.anchor === 'lead_time_days') return '';
  /*
   * The money-discount box states its format rather than showing the computed total. It used to
   * echo `bahtInput(computedThbMinor)` like the absolute boxes do — a placeholder of `13200` in a
   * box captioned ส่วนลดเป็นจำนวนเงิน, which reads as an invitation to type the whole price as the
   * discount. The absolute boxes keep that echo, where it is exactly the right suggestion.
   */
  if (enteredAs === 'discount_amount') return 'เช่น 291 = ลด ฿291';
  if (enteredAs === 'unit_price' && context.anchor === 'line_total') {
    return bahtInput(unitPriceOf(context.computedThbMinor, context.qty));
  }
  return bahtInput(context.computedThbMinor);
}

/**
 * What the typing should become, before it is sent.
 *
 * This is where "ลด 5%" and "฿8,351.45" are shown to be the same act. The label says it is a
 * preview because it is: plan 7.9(ก)'s reason for storing an absolute figure rather than a
 * delta is invisible to a salesperson until they watch the absolute figure appear as they
 * type the percentage — after which nobody needs telling that tomorrow's catalogue move will
 * not touch it.
 */
function Preview({
  context,
  entry,
}: {
  readonly context: OverrideContext;
  readonly entry: EntryPreview;
}) {
  if (context.anchor === 'lead_time_days') {
    return (
      <p className="rounded-md bg-muted px-3 py-2 text-sm">
        จะบันทึกเป็น <strong>{daysText(entry.anchorDays ?? 0)}</strong> (เดิม {daysText(context.computedDays)})
      </p>
    );
  }

  const value = entry.anchorThbMinor ?? 0n;

  return (
    <div className="flex flex-col gap-1 rounded-md bg-muted px-3 py-2 text-sm">
      <span>
        จะบันทึก{ANCHOR_LABEL_TH[context.anchor]}เป็น{' '}
        <strong className="font-mono tabular-nums">{baht(value)}</strong>
        <span className="ms-2 text-xs text-muted-foreground">(ตัวอย่าง — เซิร์ฟเวอร์เป็นผู้คิดยอดจริง)</span>
      </span>
      <span className="text-muted-foreground">
        {concessionText(context.computedThbMinor, value)}
        {context.anchor === 'line_total'
          ? ` · เท่ากับหน่วยละ ${baht(unitPriceOf(value, context.qty))} (ค่าแสดงผล บวกกันไม่ได้)`
          : ''}
      </span>
    </div>
  );
}
