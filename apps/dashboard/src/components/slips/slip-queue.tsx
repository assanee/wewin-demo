'use client';

import { useEffect, useState } from 'react';
import { formatBaht } from '@wewin/core/format';
import { AlertTriangle, ImageOff, ShieldAlert } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { failureMessage } from '@/lib/api/errors';
import { listQueue, type QueueEntry } from './slip-api';
import { slipQueueFocus } from './slip-focus';
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
 *
 * ── ⭐ One primary thing, and the table is not it ─────────────────────────────
 *
 * This screen carried **no heading at all** — the `<Card>` around the table was the only shape
 * on it, and a reader had to count rows to learn whether there was a pile. The sum of the
 * amounts was on no screen in the app.
 *
 * `slipQueueFocus` now opens the screen at `type-focal`, on the page ground with no border, and
 * the Card is gone: a `<Table>` draws every rule it needs, so wrapping it in a ring was an edge
 * around an edge — the house rule `order-list.tsx` already applies, restated here because this
 * table also carried `overflow-hidden py-0` to undo the padding of the Card it did not need.
 * The empty state lost its Card too; the focal sentence *is* the empty state now.
 *
 * ⚠️ The focal sentence names an amount and then immediately says it is not money yet. That
 * qualifier is the difference between this figure and the overview's รับชำระเดือนนี้, and
 * without it the two screens read as contradicting each other by the size of this queue.
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

  /*
   * ⚠️ `>= LIMIT` is handed in rather than checked below the table, because it changes what the
   * headline is allowed to claim. A full page means the count is a floor and the total is a
   * partial sum; the sentence says อย่างน้อย rather than quietly disagreeing with the overview.
   */
  const focus = slipQueueFocus(
    state.entries.map((entry) => entry.slip),
    state.entries.length >= LIMIT,
  );

  return (
    <div className="flex flex-col gap-6">
      {/*
       * ⭐ THE PRIMARY THING. On the page ground, no border, type doing the work.
       *
       * Rendered in the empty case too — "ไม่มีสลิปรอตรวจ" is an answer, and it used to be a
       * centred line inside a Card, which is a box drawn around the absence of anything.
       */}
      <section className="flex flex-col gap-1">
        <p className="type-focal text-balance">{focus.headlineTh}</p>
        <p className="text-muted-foreground type-body max-w-2xl">{focus.detailTh}</p>
      </section>

      {/*
       * ⚠️ The "แสดง 200 รายการแรก" paragraph that used to sit under this table is gone, and not
       * because the cap stopped mattering — it moved *into* the focal sentence, which is where a
       * caveat about a number belongs. Two elements saying the same thing a centimetre apart is
       * the duplication this pass exists to remove.
       */}
      {state.entries.length > 0 && (
        <div className="flex flex-col gap-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="type-caption h-8">ออเดอร์</TableHead>
                <TableHead className="type-caption h-8 text-right">ยอดบนสลิป</TableHead>
                <TableHead className="type-caption h-8">ผู้โอน</TableHead>
                <TableHead className="type-caption h-8">ลูกค้าแจ้งว่าโอนเมื่อ</TableHead>
                <TableHead className="type-caption h-8">ภาพ</TableHead>
                {/* `w-full` on the last column so `table-layout: auto` gives the slack to the
                    controls instead of spreading the order number, the amount and the payer
                    apart across a 1440px screen. Same call `order-list.tsx` explains. */}
                <TableHead className="type-caption h-8 w-full" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.entries.map(({ slip, orderNo }) => (
                <TableRow key={slip.id}>
                  <TableCell className="type-body px-2 py-1.5 font-mono">
                    {orderNo ?? `ร่าง ${slip.orderId.slice(0, 8)}`}
                  </TableCell>
                  <TableCell className="type-body px-2 py-1.5 text-right font-medium tabular-nums">
                    {formatBaht(slip.amountThbMinor)}
                  </TableCell>
                  <TableCell className="type-body px-2 py-1.5">
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
                      <span className="text-muted-foreground type-caption ml-2 inline-flex items-center gap-1">
                        <ShieldAlert className="size-3" />
                        ยังไม่มีใครตรวจกับภาพ
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground type-caption px-2 py-1.5">
                    {at(slip.transferredAt)}
                  </TableCell>
                  <TableCell className="px-2 py-1.5">
                    {slip.hasImage ? (
                      <span className="type-body">มี</span>
                    ) : (
                      <span className="text-muted-foreground type-body inline-flex items-center gap-1">
                        <ImageOff className="size-3.5" />
                        ไม่มี
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="px-2 py-1.5 text-right">
                    <Button size="sm" onClick={() => setReviewing(slip.id)}>
                      ตรวจ
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
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
