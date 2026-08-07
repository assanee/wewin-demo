'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { formatBaht } from '@wewin/core/format';
import { AlertTriangle, Lock } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { failureMessage } from '@/lib/api/errors';
import { listOrders, type OrderSummary } from './order-api';
import { statusLabel, statusTone, type OrderStatus } from './order-language';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Every order in the company, filtered by status.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `GET /orders` is `@RequirePrincipal()` and scoped by reach, not by a flag: a customer's
 * token returns their own orders and a token holding `orders.read` returns the table. The
 * dashboard sends no `?all=true` and there is none to send — which is why this screen needs
 * no code of its own to decide whose orders these are.
 *
 * ── ⚠️ `isFrozen` is a column, not a derivation from the status ──────────────
 *
 * "Read this, never the status." `cancelled` and `superseded` are both reachable from either
 * side of the freeze, so after the fact only the flag answers *was aluminium already cut?* —
 * which is the question that decides whether a cancellation costs the company money. It gets
 * its own column rather than being folded into the status chip for exactly that reason.
 */

const TONE: Record<ReturnType<typeof statusTone>, 'default' | 'secondary' | 'outline'> = {
  attention: 'default',
  live: 'secondary',
  done: 'outline',
  over: 'outline',
};

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly orders: readonly OrderSummary[] }
  | { readonly status: 'failed'; readonly problem: string };

/** The statuses worth filtering by, in the order work moves through them. */
const FILTERS: readonly OrderStatus[] = [
  'awaiting_payment',
  'production_confirmed',
  'in_production',
  'awaiting_installation',
  'redesign',
  'delivered',
  'draft',
  'cancelled',
];

const LIMIT = 100;

export function OrderList() {
  const [chosen, setChosen] = useState<OrderStatus | null>(null);
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });

    void (async () => {
      try {
        const orders = await listOrders({ status: chosen ?? undefined, limit: LIMIT });
        if (live) setState({ status: 'ready', orders });
      } catch (error) {
        if (live) setState({ status: 'failed', problem: failureMessage(error) });
      }
    })();

    return () => {
      live = false;
    };
  }, [chosen]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={chosen === null ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => setChosen(null)}
        >
          ทั้งหมด
        </Button>
        {FILTERS.map((status) => (
          <Button
            key={status}
            variant={chosen === status ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setChosen(status)}
          >
            {statusLabel(status)}
          </Button>
        ))}
      </div>

      {state.status === 'loading' && <Skeleton className="h-64 w-full" />}

      {state.status === 'failed' && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>โหลดรายการออเดอร์ไม่สำเร็จ</AlertTitle>
          <AlertDescription>{state.problem}</AlertDescription>
        </Alert>
      )}

      {state.status === 'ready' && state.orders.length === 0 && (
        <Card>
          <CardContent className="text-muted-foreground py-10 text-center text-sm">
            {chosen === null ? 'ยังไม่มีออเดอร์ในระบบ' : `ไม่มีออเดอร์ในสถานะ “${statusLabel(chosen)}”`}
          </CardContent>
        </Card>
      )}

      {state.status === 'ready' && state.orders.length > 0 && (
        <>
          <Card className="overflow-hidden py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>เลขที่</TableHead>
                  <TableHead>สถานะ</TableHead>
                  <TableHead>ตัดอะลูมิเนียมแล้ว</TableHead>
                  <TableHead className="text-right">ยอดรวม</TableHead>
                  <TableHead>อัปเดตล่าสุด</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.orders.map((order) => (
                  <TableRow key={order.id}>
                    <TableCell>
                      <Link href={`/orders/${order.id}` as Route} className="font-mono text-sm hover:underline">
                        {/*
                         * A draft has no number — `orders.order_no` is null until submit,
                         * because a cart is not a contract. Showing a truncated uuid keeps
                         * the row identifiable without inventing a number for it.
                         */}
                        {order.orderNo ?? `ร่าง ${order.id.slice(0, 8)}`}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={TONE[statusTone(order.status)]}>
                        {statusLabel(order.status)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {order.isFrozen ? (
                        <span className="inline-flex items-center gap-1.5 text-sm">
                          <Lock className="size-3.5" />
                          ตัดแล้ว
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-sm">ยัง</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {order.grandTotalThbMinor === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        formatBaht(order.grandTotalThbMinor)
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {new Date(order.updatedAt).toLocaleString('th-TH', {
                        timeZone: 'Asia/Bangkok',
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          {/*
           * ⚠️ Said out loud when the page is full.
           *
           * `GET /orders` caps at `limit`, and the overview's count does not. A screen that
           * silently showed the first hundred of two hundred would make the two disagree with
           * no way to tell which was wrong.
           */}
          {state.orders.length >= LIMIT && (
            <p className="text-muted-foreground text-xs">
              แสดง {LIMIT} รายการแรกเท่านั้น — กรองตามสถานะเพื่อดูให้ครบ
            </p>
          )}
        </>
      )}
    </div>
  );
}
