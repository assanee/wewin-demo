'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { formatBaht } from '@wewin/core/format';
import { AlertTriangle, Lock, Printer } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/page-header';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { failureMessage } from '@/lib/api/errors';
import {
  getOrder,
  listEvents,
  resolveChangeRequest,
  transition,
  type AvailableTransition,
  type OrderDetail as Order,
  type OrderEvent,
} from './order-api';
import { orderFocus } from './order-focus';
import { statusLabel, transitionForm } from './order-language';
import { outstandingDisplay, readOutstanding } from './order-outstanding';
import { OrderTimeline } from './order-spine';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * One order: what it is worth, what happened to it, and what may happen next.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── ⭐ The buttons are the API's, not this file's ────────────────────────────
 *
 * There is no map here of which move is legal from which status. `availableTransitions`
 * arrives on the order, derived from `order_status_transitions`, and every button on this
 * screen is one entry in it. The contract says why: *"A dashboard that hides a button is
 * being tidy; the transition table is what makes it authorisation."* Sending the list means
 * the two cannot disagree — and it is the only honest way to render `redesign`, whose
 * outgoing edges depend on data no client holds.
 *
 * What this file *does* decide is the body each move takes, and that lives in
 * `order-language.ts` where it can be tested without rendering anything.
 *
 * ── The spine is the audit trail, and staff see more of it ───────────────────
 *
 * `GET /orders/:id/events` switches audience on the caller's reach: a token holding
 * `orders.read` gets the staff member's id and the prose they typed, a customer's token does
 * not. This screen renders whatever arrived — there is no "show staff view" toggle, because
 * there is no way to ask for it without holding the permission.
 *
 * ── ⭐ The primary thing is the status, and the reading order changed for it ──
 *
 * The reason somebody opens an order is *where is this, and what can I do next*. That fact was
 * previously a **badge** beside the title — smaller than the three card headings under it —
 * while the moves lived at the bottom of the third card. Three Cards of identical weight meant
 * ผู้ติดต่อ, ยอดเงิน and the entire history read as peers.
 *
 * Now: the status is a `type-focal` statement on the page ground, directly above the spine,
 * and the spine has lost its Card so the two are one continuous region — status, then what
 * happened, then what may happen next, with no border cutting between them.
 *
 * ⚠️ **The transition buttons did not move and must not.** `order-spine.tsx` puts them at the
 * terminus of the rail on purpose: `availableTransitions` is the rows of
 * `order_status_transitions` that *could* be written and the events are the ones that *were*,
 * so the buttons are the end of the same line. Lifting them up beside the status would split
 * the thing that file was written to join, and would also make two places on one screen assert
 * the same gate. The status statement therefore *names* what is possible and points down the
 * rail; it does not duplicate the controls.
 *
 * ⚠️ **ผู้ติดต่อ and ยอดเงิน moved below the spine.** Both keep their Cards — contact details
 * and an amounts breakdown are exactly the self-contained reference a border is for — but
 * reference is not what the screen is for, so it no longer opens with it.
 *
 * ── ⚠️ What is still owed goes in ยอดเงิน, and nowhere else on this screen ────
 *
 * `outstandingThbMinor` is the most *actionable* number on an `awaiting_payment` order, and it
 * still does not go at the top. Two reasons, and the second is the binding one:
 *
 *   It is only legible against the figures it sits with. ค้างชำระ ฿9,940 means "the deposit
 *   landed" **because** ยอดรวม ฿14,200 and มัดจำตามสัญญา ฿4,260 are on the same four lines.
 *   Lifted out on its own it is a number with no scale, and the reader comes down here anyway.
 *
 *   `README.md`: *ถ้าตัวเลขหรือประโยคนั้นมีอยู่แล้วที่อื่นบนหน้าจอเดียวกัน มันไม่ใช่จุดเด่น*. Printing it
 *   here **and** beside the status is exactly the ยอดรวมสุทธิ mistake phase 1 made on the quote
 *   screen — the same figure under the same label, 400px apart. One place, and this is it.
 *   The focal statement stays what somebody opened the order to learn: where it is, and whether
 *   it can move.
 */

/*
 * ⚠️ The `TONE` map that used to be here is gone, along with the `Badge` it fed.
 *
 * It translated `statusTone`'s four tones into badge variants for the chip beside the title.
 * With the status promoted to a `type-focal` statement and `orderFocus` saying in words what
 * the tone was gesturing at, the chip was printing the same Thai word a second time. `TONE`
 * survives in `order-list.tsx`, where a badge in a table cell is still the right shape and a
 * 24px heading per row obviously is not.
 */

const at = (iso: string): string =>
  new Date(iso).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly order: Order; readonly events: readonly OrderEvent[] }
  | { readonly status: 'failed'; readonly problem: string };

export function OrderDetail({ orderId }: { readonly orderId: string }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [moving, setMoving] = useState<AvailableTransition | null>(null);
  const [resolving, setResolving] = useState(false);

  async function reload(): Promise<void> {
    try {
      const [order, events] = await Promise.all([getOrder(orderId), listEvents(orderId)]);
      setState({ status: 'ready', order, events });
    } catch (error) {
      setState({ status: 'failed', problem: failureMessage(error) });
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  if (state.status === 'loading') return <Skeleton className="h-96 w-full" />;

  if (state.status === 'failed') {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>เปิดออเดอร์นี้ไม่ได้</AlertTitle>
        <AlertDescription>{state.problem}</AlertDescription>
      </Alert>
    );
  }

  const { order, events } = state;

  const focus = orderFocus(order.availableTransitions);
  const owed = readOutstanding(order);
  /* Same three states, same wording, as the ค้างชำระ column on the list — one module decides. */
  const owedDisplay = outstandingDisplay(owed);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={order.orderNo ?? `ร่าง ${order.id.slice(0, 8)}`}
        mono={order.orderNo !== null}
        back={{ href: '/orders', label: 'รายการออเดอร์' }}
        meta={
          <>
            {order.isFrozen && (
              <span className="text-muted-foreground type-caption inline-flex items-center gap-1.5">
                <Lock className="size-3.5" aria-hidden />
                เริ่มผลิตแล้ว {order.frozenAt === null ? '' : `เมื่อ ${at(order.frozenAt)}`}
              </span>
            )}
          </>
        }
        actions={
          /* The quotation lives with the order, so the way to it does too. */
          order.documentRevision === null ? undefined : (
            <Button asChild variant="outline" size="sm">
              <Link href={`/quotes/${order.id}/print` as Route}>
                <Printer data-icon="inline-start" />
                ใบเสนอราคา
              </Link>
            </Button>
          )
        }
      />

      {/*
       * Both directions of a supersession, when there is one. An order that replaced another
       * and an order that was replaced are the same fact told from two sides, and a screen
       * that showed only one of them leaves somebody hunting for the other by order number.
       */}
      {(order.supersedesOrderId !== null || order.supersededByOrderId !== null) && (
        <Alert>
          <AlertTitle>ออเดอร์นี้เกี่ยวข้องกับอีกใบ</AlertTitle>
          <AlertDescription className="flex flex-col gap-1">
            {order.supersedesOrderId !== null && (
              <Link href={`/orders/${order.supersedesOrderId}` as Route} className="underline">
                มาแทนที่ออเดอร์ก่อนหน้า
              </Link>
            )}
            {order.supersededByOrderId !== null && (
              <Link href={`/orders/${order.supersededByOrderId}` as Route} className="underline">
                ถูกแทนที่ด้วยออเดอร์ใบใหม่
              </Link>
            )}
          </AlertDescription>
        </Alert>
      )}

      {order.openChangeRequest !== null && (
        /*
         * ⭐ Above the status, because it outranks it: a customer waiting on an answer is the
         * only thing on this screen more urgent than where the order is.
         *
         * ⚠️ `ring-foreground/25` and not the `border-foreground/20` this used to carry. `Card`
         * draws its edge with `ring-1 ring-foreground/10` and sets no border-*width*, and
         * Tailwind's preflight zeroes border-width on every element — so the old class set a
         * colour on an edge that was never drawn and the emphasis had never rendered. Same bug
         * `QueueTile` on the overview was carrying.
         */
        <Card className="bg-accent/40 ring-foreground/25">
          <CardHeader>
            <CardTitle>ลูกค้าขอแก้ไข</CardTitle>
            <CardDescription>เปิดเมื่อ {at(order.openChangeRequest.openedAt)}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="type-body whitespace-pre-wrap">{order.openChangeRequest.noteTh}</p>
            <div className="flex flex-wrap gap-2">
              {(['accepted', 'rejected', 'withdrawn'] as const).map((resolution) => (
                <Button
                  key={resolution}
                  size="sm"
                  variant={resolution === 'accepted' ? 'default' : 'outline'}
                  disabled={resolving}
                  onClick={() => {
                    setResolving(true);
                    void (async () => {
                      try {
                        await resolveChangeRequest(
                          order.id,
                          order.openChangeRequest?.id ?? '',
                          resolution,
                          '',
                        );
                        toast.success('บันทึกการตัดสินใจแล้ว');
                        await reload();
                      } catch (error) {
                        toast.error(failureMessage(error));
                      } finally {
                        setResolving(false);
                      }
                    })();
                  }}
                >
                  {{ accepted: 'รับคำขอ', rejected: 'ปฏิเสธ', withdrawn: 'ลูกค้าถอนคำขอ' }[resolution]}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/*
       * ⭐ THE PRIMARY THING, and then the rail it belongs to — one region, no border between.
       *
       * The status was a badge; it is now the statement. `orderFocus` supplies the line under
       * it, which *names* what can be done next and points at the buttons rather than repeating
       * them — see that module's header, and `order-spine.tsx`'s, for why the controls stay at
       * the terminus.
       */}
      <section className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          {/*
           * ⚠️ No `Badge` beside this, deliberately. The first draft of this block kept the
           * status chip next to the heading and printed the same Thai word twice, two
           * centimetres apart. The badge existed because the status had nowhere better to be;
           * at `type-focal` it does, and `statusTone`'s four tones now say nothing the sentence
           * underneath does not say in words.
           */}
          <h2 className="type-focal">{statusLabel(order.status)}</h2>
          <p className="text-muted-foreground type-body">{focus.nextTh}</p>
        </div>

        {/*
         * ⭐ One rail, where there were two cards. See `order-spine.tsx`.
         *
         * `เปลี่ยนสถานะ` and `ลำดับเหตุการณ์` were a box of buttons and a list of rows, always read
         * together and presented apart. They are the same table — `availableTransitions` is the
         * rows of `order_status_transitions` that *could* be written and the spine is the ones that
         * *were* — so the buttons are the terminus of the same rail.
         *
         * ⚠️ `setMoving` is passed, not moved. The dialog below, `transitionForm`'s per-kind bodies
         * and the post-freeze cancellation that needs a reason *and* a fault are untouched: the
         * timeline calls `onMove` with the same `AvailableTransition` the old button did.
         */}
        <OrderTimeline
          events={events}
          availableTransitions={order.availableTransitions}
          onMove={setMoving}
        />
      </section>

      {/*
       * Reference, below the thing the screen is for. Both keep a Card: contact details and an
       * amounts breakdown are the self-contained reference the house rule reserves borders for.
       */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>ผู้ติดต่อ</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="type-body grid grid-cols-[6rem_1fr] gap-x-4 gap-y-2">
              <dt className="text-muted-foreground">ชื่อ</dt>
              <dd>{order.contact.name ?? '—'}</dd>
              <dt className="text-muted-foreground">อีเมล</dt>
              <dd className="break-all">{order.contact.email ?? '—'}</dd>
              <dt className="text-muted-foreground">โทรศัพท์</dt>
              <dd>{order.contact.phone ?? '—'}</dd>
              <dt className="text-muted-foreground">สร้างเมื่อ</dt>
              <dd>{at(order.createdAt)}</dd>
              <dt className="text-muted-foreground">ส่งเมื่อ</dt>
              <dd>{order.submittedAt === null ? 'ยังไม่ได้ส่ง' : at(order.submittedAt)}</dd>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>ยอดเงิน</CardTitle>
            {order.money === null && (
              <CardDescription>
                {/* A draft has no contract — that is the whole draft/redesign split. */}
                ยังไม่มีสัญญา — ตะกร้าที่ยังไม่ได้ส่งจึงยังไม่มียอด
              </CardDescription>
            )}
          </CardHeader>
          {order.money !== null && (
            <CardContent>
              <dl className="type-body grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2">
                <dt className="text-muted-foreground">ก่อนภาษี</dt>
                <dd className="tabular-nums">{formatBaht(order.money.netThbMinor)}</dd>
                <dt className="text-muted-foreground">ภาษีมูลค่าเพิ่ม</dt>
                <dd className="tabular-nums">{formatBaht(order.money.vatThbMinor)}</dd>
                <dt className="font-medium">ยอดรวม</dt>
                <dd className="tabular-nums font-medium">
                  {formatBaht(order.money.grandTotalThbMinor)}
                </dd>
                <dt className="text-muted-foreground">มัดจำตามสัญญา</dt>
                <dd className="tabular-nums">
                  {formatBaht(order.money.scheduledDepositThbMinor)}
                  {/*
                   * Pinned at submit, not recomputed. It is a term of the contract and the
                   * ceiling on what may ever be forfeited — plan 7.13 — so a screen that
                   * recalculated it from today's price would be showing a different number
                   * from the one the customer agreed to.
                   */}
                  <span className="text-muted-foreground type-caption ml-2">ตรึงไว้ตั้งแต่ตอนส่ง</span>
                </dd>

                {/*
                 * ⭐ The two figures this card was missing, both read straight off the order.
                 *
                 * ⛔ Neither is arrived at here. `order_outstanding_thb_minor()` and
                 * `order_next_due_thb_minor()` are Postgres's, carried as columns on the read
                 * that fetched this order — so this card and the customer's payment screen are
                 * one function called twice rather than two derivations that can disagree.
                 * `ยอดรวม` minus `มัดจำตามสัญญา` is **not** either of them and never was: a slip
                 * can carry money no instalment claimed, and the schedule can hold more than
                 * two rows.
                 */}
                <dt className="font-medium">ค้างชำระ</dt>
                <dd
                  className={
                    owedDisplay.emphasis === 'debt'
                      ? 'tabular-nums font-semibold'
                      : 'text-muted-foreground'
                  }
                >
                  {owedDisplay.textTh}
                </dd>

                {/*
                 * ⚠️ Present only when it says something the line above does not.
                 *
                 * The two folds are **equal on a pay-in-full order** and differ by the balance on
                 * a 30/70. When they are equal, a งวดถัดไปต้องการ row would print the same baht
                 * figure a centimetre under ค้างชำระ with a different label on it — which does not
                 * read as one debt stated twice, it reads as two debts. `README.md`'s rule, and
                 * `order-outstanding.ts` is where the comparison is decided and tested.
                 */}
                {owed.kind === 'owing' && !owed.nextDueIsWholeDebt && (
                  <>
                    {/*
                     * `งวดถัดไปต้องการ`, spelled exactly as `slip-review-dialog.tsx` spells it —
                     * the screen where staff decide what a slip pays off. One concept, one Thai
                     * phrase across the two screens that both talk about it, and no new wording
                     * invented for a thing this app already has a word for.
                     */}
                    <dt className="text-muted-foreground">งวดถัดไปต้องการ</dt>
                    <dd className="tabular-nums">{formatBaht(owed.nextDueThbMinor)}</dd>
                  </>
                )}
              </dl>
            </CardContent>
          )}
        </Card>
      </div>

      {moving !== null && (
        <TransitionDialog
          orderId={order.id}
          available={moving}
          onClose={() => setMoving(null)}
          onDone={() => {
            setMoving(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

/**
 * The form for one move.
 *
 * Which fields it shows and what it posts both come from `transitionForm`, so this component
 * has no knowledge of `cancel` being two different shapes — it renders a list and composes a
 * body. That separation is what let the sharp part be tested without a browser.
 */
function TransitionDialog({
  orderId,
  available,
  onClose,
  onDone,
}: {
  readonly orderId: string;
  readonly available: AvailableTransition;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const form = transitionForm(available.payloadKind);
  const [reason, setReason] = useState('');
  const [noteTh, setNoteTh] = useState('');
  const [fault, setFault] = useState(false);
  const [busy, setBusy] = useState(false);

  const values = { reason, noteTh, attributeFaultToCompany: fault };
  const missing = form.fields.some(
    (field) => field.required && (values[field.name as 'reason' | 'noteTh'] ?? '').trim() === '',
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{available.descriptionTh}</DialogTitle>
          <DialogDescription>
            เปลี่ยนสถานะเป็น “{statusLabel(available.toStatus)}”
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {form.fields.map((field) =>
            field.kind === 'checkbox' ? (
              <div key={field.name} className="flex items-start gap-3">
                <Checkbox
                  id={field.name}
                  checked={fault}
                  onCheckedChange={(checked) => setFault(checked === true)}
                />
                <div className="flex flex-col gap-1">
                  <Label htmlFor={field.name}>{field.labelTh}</Label>
                  {field.helpTh !== undefined && (
                    <span className="text-muted-foreground text-xs">{field.helpTh}</span>
                  )}
                </div>
              </div>
            ) : (
              <div key={field.name} className="flex flex-col gap-2">
                <Label htmlFor={field.name}>
                  {field.labelTh}
                  {field.required ? '' : ' (ไม่บังคับ)'}
                </Label>
                <Textarea
                  id={field.name}
                  rows={3}
                  maxLength={2000}
                  value={field.name === 'reason' ? reason : noteTh}
                  onChange={(event) =>
                    field.name === 'reason'
                      ? setReason(event.target.value)
                      : setNoteTh(event.target.value)
                  }
                />
                {field.helpTh !== undefined && (
                  <span className="text-muted-foreground text-xs">{field.helpTh}</span>
                )}
              </div>
            ),
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </Button>
          <Button
            disabled={busy || missing}
            onClick={() => {
              setBusy(true);
              void (async () => {
                try {
                  await transition(orderId, available.toStatus, form.body(values));
                  toast.success(`เปลี่ยนเป็น “${statusLabel(available.toStatus)}” แล้ว`);
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
