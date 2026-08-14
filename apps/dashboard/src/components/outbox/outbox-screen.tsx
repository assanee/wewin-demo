'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { failureMessage } from '@/lib/api/errors';
import { getOutbox, listAttempts, retry, type Attempt, type Outbox } from './outbox-api';
import { outboxFocus } from './outbox-focus';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The outbox — messages the company believes it sent.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * *"A dead-lettered notification that nobody sees is worse than none, because the company
 * believes the customer was told."* The API says so, the worker logs at `error` when the
 * count changes, and this screen is the other half — either alone is decoration.
 *
 * ── ⚠️ Dead and suppressed are two lists, not one ────────────────────────────
 *
 *   `dead`        tried and failed. Retryable, and the button is here.
 *   `suppressed`  **never addressable.** A quote submitted with no contact channel, a LINE
 *                 rule with nowhere to send. Retrying would fail identically, so there is no
 *                 button — what it needs is somebody to get an address, which is a different
 *                 job for a different person. Merging the two would bury the ones that can
 *                 actually be fixed.
 *
 * `stuckSending` is its own alarm: a row claimed by a worker that never finished. Nothing
 * retries it on a timer, so a number above zero is somebody's process dying mid-send.
 *
 * ── ⭐ One primary thing, and the screen used not to have one ─────────────────
 *
 * This screen rendered **four `<Card>`s** (three when no send history was open) and the loudest
 * thing on it was a grid of six `text-2xl` figures with **no heading of any kind above them** —
 * the first Card had neither `CardHeader` nor `CardTitle`, so six numbers of equal weight opened
 * the page and `ส่งแล้ว`, a running total nobody acts on, was exactly as loud as `ส่งไม่สำเร็จ`,
 * which is somebody's afternoon. The sentence the whole feature exists for was written in this
 * comment block and nowhere a reader could see it.
 *
 * It now opens with `outboxFocus()`'s sentence at `type-focal`, on the page ground with no border,
 * and the figures are the evidence *under* it rather than the page's opening statement.
 *
 * ⚠️ Every figure came down from `text-2xl` to `text-xl`, for the reason `overview-screen.tsx`
 * gives for the same change: `type-focal` is 24px, so a figure at 24px **ties with** the page's
 * primary statement and reads as co-equal with it, whatever the layout intended.
 *
 * ⚠️ **The `loud` variant went with them, and it was `text-destructive`.** It painted `dead` and
 * `stuckSending` red to say those two matter — hierarchy carried by colour, which this pass moves
 * into type and wording. Both counts are now named in the focal sentence with what they mean and
 * what to do, which is strictly more than a colour said, so nothing was lost by dropping it.
 *
 * ── Two tables, and neither is in a Card any more ────────────────────────────
 *
 * Both lists were `<Table>`s inside `<CardContent className="px-0">` — a ring drawn around a grid
 * that already draws its own rules, and the `px-0` was the card's own padding being cancelled to
 * hide the seam. They sit on the page ground now, denser (`px-2 py-1.5` cells, `h-8` heads), under
 * `type-section` headings that carry the same sentences the `CardDescription`s did.
 *
 * ⭐ **`ประวัติการส่ง` keeps its Card, and it is the only one left.** It is the send history of
 * *one* row a person picked out of the table above it: self-contained reference that reads on its
 * own (it prints the notification id), appearing in the middle of a page of bands it would
 * otherwise be mistaken for. That is the case a border is *for* — the three questions in the
 * README answer yes, yes, no.
 */

const at = (iso: string): string =>
  new Date(iso).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly outbox: Outbox }
  | { readonly status: 'failed'; readonly problem: string };

export function OutboxScreen() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<{ readonly id: string; readonly rows: readonly Attempt[] } | null>(
    null,
  );

  async function reload(): Promise<void> {
    try {
      setState({ status: 'ready', outbox: await getOutbox() });
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
        <AlertTitle>โหลดคิวแจ้งเตือนไม่สำเร็จ</AlertTitle>
        <AlertDescription>{state.problem}</AlertDescription>
      </Alert>
    );
  }

  const { summary, dead, suppressed } = state.outbox;
  const focus = outboxFocus(summary);

  return (
    <div className="flex flex-col gap-10">
      {/*
       * ⭐ THE PRIMARY THING. On the page ground, no border, type doing the work.
       *
       * Rendered in every state including the calm one — a reader who opens this screen and finds
       * nothing wrong should be told that in a sentence, rather than left to add six figures up.
       */}
      <section className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <p className="type-focal text-balance">{focus.headlineTh}</p>
          {focus.detailTh === null ? null : (
            <p className="text-muted-foreground type-body max-w-3xl">{focus.detailTh}</p>
          )}
          {summary.oldestDeadAt !== null && (
            /* How long the oldest one has been sitting there. A count says how many people were
               not told; this says for how long, which is what decides whether it is still worth
               sending at all. */
            <p className="text-muted-foreground type-caption">
              รายการที่ส่งไม่สำเร็จเก่าที่สุดคือ {at(summary.oldestDeadAt)}
            </p>
          )}
        </div>

        {/* The six counts, as supporting evidence rather than as the page's opening statement.
            They used to be a Card with no heading at all — a bordered box whose contents had to
            be read before a reader could learn what it was a box of. */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
          <Figure label="รอส่ง" value={summary.pending} />
          <Figure label="กำลังส่ง" value={summary.sending} />
          {/* Dimmed like the overview's ตะกร้าที่ยังไม่ส่ง, and for the same reason: it is the one
              number in the row that is a running total rather than work. */}
          <Figure label="ส่งแล้ว" value={summary.sent} muted />
          <Figure label="ส่งไม่สำเร็จ" value={summary.dead} />
          <Figure label="ไม่มีที่อยู่ให้ส่ง" value={summary.suppressed} />
          {/*
           * ⚠️ Nothing retries these on a timer. A row stuck in `sending` was claimed by a
           * worker that then died, so the number does not come down on its own.
           */}
          <Figure label="ค้างในสถานะกำลังส่ง" value={summary.stuckSending} />
        </div>
      </section>

      <Section
        title="ส่งไม่สำเร็จ — ส่งซ้ำได้"
        descriptionTh="ระบบพยายามส่งจนครบแล้วและไม่สำเร็จ ลูกค้ายังไม่ได้รับข้อความเหล่านี้"
      >
        {dead.length === 0 ? (
          <p className="text-muted-foreground type-body">ไม่มีรายการที่ส่งไม่สำเร็จ</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="type-caption h-8">ออเดอร์</TableHead>
                <TableHead className="type-caption h-8">ข้อความ</TableHead>
                <TableHead className="type-caption h-8">ปลายทาง</TableHead>
                <TableHead className="type-caption h-8">ลองแล้ว</TableHead>
                <TableHead className="type-caption h-8">ข้อผิดพลาดล่าสุด</TableHead>
                {/* `w-full` on the last column, which here is the one holding the buttons: with
                    `table-layout: auto` the slack would otherwise be shared out between the five
                    data columns, pushing facts about one message apart across a wide screen.
                    Giving it all to the action column keeps them adjacent. */}
                <TableHead className="type-caption h-8 w-full" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {dead.map((message) => (
                <TableRow key={message.id}>
                  <TableCell className="px-2 py-1.5">
                    <OrderLink orderId={message.orderId} orderNo={message.orderNo} />
                  </TableCell>
                  <TableCell className="type-caption px-2 py-1.5 font-mono">
                    {message.templateKey}
                  </TableCell>
                  <TableCell className="type-body px-2 py-1.5">
                    {message.recipient ?? '—'}
                    <span className="text-muted-foreground type-caption ml-1">
                      ({message.channel})
                    </span>
                  </TableCell>
                  <TableCell className="type-body px-2 py-1.5 tabular-nums">
                    {message.attemptCount} ครั้ง
                  </TableCell>
                  <TableCell className="text-muted-foreground type-caption max-w-xs truncate px-2 py-1.5">
                    {message.lastError ?? '—'}
                  </TableCell>
                  <TableCell className="px-2 py-1.5 text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          void (async () => {
                            try {
                              setAttempts({ id: message.id, rows: await listAttempts(message.id) });
                            } catch (error) {
                              toast.error(failureMessage(error));
                            }
                          })();
                        }}
                      >
                        ประวัติ
                      </Button>
                      <Button
                        size="sm"
                        disabled={busyId === message.id}
                        onClick={() => {
                          setBusyId(message.id);
                          void (async () => {
                            try {
                              await retry(message.id);
                              toast.success('ส่งกลับเข้าคิวแล้ว');
                              await reload();
                            } catch (error) {
                              toast.error(failureMessage(error));
                            } finally {
                              setBusyId(null);
                            }
                          })();
                        }}
                      >
                        <RefreshCw /> ส่งซ้ำ
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      {attempts !== null && (
        /* ⭐ The one Card on this screen, and it earns it: the history of a single message the
           reader picked, dropped in among the page's own bands. Separable reference (it names
           its own notification id), and genuinely confusable with a section without an edge. */
        <Card>
          <CardHeader>
            <CardTitle>ประวัติการส่ง</CardTitle>
            <CardDescription className="type-caption font-mono">{attempts.id}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {attempts.rows.length === 0 ? (
              <p className="text-muted-foreground type-body">ยังไม่เคยพยายามส่ง</p>
            ) : (
              attempts.rows.map((attempt) => (
                <div key={attempt.attemptNo} className="type-body flex gap-4">
                  <span className="text-muted-foreground type-caption w-8 shrink-0 text-right font-mono">
                    #{attempt.attemptNo}
                  </span>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span>
                      {attempt.outcome} · {attempt.channel} · {attempt.recipient ?? '—'}
                      {/*
                       * The locale that was actually rendered, which is evidence rather than
                       * decoration: "we sent them Thai because we have no Burmese yet" is a
                       * fact in a table instead of a guess during a dispute.
                       */}
                      <span className="text-muted-foreground type-caption ml-2">{attempt.locale}</span>
                    </span>
                    {attempt.renderedSubject !== null && (
                      <span className="text-muted-foreground type-caption">
                        {attempt.renderedSubject}
                      </span>
                    )}
                    {attempt.error !== null && (
                      <span className="text-destructive type-caption">{attempt.error}</span>
                    )}
                    <span className="text-muted-foreground type-caption">{at(attempt.attemptedAt)}</span>
                  </div>
                </div>
              ))
            )}
            <Button variant="ghost" size="sm" className="w-fit" onClick={() => setAttempts(null)}>
              ปิดประวัติ
            </Button>
          </CardContent>
        </Card>
      )}

      <Section
        title="ไม่มีที่อยู่ให้ส่ง — ส่งซ้ำไม่ได้"
        /*
         * No button, and the sentence says why. These were never addressable, so a retry
         * would fail identically — what they need is somebody to obtain a contact.
         */
        descriptionTh="ตั้งแต่แรกก็ไม่มีช่องทางติดต่อ ส่งซ้ำก็ล้มเหมือนเดิม — ต้องไปหาที่อยู่หรือเบอร์ของลูกค้ามาก่อน"
      >
        {suppressed.length === 0 ? (
          <p className="text-muted-foreground type-body">ไม่มีรายการ</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="type-caption h-8">ออเดอร์</TableHead>
                <TableHead className="type-caption h-8">ข้อความ</TableHead>
                <TableHead className="type-caption h-8">ช่องทาง</TableHead>
                <TableHead className="type-caption h-8">เหตุผล</TableHead>
                {/* The slack goes to the timestamp, the least important column — same argument as
                    `order-list.tsx`'s `อัปเดตล่าสุด`. */}
                <TableHead className="type-caption h-8 w-full">เมื่อ</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {suppressed.map((message) => (
                <TableRow key={message.id}>
                  <TableCell className="px-2 py-1.5">
                    <OrderLink orderId={message.orderId} orderNo={message.orderNo} />
                  </TableCell>
                  <TableCell className="type-caption px-2 py-1.5 font-mono">
                    {message.templateKey}
                  </TableCell>
                  <TableCell className="type-body px-2 py-1.5">{message.channel}</TableCell>
                  <TableCell className="text-muted-foreground type-body px-2 py-1.5">
                    {message.reason ?? '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground type-caption px-2 py-1.5">
                    {at(message.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </div>
  );
}

/**
 * One band of the outbox.
 *
 * The two Cards these replace held a `CardTitle` and a `CardDescription` over a table; the heading
 * is now `type-section` on the page ground and the description is `type-body` under it, which is
 * the same pair of sentences without the ring. `gap-10` on the page is what separates the bands —
 * see `account-settings.tsx`, which settled this shape.
 */
function Section({
  title,
  descriptionTh,
  children,
}: {
  readonly title: string;
  readonly descriptionTh: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="type-section">{title}</h2>
        <p className="text-muted-foreground type-body max-w-2xl">{descriptionTh}</p>
      </div>
      {children}
    </section>
  );
}

/** The order a message belongs to. Both tables link the same way, so they say it once. */
function OrderLink({
  orderId,
  orderNo,
}: {
  readonly orderId: string;
  readonly orderNo: string | null;
}) {
  return (
    <Link
      href={`/orders/${orderId}` as Route}
      className="focus-visible:outline-ring type-body rounded font-mono hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      {orderNo ?? orderId.slice(0, 8)}
    </Link>
  );
}

/**
 * A labelled count.
 *
 * ⚠️ `text-xl`, not the `text-2xl` this was — `type-focal` is 24px and a figure at 24px ties with
 * the page's primary statement. These are the evidence for that sentence; they are not allowed to
 * outrank it. Same change, same reason, as `overview-screen.tsx`'s `Figure`.
 */
function Figure({
  label,
  value,
  muted = false,
}: {
  readonly label: string;
  readonly value: number;
  readonly muted?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span
        className={`text-xl leading-tight tabular-nums ${muted ? 'text-muted-foreground' : 'font-semibold'}`}
      >
        {value}
      </span>
      <span className="text-muted-foreground type-caption">{label}</span>
    </div>
  );
}
