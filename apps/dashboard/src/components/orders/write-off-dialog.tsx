'use client';

import { useState } from 'react';
import { Scissors } from 'lucide-react';
import { toast } from 'sonner';

import { formatBaht } from '@wewin/core/format';

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
import { requestWriteOff } from './order-api';
import {
  MIN_REASON_LENGTH,
  writeOffAvailability,
  writeOffFormBody,
  type WriteOffFields,
} from './write-off-request';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ ขออนุมัติตัดยอดค้างทิ้ง — beside ค้างชำระ, where the figure it is about already is.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The owner's fifth payment requirement, asked from the order's ยอดเงิน card. The customer will not
 * pay, or a settlement was agreed halfway, or the remainder is not worth chasing.
 *
 * ── Why here and not on a screen of its own ──────────────────────────────────
 *
 * The same argument `record-payment-dialog.tsx` makes about its own button: the act only means
 * anything against the amounts above it. The person asking to forgive ฿5,529.60 is deciding whether
 * *that* is the right figure, and that is a question about ยอดรวม, มัดจำตามสัญญา and ค้างชำระ — all
 * three of which are on this card and nowhere else together.
 *
 * ── ⚠️ EVERY DECISION IS IN `write-off-request.ts`, NOT IN THIS FILE ─────────
 *
 * `apps/dashboard`'s vitest is `environment: 'node'`, so a `.test.tsx` is **silently never
 * collected**. Whether the button appears, what the form refuses and what body it sends are all in
 * the `.ts` beside this, where `write-off-request.test.ts` can reach them. What is here is layout,
 * the fetch, and the two sentences that have to sit next to the fields.
 */

/**
 * The button, or nothing.
 *
 * ⚠️ Hiding it is not authorisation — `lib/auth/permissions.ts` says so in as many words, and
 * `POST /orders/:orderId/write-offs` demands both codes whatever this renders. What it buys is that
 * somebody who could never use it is not shown it.
 */
export function WriteOffButton({
  orderId,
  outstandingThbMinor,
  pendingCashflowApprovalId,
  onRequested,
}: {
  readonly orderId: string;
  /** ค้างชำระ, straight off the order — Postgres's fold, never arithmetic done here. */
  readonly outstandingThbMinor: bigint | null;
  /** The order's pending `cashflow` request of either kind, from `GET /quotes/approvals?orderId=`. */
  readonly pendingCashflowApprovalId: string | null;
  readonly onRequested: () => void;
}) {
  const { can } = useSession();
  const [open, setOpen] = useState(false);

  /*
   * ⚠️ `orders.write` + `payments.read` — the codes the *request* route declares, and deliberately
   * NOT `payments.write_off`, which is the deciding code. If the ask needed the deciding permission,
   * requester and decider would hold the same grant and the two-person separation would collapse to
   * the four-eyes CHECK plus a ceiling.
   */
  if (!can('orders.write', 'payments.read')) return null;

  const availability = writeOffAvailability({ outstandingThbMinor, pendingCashflowApprovalId });

  /*
   * ⚠️ Nothing at all when there is nothing owed — not a disabled button. A greyed control under a
   * ฿0.00 balance invites somebody to work out what is wrong with an order that has nothing wrong
   * with it. See `writeOffAvailability`, where the three states are argued.
   */
  if (availability.kind === 'nothingOwed') return null;

  if (availability.kind === 'pending') {
    return (
      <p className="text-muted-foreground type-caption">
        มีคำขออนุมัติตัดยอดค้างทิ้งของออเดอร์นี้รอการตัดสินอยู่ — ยอดคงค้างจะเปลี่ยนเมื่อมีคนอนุมัติ
      </p>
    );
  }

  return (
    <>
      <Button variant="outline" size="sm" className="w-fit" onClick={() => setOpen(true)}>
        <Scissors data-icon="inline-start" />
        ขออนุมัติตัดยอดค้างทิ้ง
      </Button>

      {open && (
        <WriteOffDialog
          orderId={orderId}
          outstandingThbMinor={availability.outstandingThbMinor}
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            onRequested();
          }}
        />
      )}
    </>
  );
}

function WriteOffDialog({
  orderId,
  outstandingThbMinor,
  onClose,
  onDone,
}: {
  readonly orderId: string;
  readonly outstandingThbMinor: bigint;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const [fields, setFields] = useState<WriteOffFields>({ amount: '', reasonTh: '' });
  const [problemsTh, setProblemsTh] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);

  const set = (key: keyof WriteOffFields, value: string): void =>
    setFields((current) => ({ ...current, [key]: value }));

  const submit = async (): Promise<void> => {
    const parsed = writeOffFormBody(fields, outstandingThbMinor);
    if (!parsed.ok) {
      setProblemsTh(parsed.problemsTh);
      return;
    }

    setProblemsTh([]);
    setBusy(true);
    try {
      await requestWriteOff(orderId, parsed.body);
      toast.success('ยื่นคำขออนุมัติตัดยอดค้างทิ้งแล้ว');
      onDone();
    } catch (error) {
      /*
       * The server's sentence, not a rewritten one. It knows things this form cannot — the balance
       * may have moved since this page was read, and a slip accepted a second ago is exactly the
       * case `write-off-request.ts` says its own comparison cannot cover.
       */
      setProblemsTh([failureMessage(error)]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>ขออนุมัติตัดยอดค้างทิ้ง</DialogTitle>
          <DialogDescription>
            สำหรับกรณีที่ลูกค้าไม่ชำระ ตกลงยุติกันครึ่งทาง หรือยอดที่เหลือไม่คุ้มค่าติดตาม
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/*
           * ⭐ THE SENTENCE THAT KEEPS THIS FROM BEING MISREAD AS "ตัดยอดเลย".
           *
           * The row is written now; ค้างชำระ changes when somebody with the authority approves it in
           * กล่องขาเข้าผู้อนุมัติ. Without this, a person presses the button, watches the balance not
           * move, and presses it again — which is the same trap `record-payment-dialog.tsx` names
           * about its own row, and the reason both say it above the fields rather than after.
           */}
          <Alert>
            <AlertTitle>คำขอนี้ยังไม่ตัดยอด</AlertTitle>
            <AlertDescription>
              ระบบจะบันทึกเป็นคำขอรออนุมัติ — ยอดคงค้างจะเปลี่ยนเมื่อมีผู้มีอำนาจอนุมัติ และผู้อนุมัติต้องไม่ใช่ผู้ยื่นคำขอ
              {` · ตอนนี้ค้างชำระ ${formatBaht(outstandingThbMinor)}`}
            </AlertDescription>
          </Alert>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="write-off-amount">ยอดที่ขอตัดทิ้ง</Label>
            <Input
              id="write-off-amount"
              value={fields.amount}
              inputMode="decimal"
              placeholder="0.00"
              className="text-right tabular-nums"
              onChange={(event) => set('amount', event.target.value)}
            />
            <span className="text-muted-foreground type-caption">
              {/*
                * Both halves said out loud, because the part-settlement is the common case and a form
                * that only mentioned the ceiling would read as all-or-nothing.
                */}
              ตัดได้ทั้งยอดหรือบางส่วน แต่ไม่เกินยอดคงค้าง {formatBaht(outstandingThbMinor)}
            </span>
          </div>

          {/*
           * ⭐ THE FIELD THE WHOLE FEATURE RESTS ON. `approvals.reason_th` is NOT NULL and it is the
           * only record of why money the company was owed will never arrive.
           */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="write-off-reason">เหตุผล</Label>
            <Textarea
              id="write-off-reason"
              rows={3}
              maxLength={1000}
              value={fields.reasonTh}
              placeholder="เช่น ลูกค้าตกลงชำระครึ่งหนึ่งเพื่อยุติเรื่อง / ติดตามแล้วไม่ชำระ ยอดที่เหลือไม่คุ้มค่าดำเนินคดี"
              onChange={(event) => set('reasonTh', event.target.value)}
            />
            <span className="text-muted-foreground type-caption">
              จำเป็นต้องกรอก อย่างน้อย {MIN_REASON_LENGTH} ตัวอักษร — เหตุผลนี้จะถูกเก็บไว้ถาวรและแก้ไขไม่ได้หลังจากมีคนตัดสินแล้ว
            </span>
          </div>

          {problemsTh.length > 0 && (
            <Alert variant="destructive">
              <AlertTitle>ยังยื่นคำขอไม่ได้</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4">
                  {problemsTh.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            ยกเลิก
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            ยื่นคำขออนุมัติ
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
