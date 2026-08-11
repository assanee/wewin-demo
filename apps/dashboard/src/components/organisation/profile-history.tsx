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

import { listProfileChanges, type ProfileChangeRow } from './organisation-api';
import { isProfileCreation, profileChangedFields } from './profile-changes';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The change history for the company profile — same reader shape as `BankAccountHistoryDialog`
 * and `TaxCountryHistoryDialog`, simpler by one thing: the profile is a singleton, so there is
 * no row to pick first. Opening this dialog needs nothing but a place to put it.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `deposit_bp` is why this exists, not letterhead: it is the `cashflow` floor — the number that
 * decides what counts as a concession needing approval — and until this screen the only way to
 * answer "who lowered it, and when" was a psql prompt. `profileChangedFields` renders it as the
 * percentage every other surface in this app shows, never the raw basis points; see that
 * module's own header for the codec it reuses to do that.
 *
 * The actor is a bare user id, not a name, for the same reason `bank-account-history.tsx` prints
 * one: `OrganisationController.profileChanges` answers straight from the row, with no join to
 * `users`.
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
  | { readonly status: 'ready'; readonly changes: readonly ProfileChangeRow[] };

export function ProfileHistoryDialog({ onClose }: { readonly onClose: () => void }) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let live = true;

    void (async () => {
      try {
        const changes = await listProfileChanges();
        if (live) setState({ status: 'ready', changes });
      } catch (cause) {
        if (live) setState({ status: 'failed', problem: failureMessage(cause) });
      }
    })();

    return () => {
      live = false;
    };
  }, []);

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>ประวัติการแก้ไข — ข้อมูลบริษัท</DialogTitle>
          <DialogDescription>
            บันทึกทุกครั้งที่มีการแก้ไขข้อมูลบริษัท พร้อมผู้แก้และเวลา แก้ไขหรือลบภายหลังไม่ได้
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
          <p className="text-muted-foreground text-sm">ยังไม่มีประวัติการแก้ไขข้อมูลบริษัท</p>
        )}

        {state.status === 'ready' && state.changes.length > 0 && (
          <ol className="flex flex-col gap-3">
            {state.changes.map((change) => {
              const creation = isProfileCreation(change);
              return (
                <li key={change.id} className="border-border/60 rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">
                      {creation ? 'สร้างข้อมูลบริษัท' : 'แก้ไขข้อมูลบริษัท'}
                    </span>
                    <span className="text-muted-foreground text-xs">{at(change.changedAt)}</span>
                  </div>

                  <p className="text-muted-foreground mt-0.5 text-xs">
                    โดย{' '}
                    {change.changedByUserId === null
                      ? 'ระบบ'
                      : `ผู้ใช้ ${change.changedByUserId.slice(0, 8)}`}
                  </p>

                  <dl className="mt-2 flex flex-col gap-1">
                    {profileChangedFields(change).map((field) => (
                      <div key={field.key} className="flex flex-wrap items-baseline gap-2">
                        <dt className="text-muted-foreground w-24 shrink-0">{field.labelTh}</dt>
                        <dd className="flex flex-wrap items-baseline gap-1.5 font-mono text-xs">
                          {!creation && (
                            <>
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
