'use client';

import { useState } from 'react';
import { AlertTriangle, History, Loader2, Pencil, Plus, ShieldCheck } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { baht } from '@/components/quotes/amounts';
import { failureMessage } from '@/lib/api/errors';

import {
  withdrawAuthorityLimit,
  type AuthorityGroupView,
  type AuthorityLimitView,
} from './authority-limits-api';
import { DIMENSION_LABEL_TH, ceilingMeaningTh } from './authority-limits';
import { AuthorityLimitDialog } from './authority-limit-dialog';
import { AuthorityLimitHistoryDialog } from './authority-limit-history';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ Who may reduce what the customer pays, and by how much — the screen that makes the
 *    approval machinery real.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `authority_limits` shipped with a REST surface and no way to reach it, so it stayed empty and
 * every part of the module that reads it answered *"nobody may concede anything"*. That is the
 * documented fail-closed default and not a bug — but a default nobody can change is a feature
 * that dies quietly, which is plan 7.13's own warning about this table.
 *
 * ── Why it is here and not on the quote screen ───────────────────────────────────
 *
 * Authority attaches to a **group**, and a salesperson who could write this table would raise
 * their own ceiling and then need nobody's approval for anything. So the API gates it on
 * `groups.write` — group administration.
 *
 * ⚠️ It began as a third tab on `/users`, and that was wrong for a reason no test could see:
 * `/users` is gated on `users.read`, so reaching the ceiling table required sight of the entire
 * staff directory, and `groups.write` — held by nobody at boot — could not be delegated without
 * it. It is its own page now, reachable with `groups.read` alone, and **nothing in this folder
 * imports from `components/users/`**. That is the invariant; the rest is layout.
 *
 * ── ⚠️ Withdrawn rows are shown, dimmed, not hidden ──────────────────────────────
 *
 * `DELETE` sets `revoked_at`; `authority_limits_block_delete` refuses a real delete, because
 * the row records who granted this role its authority and deleting it took that name away with
 * the number. Hiding the row would make reinstating look like a fresh grant and would lose the
 * one thing withdrawal is supposed to leave behind. Same call `tax-countries.tsx` makes about
 * `is_active`, for a sharper reason.
 *
 * ── The permission gate is a prop, never `useSession()` ──────────────────────────
 *
 * `editable` arrives from the parent, which resolves it once. That is what lets this component
 * be rendered under `environment: 'node'` with `renderToStaticMarkup` and asserted on — a real
 * `SessionProvider` would sit at `loading` forever, because static rendering never runs
 * effects. The gate that actually enforces anything is `@RequirePermissions('groups.write')` on
 * the route; this only decides which buttons exist.
 */

export type AuthorityLimitsState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly problem: string }
  | {
      readonly status: 'ready';
      readonly limits: readonly AuthorityLimitView[];
      /** True when no **live** ceiling exists — not merely when the list is empty. */
      readonly isFailClosed: boolean;
    };

const keyOf = (limit: Pick<AuthorityLimitView, 'groupId' | 'dimension'>): string =>
  `${limit.groupId}:${limit.dimension}`;

export default function AuthorityLimitsPanel({
  state,
  groups,
  editable,
  onChanged,
}: {
  readonly state: AuthorityLimitsState;
  /** For the add dialog's role picker — `GET /quotes/authority/groups`, under `groups.read`. */
  readonly groups: readonly AuthorityGroupView[];
  readonly editable: boolean;
  readonly onChanged: () => Promise<void>;
}) {
  const [dialog, setDialog] = useState<'create' | AuthorityLimitView | null>(null);
  const [historyOf, setHistoryOf] = useState<AuthorityLimitView | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function withdraw(limit: AuthorityLimitView): Promise<void> {
    setPendingKey(keyOf(limit));
    setProblem(null);
    try {
      await withdrawAuthorityLimit(limit.groupId, limit.dimension);
      await onChanged();
    } catch (cause) {
      setProblem(failureMessage(cause));
    } finally {
      setPendingKey(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-muted-foreground max-w-3xl text-sm">
          เพดานคือจำนวนเงินสูงสุดที่บทบาทหนึ่งลดให้ลูกค้าได้เองต่อหนึ่งใบเสนอราคา
          เกินเพดานต้องให้คนอื่นอนุมัติ และผู้อนุมัติต้องมีเพดานที่ครอบยอดนั้นด้วย
        </p>
        {/*
         * ⚠️ `state.status === 'ready'` as well as `editable`, and it is not cosmetic.
         *
         * `PUT` is an **upsert**. The dialog's collision warning is the only thing that tells
         * somebody "this role already has a ceiling and you are about to replace it", and it is
         * driven by `taken`, which is `state.limits` — `[]` on `loading` and on `failed`. So a
         * button that stayed live while the list had not arrived would let an administrator
         * replace an existing ฿5,000 with ฿50,000 believing it was a new grant, with the warning
         * suppressed and nothing on screen saying so. A control whose safety copy cannot be
         * computed yet is a control that is not ready.
         */}
        {editable && state.status === 'ready' && (
          <Button size="sm" onClick={() => setDialog('create')}>
            <Plus className="size-4" />
            กำหนดเพดาน
          </Button>
        )}
      </div>

      {problem !== null && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>ทำรายการไม่สำเร็จ</AlertTitle>
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}

      {state.status === 'loading' && <Skeleton className="h-40 w-full" />}

      {state.status === 'failed' && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>โหลดเพดานอำนาจอนุมัติไม่สำเร็จ</AlertTitle>
          <AlertDescription>{state.problem}</AlertDescription>
        </Alert>
      )}

      {/*
       * ⚠️ The fail-closed sentence, and it is the reason `isFailClosed` is on the response at
       * all rather than being computed here. An empty table is the shipped default, so a bare
       * empty list reads as "a feature nobody has used" when it actually means "nobody in this
       * company may reduce a price by one satang". Note the condition: `isFailClosed`, not
       * `limits.length === 0` — a table of nothing but withdrawn ceilings says the same thing.
       */}
      {state.status === 'ready' && state.isFailClosed && (
        <Alert>
          <ShieldCheck className="size-4" />
          <AlertTitle>ยังไม่มีใครมีอำนาจลดราคา</AlertTitle>
          <AlertDescription>
            ตอนนี้ไม่มีเพดานที่ใช้งานอยู่เลย พนักงานขายจึงลดราคาเองไม่ได้ และไม่มีใครอนุมัติส่วนลดให้ได้
            ใบเสนอราคาที่ไม่มีส่วนลดยังส่งได้ตามปกติ
          </AlertDescription>
        </Alert>
      )}

      {state.status === 'ready' && state.limits.length === 0 && (
        <p className="text-muted-foreground text-sm">ยังไม่มีการกำหนดเพดานให้บทบาทใด</p>
      )}

      {state.status === 'ready' && state.limits.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>บทบาท</TableHead>
              <TableHead>มิติ</TableHead>
              <TableHead className="text-right">เพดาน</TableHead>
              <TableHead>ความหมาย</TableHead>
              <TableHead>สถานะ</TableHead>
              <TableHead className="text-right">การจัดการ</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.limits.map((limit) => {
              const live = limit.revokedAt === null;
              return (
                <TableRow key={keyOf(limit)} className={live ? undefined : 'opacity-60'}>
                  <TableCell>
                    <div className="font-medium">{limit.groupNameTh}</div>
                    <div className="text-muted-foreground font-mono text-xs">{limit.groupCode}</div>
                  </TableCell>
                  <TableCell className="text-sm">{DIMENSION_LABEL_TH[limit.dimension]}</TableCell>
                  <TableCell className="text-right font-mono">
                    {baht(limit.maxConcessionThbMinor)}
                  </TableCell>
                  <TableCell className="text-muted-foreground max-w-xs text-xs">
                    {ceilingMeaningTh(limit)}
                    {limit.noteTh !== null && <div className="mt-0.5">หมายเหตุ: {limit.noteTh}</div>}
                  </TableCell>
                  <TableCell>
                    {live ? (
                      <Badge variant="outline">ใช้งาน</Badge>
                    ) : (
                      <Badge variant="destructive">ยกเลิกแล้ว</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {/* Not behind `editable`: reading the history needs only `groups.read`. */}
                      <Button variant="ghost" size="sm" onClick={() => setHistoryOf(limit)}>
                        <History className="size-4" />
                        ประวัติ
                      </Button>

                      {editable && (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => setDialog(limit)}>
                            <Pencil className="size-4" />
                            {live ? 'แก้ไข' : 'คืนอำนาจ'}
                          </Button>
                          {live && (
                            <Button
                              variant="destructive"
                              size="sm"
                              disabled={pendingKey === keyOf(limit)}
                              onClick={() => void withdraw(limit)}
                            >
                              {pendingKey === keyOf(limit) && (
                                <Loader2 className="size-4 animate-spin" />
                              )}
                              ยกเลิกอำนาจ
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {dialog !== null && (
        <AuthorityLimitDialog
          limit={dialog === 'create' ? null : dialog}
          groups={groups}
          taken={state.status === 'ready' ? state.limits : []}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void onChanged();
          }}
        />
      )}

      {historyOf !== null && (
        <AuthorityLimitHistoryDialog limit={historyOf} onClose={() => setHistoryOf(null)} />
      )}
    </div>
  );
}
