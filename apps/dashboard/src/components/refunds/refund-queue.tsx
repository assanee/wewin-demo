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
import {
  REFUND_PAGE_LIMIT,
  decideRefund,
  disburseRefund,
  listRefunds,
  type Refund,
  type RefundStatus,
} from './refund-api';
import { decisionBody, decisionNeeds, type Decision } from './refund-decision';
import { refundFocus } from './refund-focus';

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
 *
 * ── ⭐ One primary thing: what the company owes and has not sent ─────────────
 *
 * The `approved` queue was visible as a tab and its **total was on no screen in this dashboard**.
 * Somebody responsible for the bank account could read a page of approved refunds and still not
 * know whether it came to ฿4,000 or ฿400,000. `refundFocus` states it at `type-focal`, on the
 * page ground, above everything.
 *
 * ⚠️ **It is counted by its own request, not summed from the visible tab.** Summing the rows on
 * screen would make the headline say ไม่มีเงินค้างจ่าย the moment somebody clicked another tab —
 * a false statement produced by a filter. The extra call is the price of a sentence that is
 * about the company rather than about the control the reader last touched.
 *
 * The `Card` around the table is gone (a table draws its own rules — house rule, and
 * `order-list.tsx` explains it), the empty state's Card with it, and the four tabs now match the
 * orders list: `type-caption` on `h-7` ghost buttons, quieter than the data they filter, with a
 * line under them saying what the chosen one actually contains. Nothing said that before.
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

/**
 * ⚠️ `meaningTh` is new and is not decoration. Four buttons sat above this table with nothing
 * saying what any of them selected, and two of them — รอจ่าย and รอตัดสินใจ — are one word apart
 * and opposite halves of the process. A reader who picked the wrong one saw a plausible table.
 */
const TABS: readonly { readonly key: Tab; readonly labelTh: string; readonly meaningTh: string }[] = [
  { key: 'payable', labelTh: 'รอจ่าย', meaningTh: 'อนุมัติแล้ว เงินยังไม่ออกจากบัญชี' },
  { key: 'requested', labelTh: 'รอตัดสินใจ', meaningTh: 'ลูกค้าขอมาแล้ว ยังไม่มีใครอนุมัติหรือปฏิเสธ' },
  {
    key: 'different',
    labelTh: 'บัญชีไม่ตรงกับที่โอนมา',
    meaningTh: 'ปลายทางไม่ใช่บัญชีที่ระบบจับคู่กับสลิปที่รับไว้ — ทุกสถานะ',
  },
  { key: 'all', labelTh: 'ทั้งหมด', meaningTh: 'ทุกคำขอคืนเงิน ทุกสถานะ' },
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

/**
 * The payable total, which is **not** derived from the visible tab.
 *
 * `counting` is not `[]`: an empty list and a count that has not arrived are the same shape and
 * opposite news, and `refundFocus` refuses to fold them together.
 */
type Payable =
  | { readonly status: 'counting' }
  | { readonly status: 'counted'; readonly refunds: readonly Refund[] }
  | { readonly status: 'unknown' };

export function RefundQueue() {
  const [tab, setTab] = useState<Tab>('payable');
  const [state, setState] = useState<State>({ status: 'loading' });
  const [payable, setPayable] = useState<Payable>({ status: 'counting' });
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

  /*
   * ⚠️ Separate from the tab's own load, and its failure is separate too — the same call
   * `authority-screen.tsx` makes about its two reads. Losing the total must not lose the table,
   * and a total that could not be fetched says so rather than reading as ฿0.
   */
  async function count(): Promise<void> {
    try {
      setPayable({ status: 'counted', refunds: await listRefunds(QUERY.payable) });
    } catch {
      setPayable({ status: 'unknown' });
    }
  }

  useEffect(() => {
    void reload(tab);
  }, [tab]);

  useEffect(() => {
    void count();
  }, []);

  /** Both loads, so a disbursement moves the headline as well as the row it came from. */
  async function refresh(): Promise<void> {
    await Promise.all([reload(tab), count()]);
  }

  const focus = refundFocus(
    payable.status === 'counted' ? payable.refunds : null,
    payable.status === 'counted' && payable.refunds.length >= REFUND_PAGE_LIMIT,
  );

  const chosen = TABS.find((entry) => entry.key === tab);

  return (
    <div className="flex flex-col gap-6">
      {/*
       * ⭐ THE PRIMARY THING. On the page ground, no border, type doing the work.
       *
       * Held back until the count has actually been attempted — a headline that said
       * "ไม่มีเงินที่อนุมัติแล้วและยังไม่ได้จ่าย" for half a second on every load would be a
       * reassurance the screen had not earned yet.
       */}
      {payable.status !== 'counting' && (
        <section className="flex flex-col gap-1">
          <p className="type-focal text-balance">{focus.headlineTh}</p>
          <p className="text-muted-foreground type-body max-w-2xl">{focus.detailTh}</p>
        </section>
      )}

      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-1">
          {TABS.map((entry) => (
            /*
             * `type-caption` on an `h-7` ghost button — the orders list's treatment, and the
             * same argument: the filter row is how you get to the answer, not the answer, so it
             * is deliberately quieter than the table under it.
             */
            <Button
              key={entry.key}
              size="sm"
              variant={tab === entry.key ? 'secondary' : 'ghost'}
              className="type-caption h-7 px-2.5"
              onClick={() => setTab(entry.key)}
            >
              {entry.labelTh}
            </Button>
          ))}
        </div>
        {/* What the chosen tab actually contains. Four buttons sat here saying nothing. */}
        {chosen === undefined ? null : (
          <p className="text-muted-foreground type-caption">{chosen.meaningTh}</p>
        )}
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
        /* Nothing to separate from anything, so nothing to draw a border around. */
        <p className="text-muted-foreground type-body py-10 text-center">ไม่มีรายการในหมวดนี้</p>
      )}

      {state.status === 'ready' && state.refunds.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="type-caption h-8">ออเดอร์</TableHead>
              <TableHead className="type-caption h-8 text-right">ยอด</TableHead>
              <TableHead className="type-caption h-8">ปลายทาง</TableHead>
              <TableHead className="type-caption h-8">สถานะ</TableHead>
              <TableHead className="type-caption h-8">ขอเมื่อ</TableHead>
              {/* `w-full` on the last column: the slack goes to the controls rather than being
                  shared out between the order number, the amount and the destination, which are
                  the three facts a scan reads together. Same call `order-list.tsx` explains. */}
              <TableHead className="type-caption h-8 w-full" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.refunds.map((refund) => (
              <TableRow key={refund.id}>
                <TableCell className="px-2 py-1.5">
                  <Link
                    href={`/orders/${refund.orderId}` as Route}
                    className="focus-visible:outline-ring type-body rounded font-mono hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                  >
                    {refund.orderNo ?? refund.orderId.slice(0, 8)}
                  </Link>
                </TableCell>
                <TableCell className="type-body px-2 py-1.5 text-right font-medium tabular-nums">
                  {formatBaht(refund.amountThbMinor)}
                </TableCell>
                <TableCell className="type-body px-2 py-1.5">
                  <div className="flex flex-col gap-0.5">
                    <span>
                      {refund.payeeName}{' '}
                      <span className="text-muted-foreground type-caption font-mono">
                        {refund.payeeBankCode} ···{refund.payeeAccountLast4}
                      </span>
                    </span>
                    {/*
                     * ⚠️ The flag, on the row, before anybody opens anything. It is derived
                     * from the accepted slips — the system could not match this destination
                     * to money that came in — and a refund reaching this state should be
                     * visible at a glance rather than only inside the decision dialog.
                     *
                     * `text-destructive` survives this pass on purpose. It is not carrying
                     * hierarchy — it is a warning about one row, which is what the token is for,
                     * and it is the same colour the acknowledgement Alert uses two clicks later.
                     */}
                    {refund.payeeIsOriginalAccount === 'no' && (
                      <span className="text-destructive type-caption inline-flex items-center gap-1">
                        <ShieldAlert className="size-3" />
                        ไม่ใช่บัญชีที่โอนเงินเข้ามา
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="px-2 py-1.5">
                  <Badge variant={refund.status === 'approved' ? 'default' : 'outline'}>
                    {STATUS_TH[refund.status]}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground type-caption px-2 py-1.5">
                  {at(refund.requestedAt)}
                </TableCell>
                <TableCell className="px-2 py-1.5 text-right">
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
                    <span className="text-muted-foreground type-caption font-mono">
                      {refund.disbursementReference}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {deciding !== null && (
        <DecisionDialog
          refund={deciding}
          onClose={() => setDeciding(null)}
          onDone={() => {
            setDeciding(null);
            void refresh();
          }}
        />
      )}

      {paying !== null && (
        <DisbursementDialog
          refund={paying}
          onClose={() => setPaying(null)}
          onDone={() => {
            setPaying(null);
            void refresh();
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
