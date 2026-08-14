'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { AlertTriangle, ArrowRight, ShieldAlert, ShieldCheck, Users } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { baht } from '@/components/quotes/amounts';
import { failureMessage } from '@/lib/api/errors';
import {
  decideApproval,
  fetchApproval,
  fetchApprovalQueue,
  listApprovals,
  type ApprovalDetailView,
  type ApprovalQueueView,
  type ApprovalView,
} from './approvals-api';
import {
  ceilingTh,
  decisionBody,
  decisionNeeds,
  REASON_TH,
  type Decision,
} from './approval-decision';
import { approvalFocus } from './approval-focus';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE APPROVER'S INBOX — the screen a concession request has been arriving at nowhere.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `authority_limits`, `/authority`, the ceiling history and the fail-closed banner all shipped
 * before this page existed, and without it every one of them was inert: a ceiling that can be
 * exceeded but never approved is a ceiling that only blocks work. `POST /quotes/approvals` had a
 * caller (the quote editor's authority panel) and `POST …/decision` had none anywhere in the
 * monorepo, so a salesperson could ask and nobody could answer.
 *
 * ── What is on the page, and why each part is ────────────────────────────────────
 *
 *   **⭐ How many decisions are yours, first.** `approvalFocus` at `type-focal`, on the page
 *   ground with no border. That is the reason somebody opened this screen; everything else here
 *   qualifies it.
 *
 *   **Your authority, under it, quietly.** Two ceilings, named, at `type-caption` — because every
 *   judgement below is made against them and an approver who does not know their own limit cannot
 *   tell a request that is theirs to take from one that is not. When there is no live row it says
 *   so: plan 13's fail-closed is a state to read, not an empty table to misinterpret.
 *
 *   ⚠️ They used to be the *loudest* text on the page: a `<Card>` holding both at `text-lg
 *   font-semibold`, above an `h2` at `text-base`. A ceiling is a precondition for reading the
 *   queue and never the point of it, and a figure larger than the page's primary statement *is*
 *   the page's primary statement whatever the layout intended.
 *
 *   **What you are not being shown.** The queue lists only what this person may decide. The
 *   requests it withholds are *counted* — above your authority, and your own — so that
 *   `pendingTotal` reconciles with the overview's ใบเสนอราคารออนุมัติ card. A screen showing two
 *   while the dashboard says five is how somebody concludes one of the two is lying; and a
 *   backlog stuck above every ceiling in the company has to be visible to somebody, or
 *   fail-closed becomes fail-silent.
 *
 *   **The decision reads the request again.** Clicking a row fetches `GET /quotes/approvals/:id`,
 *   which re-measures the quote *now*. Sales keeps editing after asking, and an approver shown
 *   only the stored figure agrees to a document that no longer exists. Two warnings come from
 *   that read and they are different: `hasMovedSinceRequest` means the quote now concedes more,
 *   and a moved `quoteRevision` means approving grants **nothing at all**, because `judge` matches
 *   an approval to the exact quote it was measured against.
 *
 * ── ⚠️ WHAT THIS SCREEN NEVER DOES ──────────────────────────────────────────────
 *
 * It does not decide whether a decision is permitted. `rights.mayApprove` / `mayRefuse` arrive
 * from the API, computed by the same function the decision endpoint enforces
 * (`apps/api/src/quotes/authority/approval-rights.ts`). There is no `concession <= ceiling`
 * anywhere in this folder, and adding one would be a second copy of the only control this system
 * has over what a customer is charged.
 *
 * It also does not notify anybody. The API writes no `order_events` row for a concession request
 * and has no outbox for one, so an approver who does not open this page sees nothing. That gap is
 * real, it is recorded in `approvals.controller.ts`, and it is not papered over with a poll here.
 */

const DIMENSION_TH = {
  margin: 'ส่วนลด (มาร์จิ้น)',
  cashflow: 'เงินเข้าก่อนผลิต',
} as const;

/**
 * ⭐ WHAT THE `มิติ` CELL SAYS — and why `DIMENSION_TH` alone is no longer enough.
 *
 * `cashflow` covers **two mechanisms** since 0048 and the sentence "เงินเข้าก่อนผลิต" is only true of
 * one of them:
 *
 *   `quote_concession` + `cashflow`  a deposit schedule that gates less before production than the
 *                                    company's own floor. Money arriving *later*.
 *   `write_off` + `cashflow`         ขออนุมัติตัดยอดค้างทิ้ง. Money that will **never** arrive, taken
 *                                    off the customer's balance the moment this is approved.
 *
 * ⚠️ Labelling the second "เงินเข้าก่อนผลิต" would put an approver in front of a ฿20,000 debt
 * forgiveness under a heading about a deposit timetable — and `ยอดที่ขอลด` over the figure, which
 * says *discount*. So the kind wins where they disagree, and the two words are the owner's own from
 * *"ขออนุมัติตัดยอดค้างทิ้ง"* rather than new vocabulary.
 *
 * ⚠️ It reads `kind` and never `dimension === 'cashflow'`: the two are not the same question, which
 * is the whole reason `APPROVAL_KINDS_WIRE` exists.
 */
const subjectTh = (approval: Pick<ApprovalView, 'kind' | 'dimension'>): string =>
  approval.kind === 'write_off' ? 'ตัดยอดค้างทิ้ง' : DIMENSION_TH[approval.dimension];

/**
 * What the **figure** on a row means, which is not the same across the two kinds.
 *
 * A quote concession is money the customer will not be charged — `ยอดที่ขอลด`, the phrase this
 * screen has always used. A write-off is money the company will not be paid, and the balance it
 * comes off is `ยอดคงค้าง`, so the ask is `ยอดที่ขอตัดทิ้ง`. Same two roots, one honest sentence each.
 */
const amountLabelTh = (approval: Pick<ApprovalView, 'kind'>): string =>
  approval.kind === 'write_off' ? 'ยอดที่ขอตัดทิ้ง' : 'ยอดที่ขอลด';

const at = (iso: string): string =>
  new Date(iso).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

/** How long a request has been waiting, in whole days — the number an approver should feel. */
function waitingDays(iso: string): number {
  const asked = new Date(iso).getTime();
  if (Number.isNaN(asked)) return 0;
  return Math.max(0, Math.floor((Date.now() - asked) / 86_400_000));
}

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly queue: ApprovalQueueView }
  | { readonly status: 'failed'; readonly problem: string };

/**
 * ⭐ Three tabs, and the two decided ones are not a nicety.
 *
 * A decision used to leave the queue and appear **nowhere**: the note an approver is *required* to
 * write on a refusal had no reader, and `decided_ceiling_thb_minor` — the column that exists so a
 * limit raised next month does not make last month's approvals look unnecessary — could only be
 * read with `psql`. `GET /quotes/approvals?status=approved|rejected` had no caller anywhere in the
 * monorepo; these two tabs are it.
 */
const TABS = [
  { key: 'pending', labelTh: 'รอคุณตัดสิน' },
  { key: 'approved', labelTh: 'อนุมัติแล้ว' },
  { key: 'rejected', labelTh: 'ไม่อนุมัติ' },
] as const;

type Tab = (typeof TABS)[number]['key'];

export function ApprovalInbox() {
  const [tab, setTab] = useState<Tab>('pending');
  const [state, setState] = useState<State>({ status: 'loading' });
  const [decided, setDecided] = useState<readonly ApprovalView[] | null>(null);
  const [deciding, setDeciding] = useState<ApprovalView | null>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', queue: await fetchApprovalQueue() });
    } catch (error) {
      setState({ status: 'failed', problem: failureMessage(error) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (tab === 'pending') return;

    let live = true;
    setDecided(null);
    void (async () => {
      try {
        const rows = await listApprovals({ status: tab, limit: 50 });
        if (live) setDecided(rows);
      } catch (error) {
        if (live) toast.error(failureMessage(error));
      }
    })();
    return () => {
      live = false;
    };
  }, [tab]);

  const tabs = (
    <div className="flex flex-wrap gap-2">
      {TABS.map((entry) => (
        <Button
          key={entry.key}
          size="sm"
          variant={tab === entry.key ? 'secondary' : 'ghost'}
          onClick={() => setTab(entry.key)}
        >
          {entry.labelTh}
        </Button>
      ))}
    </div>
  );

  if (tab !== 'pending') {
    return (
      <div className="flex flex-col gap-4">
        {tabs}
        <DecidedTable rows={decided} kind={tab} />
      </div>
    );
  }

  if (state.status === 'loading') {
    return (
      <div className="flex flex-col gap-4">
        {tabs}
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (state.status === 'failed') {
    return (
      <div className="flex flex-col gap-4">
        {tabs}
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>เปิดคิวคำขออนุมัติไม่สำเร็จ</AlertTitle>
          <AlertDescription>{state.problem}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const { queue } = state;
  const focus = approvalFocus(queue);
  const noAuthorityAtAll =
    (!queue.ceilings.margin.known || queue.ceilings.margin.thbMinor === null) &&
    (!queue.ceilings.cashflow.known || queue.ceilings.cashflow.thbMinor === null);

  return (
    <div className="flex flex-col gap-6">
      {tabs}

      {/*
       * ⭐ THE PRIMARY THING: how much of this queue is waiting on you. On the page ground, no
       * border, type doing the work.
       *
       * What used to be here was a `<Card>` holding the two ceiling figures at `text-lg
       * font-semibold` — the loudest text on the screen — with the queue's own heading below it
       * at `text-base`. The screen's biggest number was a limit nobody acts on, and the count of
       * decisions somebody has to make today was in a heading two steps smaller.
       *
       * The `รอคุณตัดสิน (n)` heading that used to sit above the table is **gone rather than
       * demoted**: `focus.headlineTh` is already that sentence, in the same words, and printing
       * it twice a few centimetres apart is the duplication this pass exists to remove.
       */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <p className="type-focal text-balance">{focus.headlineTh}</p>
          {focus.detailTh === null ? null : (
            <p className="text-muted-foreground type-body">{focus.detailTh}</p>
          )}
        </div>

        {/*
         * Your own authority, demoted to what it is: a **precondition** for reading the queue,
         * not the reason anybody opened the screen. Still stated before the list, because a
         * judgement below is made against it and an approver who does not know their own limit
         * cannot tell a request that is theirs to take from one that is not — but at caption
         * scale, in one line, rather than as the largest thing on the page.
         *
         * Rendered from `ceilings`, which the server reads unconditionally — so
         * "ยังไม่มีเพดานอำนาจ" here is the server saying this role holds no live row, and not
         * this screen guessing from an absent field.
         */}
        <div className="text-muted-foreground type-caption flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="flex items-center gap-1.5">
            <ShieldCheck className="size-3.5" aria-hidden />
            เพดานอำนาจอนุมัติของคุณ
          </span>
          <span className="tabular-nums">
            {DIMENSION_TH.margin} {ceilingTh(queue.ceilings.margin, baht)}
          </span>
          <span className="tabular-nums">
            {DIMENSION_TH.cashflow} {ceilingTh(queue.ceilings.cashflow, baht)}
          </span>
          <span>ต่อหนึ่งใบเสนอราคา · กำหนดที่หน้า เพดานอำนาจอนุมัติ</span>
        </div>
      </section>

      {noAuthorityAtAll && (
        /*
         * ⚠️ Fail-closed, said out loud. With no live ceiling in either dimension this person can
         * refuse and cannot approve anything at all, and the queue below is empty for that reason
         * rather than because the company has no work. The same sentence `/authority` shows for
         * the table as a whole, here for the one role that is reading.
         */
        <Alert>
          <ShieldAlert />
          <AlertTitle>บทบาทของคุณยังไม่ได้รับเพดานอำนาจอนุมัติ</AlertTitle>
          <AlertDescription>
            คุณยัง “ไม่อนุมัติ” คำขอได้ แต่ยังอนุมัติไม่ได้จนกว่าผู้ดูแลจะกำหนดเพดานอำนาจให้บทบาทของคุณ —
            ระบบตั้งใจปิดไว้ก่อน ไม่ใช่ความผิดพลาด
          </AlertDescription>
        </Alert>
      )}

      {focus.withheld > 0 && (
        /*
         * Counted, never listed. This discloses nothing the reader could not already read from
         * `GET /quotes/approvals` — which asks for the same `quotes.read` this page does — and it
         * is the difference between "nothing is waiting" and "nothing is waiting *for you*".
         */
        <Alert>
          <Users />
          <AlertTitle>ไม่ได้แสดงอีก {focus.withheld} คำขอ</AlertTitle>
          <AlertDescription>
            <ul className="list-inside list-disc">
              {queue.withheld.beyondYourAuthority > 0 && (
                <li>
                  {queue.withheld.beyondYourAuthority} คำขอเกินเพดานอำนาจของคุณ — ต้องให้ผู้ที่มีเพดานสูงกว่าตัดสิน
                  หรือให้ผู้ดูแลปรับเพดาน
                </li>
              )}
              {queue.withheld.yourOwnRequests > 0 && (
                <li>
                  {queue.withheld.yourOwnRequests} คำขอที่คุณยื่นเอง — ผู้อนุมัติต้องไม่ใช่ผู้ขอ
                </li>
              )}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {queue.approvals.length === 0 ? (
        /* Nothing to separate from anything, so nothing to draw a border around. */
        <p className="text-muted-foreground type-body py-10 text-center">
          ไม่มีคำขอที่คุณตัดสินได้ในขณะนี้
        </p>
      ) : (
        /*
         * ⚠️ No `<Card>`. A table is already a grid of rules — `Card className="overflow-hidden
         * py-0"` around it was a ring drawn around an edge, and the `py-0` was there to undo the
         * padding the ring brought with it, which is the tell that the wrapper was fighting the
         * content rather than framing it.
         */
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="type-caption h-8">ใบเสนอราคา</TableHead>
                <TableHead className="type-caption h-8">มิติ</TableHead>
                <TableHead className="type-caption h-8 text-right">ยอดที่ขอลด</TableHead>
                <TableHead className="type-caption h-8">ผู้ขอ</TableHead>
                <TableHead className="type-caption h-8">รออยู่</TableHead>
                <TableHead className="type-caption h-8">เหตุผล</TableHead>
                {/* Slack goes to the last column — see the note in `order-list.tsx`. Here that is
                    the action cell, which keeps the money, the age and the reason adjacent. */}
                <TableHead className="type-caption h-8 w-full" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {queue.approvals.map((approval) => {
                const days = waitingDays(approval.createdAt);
                return (
                  <TableRow key={approval.id}>
                    <TableCell className="px-2 py-1.5">
                      <Link
                        href={`/quotes/${approval.orderId}` as Route}
                        className="focus-visible:outline-ring type-body rounded font-mono hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                      >
                        {approval.orderNo ?? approval.orderId.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell className="type-body px-2 py-1.5">
                      {/* ⭐ The kind, not the dimension, where the two disagree — see `subjectTh`. */}
                      {subjectTh(approval)}
                    </TableCell>
                    <TableCell className="type-body px-2 py-1.5 text-right font-medium tabular-nums">
                      {baht(approval.concessionThbMinor)}
                    </TableCell>
                    <TableCell className="type-body px-2 py-1.5">
                      {/* An erased actor has no name — the id is what remains, and it is shown. */}
                      {approval.requestedByName ?? (
                        <span className="text-muted-foreground type-caption font-mono">
                          {approval.requestedByUserId.slice(0, 8)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="type-body px-2 py-1.5">
                      {days === 0 ? (
                        <span className="text-muted-foreground">วันนี้</span>
                      ) : (
                        <Badge variant={days >= 3 ? 'destructive' : 'outline'}>{days} วัน</Badge>
                      )}
                    </TableCell>
                    <TableCell
                      className="type-body max-w-88 truncate px-2 py-1.5"
                      title={approval.reasonTh}
                    >
                      {approval.reasonTh}
                    </TableCell>
                    <TableCell className="px-2 py-1.5 text-right">
                      <Button size="sm" onClick={() => setDeciding(approval)}>
                        ตรวจและตัดสิน
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {deciding !== null && (
        <DecisionDialog
          approvalId={deciding.id}
          onClose={() => setDeciding(null)}
          onDone={() => {
            setDeciding(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

/**
 * ⭐ What was decided, and on whose authority.
 *
 * Newest first, straight from `GET /quotes/approvals?status=…` — no ceiling filter, because a
 * decision that has already been taken is history rather than work, and hiding a colleague's
 * decision from somebody with a smaller ceiling would make the record depend on who is reading it.
 *
 * Two columns here exist nowhere else in the application:
 *
 *   **เพดานตอนอนุมัติ** — `decided_ceiling_thb_minor`, the approver's own ceiling at the moment they
 *   said yes. The column was added so that an owner raising a limit next month does not make last
 *   month's approvals look unnecessary, and lowering it does not make them look like abuses; until
 *   this table it could only be read with `psql`. It is deliberately empty on a refusal — saying no
 *   is not an exercise of authority.
 *
 *   **เหตุผล** — the decision note. Required on a refusal by `ApprovalsController.decide`, and
 *   until now written for nobody: the requester could not see it and neither could the approver.
 */
function DecidedTable({
  rows,
  kind,
}: {
  readonly rows: readonly ApprovalView[] | null;
  readonly kind: 'approved' | 'rejected';
}) {
  if (rows === null) return <Skeleton className="h-48 w-full" />;

  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground type-body py-10 text-center">
        {kind === 'approved' ? 'ยังไม่มีคำขอที่ถูกอนุมัติ' : 'ยังไม่มีคำขอที่ถูกปฏิเสธ'}
      </p>
    );
  }

  /* De-carded for the same reason as the pending table above — a table draws its own edges. */
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="type-caption h-8">ใบเสนอราคา</TableHead>
            <TableHead className="type-caption h-8">มิติ</TableHead>
            <TableHead className="type-caption h-8 text-right">ยอดที่ลด</TableHead>
            <TableHead className="type-caption h-8">ผู้ขอ</TableHead>
            <TableHead className="type-caption h-8">ตัดสินเมื่อ</TableHead>
            <TableHead className="type-caption h-8 text-right">เพดานตอนอนุมัติ</TableHead>
            <TableHead className="type-caption h-8 w-full">เหตุผล</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((approval) => (
            <TableRow key={approval.id}>
              <TableCell className="px-2 py-1.5">
                <Link
                  href={`/quotes/${approval.orderId}` as Route}
                  className="focus-visible:outline-ring type-body rounded font-mono hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  {approval.orderNo ?? approval.orderId.slice(0, 8)}
                </Link>
              </TableCell>
              <TableCell className="type-body px-2 py-1.5">
                {subjectTh(approval)}
              </TableCell>
              <TableCell className="type-body px-2 py-1.5 text-right font-medium tabular-nums">
                {baht(approval.concessionThbMinor)}
              </TableCell>
              <TableCell className="type-body px-2 py-1.5">
                {approval.requestedByName ?? (
                  <span className="text-muted-foreground type-caption font-mono">
                    {approval.requestedByUserId.slice(0, 8)}
                  </span>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground type-caption px-2 py-1.5">
                {approval.decidedAt === null ? '—' : at(approval.decidedAt)}
              </TableCell>
              <TableCell className="type-body px-2 py-1.5 text-right tabular-nums">
                {/*
                 * ⚠️ `—` on a refusal is not missing data: `approvals_ceiling_shape` makes this
                 * column present exactly when the status is `approved`, because a refusal needs no
                 * authority to make.
                 */}
                {approval.decidedCeilingThbMinor === null
                  ? '—'
                  : baht(approval.decidedCeilingThbMinor)}
              </TableCell>
              <TableCell
                className="type-body max-w-88 truncate px-2 py-1.5"
                title={approval.decisionNoteTh ?? ''}
              >
                {approval.decisionNoteTh ?? (
                  <span className="text-muted-foreground">ไม่ได้ระบุ</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * ⭐ One request, read again, then answered.
 *
 * The dialog fetches rather than trusting the row it was opened from, for two reasons that are
 * both about time passing: the quote may have been edited since the queue was loaded, and
 * somebody else may have decided the request in the meantime. `rights` comes back with that read,
 * so the buttons reflect the answer the endpoint would give *now* — and a 409 from a colleague who
 * got there first still arrives as a message rather than as a silent no-op.
 */
function DecisionDialog({
  approvalId,
  onClose,
  onDone,
}: {
  readonly approvalId: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const [detail, setDetail] = useState<ApprovalDetailView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision>('approved');
  const [noteTh, setNoteTh] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const loaded = await fetchApproval(approvalId);
        if (live) setDetail(loaded);
      } catch (error) {
        if (live) setProblem(failureMessage(error));
      }
    })();
    return () => {
      live = false;
    };
  }, [approvalId]);

  const needs = detail === null ? null : decisionNeeds(decision, detail.rights);
  /*
   * ⭐ A WRITE-OFF HAS NO LIVE CONCESSION, AND SHOWING ONE WOULD BE A LIE.
   *
   * `liveConcession.cashflow` measures the *quote's* `gate_below_floor` — a deposit schedule — and on
   * a delivered order that is ฿0.00. Printing it under "ลดอยู่จริงตอนนี้" beside a ฿20,000 write-off
   * would tell the approver the request had evaporated. `detail.writeOff` is this row's equivalent
   * and it is the balance, which is what the decision actually turns on.
   */
  const isWriteOff = detail?.approval.kind === 'write_off';
  const live =
    detail === null || isWriteOff
      ? null
      : detail.approval.dimension === 'margin'
        ? detail.liveConcession.margin
        : detail.liveConcession.cashflow;
  /*
   * ⚠️ Never for a write-off. Editing a quote line does not un-forgive a debt, and nothing in
   * `decide` matches a write-off to a revision — so the "ใบเสนอราคาถูกแก้" alarm would be a warning
   * about a consequence that does not exist. `writeOff.stillCovered` is this row's real warning.
   */
  const staleQuote =
    detail !== null && !isWriteOff && detail.quoteRevisionNow !== detail.approval.quoteRevision;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {detail === null
              ? 'กำลังอ่านคำขอ'
              : `${amountLabelTh(detail.approval)} ${baht(detail.approval.concessionThbMinor)}`}
          </DialogTitle>
          <DialogDescription>
            {detail === null
              ? 'อ่านยอดที่ใบเสนอราคานี้ลดอยู่จริงในตอนนี้'
              : `${subjectTh(detail.approval)} · ${
                  detail.approval.orderNo ?? detail.approval.orderId.slice(0, 8)
                }`}
          </DialogDescription>
        </DialogHeader>

        {problem !== null && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>อ่านคำขอนี้ไม่สำเร็จ</AlertTitle>
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        )}

        {detail === null && problem === null && <Skeleton className="h-48 w-full" />}

        {detail !== null && needs !== null && (live !== null || isWriteOff) && (
          <div className="flex flex-col gap-4">
            {/* What was conceded, by whom, why, and against which quote. */}
            <dl className="type-body grid grid-cols-2 gap-x-6 gap-y-3">
              <Fact label="ผู้ขอ">
                {detail.approval.requestedByName ?? detail.approval.requestedByUserId.slice(0, 8)}
              </Fact>
              <Fact label="ขอเมื่อ">{at(detail.approval.createdAt)}</Fact>
              <Fact label="เพดานอำนาจของคุณ">
                <span className="tabular-nums">{ceilingTh(detail.rights.ceiling, baht)}</span>
              </Fact>
              {/*
                * ⭐ Two different questions for two different mechanisms, in the same slot.
                *
                * A quote concession's approver needs to know what the document concedes **now**; a
                * write-off's needs the order's ยอดคงค้าง, because that is the figure the decision is
                * bounded by and the one that may have moved. Neither answers the other's question.
                */}
              {live !== null ? (
                <Fact label="ลดอยู่จริงตอนนี้">
                  <span className="tabular-nums">{baht(live.concessionThbMinor)}</span>
                </Fact>
              ) : (
                <Fact label="ยอดคงค้างตอนนี้">
                  <span className="tabular-nums">
                    {detail.writeOff === null ? '—' : baht(detail.writeOff.outstandingThbMinor)}
                  </span>
                </Fact>
              )}
              <div className="col-span-2">
                <Fact label="เหตุผลที่ขอ">{detail.approval.reasonTh}</Fact>
              </div>
            </dl>

            {/*
             * ⭐ Where the concession comes from, row by row. A number with no context is a coin
             * toss: this is the override that produced it, the line it sits on and the reason code
             * the salesperson chose, which is what makes "6.97% on one door" different from
             * "100% on a line nobody looked at".
             */}
            {live !== null && live.sources.length > 0 && (
              /*
               * ⚠️ The `rounded-md border` that used to wrap this table is gone. It was a Card
               * lookalike in a *different* visual language — `Card` draws `rounded-xl ring-1
               * ring-foreground/10` — so the dialog held two kinds of box that meant the same
               * thing, and it was drawn around the one element that already has rules of its own.
               */
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground type-caption">ที่มาของยอดที่ลด</span>
                <Table>
                  <TableBody>
                    {live.sources.map((source, index) => (
                      <TableRow
                        key={`${source.kind}-${source.overrideId ?? source.quoteLineId ?? index}`}
                      >
                        <TableCell className="type-caption px-2 py-1.5">{source.kind}</TableCell>
                        <TableCell className="text-muted-foreground type-caption px-2 py-1.5 font-mono">
                          {source.quoteLineId?.slice(0, 8) ?? '—'}
                        </TableCell>
                        <TableCell className="type-caption px-2 py-1.5">
                          {source.reasonCode ?? '—'}
                        </TableCell>
                        <TableCell className="type-caption w-full px-2 py-1.5 text-right tabular-nums">
                          {baht(source.amountThbMinor)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {/*
             * ⚠️ The sharper of the two drift warnings, and the one that changes the answer: when
             * the digest has moved, approving this request grants nothing at all — `judge` matches
             * an approval to the quote it was measured against, so the quote would still be
             * blocked and the approver would believe they had unblocked it.
             */}
            {staleQuote && (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertTitle>ใบเสนอราคาถูกแก้หลังยื่นคำขอ</AlertTitle>
                <AlertDescription>
                  คำขอนี้วัดจากใบเสนอราคาเวอร์ชัน <code className="font-mono">{detail.approval.quoteRevision}</code>{' '}
                  แต่ตอนนี้เป็น <code className="font-mono">{detail.quoteRevisionNow}</code> —
                  ถ้าอนุมัติตอนนี้จะไม่ครอบคลุมใบเสนอราคาปัจจุบัน ต้องให้ฝ่ายขายยื่นคำขอใหม่
                </AlertDescription>
              </Alert>
            )}

            {/*
             * ⭐ A WRITE-OFF'S OWN WARNING, and the one thing an approver must read before pressing
             * อนุมัติ: the customer has transferred money since the request was raised, so the figure
             * asked for is larger than what is left owing and `decide` will refuse the approval.
             *
             * ⚠️ It names the answer that *is* available. The API deliberately does not reduce the
             * figure to what remains — `approvals.concession_thb_minor` is frozen while pending — so
             * the correct next step is ไม่อนุมัติ with a note, and the alert says so rather than
             * leaving the approver pressing a button that 409s.
             */}
            {detail.writeOff !== null && !detail.writeOff.stillCovered && (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertTitle>ยอดคงค้างลดลงหลังยื่นคำขอ</AlertTitle>
                <AlertDescription>
                  ขอตัดทิ้ง {baht(detail.approval.concessionThbMinor)} แต่ตอนนี้ยอดคงค้างเหลือ{' '}
                  {baht(detail.writeOff.outstandingThbMinor)} — อนุมัติตามจำนวนที่ขอไม่ได้ ต้องไม่อนุมัติคำขอนี้
                  แล้วแจ้งให้ผู้ขอยื่นใหม่ตามยอดคงค้างปัจจุบัน
                </AlertDescription>
              </Alert>
            )}

            {live !== null && !staleQuote && detail.liveConcession.hasMovedSinceRequest && (
              <Alert>
                <AlertTriangle />
                <AlertTitle>ยอดที่ลดเพิ่มขึ้นหลังยื่นคำขอ</AlertTitle>
                <AlertDescription>
                  ขอไว้ {baht(detail.approval.concessionThbMinor)} แต่ตอนนี้ลดอยู่{' '}
                  {baht(live.concessionThbMinor)}
                </AlertDescription>
              </Alert>
            )}

            {/*
             * ⭐ Two buttons, side by side, the same size. Refusing must be as easy as approving —
             * a queue that makes approval the path of least resistance produces approvals — and
             * `mayRefuse` is deliberately wider than `mayApprove` on the wire, because saying no
             * is not an exercise of authority.
             */}
            <div className="flex flex-col gap-2">
              <span className="text-muted-foreground type-caption">คำตอบ</span>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant={decision === 'approved' ? 'default' : 'outline'}
                  disabled={!detail.rights.mayApprove}
                  onClick={() => setDecision('approved')}
                >
                  อนุมัติ
                </Button>
                <Button
                  variant={decision === 'rejected' ? 'destructive' : 'outline'}
                  disabled={!detail.rights.mayRefuse}
                  onClick={() => setDecision('rejected')}
                >
                  ไม่อนุมัติ
                </Button>
              </div>
              {/*
               * The server's sentence, not a guess. `REASON_TH` is exhaustive over the wire's
               * reasons by type, so a new one cannot arrive here as a blank space.
               */}
              {!needs.permitted && (
                <span className="text-destructive type-caption">
                  {REASON_TH[detail.rights.because]}
                </span>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="approval-note">
                {needs.note ? 'เหตุผลที่ไม่อนุมัติ (บังคับ)' : 'บันทึกเพิ่มเติม (ไม่บังคับ)'}
              </Label>
              <Textarea
                id="approval-note"
                rows={3}
                maxLength={1000}
                value={noteTh}
                onChange={(event) => setNoteTh(event.target.value)}
              />
              <span className="text-muted-foreground type-caption">
                {needs.note
                  ? 'ผู้ขอเห็นข้อความนี้ — การไม่อนุมัติที่ไม่บอกเหตุผลคือคำขอที่กลับไปแล้วแก้อะไรไม่ได้'
                  : 'บันทึกไว้กับการตัดสินใจ และย้อนกลับมาอ่านได้ภายหลัง'}
              </span>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </Button>
          <Button
            variant={decision === 'rejected' ? 'destructive' : 'default'}
            disabled={busy || needs === null || !needs.ready({ noteTh })}
            onClick={() => {
              setBusy(true);
              void (async () => {
                try {
                  await decideApproval(approvalId, decisionBody(decision, { noteTh }));
                  toast.success(decision === 'approved' ? 'อนุมัติแล้ว' : 'ไม่อนุมัติแล้ว');
                  onDone();
                } catch (error) {
                  /*
                   * A 409 here is the ordinary outcome of two people opening the same request —
                   * the API names who decided it first. Shown, then the queue is reloaded, so the
                   * row disappears rather than staying on screen as a button that will fail again.
                   */
                  toast.error(failureMessage(error));
                  onDone();
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            {decision === 'approved' ? 'ยืนยันการอนุมัติ' : 'ยืนยันการไม่อนุมัติ'}
          </Button>
        </DialogFooter>

        {detail !== null && (
          <Link
            href={`/quotes/${detail.approval.orderId}` as Route}
            className="text-muted-foreground hover:text-foreground type-caption focus-visible:outline-ring inline-flex w-fit items-center gap-1 rounded px-1 py-0.5 focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            เปิดใบเสนอราคาฉบับเต็ม <ArrowRight className="size-3" />
          </Link>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground type-caption">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
