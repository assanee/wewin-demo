'use client';

import { useState } from 'react';
import { formatBaht } from '@wewin/core/format';
import { AlertTriangle, ReceiptText } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useSession } from '@/lib/auth/session';
import { failureMessage } from '@/lib/api/errors';
import { MIN_REASON_LENGTH, recordFormBody, type RecordFormFields } from './no-slip';
import { recordPayment } from './slip-api';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ ปิดยอดการชำระโดยไม่มีสลิป — the owner's ask, on the screen it belongs on.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * *"เจ้าหน้าที่สามารถปิดยอดการชำระได้โดยไม่มีการยืนยันสลิป แต่ต้องระบุเหตุผล เพราะอาจมีกรณีที่
 * ลูกค้าโอนชำระแล้วแต่ไม่ได้แนบสลิปยืนยัน"*.
 *
 * ── ⭐ WHY THE ORDER SCREEN AND NOT THE SLIPS SCREEN ─────────────────────────
 *
 * Both were candidates and the slips screen is the one it is *not* on. Three reasons, in the
 * order they settled it:
 *
 *   **The act needs an order, and `/slips` has none.** Every other control on that screen acts
 *   on a row that is already in front of the reviewer. Recording starts from an order nobody has
 *   picked yet, so putting it there means adding an order picker — a *second* way to find an
 *   order, competing with `/orders`, which is the screen built for exactly that and which knows
 *   about status, ค้างชำระ and the customer's name.
 *
 *   **The figure has to be legible, and it is legible here.** The person keying a telephoned
 *   transfer is answering "did they pay the right amount", and ยอดคงค้าง means something only
 *   beside ยอดรวม and มัดจำตามสัญญา — `order-detail.tsx` argues that at length for its own card
 *   and it is the same argument. On `/slips` the same number would be a figure with no scale.
 *
 *   **It is where the person already is.** They looked the order up to answer "how much do I
 *   owe"; the button is on the answer.
 *
 * What *does* go on `/slips` is the other half — the queue marker and the audit list — because
 * those are about the review process rather than about one order. See `recorded-list.tsx`.
 *
 * ── ⚠️ WHAT THIS BUTTON DOES NOT DO ─────────────────────────────────────────
 *
 * It does not take the money. It writes a `submitted` slip with no image and a stated reason,
 * and that entry then goes through the ordinary review on `/slips` — same two-column comparison,
 * same allocations, same ledger. So the wording is deliberately *บันทึก* and never *รับ*: a
 * screen that said "รับชำระ" would be promising a balance change that has not happened, and the
 * ค้างชำระ figure on the card behind this dialog would not move.
 *
 * The two-person rule survives that split for free when there are two people. When there is one,
 * they hold `payments.self_review_slip` and the review dialog asks them to write down why.
 *
 * ── The arithmetic is not here ───────────────────────────────────────────────
 *
 * `no-slip.ts` holds it, and is tested without a browser: `apps/dashboard` runs vitest in
 * `environment: 'node'` and a `.test.tsx` is silently never collected, so anything that can be
 * wrong lives outside this file on purpose.
 */

/** `2026-08-14T09:30` in the browser's own zone — what `<input type="datetime-local">` wants. */
function localNow(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

const EMPTY = (orderId: string, now: Date): RecordFormFields => ({
  orderId,
  amount: '',
  transferredAtLocal: localNow(now),
  noSlipReasonTh: '',
  bankReference: '',
  payerName: '',
  payerAccountLast4: '',
});

export function RecordPaymentButton({
  orderId,
  outstandingThbMinor,
  onRecorded,
}: {
  readonly orderId: string;
  /** ค้างชำระ, straight off the order — Postgres's fold, never arithmetic done here. */
  readonly outstandingThbMinor: bigint | null;
  readonly onRecorded: () => void;
}) {
  const { can } = useSession();
  const [open, setOpen] = useState(false);

  /*
   * ⚠️ Hiding a button is not authorisation — `permissions.ts` says so in as many words, and the
   * route requires all four codes whatever this renders. What it buys is that somebody who can
   * never use it is not shown it. Both new codes are held by nobody at boot, so until the owner
   * grants them this button exists for no one, which is the fail-closed direction.
   */
  if (!can('payments.record_without_slip', 'payments.read', 'orders.read', 'orders.write')) {
    return null;
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() => setOpen(true)}
      >
        <ReceiptText data-icon="inline-start" />
        บันทึกการชำระโดยไม่มีสลิป
      </Button>

      {open && (
        <RecordPaymentDialog
          orderId={orderId}
          outstandingThbMinor={outstandingThbMinor}
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            onRecorded();
          }}
        />
      )}
    </>
  );
}

function RecordPaymentDialog({
  orderId,
  outstandingThbMinor,
  onClose,
  onDone,
}: {
  readonly orderId: string;
  readonly outstandingThbMinor: bigint | null;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const [fields, setFields] = useState<RecordFormFields>(() => EMPTY(orderId, new Date()));
  const [problemsTh, setProblemsTh] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);

  const set = (key: keyof RecordFormFields, value: string): void =>
    setFields((current) => ({ ...current, [key]: value }));

  const reasonShort = fields.noSlipReasonTh.trim().length < MIN_REASON_LENGTH;

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>บันทึกการชำระโดยไม่มีสลิป</DialogTitle>
          <DialogDescription>
            สำหรับกรณีที่ลูกค้าโอนแล้วแต่ไม่ได้แนบสลิปยืนยัน
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/*
           * ⭐ THE SENTENCE THAT KEEPS THIS FROM BEING MISREAD AS "รับเงิน".
           *
           * The row is written now; the money moves when somebody รับรอง it in คิวสลิป. Without
           * this, a person would press the button, watch ยอดคงค้าง not move, and press it again.
           */}
          <Alert>
            <AlertTitle>รายการนี้ยังไม่ตัดยอด</AlertTitle>
            <AlertDescription>
              ระบบจะบันทึกเป็นรายการรอตรวจในคิวสลิป — ยอดคงค้างจะเปลี่ยนเมื่อมีคนรับรองรายการนี้
              {outstandingThbMinor === null
                ? ''
                : ` · ตอนนี้ค้างชำระ ${formatBaht(outstandingThbMinor)}`}
            </AlertDescription>
          </Alert>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="record-amount">ยอดที่ลูกค้าโอน</Label>
              <Input
                id="record-amount"
                value={fields.amount}
                inputMode="decimal"
                placeholder="0.00"
                className="text-right tabular-nums"
                onChange={(event) => set('amount', event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="record-when">โอนเมื่อ</Label>
              <Input
                id="record-when"
                type="datetime-local"
                value={fields.transferredAtLocal}
                onChange={(event) => set('transferredAtLocal', event.target.value)}
              />
            </div>
          </div>

          {/*
           * ⭐ THE FIELD THIS WHOLE FEATURE EXISTS FOR — first among the optional ones, required,
           * and with the permanence said out loud under it. The owner accepted an evidence-free
           * payment on the condition it can be audited afterwards, and this box is that condition.
           */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="record-reason">เหตุผลที่ไม่มีสลิป</Label>
            <Textarea
              id="record-reason"
              rows={3}
              maxLength={2000}
              value={fields.noSlipReasonTh}
              placeholder="เช่น ลูกค้าโอนแล้วแจ้งทางโทรศัพท์ แต่ไม่ได้ส่งสลิปกลับมา"
              onChange={(event) => set('noSlipReasonTh', event.target.value)}
            />
            <span
              className={
                reasonShort ? 'text-destructive type-caption' : 'text-muted-foreground type-caption'
              }
            >
              จำเป็นต้องกรอก อย่างน้อย {MIN_REASON_LENGTH} ตัวอักษร —
              เหตุผลนี้จะถูกเก็บไว้ถาวรและแก้ไขไม่ได้หลังจากมีคนรับรองแล้ว
            </span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="record-ref">เลขอ้างอิงจากธนาคาร (ไม่บังคับ)</Label>
              <Input
                id="record-ref"
                value={fields.bankReference}
                maxLength={120}
                onChange={(event) => set('bankReference', event.target.value)}
              />
            </div>

            <div className="grid grid-cols-[1fr_6rem] gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="record-payer">ชื่อผู้โอน (ไม่บังคับ)</Label>
                <Input
                  id="record-payer"
                  value={fields.payerName}
                  maxLength={200}
                  onChange={(event) => set('payerName', event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="record-last4">เลขท้ายบัญชี</Label>
                <Input
                  id="record-last4"
                  value={fields.payerAccountLast4}
                  inputMode="numeric"
                  maxLength={4}
                  onChange={(event) =>
                    set('payerAccountLast4', event.target.value.replace(/\D/gu, ''))
                  }
                />
              </div>
            </div>
          </div>

          {problemsTh.length > 0 && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>ยังบันทึกไม่ได้</AlertTitle>
              <AlertDescription>
                <ul className="list-inside list-disc">
                  {problemsTh.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              /*
               * Checked here rather than by disabling the button, deliberately. A disabled button
               * with no message is a screen that refuses without saying why; `recordFormBody`
               * returns *every* problem at once and this renders all of them.
               */
              const result = recordFormBody(fields, new Date());
              if (!result.ok) {
                setProblemsTh(result.problemsTh);
                return;
              }

              setProblemsTh([]);
              setBusy(true);
              void (async () => {
                try {
                  await recordPayment(result.body);
                  toast.success('บันทึกแล้ว — รายการนี้อยู่ในคิวสลิป รอให้มีคนรับรอง');
                  onDone();
                } catch (error) {
                  toast.error(failureMessage(error));
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            บันทึกรายการ
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
