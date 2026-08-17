'use client';

import { useState } from 'react';
import { AlertTriangle, History, Pencil, Plus } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
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
import { authorityFocus } from './authority-focus';
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
 *
 * ── ⭐ The fail-closed sentence is the screen, and it used to be an Alert ─────
 *
 * This panel had **no heading of any kind** and opened with a muted `text-sm` paragraph where a
 * heading belongs, so the loudest things on it were a table and an `<Alert>` — and that Alert
 * was the *default* variant, carrying the single most consequential statement this dashboard can
 * make: nobody in the company may reduce a price by one satang, and nobody may approve one
 * either. It looked exactly like "ทำรายการไม่สำเร็จ" looks.
 *
 * `authorityFocus` now states it at `type-focal`, on the page ground, with a counterpart for the
 * live case that the Alert never had — a warning that only ever fires in one direction leaves a
 * reader unable to tell "healthy" from "not loaded".
 *
 * ⚠️ Unlike `/account`, whose one-way-in warning **stays** an `Alert`, this one does not: that
 * one is an exceptional consequence of an action the reader is about to take, while this is the
 * permanent state of the screen with two possible values. `Alert` is the app's shape for the
 * first thing, not the second.
 *
 * ⚠️ **The table stays uncontained** — no `Card`, no wrapper — and that is not an omission. It
 * is the only bare `<Table>` in the app and the house rule says a table draws its own rules; the
 * standard density (`px-2 py-1.5` cells, `h-8 type-caption` heads, `w-full` on the last column)
 * is what it gets instead of chrome.
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

  const focus = state.status === 'ready' ? authorityFocus(state) : null;

  return (
    <div className="flex flex-col gap-8">
      {/*
       * ⭐ THE PRIMARY THING. On the page ground, no border, type doing the work.
       *
       * Only once the list has arrived: neither sentence can be told from the other while the
       * request is in flight, and guessing would mean printing "ยังไม่มีใครมีอำนาจลดราคา" —
       * the alarming one — on every load of a perfectly healthy company.
       */}
      {focus !== null && (
        <section className="flex flex-col gap-1">
          <p className="type-focal text-balance">{focus.headlineTh}</p>
          <p className="text-muted-foreground type-body max-w-3xl">{focus.detailTh}</p>
        </section>
      )}

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

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          {/*
           * The screen's first heading. What stood here was a muted `text-sm` paragraph doing a
           * heading's job — and its first clause repeated the page description word for word, so
           * `PageHeader` now carries that half and this keeps the part it added: that an approver
           * needs a ceiling covering the amount too.
           */}
          <div className="flex flex-col gap-1">
            <h2 className="type-section">เพดานที่กำหนดไว้</h2>
            <p className="text-muted-foreground type-body max-w-3xl">
              ผู้อนุมัติต้องมีเพดานที่ครอบยอดนั้นด้วย — ไม่ใช่แค่มีสิทธิ์อนุมัติ
            </p>
          </div>
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

        {state.status === 'ready' && state.limits.length === 0 && (
          /*
           * Still said, even though the focal sentence above already covers the company-wide
           * consequence: this one is a fact about *the table underneath this heading*, and an
           * empty region with no explanation reads as a failed render.
           */
          <p className="text-muted-foreground type-body">ยังไม่มีการกำหนดเพดานให้บทบาทใด</p>
        )}

        {state.status === 'ready' && state.limits.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="type-caption h-8">บทบาท</TableHead>
                <TableHead className="type-caption h-8">มิติ</TableHead>
                <TableHead className="type-caption h-8 text-right">เพดาน</TableHead>
                <TableHead className="type-caption h-8">ความหมาย</TableHead>
                <TableHead className="type-caption h-8">สถานะ</TableHead>
                {/* `w-full` on the last column so the slack lands on the controls instead of
                    being shared out between the role, the dimension and the ceiling — the three
                    that are read together. Same call `order-list.tsx` explains. */}
                <TableHead className="type-caption h-8 w-full text-right">การจัดการ</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.limits.map((limit) => {
                const live = limit.revokedAt === null;
                return (
                  <TableRow key={keyOf(limit)} className={live ? undefined : 'opacity-60'}>
                    <TableCell className="px-2 py-1.5">
                      <div className="type-body font-medium">{limit.groupNameTh}</div>
                      <div className="text-muted-foreground type-caption font-mono">
                        {limit.groupCode}
                      </div>
                    </TableCell>
                    <TableCell className="type-body px-2 py-1.5">
                      {DIMENSION_LABEL_TH[limit.dimension]}
                    </TableCell>
                    <TableCell className="type-body px-2 py-1.5 text-right font-mono">
                      {baht(limit.maxConcessionThbMinor)}
                    </TableCell>
                    <TableCell className="text-muted-foreground type-caption max-w-xs px-2 py-1.5">
                      {ceilingMeaningTh(limit)}
                      {limit.noteTh !== null && <div className="mt-0.5">หมายเหตุ: {limit.noteTh}</div>}
                    </TableCell>
                    <TableCell className="px-2 py-1.5">
                      {live ? (
                        <Badge variant="outline">ใช้งาน</Badge>
                      ) : (
                        <Badge variant="destructive">ยกเลิกแล้ว</Badge>
                      )}
                    </TableCell>
                    <TableCell className="px-2 py-1.5 text-right">
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
                                  <Spinner />
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
      </section>

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
