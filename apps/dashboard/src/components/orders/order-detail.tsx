'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { formatBaht } from '@wewin/core/format';
import { AlertTriangle, ArrowLeft, Lock, Printer } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { statusLabel, statusTone, transitionForm } from './order-language';

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
 */

const TONE: Record<ReturnType<typeof statusTone>, 'default' | 'secondary' | 'outline'> = {
  attention: 'default',
  live: 'secondary',
  done: 'outline',
  over: 'outline',
};

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

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/orders"
        className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4" /> กลับไปรายการออเดอร์
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-2xl font-semibold">
          {order.orderNo ?? `ร่าง ${order.id.slice(0, 8)}`}
        </h1>
        <Badge variant={TONE[statusTone(order.status)]}>{statusLabel(order.status)}</Badge>
        {/* The quotation lives with the order, so the way to it does too. */}
        {order.documentRevision !== null && (
          <Link
            href={`/quotes/${order.id}/print` as Route}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
          >
            <Printer className="size-3.5" /> ใบเสนอราคา
          </Link>
        )}
        {order.isFrozen && (
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-sm">
            <Lock className="size-3.5" />
            ตัดอะลูมิเนียมแล้ว {order.frozenAt === null ? '' : `เมื่อ ${at(order.frozenAt)}`}
          </span>
        )}
      </div>

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

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">ผู้ติดต่อ</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[6rem_1fr] gap-x-4 gap-y-2 text-sm">
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
            <CardTitle className="text-base">ยอดเงิน</CardTitle>
            {order.money === null && (
              <CardDescription>
                {/* A draft has no contract — that is the whole draft/redesign split. */}
                ยังไม่มีสัญญา — ตะกร้าที่ยังไม่ได้ส่งจึงยังไม่มียอด
              </CardDescription>
            )}
          </CardHeader>
          {order.money !== null && (
            <CardContent>
              <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
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
                  <span className="text-muted-foreground ml-2 text-xs">ตรึงไว้ตั้งแต่ตอนส่ง</span>
                </dd>
              </dl>
            </CardContent>
          )}
        </Card>
      </div>

      {order.openChangeRequest !== null && (
        <Card className="border-foreground/20">
          <CardHeader>
            <CardTitle className="text-base">ลูกค้าขอแก้ไข</CardTitle>
            <CardDescription>เปิดเมื่อ {at(order.openChangeRequest.openedAt)}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm whitespace-pre-wrap">{order.openChangeRequest.noteTh}</p>
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">เปลี่ยนสถานะ</CardTitle>
          <CardDescription>
            {/*
             * Said out loud, because it is the reason there is no greyed-out button here for
             * a move that is merely unavailable: an unavailable move is not in the list at
             * all, and the list came from the database.
             */}
            ปุ่มเหล่านี้มาจากตารางสถานะของ API โดยตรง — สิ่งที่ไม่ปรากฏคือสิ่งที่ทำไม่ได้จริง
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {order.availableTransitions.length === 0 && (
            <p className="text-muted-foreground text-sm">
              ออเดอร์นี้เดินต่อไม่ได้แล้ว — เป็นสถานะปลายทาง
            </p>
          )}
          {order.availableTransitions.map((available) => {
            const form = transitionForm(available.payloadKind);

            return form.offered ? (
              <Button key={available.toStatus} variant="outline" onClick={() => setMoving(available)}>
                {available.descriptionTh}
              </Button>
            ) : (
              <div
                key={available.toStatus}
                className="border-border text-muted-foreground rounded-md border border-dashed px-3 py-2 text-xs"
              >
                {available.descriptionTh} — {form.whyNotTh}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">สันประวัติ</CardTitle>
          <CardDescription>ทุกบรรทัดเขียนโดยการเปลี่ยนสถานะที่ทำให้เกิดขึ้น — แก้ไม่ได้</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="flex flex-col gap-4">
            {events.map((event) => (
              <li key={event.id} className="flex gap-4">
                <span className="text-muted-foreground w-8 shrink-0 text-right font-mono text-xs">
                  {event.seq}
                </span>
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm">
                    <span className="font-medium">{event.eventType}</span>
                    {event.toStatus !== null && (
                      <>
                        {' → '}
                        {statusLabel(event.toStatus)}
                      </>
                    )}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {at(event.createdAt)} · {event.actorKind}
                    {event.actorUserId === null ? '' : ` · ${event.actorUserId.slice(0, 8)}`}
                  </span>
                  {Object.keys(event.payload).length > 0 && (
                    <pre className="bg-muted/50 mt-1 max-w-full overflow-x-auto rounded p-2 text-xs">
                      {JSON.stringify(event.payload, null, 2)}
                    </pre>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

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
