'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { useCallback, useEffect, useState } from 'react';
import { Lock, Plus } from 'lucide-react';
import { toast } from 'sonner';

import { orderSummaryWireSchema } from '@wewin/contract/order';
import type { OrderSummaryWire } from '@wewin/contract';

import { formatTimestamp } from '@/components/products/publish-state';
import { PageHeader } from '@/components/page-header';
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

/**
 * The statuses a quote may still be edited in — a mirror of `QUOTE_EDITABLE_ORDER_STATUSES`.
 *
 * ⛔ `awaiting_confirmation` was missing for one round, and it is the status this screen is now
 * mostly *for*: since 0056 a customer's request lands there and waits for a member of staff to
 * price it and agree it. The list filtered to three statuses, so the orders most in need of
 * editing were the ones it did not show — and nothing failed, because a filter that omits a
 * value looks exactly like a filter that found none.
 */
const EDITABLE_STATUSES = ['draft', 'awaiting_confirmation', 'awaiting_payment', 'redesign'] as const;

const STATUS_LABEL_TH: Readonly<Record<string, string>> = {
  draft: 'ฉบับร่าง',
  awaiting_confirmation: 'รอยืนยัน',
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

/**
 * Open an empty order for somebody at the counter, and answer with its id.
 *
 * ⚠️ `{}` and not a contact: `POST /orders` accepts an optional one, and the walk-in's details
 * are collected at the submit, where they become part of a quotation rather than a note on a
 * cart nobody has priced yet.
 */
const startWalkInOrder = async (): Promise<string> =>
  apiJson(
    '/orders',
    (body) => {
      if (typeof body !== 'object' || body === null || !('id' in body)) {
        throw new TypeError('expected an order with an id');
      }
      return String((body as { id: unknown }).id);
    },
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  );

/**
 * ⚠️ The header is rendered in **all four** states, not only when the rows arrived.
 *
 * It used to be an `<h1 className="text-xl font-semibold">` inside the ready branch, so a
 * failed fetch and an empty list both produced a screen with no title on it — a reader could
 * not tell "this is broken" from "I clicked the wrong menu item". `PageHeader` now sits above
 * the switch, which is also how the page title stops being a fourth spelling of itself.
 */
const HEADER = (
  <PageHeader
    title="ใบเสนอราคา"
    description="ออร์เดอร์ที่ยังแก้ใบเสนอราคาได้ — ฉบับร่าง รอยืนยัน รอชำระเงิน และตีกลับมาแก้แบบ"
    actions={<WalkInButton />}
  />
);

/**
 * ⭐ ลูกค้า walk-in — the customer standing at the counter, who has no account and no browser.
 *
 * Until now every order in this system began in a customer's own browser: the storefront minted
 * a guest, filled a cart and submitted it. A salesperson taking an order face to face had no way
 * in at all — the API accepted it, and no screen offered it.
 *
 * ⚠️ It opens an **empty order** and goes straight to the quote editor, which is where the work
 * is. It does not ask for the customer's name first: a name typed into a dialog before anything
 * exists is a name that is lost when the person changes their mind about the product, and the
 * submit collects the contact anyway — that is the step where it becomes a quotation somebody
 * can act on.
 *
 * ⚠️ The order is owned by a freshly minted anonymous customer, not by the salesperson. That is
 * `OrdersService.createDraft`'s doing and it is the whole reason this button is safe to add; see
 * its comment for what it used to record.
 */
function WalkInButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <Button
      size="sm"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void startWalkInOrder()
          .then((orderId) => {
            router.push(`/quotes/${orderId}` as Route);
          })
          .catch((error: unknown) => {
            toast.error(failureMessage(error));
            setBusy(false);
          });
      }}
    >
      <Plus className="size-4" />
      เปิดใบเสนอราคาหน้าร้าน
    </Button>
  );
}

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

  if (state.status === 'loading') {
    return (
      <div className="flex flex-col gap-8">
        {HEADER}
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex flex-col gap-8">
        {HEADER}
        <Empty>
          <EmptyHeader>
            <EmptyTitle>โหลดรายการใบเสนอราคาไม่สำเร็จ</EmptyTitle>
            <EmptyDescription>{failureMessage(state.error)}</EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" onClick={load}>
            ลองอีกครั้ง
          </Button>
        </Empty>
      </div>
    );
  }

  if (state.orders.length === 0) {
    return (
      <div className="flex flex-col gap-8">
        {HEADER}
        <Empty>
          <EmptyHeader>
            <EmptyTitle>ยังไม่มีใบเสนอราคาที่แก้ไขได้</EmptyTitle>
            <EmptyDescription>
              ใบเสนอราคาแก้ได้เฉพาะออร์เดอร์ที่อยู่ในสถานะฉบับร่าง รอชำระเงิน หรือตีกลับมาแก้แบบ — หลังเปิดสายการผลิตแล้ว
              เข้าผลิตแล้ว การเปลี่ยนราคาจึงเป็นใบลดหนี้หรือการคืนเงิน
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {HEADER}

      {/* The list is the primary thing on a list screen, so it gets the page ground and no ring. */}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="type-caption h-8">เลขที่</TableHead>
              <TableHead className="type-caption h-8">สถานะ</TableHead>
              <TableHead className="type-caption h-8 text-end">ยอดรวม</TableHead>
              {/* Slack goes to the last column — see the note in `order-list.tsx`. */}
              <TableHead className="type-caption h-8 w-full">แก้ล่าสุด</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.orders.map((order) => (
              <TableRow key={order.id}>
                <TableCell className="px-2 py-1.5">
                  <Link
                    href={`/quotes/${order.id}`}
                    className="focus-visible:outline-ring type-body rounded font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                  >
                    {order.orderNo ?? 'ฉบับร่าง'}
                  </Link>
                </TableCell>
                <TableCell className="px-2 py-1.5">
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
                <TableCell className="type-body px-2 py-1.5 text-end font-mono tabular-nums">
                  {order.grandTotalThbMinor === null
                    ? '—'
                    : baht(thbMinorOf(order.grandTotalThbMinor))}
                </TableCell>
                <TableCell className="text-muted-foreground type-caption px-2 py-1.5">
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
