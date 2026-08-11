'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { failureMessage } from '@/lib/api/errors';

import {
  listAuthorityLimitChanges,
  type AuthorityLimitChangeView,
  type AuthorityLimitView,
} from './authority-limits-api';
import { DIMENSION_LABEL_TH, changeHeadlineTh, changedFields, isGrant } from './authority-limits';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ Who moved this ceiling, from what, and when — the control, not a decoration.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The attack this answers is the one `bank_account_changes` answers in its own shape: widen an
 * authority for one deal and narrow it back afterwards. Nothing else in the system would show
 * it. `approvals.decided_ceiling_thb_minor` pins what the ceiling *was* at the moment somebody
 * approved, which is a different and narrower fact — it says the decision was within authority,
 * and says nothing about the authority having been granted an hour earlier for that decision.
 *
 * So this renders a labelled before → after per entry rather than a `<pre>` of JSON, and the
 * headline names the verb (ให้อำนาจครั้งแรก / ขยายเพดาน / ยกเลิกอำนาจ / คืนอำนาจ) because a
 * column of "แก้ไข" is the least useful thing a reader scanning for a widening could be shown.
 *
 * ⚠️ **The actor is a bare user id, not a name.** `GET …/changes` answers with
 * `changedByUserId` straight off the row; there is no join to `users` on this endpoint. The
 * truncation (`slice(0, 8)`) is the honest rendering of what the endpoint knows — resolving it
 * to a name is a real feature with its own review, not a side effect of this dialog. Identical
 * position to `bank-account-history.tsx`, which says the same thing about the same gap.
 *
 * ⚠️ **`changedByUserId` is never null here**, unlike the three settings-history tables. Their
 * actor column is nullable and erasure scrubs it; `authority_limit_changes.changed_by_user_id`
 * is NOT NULL and declared `keep` — a history of who may concede money whose actor can be
 * nulled is a weaker record than the ceiling row it describes. So there is no `ระบบ` branch,
 * because there is no state it could describe.
 */

const at = (iso: string): string =>
  new Date(iso).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly problem: string }
  | { readonly status: 'ready'; readonly changes: readonly AuthorityLimitChangeView[] };

export function AuthorityLimitHistoryDialog({
  limit,
  onClose,
}: {
  readonly limit: AuthorityLimitView;
  readonly onClose: () => void;
}) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let live = true;

    void (async () => {
      try {
        const changes = await listAuthorityLimitChanges(limit.groupId, limit.dimension);
        if (live) setState({ status: 'ready', changes });
      } catch (cause) {
        if (live) setState({ status: 'failed', problem: failureMessage(cause) });
      }
    })();

    return () => {
      live = false;
    };
  }, [limit.groupId, limit.dimension]);

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>ประวัติเพดานอำนาจ — {limit.groupNameTh}</DialogTitle>
          <DialogDescription>
            {DIMENSION_LABEL_TH[limit.dimension]} · {limit.groupCode} —
            บันทึกทุกครั้งที่มีการเปลี่ยนแปลง พร้อมผู้แก้และเวลา แก้ไขหรือลบภายหลังไม่ได้
          </DialogDescription>
        </DialogHeader>

        {state.status === 'loading' && (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}

        {state.status === 'failed' && (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" />
            <AlertTitle>โหลดประวัติไม่สำเร็จ</AlertTitle>
            <AlertDescription>{state.problem}</AlertDescription>
          </Alert>
        )}

        {state.status === 'ready' && state.changes.length === 0 && (
          <p className="text-muted-foreground text-sm">ยังไม่มีประวัติของเพดานนี้</p>
        )}

        {state.status === 'ready' && state.changes.length > 0 && (
          <ol className="flex flex-col gap-3">
            {state.changes.map((change) => {
              const grant = isGrant(change);
              return (
                <li key={change.id} className="border-border/60 rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{changeHeadlineTh(change)}</span>
                    <span className="text-muted-foreground text-xs">{at(change.changedAt)}</span>
                  </div>

                  <p className="text-muted-foreground mt-0.5 text-xs">
                    โดยผู้ใช้ {change.changedByUserId.slice(0, 8)}
                  </p>

                  <dl className="mt-2 flex flex-col gap-1">
                    {changedFields(change).map((field) => (
                      <div key={field.key} className="flex flex-wrap items-baseline gap-2">
                        <dt className="text-muted-foreground w-16 shrink-0">{field.labelTh}</dt>
                        <dd className="flex flex-wrap items-baseline gap-1.5 font-mono text-xs">
                          {!grant && (
                            <>
                              {/*
                               * "จาก"/"เป็น" are read text, not decoration: a strikethrough
                               * announces nothing to a screen reader and an arrow announces the
                               * wrong thing, so a listener would hear two values with nothing
                               * saying which was which. Same fix, same reasoning, as
                               * `bank-account-history.tsx`.
                               */}
                              <span className="text-muted-foreground">
                                จาก <span className="line-through">{field.beforeText}</span>
                              </span>
                              <span aria-hidden>→</span>
                              <span className="text-muted-foreground">เป็น</span>
                            </>
                          )}
                          <span>{field.afterText}</span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </li>
              );
            })}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}
