'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { formatBaht } from '@wewin/core/format';
import { AlertTriangle, Lock } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { failureMessage } from '@/lib/api/errors';
import { listOrders, type OrderSummary } from './order-api';
import { statusLabel, statusTone, type OrderStatus } from './order-language';
import { outstandingDisplay, readOutstanding } from './order-outstanding';
import { describeOwingFilter } from './owing-filter';

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
 *
 * ── ⚠️ ค้างชำระ is a column, and it is the one with weight ────────────────────
 *
 * "Which order owes money" was not answerable from this screen at all: ยอดรวม is what an order
 * is worth, which is the same number on the day it is quoted and the day it is paid off. The
 * debt now sits beside it, from `order_outstanding_thb_minor()` — a column on the same select,
 * so a hundred rows are still one query and nothing on this side subtracts anything.
 *
 * The two are **not** a duplicate pair even though they read alike on an unpaid order, where
 * the debt *is* the total. They diverge the moment a deposit is accepted, and the divergence is
 * the information: ค้างชำระ ฿9,940 next to ยอดรวม ฿14,200 says the deposit landed, without a
 * third column saying so in words. That is why there is no "partly paid" label here — the two
 * numbers already say it, and `README.md`'s rule is that a fact already on the screen does not
 * get a second place on it.
 *
 * ⚠️ **An order that owes nothing must not read as money.** `฿0` at the debt's weight, forty
 * times down a list, is forty false hits for an eye that is scanning for money — so settled
 * becomes a muted word and only a live debt gets `font-semibold`. `order-outstanding.ts` makes
 * that call, and it is also what keeps a paid-off order (ชำระครบแล้ว) apart from a cart that was
 * never priced (the same em dash ยอดรวม uses) — the API sends null for one and ฿0.00 for the
 * other, and a cell that printed both as ฿0 would lose the difference.
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
  /*
   * ⚠️ Separate state from `chosen`, because they are separate axes. The status buttons are
   * radio-like — picking one replaces the last — and owing is a toggle that composes with
   * whichever is picked. `?status=in_production&payment=outstanding` is the question a
   * production manager asks, and the server ANDs the two; folding owing into `chosen` would
   * have made it one more alternative in the same OR and that question unaskable.
   */
  const [owingOnly, setOwingOnly] = useState(false);
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });

    void (async () => {
      try {
        const orders = await listOrders({
          status: chosen ?? undefined,
          /* Absent rather than `'all'` — see the note on `listOrders`. */
          ...(owingOnly ? { payment: 'outstanding' as const } : {}),
          limit: LIMIT,
        });
        if (live) setState({ status: 'ready', orders });
      } catch (error) {
        if (live) setState({ status: 'failed', problem: failureMessage(error) });
      }
    })();

    return () => {
      live = false;
    };
  }, [chosen, owingOnly]);

  const notice = describeOwingFilter({
    owingOnly,
    shown: state.status === 'ready' ? state.orders.length : 0,
    limit: LIMIT,
    statusLabelTh: chosen === null ? null : statusLabel(chosen),
  });

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

        {/*
          Set apart by a divider rather than sitting in the run of status buttons: beside them it
          would read as a ninth status and as mutually exclusive with them, which is the opposite
          of what it is. `aria-pressed` because this one is a toggle and the others are a choice.
        */}
        <Separator orientation="vertical" className="mx-1 h-5" />
        <FilterButton
          active={owingOnly}
          aria-pressed={owingOnly}
          onClick={() => setOwingOnly((on) => !on)}
        >
          ค้างชำระ
        </FilterButton>
      </div>

      {notice.summaryTh !== null && (
        <p className="text-muted-foreground type-caption">{notice.summaryTh}</p>
      )}

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
        <p className="text-muted-foreground type-body py-10 text-center">{notice.emptyTh}</p>
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
                {/* Immediately after ยอดรวม, because the pair is read as a pair — the gap between
                    them is what says how much has been paid. */}
                <TableHead className="h-8 type-caption text-right">ค้างชำระ</TableHead>
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
                  <OwedCell order={order} />
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
 * What this order still owes.
 *
 * ⚠️ The weight is the whole point of the cell, so it is worth stating what the three states
 * look like from across a desk: a live debt is `font-semibold` and reads as money; a settled
 * order is a muted word at `type-caption` and reads as *done*; a draft is the same em dash the
 * ยอดรวม cell beside it already uses for "no contract yet", so the row does not claim a cart
 * has paid anything.
 *
 * `font-semibold` here against `font-medium` on ยอดรวม is one notch, deliberately. The debt is
 * what somebody is scanning for; the total is the context they read it against, and turning the
 * context down further would make an ordinary order look like a problem.
 */
function OwedCell({ order }: { readonly order: OrderSummary }) {
  const owed = outstandingDisplay(readOutstanding(order));

  return (
    <TableCell className="px-2 py-1.5 text-right">
      {owed.emphasis === 'debt' ? (
        <span className="type-body font-semibold tabular-nums">{owed.textTh}</span>
      ) : (
        <span className="text-muted-foreground type-caption">{owed.textTh}</span>
      )}
    </TableCell>
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
