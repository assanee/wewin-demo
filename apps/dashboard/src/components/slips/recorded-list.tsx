'use client';

import { useEffect, useState } from 'react';
import { formatBaht } from '@wewin/core/format';
import { AlertTriangle, ShieldAlert } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { failureMessage } from '@/lib/api/errors';
import { listRecorded, type RecordedEntry } from './slip-api';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE AUDIT SURFACE THE OWNER IS TRUSTING.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Told that recording a payment with no slip opens a path for money to enter with no customer
 * evidence, the owner answered *"สิ่งสำคัญคือต้องสามารถตรวจสอบย้อนหลังได้ ถ้าทำได้ก็โอเค"*. This
 * table is the "ทำได้", and every clause of the question is a column:
 *
 *     which payments were recorded with no slip   every row, and only those
 *     who recorded them                           ผู้บันทึก
 *     who accepted them                           ผู้รับรอง
 *     why                                         เหตุผล — both of them
 *     which were self-reviewed                    the ShieldAlert row, and the filter
 *
 * ── ⚠️ Every status, not only the accepted ones ──────────────────────────────
 *
 * `GET /payments/slips/recorded` returns the rejected and the still-waiting too. A list of only
 * the entries that *worked* would hide the pattern an auditor is actually looking for — somebody
 * repeatedly keying evidence-free payments, most of which a colleague then threw out.
 *
 * ── ⚠️ `selfReviewed` is the server's answer, never a comparison made here ────
 *
 * It comes from `slip_submitter_user_ids()` — the same SQL function the trigger enforces the rule
 * with — which resolves a guest cart later signed into an account to the same person.
 * `recordedBy.userId === reviewedBy.userId` would look equivalent and would silently
 * under-report, and an audit list that under-reports is worse than none because somebody read it
 * and stopped looking.
 *
 * ── Why this lives on `/slips` and the recording button does not ─────────────
 *
 * This is about the review process across every order; recording is about one order and one
 * figure. `record-payment-dialog.tsx` argues its own placement.
 */

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly entries: readonly RecordedEntry[] }
  | { readonly status: 'failed'; readonly problem: string };

const at = (iso: string): string =>
  new Date(iso).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

const STATUS_TH: Record<string, string> = {
  submitted: 'รอตรวจ',
  accepted: 'รับรองแล้ว',
  rejected: 'ปฏิเสธ',
};

export function RecordedWithoutSlipList() {
  const [only, setOnly] = useState<'all' | 'self_reviewed'>('all');
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let live = true;

    void (async () => {
      try {
        const entries = await listRecorded(only);
        if (live) setState({ status: 'ready', entries });
      } catch (error) {
        if (live) setState({ status: 'failed', problem: failureMessage(error) });
      }
    })();

    return () => {
      live = false;
    };
  }, [only]);

  if (state.status === 'loading') return <Skeleton className="h-40 w-full" />;

  if (state.status === 'failed') {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>โหลดรายการที่บันทึกโดยไม่มีสลิปไม่สำเร็จ</AlertTitle>
        <AlertDescription>{state.problem}</AlertDescription>
      </Alert>
    );
  }

  const selfReviewed = state.entries.filter((entry) => entry.selfReviewed).length;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="type-section">การชำระที่บันทึกโดยไม่มีสลิป</p>
          {/*
           * The count of self-reviews said out loud beside the total, because that is the number
           * the owner will want and counting rows by eye is how it stops being looked at. Stated
           * only on the unfiltered list — on the narrowed one it would restate its own length.
           */}
          <p className="text-muted-foreground type-body">
            {state.entries.length === 0
              ? 'ยังไม่มีรายการที่บันทึกโดยไม่มีสลิป'
              : only === 'self_reviewed'
                ? `${String(state.entries.length)} รายการที่คนบันทึกกับคนรับรองเป็นคนเดียวกัน`
                : `${String(state.entries.length)} รายการ · ในจำนวนนี้ ${String(selfReviewed)} รายการที่คนบันทึกกับคนรับรองเป็นคนเดียวกัน`}
          </p>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => setOnly(only === 'all' ? 'self_reviewed' : 'all')}
        >
          {only === 'all' ? 'ดูเฉพาะที่รับรองเอง' : 'ดูทั้งหมด'}
        </Button>
      </div>

      {state.entries.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="type-caption h-8">ออเดอร์</TableHead>
              <TableHead className="type-caption h-8 text-right">ยอด</TableHead>
              <TableHead className="type-caption h-8">โอนเมื่อ</TableHead>
              <TableHead className="type-caption h-8">ผู้บันทึก</TableHead>
              <TableHead className="type-caption h-8">ผู้รับรอง</TableHead>
              <TableHead className="type-caption h-8 w-full">เหตุผล</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.entries.map((entry) => (
              <TableRow key={entry.slip.id}>
                <TableCell className="type-body px-2 py-1.5 font-mono">
                  {entry.orderNo ?? `ร่าง ${entry.orderId.slice(0, 8)}`}
                  <span className="text-muted-foreground type-caption ml-2 font-sans">
                    {STATUS_TH[entry.slip.status] ?? entry.slip.status}
                  </span>
                </TableCell>
                <TableCell className="type-body px-2 py-1.5 text-right font-medium tabular-nums">
                  {formatBaht(entry.slip.amountThbMinor)}
                </TableCell>
                <TableCell className="text-muted-foreground type-caption px-2 py-1.5">
                  {at(entry.slip.transferredAt)}
                </TableCell>
                <TableCell className="type-body px-2 py-1.5">
                  {/*
                   * `ไม่ทราบชื่อ` rather than a blank: `users.display_name` is null on an account
                   * with no name, and — on an **erased** one — that is a guarantee rather than an
                   * omission (`users_erased_has_no_name`). A blank cell would read as "nobody".
                   */}
                  {entry.recordedBy?.name ?? (entry.recordedBy === null ? '—' : 'ไม่ทราบชื่อ')}
                </TableCell>
                <TableCell className="type-body px-2 py-1.5">
                  {entry.reviewedBy === null ? (
                    <span className="text-muted-foreground">ยังไม่มีใครรับรอง</span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      {entry.reviewedBy.name ?? 'ไม่ทราบชื่อ'}
                      {entry.selfReviewed && (
                        <span className="text-destructive type-caption inline-flex items-center gap-1">
                          <ShieldAlert className="size-3.5" />
                          รับรองเอง
                        </span>
                      )}
                    </span>
                  )}
                </TableCell>
                <TableCell className="type-caption px-2 py-1.5">
                  <span className="flex flex-col gap-0.5">
                    <span>{entry.slip.noSlipReasonTh ?? '—'}</span>
                    {entry.slip.selfReviewReasonTh !== null && (
                      <span className="text-muted-foreground">
                        รับรองเอง: {entry.slip.selfReviewReasonTh}
                      </span>
                    )}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
