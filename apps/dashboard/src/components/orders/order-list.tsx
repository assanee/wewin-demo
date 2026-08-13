'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { formatBaht } from '@wewin/core/format';
import { AlertTriangle, Lock } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
 *
 * ── ⭐ The primary thing on a list screen is the list ─────────────────────────
 *
 * So the `<Card>` around the table is gone. A table is already a grid of rules — it has all
 * the structure it needs — and wrapping it in a ring drew a second edge around an edge. What
 * is left is the same rows on the page ground, **tighter**: `py-1.5` cells instead of `p-2`,
 * because a forty-row table should be scannable rather than airy. Removing chrome is what
 * reduces noise; spreading rows out increases it.
 *
 * The filter row is deliberately quieter than the table it filters — `type-caption` labels on
 * ghost buttons — for the same reason. It is how you get to the answer, not the answer.
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
      <div className="flex flex-wrap items-center gap-1">
        <FilterButton active={chosen === null} onClick={() => setChosen(null)}>
          ทั้งหมด
        </FilterButton>
        {FILTERS.map((status) => (
          <FilterButton
            key={status}
            active={chosen === status}
            onClick={() => setChosen(status)}
          >
            {statusLabel(status)}
          </FilterButton>
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
        /* Nothing to separate from anything, so nothing to draw a border around. */
        <p className="text-muted-foreground type-body py-10 text-center">
          {chosen === null ? 'ยังไม่มีออเดอร์ในระบบ' : `ไม่มีออเดอร์ในสถานะ “${statusLabel(chosen)}”`}
        </p>
      )}

      {state.status === 'ready' && state.orders.length > 0 && (
        <div className="flex flex-col gap-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="h-8 type-caption">เลขที่</TableHead>
                <TableHead className="h-8 type-caption">สถานะ</TableHead>
                <TableHead className="h-8 type-caption">เริ่มผลิตแล้ว</TableHead>
                <TableHead className="h-8 type-caption text-right">ยอดรวม</TableHead>
                {/* `w-full` on the last column: with `table-layout: auto` the slack would otherwise be
                    shared out between the first three, pushing related facts about one order apart
                    across a 1440px screen. Giving it all to the least important column keeps the
                    number, the status and the freeze flag adjacent, which is what a scan needs. */}
                <TableHead className="h-8 type-caption w-full">อัปเดตล่าสุด</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.orders.map((order) => (
                <TableRow key={order.id}>
                  <TableCell className="px-2 py-1.5">
                    <Link
                      href={`/orders/${order.id}` as Route}
                      className="focus-visible:outline-ring rounded font-mono type-body hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                    >
                      {/*
                       * A draft has no number — `orders.order_no` is null until submit,
                       * because a cart is not a contract. Showing a truncated uuid keeps
                       * the row identifiable without inventing a number for it.
                       */}
                      {order.orderNo ?? `ร่าง ${order.id.slice(0, 8)}`}
                    </Link>
                  </TableCell>
                  <TableCell className="px-2 py-1.5">
                    <Badge variant={TONE[statusTone(order.status)]}>
                      {statusLabel(order.status)}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-2 py-1.5">
                    {order.isFrozen ? (
                      <span className="type-body inline-flex items-center gap-1.5">
                        <Lock className="size-3.5" aria-hidden />
                        เริ่มแล้ว
                      </span>
                    ) : (
                      <span className="text-muted-foreground type-body">ยัง</span>
                    )}
                  </TableCell>
                  <TableCell className="type-body px-2 py-1.5 text-right font-medium tabular-nums">
                    {order.grandTotalThbMinor === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      formatBaht(order.grandTotalThbMinor)
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground type-caption px-2 py-1.5">
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

          {/*
           * ⚠️ Said out loud when the page is full.
           *
           * `GET /orders` caps at `limit`, and the overview's count does not. A screen that
           * silently showed the first hundred of two hundred would make the two disagree with
           * no way to tell which was wrong.
           */}
          {state.orders.length >= LIMIT && (
            <p className="text-muted-foreground type-caption">
              แสดง {LIMIT} รายการแรกเท่านั้น — กรองตามสถานะเพื่อดูให้ครบ
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One status filter.
 *
 * `type-caption` on a `size="sm"` ghost button: the filter row sits above the table and used
 * to carry nine `text-sm` buttons, which put the controls and the data at the same weight. The
 * chosen one keeps `secondary` so the current filter is still obvious at a glance.
 */
function FilterButton({
  active,
  onClick,
  children,
}: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Button
      variant={active ? 'secondary' : 'ghost'}
      size="sm"
      className="type-caption h-7 px-2.5"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
