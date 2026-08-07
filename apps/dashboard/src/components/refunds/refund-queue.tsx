'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { formatBaht } from '@wewin/core/format';
import { AlertTriangle, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { failureMessage } from '@/lib/api/errors';
import { decideRefund, disburseRefund, listRefunds, type Refund, type RefundStatus } from './refund-api';
import { decisionBody, decisionNeeds, type Decision } from './refund-decision';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Refunds: decide them, then record that the money actually left.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Three stops, and the screen shows all three because skipping one is how a refund gets
 * approved and never paid:
 *
 *   `requested`  waiting on a decision
 *   `approved`   decided and **not yet paid** — the payable queue, which plan 7.12 says must
 *                be visible. This is the tab that opens first.
 *   `disbursed`  money gone, with the bank reference that proves it
 *
 * ── ⭐ The different-account report is a tab, not a filter ───────────────────
 *
 * `?payee=different` lists every refund going somewhere other than the account that paid.
 * It is not there for convenience — it is a list somebody is meant to read, and a refund
 * that appears on it was approved by a click that had to acknowledge it.
 */

const STATUS_TH: Record<RefundStatus, string> = {
  requested: 'รอตัดสินใจ',
  approved: 'อนุมัติแล้ว รอจ่าย',
  rejected: 'ปฏิเสธ',
  disbursed: 'จ่ายแล้ว',
};

const at = (iso: string): string =>
  new Date(iso).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

type Tab = 'payable' | 'requested' | 'different' | 'all';

const TABS: readonly { readonly key: Tab; readonly labelTh: string }[] = [
  { key: 'payable', labelTh: 'รอจ่าย' },
  { key: 'requested', labelTh: 'รอตัดสินใจ' },
  { key: 'different', labelTh: 'บัญชีไม่ตรงกับที่โอนมา' },
  { key: 'all', labelTh: 'ทั้งหมด' },
];

const QUERY: Record<Tab, Parameters<typeof listRefunds>[0]> = {
  payable: { statuses: ['approved'] },
  requested: { statuses: ['requested'] },
  different: { payee: 'different' },
  all: {},
};

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly refunds: readonly Refund[] }
  | { readonly status: 'failed'; readonly problem: string };

export function RefundQueue() {
  const [tab, setTab] = useState<Tab>('payable');
  const [state, setState] = useState<State>({ status: 'loading' });
  const [deciding, setDeciding] = useState<Refund | null>(null);
  const [paying, setPaying] = useState<Refund | null>(null);

  async function reload(which: Tab): Promise<void> {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', refunds: await listRefunds(QUERY[which]) });
    } catch (error) {
      setState({ status: 'failed', problem: failureMessage(error) });
    }
  }

  useEffect(() => {
    void reload(tab);
  }, [tab]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {TABS.map((entry) => (
          <Button
            key={entry.key}
            size="sm"
            variant={tab === entry.key ? 'secondary' : 'ghost'}
            onClick={() => setTab(entry.key)}
          >
            {entry.labelTh}
          </Button>
        ))}
      </div>

      {state.status === 'loading' && <Skeleton className="h-64 w-full" />}

      {state.status === 'failed' && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>โหลดรายการคืนเงินไม่สำเร็จ</AlertTitle>
          <AlertDescription>{state.problem}</AlertDescription>
        </Alert>
      )}

      {state.status === 'ready' && state.refunds.length === 0 && (
        <Card>
          <CardContent className="text-muted-foreground py-10 text-center text-sm">
            ไม่มีรายการในหมวดนี้
          </CardContent>
        </Card>
      )}

      {state.status === 'ready' && state.refunds.length > 0 && (
        <Card className="overflow-hidden py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ออเดอร์</TableHead>
                <TableHead className="text-right">ยอด</TableHead>
                <TableHead>ปลายทาง</TableHead>
                <TableHead>สถานะ</TableHead>
                <TableHead>ขอเมื่อ</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.refunds.map((refund) => (
                <TableRow key={refund.id}>
                  <TableCell>
                    <Link
                      href={`/orders/${refund.orderId}` as Route}
                      className="font-mono text-sm hover:underline"
                    >
                      {refund.orderNo ?? refund.orderId.slice(0, 8)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatBaht(refund.amountThbMinor)}
                  </TableCell>
                  <TableCell className="text-sm">
                    <div className="flex flex-col gap-0.5">
                      <span>
                        {refund.payeeName}{' '}
                        <span className="text-muted-foreground font-mono text-xs">
                          {refund.payeeBankCode} ···{refund.payeeAccountLast4}
                        </span>
                      </span>
                      {/*
                       * ⚠️ The flag, on the row, before anybody opens anything. It is derived
                       * from the accepted slips — the system could not match this destination
                       * to money that came in — and a refund reaching this state should be
                       * visible at a glance rather than only inside the decision dialog.
                       */}
                      {refund.payeeIsOriginalAccount === 'no' && (
                        <span className="text-destructive inline-flex items-center gap-1 text-xs">
                          <ShieldAlert className="size-3" />
                          ไม่ใช่บัญชีที่โอนเงินเข้ามา
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={refund.status === 'approved' ? 'default' : 'outline'}>
                      {STATUS_TH[refund.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {at(refund.requestedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    {refund.status === 'requested' && (
                      <Button size="sm" onClick={() => setDeciding(refund)}>
                        ตัดสินใจ
                      </Button>
                    )}
                    {refund.status === 'approved' && (
                      <Button size="sm" variant="outline" onClick={() => setPaying(refund)}>
                        บันทึกการจ่าย
                      </Button>
                    )}
                    {refund.status === 'disbursed' && refund.disbursementReference !== null && (
                      <span className="text-muted-foreground font-mono text-xs">
                        {refund.disbursementReference}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {deciding !== null && (
        <DecisionDialog
          refund={deciding}
          onClose={() => setDeciding(null)}
          onDone={() => {
            setDeciding(null);
            void reload(tab);
          }}
        />
      )}

      {paying !== null && (
        <DisbursementDialog
          refund={paying}
          onClose={() => setPaying(null)}
          onDone={() => {
            setPaying(null);
            void reload(tab);
          }}
        />
      )}
    </div>
  );
}

/**
 * Approve or refuse — one dialog, because they are one decision.
 *
 * ⭐ The acknowledgement checkbox appears only when the account is not the original, and
 * `decisionBody` sends the field only in that case. See `refund-decision.ts`: an
 * always-attached acknowledgement satisfies the schema and deletes the control.
 */
function DecisionDialog({
  refund,
  onClose,
  onDone,
}: {
  readonly refund: Refund;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const [decision, setDecision] = useState<Decision>('approved');
  const [noteTh, setNoteTh] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);

  const facts = { decision, payeeIsOriginalAccount: refund.payeeIsOriginalAccount };
  const needs = decisionNeeds(facts);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>คืนเงิน {formatBaht(refund.amountThbMinor)}</DialogTitle>
          <DialogDescription>
            ไป {refund.payeeName} · {refund.payeeBankCode} ···{refund.payeeAccountLast4}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex gap-2">
            {(['approved', 'rejected'] as const).map((option) => (
              <Button
                key={option}
                variant={decision === option ? 'default' : 'outline'}
                size="sm"
                onClick={() => setDecision(option)}
              >
                {option === 'approved' ? 'อนุมัติ' : 'ปฏิเสธ'}
              </Button>
            ))}
          </div>

          {needs.acknowledgement && (
            <Alert variant="destructive">
              <ShieldAlert />
              <AlertTitle>ปลายทางไม่ใช่บัญชีที่โอนเงินเข้ามา</AlertTitle>
              <AlertDescription className="flex flex-col gap-3">
                <span>
                  ระบบเทียบกับสลิปที่รับไว้แล้วและไม่พบว่าบัญชีนี้เคยโอนเงินเข้ามา —
                  ต้องยืนยันแยกอีกครั้งก่อนอนุมัติ
                </span>
                <div className="flex items-start gap-3">
                  <Checkbox
                    id="ack"
                    checked={acknowledged}
                    onCheckedChange={(checked) => setAcknowledged(checked === true)}
                  />
                  <Label htmlFor="ack" className="leading-snug font-normal">
                    ฉันอ่านแล้วและยืนยันให้จ่ายไปบัญชีนี้
                  </Label>
                </div>
              </AlertDescription>
            </Alert>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="note">
              {needs.note ? 'เหตุผลที่ปฏิเสธ' : 'บันทึกเพิ่มเติม (ไม่บังคับ)'}
            </Label>
            <Textarea
              id="note"
              rows={3}
              maxLength={1000}
              value={noteTh}
              onChange={(event) => setNoteTh(event.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </Button>
          <Button
            disabled={busy || !needs.ready({ acknowledged, noteTh })}
            onClick={() => {
              setBusy(true);
              void (async () => {
                try {
                  await decideRefund(refund.id, decisionBody({ ...facts, acknowledged, noteTh }));
                  toast.success(decision === 'approved' ? 'อนุมัติแล้ว' : 'ปฏิเสธแล้ว');
                  onDone();
                } catch (error) {
                  toast.error(failureMessage(error));
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            ยืนยัน
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** ⚠️ The reference is required and is not generated — see `disburseRefund`. */
function DisbursementDialog({
  refund,
  onClose,
  onDone,
}: {
  readonly refund: Refund;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>บันทึกว่าจ่ายแล้ว</DialogTitle>
          <DialogDescription>
            {formatBaht(refund.amountThbMinor)} ไป {refund.payeeName} ···{refund.payeeAccountLast4}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reference">เลขอ้างอิงการโอน</Label>
          <Input
            id="reference"
            value={reference}
            maxLength={200}
            onChange={(event) => setReference(event.target.value)}
          />
          <span className="text-muted-foreground text-xs">
            หาได้จากสเตทเมนต์ธนาคาร — คืนเงินที่บันทึกว่าจ่ายแล้วโดยไม่มีเลขอ้างอิง คือคืนเงินที่ตามหาไม่เจอ
          </span>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </Button>
          <Button
            disabled={busy || reference.trim().length < 3}
            onClick={() => {
              setBusy(true);
              void (async () => {
                try {
                  await disburseRefund(refund.id, reference);
                  toast.success('บันทึกการจ่ายแล้ว');
                  onDone();
                } catch (error) {
                  toast.error(failureMessage(error));
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            บันทึก
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
