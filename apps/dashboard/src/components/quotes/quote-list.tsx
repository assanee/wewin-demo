'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Lock } from 'lucide-react';

import { orderSummaryWireSchema } from '@wewin/contract/order';
import type { OrderSummaryWire } from '@wewin/contract';

import { formatTimestamp } from '@/components/products/publish-state';
import { apiJson } from '@/lib/api/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

import { baht } from './amounts';
import { failureMessage } from './quote-api';
import { thbMinorOf } from './quote-wire';

/**
 * Every order whose quote may still be edited.
 *
 * ### Why this reads the orders list and not a quotes list
 *
 * There is no `GET /quotes`, and there should not be one: a quote is not an entity in this
 * system, it is the editable face of an order in one of three statuses. apps/api's controller
 * says the same thing by mounting every quote route under `/orders/:orderId/quote`.
 *
 * The three statuses are `draft`, `awaiting_payment` and `redesign` —
 * `QUOTE_EDITABLE_ORDER_STATUSES` in packages/db, and the ones plan 7.5(ง) names as
 * repriceable. `redesign` is the one everybody forgets and the one where the edit is usually
 * *more* expensive rather than less, so it is fetched explicitly rather than left to a default.
 *
 * ### 🚧 What this list cannot tell you, and does not pretend to
 *
 * `OrderSummaryWire` carries no count of overridden lines and no concession figure, so there
 * is no "3 บรรทัดถูกแก้ราคา" column here. Inventing one would mean fetching every quote to
 * build a list, which is the read that turns a fifty-order screen into fifty round trips. The
 * honest version is a summary field on the orders list; until then the provenance is one click
 * away and this column is absent rather than approximate.
 */

/** The three statuses a quote may still be edited in — a mirror, checked by the API's own guard. */
const EDITABLE_STATUSES = ['draft', 'awaiting_payment', 'redesign'] as const;

const STATUS_LABEL_TH: Readonly<Record<string, string>> = {
  draft: 'ฉบับร่าง',
  awaiting_payment: 'รอชำระเงิน',
  redesign: 'ตีกลับมาแก้แบบ',
};

const listQuotableOrders = (): Promise<readonly OrderSummaryWire[]> => {
  const query = new URLSearchParams();
  for (const status of EDITABLE_STATUSES) query.append('status', status);

  return apiJson(`/orders?${query.toString()}`, (body) => {
    if (typeof body !== 'object' || body === null || !('orders' in body)) {
      throw new TypeError('expected { orders: [...] }');
    }
    const { orders } = body as { orders: unknown };
    if (!Array.isArray(orders)) throw new TypeError('orders is not an array');
    return orders.map((entry: unknown) => orderSummaryWireSchema.parse(entry));
  });
};

export function QuoteListScreen() {
  const [state, setState] = useState<
    | { readonly status: 'loading' }
    | { readonly status: 'error'; readonly error: unknown }
    | { readonly status: 'ready'; readonly orders: readonly OrderSummaryWire[] }
  >({ status: 'loading' });

  const load = useCallback(() => {
    setState({ status: 'loading' });
    void listQuotableOrders()
      .then((orders) => setState({ status: 'ready', orders }))
      .catch((error: unknown) => setState({ status: 'error', error }));
  }, []);

  useEffect(load, [load]);

  if (state.status === 'loading') return <Skeleton className="h-64 w-full" />;

  if (state.status === 'error') {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>โหลดรายการใบเสนอราคาไม่สำเร็จ</EmptyTitle>
          <EmptyDescription>{failureMessage(state.error)}</EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" onClick={load}>
          ลองอีกครั้ง
        </Button>
      </Empty>
    );
  }

  if (state.orders.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>ยังไม่มีใบเสนอราคาที่แก้ไขได้</EmptyTitle>
          <EmptyDescription>
            ใบเสนอราคาแก้ได้เฉพาะออร์เดอร์ที่อยู่ในสถานะฉบับร่าง รอชำระเงิน หรือตีกลับมาแก้แบบ — หลังเปิดสายการผลิตแล้ว
            เข้าผลิตแล้ว การเปลี่ยนราคาจึงเป็นใบลดหนี้หรือการคืนเงิน
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">ใบเสนอราคา</h1>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>เลขที่</TableHead>
              <TableHead>สถานะ</TableHead>
              <TableHead className="text-end">ยอดรวม</TableHead>
              <TableHead>แก้ล่าสุด</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.orders.map((order) => (
              <TableRow key={order.id}>
                <TableCell>
                  <Link
                    href={`/quotes/${order.id}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {order.orderNo ?? 'ฉบับร่าง'}
                  </Link>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline">
                      {STATUS_LABEL_TH[order.status] ?? order.status}
                    </Badge>
                    {/*
                      `isFrozen` and not the status. `cancelled` and `superseded` are reachable
                      from both sides of the freeze, so after the fact only this flag can answer
                      "was anything already cut?" — the contract says so in its own comment.
                    */}
                    {order.isFrozen ? (
                      <Badge variant="secondary" title="เริ่มผลิตแล้ว">
                        <Lock data-icon="inline-start" />
                        แช่แข็งแล้ว
                      </Badge>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="text-end font-mono tabular-nums">
                  {order.grandTotalThbMinor === null
                    ? '—'
                    : baht(thbMinorOf(order.grandTotalThbMinor))}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatTimestamp(order.updatedAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
