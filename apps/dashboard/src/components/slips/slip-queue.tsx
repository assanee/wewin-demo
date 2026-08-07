'use client';

import { useEffect, useState } from 'react';
import { formatBaht } from '@wewin/core/format';
import { AlertTriangle, ImageOff, ShieldAlert } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { failureMessage } from '@/lib/api/errors';
import { listQueue, type QueueEntry } from './slip-api';
import { SlipReviewDialog } from './slip-review-dialog';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Slips waiting for somebody to say the money is real.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `GET /payments/slips` lists `status = 'submitted'` — the exact clause the overview's card
 * counts, which is what keeps the number on the landing page and the length of this table
 * from drifting apart.
 *
 * ── ⚠️ A submitted slip is a photograph, not money ───────────────────────────
 *
 * Nothing on this screen has moved a balance. `order_settled_thb_minor()` counts **accepted**
 * slips only, so every row here is a customer's claim that they transferred something, and
 * the whole job of the review dialog is turning a claim into a fact — with a person's name
 * against it.
 */

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly entries: readonly QueueEntry[] }
  | { readonly status: 'failed'; readonly problem: string };

const at = (iso: string): string =>
  new Date(iso).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

const LIMIT = 200;

export function SlipQueue() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [reviewing, setReviewing] = useState<string | null>(null);

  async function reload(): Promise<void> {
    try {
      setState({ status: 'ready', entries: await listQueue(LIMIT) });
    } catch (error) {
      setState({ status: 'failed', problem: failureMessage(error) });
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  if (state.status === 'loading') return <Skeleton className="h-64 w-full" />;

  if (state.status === 'failed') {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>โหลดคิวสลิปไม่สำเร็จ</AlertTitle>
        <AlertDescription>{state.problem}</AlertDescription>
      </Alert>
    );
  }

  if (state.entries.length === 0) {
    return (
      <Card>
        <CardContent className="text-muted-foreground py-10 text-center text-sm">
          ไม่มีสลิปรอตรวจ
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ออเดอร์</TableHead>
              <TableHead className="text-right">ยอดบนสลิป</TableHead>
              <TableHead>ผู้โอน</TableHead>
              <TableHead>ลูกค้าแจ้งว่าโอนเมื่อ</TableHead>
              <TableHead>ภาพ</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.entries.map(({ slip, orderNo }) => (
              <TableRow key={slip.id}>
                <TableCell className="font-mono text-sm">
                  {orderNo ?? `ร่าง ${slip.orderId.slice(0, 8)}`}
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {formatBaht(slip.amountThbMinor)}
                </TableCell>
                <TableCell className="text-sm">
                  {slip.payerName ?? <span className="text-muted-foreground">ไม่ได้ระบุ</span>}
                  {/*
                   * ⚠️ The name the *customer typed*, until somebody reads it off the image.
                   *
                   * 5b red team RT-2: `payer_name` arrives on the customer's own create-slip
                   * body and nothing compares it to the picture or to anything a bank said. A
                   * mule account named on the slip and then named again on the refund request
                   * reads as "the original account" — so the queue flags the gap rather than
                   * printing the claim as though it were checked.
                   */}
                  {slip.payerName !== null && !slip.payerVerified && (
                    <span className="text-muted-foreground ml-2 inline-flex items-center gap-1 text-xs">
                      <ShieldAlert className="size-3" />
                      ยังไม่มีใครตรวจกับภาพ
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {at(slip.transferredAt)}
                </TableCell>
                <TableCell>
                  {slip.hasImage ? (
                    <span className="text-sm">มี</span>
                  ) : (
                    <span className="text-muted-foreground inline-flex items-center gap-1 text-sm">
                      <ImageOff className="size-3.5" />
                      ไม่มี
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Button size="sm" onClick={() => setReviewing(slip.id)}>
                    ตรวจ
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {state.entries.length >= LIMIT && (
        <p className="text-muted-foreground text-xs">
          แสดง {LIMIT} รายการแรก — API จำกัดไว้เท่านี้ ส่วนตัวเลขบนภาพรวมคือยอดจริงทั้งหมด
        </p>
      )}

      {reviewing !== null && (
        <SlipReviewDialog
          slipId={reviewing}
          onClose={() => setReviewing(null)}
          onDone={() => {
            setReviewing(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}
