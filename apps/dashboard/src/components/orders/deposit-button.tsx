'use client';

import { useState } from 'react';
import { toast } from 'sonner';

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
import { failureMessage } from '@/lib/api/errors';

import { setDeposit } from './order-api';
import { formatDepositPercent, mayEditDeposit, parseDepositPercent } from './deposit-entry';

/**
 * ⭐ "การระบุยอดมัดจำ" — the box the owner asked for, on the screen where the money is.
 *
 * It appears only while the quotation is still being negotiated (`mayEditDeposit`), and that
 * check decides what to *draw* rather than what is permitted: the API refuses the write itself,
 * and money closes it there through a fold this screen cannot see. What the check buys is a
 * person not being offered a control that would answer 409.
 *
 * ── The refusals are shown where they were made ─────────────────────────────────
 *
 * ⚠️ Two quite different ones can come back, and the dialog stays open for both. The first is
 * this app's, from `parseDepositPercent`, about what was typed. The second is the server's —
 * below the company standard with the setting switched off, or an authority ceiling nobody has
 * granted — and its sentence is already written for a salesperson, so it is relayed verbatim
 * rather than translated into a shorter one that says less.
 *
 * A dialog that closed on a refusal would lose both the sentence and what was typed, which is
 * the mistake this file's sibling `override-dialog.tsx` was corrected for.
 */
export function DepositButton({
  orderId,
  status,
  depositBpAuthored,
  onChanged,
}: {
  readonly orderId: string;
  readonly status: string;
  /** The share somebody chose for this order, or `null` while the company setting applies. */
  readonly depositBpAuthored: number | null;
  readonly onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!mayEditDeposit(status)) return null;

  const submit = async (): Promise<void> => {
    const parsed = parseDepositPercent(typed);
    if (!parsed.ok) {
      setProblem(parsed.messageTh);
      return;
    }

    setBusy(true);
    try {
      await setDeposit(orderId, parsed.bp);
      toast.success(`ตั้งยอดมัดจำเป็น ${formatDepositPercent(parsed.bp)} แล้ว`);
      setOpen(false);
      setTyped('');
      setProblem(null);
      onChanged();
    } catch (error: unknown) {
      /* The server's own sentence, verbatim — see the header. */
      setProblem(failureMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setProblem(null);
          setTyped(depositBpAuthored === null ? '' : formatDepositPercent(depositBpAuthored).replace('%', ''));
          setOpen(true);
        }}
      >
        แก้ยอดมัดจำ
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>ยอดมัดจำของออร์เดอร์นี้</DialogTitle>
            <DialogDescription>
              กรอกเป็นเปอร์เซ็นต์ของยอดรวม — ระบบจะคิดยอดและจัดงวดชำระใหม่ให้เอง
              {depositBpAuthored === null
                ? ' ตอนนี้ใช้ค่ามาตรฐานของบริษัทอยู่'
                : ` ตอนนี้ตั้งไว้ที่ ${formatDepositPercent(depositBpAuthored)}`}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label htmlFor="deposit-percent">เปอร์เซ็นต์มัดจำ</Label>
            <div className="flex items-center gap-2">
              <Input
                id="deposit-percent"
                inputMode="decimal"
                placeholder="30"
                value={typed}
                onChange={(event) => {
                  setTyped(event.target.value);
                  setProblem(null);
                }}
                className="max-w-[8rem]"
              />
              <span className="text-muted-foreground">%</span>
            </div>
            {problem === null ? null : (
              <p role="alert" className="text-destructive type-caption">
                {problem}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              ยกเลิก
            </Button>
            <Button onClick={() => void submit()} disabled={busy}>
              บันทึกยอดมัดจำ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
