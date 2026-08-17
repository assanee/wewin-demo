'use client';

import { useState } from 'react';
import { AlertTriangle, Undo2 } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
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
import { failureMessage } from '@/lib/api/errors';
import { baht } from '@/components/quotes/amounts';
import { requestRefund } from '@/components/refunds/refund-api';
import { useSession } from '@/lib/auth/session';

import { refundAvailability, refundFormBody, type RefundPayee } from './refund-request';

/**
 * ⭐ ขอคืนเงิน — beside the money on a cancelled order, where the figure it is about already is.
 *
 * `refund-request.ts` carries the argument for when this may be offered at all, and the three
 * refusals it was learned from. In short: the คืนเงิน queue had a decide button and a disburse
 * button and no way for anybody to put a request into it.
 *
 * ⚠️ It renders nothing for a caller without `orders.refund`, and nothing on an order that is
 * not cancelled, holds nothing, or already has a request waiting. Every one of those would be
 * a button whose only outcome is a 409 in Thai.
 */
export function RefundButton({
  orderId,
  status,
  heldThbMinor,
  hasOpenRefund,
  onRequested,
}: {
  readonly orderId: string;
  readonly status: string;
  readonly heldThbMinor: bigint | null;
  readonly hasOpenRefund: boolean;
  readonly onRequested: () => void;
}) {
  const { can } = useSession();
  const [open, setOpen] = useState(false);

  const availability = refundAvailability({ status, heldThbMinor, hasOpenRefund });

  if (!can('orders.refund')) return null;

  if (availability.kind === 'pending') {
    return (
      <p className="text-muted-foreground type-body">
        มีคำขอคืนเงินของออเดอร์นี้รอการตัดสินอยู่ — ดูได้ในหน้าคืนเงิน
      </p>
    );
  }

  /* Nothing at all: a cancelled order holding no money, or an order still running. */
  if (availability.kind !== 'available') return null;

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Undo2 data-icon="inline-start" />
        ขอคืนเงิน {baht(availability.heldThbMinor)}
      </Button>

      {open && (
        <RefundDialog
          orderId={orderId}
          heldThbMinor={availability.heldThbMinor}
          onClose={() => setOpen(false)}
          onRequested={() => {
            setOpen(false);
            onRequested();
          }}
        />
      )}
    </>
  );
}

function RefundDialog({
  orderId,
  heldThbMinor,
  onClose,
  onRequested,
}: {
  readonly orderId: string;
  readonly heldThbMinor: bigint;
  readonly onClose: () => void;
  readonly onRequested: () => void;
}) {
  const [destination, setDestination] = useState<'original' | 'other'>('original');
  const [name, setName] = useState('');
  const [bankCode, setBankCode] = useState('');
  const [last4, setLast4] = useState('');
  const [reasonTh, setReasonTh] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const payee: RefundPayee | null =
    destination === 'other' ? { name, bankCode, accountLast4: last4 } : null;
  const form = refundFormBody({ payee, reasonTh });

  async function submit(): Promise<void> {
    if (!form.ok) return;
    setBusy(true);
    setProblem(null);
    try {
      await requestRefund(orderId, form.body);
      toast.success('ยื่นคำขอคืนเงินแล้ว — รอผู้มีอำนาจตัดสินในหน้าคืนเงิน');
      onRequested();
    } catch (cause) {
      setProblem(failureMessage(cause));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>ขอคืนเงิน {baht(heldThbMinor)}</DialogTitle>
          <DialogDescription>
            ออเดอร์นี้ถูกยกเลิกแล้วและบริษัทยังถือเงินอยู่ — คำขอนี้ยังไม่ใช่การโอน
            ต้องมีผู้มีอำนาจอนุมัติก่อน แล้วจึงบันทึกการโอนอีกครั้ง
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {problem !== null && (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle>ยื่นคำขอไม่สำเร็จ</AlertTitle>
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          )}

          {/*
            ⚠️ The amount is not a field. The server works out what is owed back from the
            order's own ledger; a number typed here would be a second opinion about how much
            money the company holds, and the one that reached the customer would be whichever
            screen was open at the time.
          */}
          <SelectField
            label="คืนเข้าบัญชีไหน"
            description="ค่าตั้งต้นคือบัญชีเดิมที่ลูกค้าโอนมา"
            value={destination}
            onChange={(next) => setDestination(next === 'other' ? 'other' : 'original')}
            options={[
              { value: 'original', labelTh: 'บัญชีเดิมที่โอนเข้ามา' },
              { value: 'other', labelTh: 'บัญชีอื่น — ต้องระบุเหตุผล' },
            ]}
            disabled={busy}
          />

          {destination === 'other' && (
            <>
              <TextField
                label="ชื่อบัญชีผู้รับเงิน"
                value={name}
                onChange={setName}
                disabled={busy}
                placeholder="มานี ใจดี"
              />
              <TextField
                label="รหัสธนาคาร"
                description="เช่น KBANK · SCB · BBL"
                value={bankCode}
                onChange={setBankCode}
                mono
                disabled={busy}
                placeholder="KBANK"
              />
              <TextField
                label="เลขท้ายบัญชี"
                description="สี่หลักสุดท้าย"
                value={last4}
                onChange={setLast4}
                mono
                disabled={busy}
                placeholder="2233"
              />
            </>
          )}

          <TextField
            label={destination === 'other' ? 'เหตุผล' : 'เหตุผล (ไม่บังคับ)'}
            description="อ่านโดยผู้อนุมัติ และเก็บไว้กับคำขอ"
            value={reasonTh}
            onChange={setReasonTh}
            multiline
            disabled={busy}
            placeholder="เช่น บัญชีเดิมปิดไปแล้ว ลูกค้าแจ้งบัญชีใหม่ทางโทรศัพท์"
          />

          {!form.ok && (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle>ยังยื่นไม่ได้</AlertTitle>
              <AlertDescription>
                <ul className="flex list-disc flex-col gap-1 pl-4">
                  {form.problems.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </Button>
          <Button onClick={() => void submit()} disabled={!form.ok || busy}>
            {busy && <Spinner />}
            ยื่นคำขอคืนเงิน
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
