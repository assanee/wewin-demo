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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { failureMessage } from '@/lib/api/errors';
import { fetchOverview, type Overview } from './overview-api';

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
 *   ⓷ **เงิน** — taken this month, still owed.
 *   ⓸ **แคตตาล็อกและระบบ** — health, not work. Slowest-moving, so last.
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

  const waiting = queues.reduce((total, queue) => total + queue.count, 0);
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
    <div className="flex flex-col gap-8">
      {queues.length > 0 && (
        <section className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-base font-semibold">ต้องมีคนทำ</h2>
            <p className="text-muted-foreground text-sm">
              {waiting === 0 ? 'ไม่มีงานค้างในคิวที่คุณดูได้' : `${waiting} รายการรอดำเนินการ`}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {queues.map((queue) => (
              <QueueTile key={queue.label} queue={queue} />
            ))}
          </div>
        </section>
      )}

      {overview.orders && (
        <section className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-base font-semibold">ออเดอร์</h2>
            <Link
              href="/orders"
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
            >
              เปิดรายการออเดอร์ <ArrowRight className="size-3" />
            </Link>
          </div>

          <Card>
            <CardContent className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 xl:grid-cols-6">
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
            </CardContent>
          </Card>
        </section>
      )}

      {overview.money && (
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">เงิน</h2>

          <div className="grid gap-3 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardDescription className="flex items-center gap-2">
                  <Banknote className="size-4" />
                  รับชำระเดือนนี้
                </CardDescription>
                <CardTitle className="text-3xl tabular-nums">
                  {formatBaht(overview.money.receivedThisMonth)}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {/*
                 * The API's contract says which of the several possible money numbers this
                 * is, and a screen that shows money without saying which one is how two
                 * departments end up quoting different figures from the same dashboard.
                 */}
                <p className="text-muted-foreground text-xs">
                  ยอดหน้าสลิปที่อนุมัติแล้ว นับตามเดือนเวลาไทย — ไม่ใช่ยอดที่ลูกค้าแจ้งว่าโอน
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardDescription className="flex items-center gap-2">
                  <Banknote className="size-4" />
                  ยอดค้างชำระ
                </CardDescription>
                <CardTitle className="text-3xl tabular-nums">
                  {formatBaht(overview.money.outstanding)}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-xs">
                  รวมทุกออเดอร์ที่ยังเดินอยู่ ไม่นับตะกร้า ออเดอร์ที่ยกเลิก และที่ถูกแทนที่
                </p>
              </CardContent>
            </Card>
          </div>
        </section>
      )}

      {(overview.catalog ?? overview.users) && (
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">แคตตาล็อกและระบบ</h2>

          <div className="grid gap-3 sm:grid-cols-2">
            {overview.catalog && (
              <Card>
                <CardContent className="flex flex-col gap-4">
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
                  <Link
                    href="/products"
                    className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
                  >
                    เปิดแคตตาล็อก <ArrowRight className="size-3" />
                  </Link>
                </CardContent>
              </Card>
            )}

            {overview.users && (
              <Card>
                <CardContent className="flex flex-col gap-4">
                  <div className="grid grid-cols-3 gap-4">
                    <Figure label="ผู้ใช้ที่ใช้งานอยู่" value={overview.users.active} icon={UsersIcon} />
                    <Figure label="ถูกระงับ" value={overview.users.suspended} muted />
                  </div>
                  <Link
                    href="/users"
                    className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
                  >
                    จัดการผู้ใช้และสิทธิ์ <ArrowRight className="size-3" />
                  </Link>
                </CardContent>
              </Card>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * One queue.
 *
 * Zero is styled *down*, not up. The instinct on a dashboard is to make every number loud,
 * and the result is a page where nothing stands out on the day something does. An empty
 * queue is good news and should read as calm; a non-zero one gets the foreground colour and
 * a sentence saying what the number means somebody has to do.
 */
function QueueTile({ queue }: { readonly queue: QueueCard }) {
  const idle = queue.count === 0;
  const Icon = queue.icon;

  const body = (
    <Card
      className={
        idle
          ? 'h-full'
          : 'border-foreground/20 bg-accent/40 h-full transition-colors hover:bg-accent/60'
      }
    >
      <CardContent className="flex items-start gap-4">
        <Icon className={idle ? 'text-muted-foreground mt-1 size-5' : 'mt-1 size-5'} />

        <div className="flex min-w-0 flex-col gap-1">
          <span className={`text-3xl leading-none tabular-nums ${idle ? 'text-muted-foreground' : 'font-semibold'}`}>
            {queue.count}
          </span>
          <span className="text-sm font-medium">{queue.label}</span>

          {idle ? null : <span className="text-muted-foreground text-xs">{queue.action}</span>}

          {queue.href === undefined ? (
            /*
             * Said out loud rather than hidden. The API for every one of these queues is
             * finished; the screen is not. A reader who sees "4 สลิปรอตรวจ" and cannot find
             * where to do it should learn why from this page, not from clicking around.
             */
            <span className="text-muted-foreground/70 text-xs">ยังไม่มีหน้าจัดการ</span>
          ) : (
            <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
              เปิดหน้าจัดการ <ArrowRight className="size-3" />
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );

  return queue.href === undefined ? (
    body
  ) : (
    <Link href={queue.href} className="rounded-xl focus-visible:ring-2 focus-visible:outline-none">
      {body}
    </Link>
  );
}

/** A labelled number. `muted` is for the ones that are context rather than work. */
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
        className={`text-2xl leading-none tabular-nums ${muted ? 'text-muted-foreground' : 'font-semibold'}`}
      >
        {value}
      </span>
      <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
        {Icon === undefined ? null : <Icon className="size-3" />}
        {label}
      </span>
    </div>
  );
}
