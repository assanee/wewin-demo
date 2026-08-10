'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { BankAccountChangeWire, BankAccountWire } from '@wewin/contract/organisation';

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

import { changedFields, isCreation } from './bank-account-changes';
import { listBankAccountChanges } from './organisation-api';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ The change history — the fraud control, not a decoration on this screen.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `bank_account_changes`' own header names the attack this exists to catch: change the
 * receiving account number, wait for one transfer, change it back. A person auditing that has
 * to be able to see the two numbers side by side, who moved them, and when — so this renders
 * `changedFields` as a labelled before → after per row rather than the `<pre>` of raw JSON
 * `users/audit-trail.tsx` accepts for its own, much lower-stakes payload.
 *
 * ⚠️ **The actor is a bare user id, not a name.** `OrganisationController.changes` answers with
 * `BankAccountChangeWire.changedByUserId` straight from the row — there is no join to `users`
 * on this endpoint, unlike `audit-trail.tsx`'s `actorName`. Truncating it (`slice(0, 8)`)
 * rather than pretending to resolve it is the honest rendering of what this endpoint actually
 * knows; resolving it to a name is a real feature with its own review, not a side effect of
 * this screen.
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
  | { readonly status: 'ready'; readonly changes: readonly BankAccountChangeWire[] };

export function BankAccountHistoryDialog({
  account,
  onClose,
}: {
  readonly account: BankAccountWire;
  readonly onClose: () => void;
}) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let live = true;

    void (async () => {
      try {
        const changes = await listBankAccountChanges(account.id);
        if (live) setState({ status: 'ready', changes });
      } catch (cause) {
        if (live) setState({ status: 'failed', problem: failureMessage(cause) });
      }
    })();

    return () => {
      live = false;
    };
  }, [account.id]);

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>ประวัติการแก้ไข — {account.accountName}</DialogTitle>
          <DialogDescription>
            {account.bankCode} · {account.accountNumber} — บันทึกทุกครั้งที่มีการแก้ไข พร้อมผู้แก้และเวลา
            แก้ไขหรือลบภายหลังไม่ได้
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
          <p className="text-muted-foreground text-sm">ยังไม่มีประวัติการแก้ไขของบัญชีนี้</p>
        )}

        {state.status === 'ready' && state.changes.length > 0 && (
          <ol className="flex flex-col gap-3">
            {state.changes.map((change) => {
              const creation = isCreation(change);
              return (
                <li key={change.id} className="border-border/60 rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{creation ? 'สร้างบัญชี' : 'แก้ไขบัญชี'}</span>
                    <span className="text-muted-foreground text-xs">{at(change.changedAt)}</span>
                  </div>

                  <p className="text-muted-foreground mt-0.5 text-xs">
                    โดย{' '}
                    {change.changedByUserId === null
                      ? 'ระบบ'
                      : `ผู้ใช้ ${change.changedByUserId.slice(0, 8)}`}
                  </p>

                  <dl className="mt-2 flex flex-col gap-1">
                    {changedFields(change).map((field) => (
                      <div key={field.key} className="flex flex-wrap items-baseline gap-2">
                        <dt className="text-muted-foreground w-24 shrink-0">{field.labelTh}</dt>
                        <dd className="flex flex-wrap items-baseline gap-1.5 font-mono text-xs">
                          {!creation && (
                            <>
                              {/*
                               * F4's fix: the strikethrough and the arrow are both
                               * `aria-hidden` in effect (the arrow explicitly, the strikethrough
                               * because CSS text-decoration announces nothing) — a screen reader
                               * heard two values with nothing saying which was which. "จาก"/
                               * "เป็น" are read text, not decoration, so that holds without them.
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
