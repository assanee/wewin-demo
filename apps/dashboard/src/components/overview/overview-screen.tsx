'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { formatBaht } from '@wewin/core/format';
import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  Boxes,
  FileText,
  Image as ImageIcon,
  Inbox,
  MessageSquare,
  Receipt,
  RotateCcw,
  SlidersHorizontal,
  Users as UsersIcon,
  type LucideIcon,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { failureMessage } from '@/lib/api/errors';
import { statusLabel } from '@/components/orders/order-language';
import {
  fetchOverview,
  type MoneyOverview,
  type OutstandingOrder,
  type Overview,
} from './overview-api';
import { overviewFocus } from './overview-focus';
import { outstandingBreakdown } from './outstanding-breakdown';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OVERVIEW — what is waiting for a person, then how the company is doing.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This page used to print `GET /me`: the caller's user id, group ids and permission codes.
 * That was a genuinely useful thing — it is how somebody answers "why can I not see
 * สินค้า?" in ten seconds — and it was the wrong thing for the first screen of the day. It
 * answered a question about the *reader* on the page that should answer questions about the
 * *company*. The permission list moved to `/account`, where a fact about you belongs.
 *
 * ── The order of the page is the order of the day ────────────────────────────
 *
 *   ⓵ **ต้องมีคนทำ** — the five queues. A number here is somebody's afternoon.
 *   ⓶ **ออเดอร์** — where the work in the building actually is.
 *   ⓷ **เงิน** — taken this month, still owed, and *by whom* (`OutstandingOrders`).
 *   ⓸ **แคตตาล็อกและระบบ** — health, not work. Slowest-moving, so last.
 *
 * ── ⭐ One primary thing, and it is a sentence rather than a card ─────────────
 *
 * This screen rendered **ten `<Card>`s** on a full-permission account — five queue tiles, the
 * order row, two money cards, catalogue and users — each with the same ring, ground and
 * padding. (The source holds five `<Card>` literals; `QueueTile`'s is one literal that renders
 * once per queue, which is why counting the file undercounts the screen.) With four section
 * headings all at `text-base` and the two money figures at `text-3xl`, the loudest things on
 * the page were the two numbers nobody acts on, and the question the screen exists to answer —
 * *does the company owe anybody an afternoon?* — had no visual home at all.
 *
 * It now opens with `overviewFocus()`'s sentence at `type-focal`, on the page ground with no
 * border around it, and **one** Card survives: เงิน, which is an amounts breakdown and is the
 * kind of self-contained reference that earns one. The queues became a list of aligned
 * numbers, which is both quieter and denser than five tiles in a grid.
 *
 * ⚠️ Every number below `type-focal` is `text-xl`, including money, which used to be
 * `text-3xl`. That is deliberate: a figure larger than the page's primary statement *is* the
 * page's primary statement, whatever the layout intended.
 *
 * ── ⚠️ Two honesty rules this screen keeps ───────────────────────────────────
 *
 *   **A card that is absent is not zero.** The API omits the key entirely when the reader
 *   may not see it, so `{card && ...}` is the whole permission logic on this side. There is
 *   no local copy of who may see what, which is why this screen cannot drift from the API's
 *   answer — see `apps/api/src/overview/sections.ts`.
 *
 *   **A number that leads nowhere says so.** For one round every queue here carried
 *   `ยังไม่มีหน้าจัดการ`: the APIs were complete and the screens were not, and showing the
 *   count anyway was how the company found out work was piling up somewhere nobody could
 *   open. All five now have screens, so `QueueCard.href` is populated for all five — but the
 *   field stays optional, and `QueueTile` still renders the sentence when it is absent. The
 *   next queue to arrive before its screen should say so too, rather than link to a 404.
 */

interface QueueCard {
  readonly label: string;
  readonly count: number;
  readonly icon: LucideIcon;
  /** Absent when the screen does not exist yet — the card then says so instead of linking. */
  readonly href?: Route;
  /** What a non-zero number means somebody has to do. */
  readonly action: string;
}

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly overview: Overview }
  | { readonly status: 'failed'; readonly problem: string };

export function OverviewScreen() {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let live = true;

    void (async () => {
      try {
        const overview = await fetchOverview();
        if (live) setState({ status: 'ready', overview });
      } catch (error) {
        if (live) setState({ status: 'failed', problem: failureMessage(error) });
      }
    })();

    return () => {
      live = false;
    };
  }, []);

  if (state.status === 'loading') {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (state.status === 'failed') {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>เปิดภาพรวมไม่สำเร็จ</AlertTitle>
        <AlertDescription>{state.problem}</AlertDescription>
      </Alert>
    );
  }

  const { overview } = state;

  /*
   * Built as a list rather than written out as JSX so the zero/non-zero split below is one
   * decision applied uniformly. A queue whose card the reader may not see never enters the
   * list at all.
   */
  const queues: readonly QueueCard[] = [
    ...(overview.slips
      ? [
          {
            label: 'สลิปรอตรวจ',
            count: overview.slips.awaitingReview,
            icon: Receipt,
            href: '/slips' as Route,
            action: 'มีลูกค้าโอนเงินแล้วรอการยืนยัน',
          },
        ]
      : []),
    ...(overview.quotes
      ? [
          {
            label: 'ใบเสนอราคารออนุมัติ',
            count: overview.quotes.approvalsPending,
            icon: FileText,
            /*
             * ⚠️ **`/approvals`, and it pointed at `/quotes` for a whole round.**
             *
             * `/quotes` is the editor's list: it can neither show an approval request nor action
             * one, so the card counted a queue and then sent the reader to a screen with no trace
             * of it. That is the softer form of the `ยังไม่มีหน้าจัดการ` case below — a number that
             * leads *somewhere*, which is worse, because the reader concludes the count is wrong
             * rather than that the screen is missing.
             *
             * The count is company-wide pending; `/approvals` shows what this reader may decide and
             * accounts for the rest, so the two figures reconcile rather than contradict. The card
             * now sits behind `quotes.read` + `quotes.approve` (`overview/sections.ts`), which is
             * what that page and its queue endpoint ask for.
             */
            href: '/approvals' as Route,
            action: 'มีส่วนลดเกินอำนาจที่พนักงานขายตั้งไว้',
          },
        ]
      : []),
    ...(overview.refunds
      ? [
          {
            label: 'คำขอคืนเงิน',
            count: overview.refunds.requested,
            icon: RotateCcw,
            href: '/refunds' as Route,
            action: 'รอการตัดสินใจว่าจะคืนหรือไม่',
          },
        ]
      : []),
    ...(overview.reviews
      ? [
          {
            label: 'รีวิวรอกลั่นกรอง',
            count: overview.reviews.awaitingModeration,
            icon: MessageSquare,
            href: '/reviews' as Route,
            action: 'ยังอยู่ในช่วงเวลาที่ซ่อนได้ก่อนเผยแพร่',
          },
        ]
      : []),
    ...(overview.notifications
      ? [
          {
            label: 'แจ้งเตือนส่งไม่สำเร็จ',
            count: overview.notifications.dead,
            icon: Inbox,
            href: '/outbox' as Route,
            action: 'ลูกค้าไม่ได้รับข้อความ และระบบเชื่อว่าส่งแล้ว',
          },
        ]
      : []),
  ];

  const focus = overviewFocus(queues);
  const nothingAtAll = Object.keys(overview).length === 0;

  if (nothingAtAll) {
    /*
     * A real state, not an error: an account can be in no group at all. Saying so beats a
     * blank page, and beats a wall of zeros implying the company has no work.
     */
    return (
      <Alert>
        <AlertTriangle />
        <AlertTitle>บัญชีนี้ยังไม่มีสิทธิ์ดูส่วนใดของระบบ</AlertTitle>
        <AlertDescription>
          ต้องให้ผู้ดูแลระบบเพิ่มบัญชีนี้เข้ากลุ่มก่อน จึงจะเห็นข้อมูลบนหน้านี้
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-10">
      {/*
       * ⭐ THE PRIMARY THING. On the page ground, no border, type doing the work.
       *
       * Rendered even when `queues` is empty — a reader holding no queue permission still
       * gets told that, rather than being left to infer it from an absence.
       */}
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <p className="type-focal text-balance">{focus.headlineTh}</p>
          {focus.detailTh === null ? null : (
            <p className="text-muted-foreground type-body">{focus.detailTh}</p>
          )}
        </div>

        {queues.length > 0 && (
          /*
           * A list of aligned numbers, not a grid of tiles. Five bordered cards were five
           * repetitions of the same chrome around one integer each; a column puts every count
           * in the same place so the eye compares them without reading, and takes about a third
           * of the height. Density where density helps.
           */
          <ul className="flex flex-col">
            {queues.map((queue) => (
              <QueueRow key={queue.label} queue={queue} />
            ))}
          </ul>
        )}
      </section>

      {overview.orders && (
        <Section title="ออเดอร์" more={{ href: '/orders', label: 'เปิดรายการออเดอร์' }}>
          <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 xl:grid-cols-6">
            <Figure label="รอชำระเงิน" value={overview.orders.awaitingPayment} />
            <Figure label="ยืนยันผลิตแล้ว" value={overview.orders.productionConfirmed} />
            <Figure label="กำลังผลิต" value={overview.orders.inProduction} />
            <Figure label="รอติดตั้ง" value={overview.orders.awaitingInstallation} />
            <Figure label="ขอแก้แบบ" value={overview.orders.redesign} />
            {/*
             * Deliberately last and deliberately dimmed. A draft is an abandoned cart, not
             * work — it is the only number in this row nobody is supposed to act on, and
             * putting it beside `กำลังผลิต` at the same weight would say otherwise.
             */}
            <Figure label="ตะกร้าที่ยังไม่ส่ง" value={overview.orders.draft} muted />
          </div>
        </Section>
      )}

      {overview.money && (
        <Section title="เงิน">
          {/*
           * ⭐ The one Card left on this screen, and it earns it under the house rule: two
           * figures that are only meaningful read against each other, each needing a sentence
           * saying which of the several possible money numbers it is. That is a self-contained
           * amounts breakdown — the case a border is *for*.
           *
           * The itemised debt is **inside** this card rather than beside it, on the API's own
           * arrangement: `outstandingOrders` is a key of `money`, so `payments.read` gates the
           * breakdown by exactly the key that gates the total. See `OutstandingOrders`.
           */}
          <Card>
            <CardContent className="flex flex-col gap-6">
              <div className="grid gap-6 sm:grid-cols-2">
                <MoneyFigure
                  label="รับชำระเดือนนี้"
                  value={overview.money.receivedThisMonth}
                  /*
                   * The API's contract says which of the several possible money numbers this
                   * is, and a screen that shows money without saying which one is how two
                   * departments end up quoting different figures from the same dashboard.
                   */
                  noteTh="ยอดหน้าสลิปที่อนุมัติแล้ว นับตามเดือนเวลาไทย — ไม่ใช่ยอดที่ลูกค้าแจ้งว่าโอน"
                />
                <MoneyFigure
                  label="ยอดค้างชำระ"
                  value={overview.money.outstanding}
                  noteTh="รวมทุกออเดอร์ที่ยังเดินอยู่ ไม่นับตะกร้า ออเดอร์ที่ยกเลิก และที่ถูกแทนที่"
                />
              </div>

              <OutstandingOrders money={overview.money} />
            </CardContent>
          </Card>
        </Section>
      )}

      {(overview.catalog ?? overview.users) && (
        <Section title="แคตตาล็อกและระบบ">
          <div className="grid gap-x-6 gap-y-8 sm:grid-cols-2">
            {overview.catalog && (
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-3 gap-4">
                  <Figure label="สินค้า" value={overview.catalog.products} icon={Boxes} />
                  <Figure
                    label="ชุดตัวเลือก"
                    value={overview.catalog.optionGroups}
                    icon={SlidersHorizontal}
                  />
                  <Figure
                    label="ร่างที่ยังไม่เผยแพร่"
                    value={overview.catalog.unpublishedDrafts}
                    icon={ImageIcon}
                  />
                </div>
                <MoreLink href="/products" label="เปิดแคตตาล็อก" />
              </div>
            )}

            {overview.users && (
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-3 gap-4">
                  <Figure label="ผู้ใช้ที่ใช้งานอยู่" value={overview.users.active} icon={UsersIcon} />
                  <Figure label="ถูกระงับ" value={overview.users.suspended} muted />
                </div>
                <MoreLink href="/users" label="จัดการผู้ใช้และสิทธิ์" />
              </div>
            )}
          </div>
        </Section>
      )}
    </div>
  );
}

/**
 * A band of the page. Its title is `type-section` — 18px against the 14px underneath it, where
 * both used to be within 2px of each other and neither read as a heading.
 *
 * A `<section>` with a heading and no border. The content of these bands does not need
 * separating from the band above it, and `gap-10` on the page is what separates them; a ring
 * around each one was six statements that they might be confused.
 */
function Section({
  title,
  more,
  children,
}: {
  readonly title: string;
  readonly more?: { readonly href: Route; readonly label: string };
  readonly children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="type-section">{title}</h2>
        {more === undefined ? null : <MoreLink href={more.href} label={more.label} />}
      </div>
      {children}
    </section>
  );
}

function MoreLink({ href, label }: { readonly href: Route; readonly label: string }) {
  return (
    <Link
      href={href}
      className="text-muted-foreground hover:text-foreground type-caption focus-visible:outline-ring -mx-1 inline-flex w-fit items-center gap-1 rounded px-1 py-0.5 focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      {label} <ArrowRight className="size-3" aria-hidden />
    </Link>
  );
}

/**
 * One queue, as a row.
 *
 * Zero is styled *down*, not up — unchanged from the tile this replaces, and the argument is
 * the same: the instinct on a dashboard is to make every number loud, and the result is a page
 * where nothing stands out on the day something does. An empty queue is good news and reads as
 * calm; a non-zero one gets the foreground colour, the weight, and a sentence saying what the
 * number means somebody has to do.
 *
 * ⚠️ The old tile carried `border-foreground/20` on its non-idle `Card` and **that class
 * painted nothing**. `Card` draws its edge with `ring-1 ring-foreground/10` and has no
 * border-*width*; Tailwind's preflight sets `border-width: 0` on every element, so a
 * `border-color` utility on its own is inert. The tile's "this one is live" edge had never
 * rendered — the wash was doing all the work. Exactly the failure mode `order-spine.tsx`
 * warns about, found by counting borders that were supposed to be there.
 */
function QueueRow({ queue }: { readonly queue: QueueCard }) {
  const idle = queue.count === 0;
  const Icon = queue.icon;

  const inner = (
    <>
      <span
        className={`w-10 shrink-0 text-right text-xl leading-tight tabular-nums ${
          idle ? 'text-muted-foreground' : 'font-semibold'
        }`}
      >
        {queue.count}
      </span>
      <Icon
        className={idle ? 'text-muted-foreground size-4 shrink-0' : 'size-4 shrink-0'}
        aria-hidden
      />
      <span className="flex min-w-0 flex-col">
        <span className="type-body font-medium">{queue.label}</span>
        {idle ? null : <span className="text-muted-foreground type-caption">{queue.action}</span>}
        {queue.href === undefined && (
          /*
           * Said out loud rather than hidden. The API for every one of these queues is
           * finished; the screen is not. A reader who sees "4 สลิปรอตรวจ" and cannot find
           * where to do it should learn why from this page, not from clicking around.
           */
          <span className="text-muted-foreground/70 type-caption">ยังไม่มีหน้าจัดการ</span>
        )}
      </span>
      {queue.href === undefined ? null : (
        <ArrowRight
          className="text-muted-foreground ml-auto size-4 shrink-0 self-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
          aria-hidden
        />
      )}
    </>
  );

  /* `py-2.5 -mx-2 px-2` keeps the row's hit area generous while the text stays on the page's
   * own left edge — the number column lines up with the headline above it. */
  const shape = 'group flex items-start gap-3 rounded-md -mx-2 px-2 py-2.5';

  return (
    <li>
      {queue.href === undefined ? (
        <div className={shape}>{inner}</div>
      ) : (
        <Link
          href={queue.href}
          className={`${shape} focus-visible:outline-ring hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-offset-2`}
        >
          {inner}
        </Link>
      )}
    </li>
  );
}

/**
 * ⭐ ยอดค้างชำระ, itemised — the figure turned into somewhere to go.
 *
 * The card used to end at the number. ฿487,000 owed is a fact nobody can act on: the next
 * question is always *which orders*, and answering it meant leaving for `/orders` and reading
 * a hundred rows. The API now sends the biggest debts alongside the aggregate, so the answer
 * is one glance and one click.
 *
 * ── ⚠️ THE LIST IS CAPPED AND THE TOTAL IS NOT THE SUM OF THESE ROWS ─────────
 *
 * `money.outstandingOrders` is the **top 8 by amount** (`OUTSTANDING_ORDERS_CAP` in
 * `overview.repository.ts`), over the same live-order predicate the aggregate folds. On a
 * company with nine unpaid orders the rows add up to less than the figure above them, and
 * nothing in the rows says so — eight plausible orders that simply do not reconcile. The
 * total is carried beside them precisely so that no screen has to add these up, and
 * `outstandingBreakdown` supplies the sentence that makes the pair honest. It is a qualifier,
 * not a caption: without it the card contradicts itself the day a ninth order goes unpaid.
 *
 * ⚠️ The note is **above** the rows rather than under them. A reader has to know the list is
 * a shortlist *before* they read it, not after — and it doubles as the lead-in that says these
 * rows belong to ยอดค้างชำระ and not to รับชำระเดือนนี้ beside it.
 *
 * ⚠️ Inside the money `Card` and not a Section of its own. The API nests it inside the money
 * key so `payments.read` gates the breakdown by exactly the key that gates the total; a card of
 * its own on this screen would suggest a permission of its own, and it would also be the sixth
 * bordered thing on a page that spent a whole phase getting down to one.
 *
 * ⚠️ When exactly one order owes, its row repeats the total above it. That is unavoidable — the
 * row is where the *link* is — and it is the case the coversAll sentence exists for: it says the
 * figure and the row are one debt rather than leaving them to look like two.
 */
function OutstandingOrders({ money }: { readonly money: MoneyOverview }) {
  const breakdown = outstandingBreakdown(money.outstanding, money.outstandingOrders);

  return (
    <div className="border-border/60 flex flex-col gap-1 border-t pt-5">
      <p className="text-muted-foreground type-caption">{breakdown.noteTh}</p>

      {breakdown.shown.length > 0 && (
        /*
         * A list of aligned amounts, matching `QueueRow` above rather than a table: the money
         * lands in one column so the eye ranks the debts without reading them, and the whole row
         * is the hit area. `divide-y` is deliberately absent — eight rules under a rule the
         * block already has would be drawing edges around edges.
         */
        <ul className="flex flex-col">
          {breakdown.shown.map((order) => (
            <OwingRow key={order.id} order={order} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One owing order, as a row that goes somewhere.
 *
 * ⚠️ The amount is `type-body`, not the `text-xl` of the figure above it. These rows are the
 * breakdown *of* that figure; a part rendered louder than its whole inverts the reading order
 * the phase-2 rewrite exists to establish — and the same argument that took money down from
 * `text-3xl` applies one level further in.
 *
 * The status is here because a debt in ขอแก้แบบ is a different telephone call from one in
 * รอชำระเงิน, and it is `statusLabel` from the orders folder rather than a second Thai table on
 * this side: two copies of `STATUS_TH` is how two screens come to call one status two things.
 */
function OwingRow({ order }: { readonly order: OutstandingOrder }) {
  return (
    <li>
      <Link
        href={`/orders/${order.id}` as Route}
        className="group focus-visible:outline-ring hover:bg-accent/60 -mx-2 flex items-center gap-3 rounded-md px-2 py-2 focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {/*
         * `orderNo` is unreachable-null through this list — every status it admits is
         * post-submit — but it is typed nullable and rendering an empty cell for a debt would
         * be the one row nobody could act on. The id prefix is what `order-list.tsx` falls back
         * to for the same reason.
         */}
        <span className="type-body font-mono">{order.orderNo ?? order.id.slice(0, 8)}</span>
        <span className="text-muted-foreground type-caption">{statusLabel(order.status)}</span>
        <span className="type-body ml-auto font-medium tabular-nums">
          {formatBaht(order.outstandingThbMinor)}
        </span>
        <ArrowRight
          className="text-muted-foreground size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
          aria-hidden
        />
      </Link>
    </li>
  );
}

/**
 * One money figure with the sentence that says which number it is.
 *
 * `bigint` and not `number`: these are satang, `formatBaht` takes the minor unit, and the
 * contract carries them as bigint precisely so a total cannot silently lose precision.
 */
function MoneyFigure({
  label,
  value,
  noteTh,
}: {
  readonly label: string;
  readonly value: bigint;
  readonly noteTh: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground type-caption flex items-center gap-2">
        <Banknote className="size-3.5" aria-hidden />
        {label}
      </span>
      <span className="text-xl leading-tight font-semibold tabular-nums">{formatBaht(value)}</span>
      <p className="text-muted-foreground type-caption">{noteTh}</p>
    </div>
  );
}

/**
 * A labelled number. `muted` is for the ones that are context rather than work.
 *
 * ⚠️ `text-xl` and not the `text-2xl` this used to be — and the money figures came down from
 * `text-3xl` to match. `type-focal` is 24px, so a figure at 24px tied with the page's primary
 * statement and one at 30px beat it. The counts on this screen are supporting evidence for the
 * sentence at the top; they are not allowed to outrank it.
 */
function Figure({
  label,
  value,
  icon: Icon,
  muted = false,
}: {
  readonly label: string;
  readonly value: number;
  readonly icon?: LucideIcon;
  readonly muted?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span
        className={`text-xl leading-tight tabular-nums ${muted ? 'text-muted-foreground' : 'font-semibold'}`}
      >
        {value}
      </span>
      <span className="text-muted-foreground type-caption flex items-center gap-1.5">
        {Icon === undefined ? null : <Icon className="size-3" aria-hidden />}
        {label}
      </span>
    </div>
  );
}
