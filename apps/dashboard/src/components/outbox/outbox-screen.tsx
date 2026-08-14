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

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <Figure label="รอส่ง" value={summary.pending} />
          <Figure label="กำลังส่ง" value={summary.sending} />
          <Figure label="ส่งแล้ว" value={summary.sent} muted />
          <Figure label="ส่งไม่สำเร็จ" value={summary.dead} loud={summary.dead > 0} />
          <Figure label="ไม่มีที่อยู่ให้ส่ง" value={summary.suppressed} />
          {/*
           * ⚠️ Nothing retries these on a timer. A row stuck in `sending` was claimed by a
           * worker that then died, so the number does not come down on its own.
           */}
          <Figure label="ค้างในสถานะกำลังส่ง" value={summary.stuckSending} loud={summary.stuckSending > 0} />
        </CardContent>
      </Card>

      {summary.oldestDeadAt !== null && (
        <p className="text-muted-foreground text-xs">
          รายการที่ส่งไม่สำเร็จเก่าที่สุดคือ {at(summary.oldestDeadAt)}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>ส่งไม่สำเร็จ — ส่งซ้ำได้</CardTitle>
          <CardDescription>
            ระบบพยายามส่งจนครบแล้วและไม่สำเร็จ ลูกค้ายังไม่ได้รับข้อความเหล่านี้
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {dead.length === 0 ? (
            <p className="text-muted-foreground px-6 text-sm">ไม่มีรายการที่ส่งไม่สำเร็จ</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ออเดอร์</TableHead>
                  <TableHead>ข้อความ</TableHead>
                  <TableHead>ปลายทาง</TableHead>
                  <TableHead>ลองแล้ว</TableHead>
                  <TableHead>ข้อผิดพลาดล่าสุด</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {dead.map((message) => (
                  <TableRow key={message.id}>
                    <TableCell>
                      <Link
                        href={`/orders/${message.orderId}` as Route}
                        className="font-mono text-sm hover:underline"
                      >
                        {message.orderNo ?? message.orderId.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{message.templateKey}</TableCell>
                    <TableCell className="text-sm">
                      {message.recipient ?? '—'}
                      <span className="text-muted-foreground ml-1 text-xs">({message.channel})</span>
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">{message.attemptCount} ครั้ง</TableCell>
                    <TableCell className="text-muted-foreground max-w-xs truncate text-xs">
                      {message.lastError ?? '—'}
                    </TableCell>
                    <TableCell className="text-right">
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
        </CardContent>
      </Card>

      {attempts !== null && (
        <Card>
          <CardHeader>
            <CardTitle>ประวัติการส่ง</CardTitle>
            <CardDescription className="font-mono text-xs">{attempts.id}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {attempts.rows.length === 0 ? (
              <p className="text-muted-foreground text-sm">ยังไม่เคยพยายามส่ง</p>
            ) : (
              attempts.rows.map((attempt) => (
                <div key={attempt.attemptNo} className="flex gap-4 text-sm">
                  <span className="text-muted-foreground w-8 shrink-0 text-right font-mono text-xs">
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
                      <span className="text-muted-foreground ml-2 text-xs">{attempt.locale}</span>
                    </span>
                    {attempt.renderedSubject !== null && (
                      <span className="text-muted-foreground text-xs">{attempt.renderedSubject}</span>
                    )}
                    {attempt.error !== null && (
                      <span className="text-destructive text-xs">{attempt.error}</span>
                    )}
                    <span className="text-muted-foreground text-xs">{at(attempt.attemptedAt)}</span>
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

      <Card>
        <CardHeader>
          <CardTitle>ไม่มีที่อยู่ให้ส่ง — ส่งซ้ำไม่ได้</CardTitle>
          <CardDescription>
            {/*
             * No button, and the sentence says why. These were never addressable, so a retry
             * would fail identically — what they need is somebody to obtain a contact.
             */}
            ตั้งแต่แรกก็ไม่มีช่องทางติดต่อ ส่งซ้ำก็ล้มเหมือนเดิม — ต้องไปหาที่อยู่หรือเบอร์ของลูกค้ามาก่อน
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {suppressed.length === 0 ? (
            <p className="text-muted-foreground px-6 text-sm">ไม่มีรายการ</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ออเดอร์</TableHead>
                  <TableHead>ข้อความ</TableHead>
                  <TableHead>ช่องทาง</TableHead>
                  <TableHead>เหตุผล</TableHead>
                  <TableHead>เมื่อ</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {suppressed.map((message) => (
                  <TableRow key={message.id}>
                    <TableCell>
                      <Link
                        href={`/orders/${message.orderId}` as Route}
                        className="font-mono text-sm hover:underline"
                      >
                        {message.orderNo ?? message.orderId.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{message.templateKey}</TableCell>
                    <TableCell className="text-sm">{message.channel}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {message.reason ?? '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {at(message.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Figure({
  label,
  value,
  muted = false,
  loud = false,
}: {
  readonly label: string;
  readonly value: number;
  readonly muted?: boolean;
  readonly loud?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span
        className={`text-2xl leading-none tabular-nums ${
          loud ? 'text-destructive font-semibold' : muted ? 'text-muted-foreground' : 'font-semibold'
        }`}
      >
        {value}
      </span>
      <span className="text-muted-foreground text-xs">{label}</span>
    </div>
  );
}
