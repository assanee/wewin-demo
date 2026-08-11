'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { TaxCountryWire } from '@wewin/contract/tax';

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

import { listTaxCountryChanges, type TaxCountryChangeRow } from './organisation-api';
import { isTaxCountryCreation, taxCountryChangedFields } from './tax-country-fields';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The change history — same reader shape `BankAccountHistoryDialog` renders.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Labelled before→after per row, oldest-first (the API's own ordering), actor by bare user id
 * (nothing here joins `users` — see `bank-account-history.tsx`'s own note on that), everything
 * shown for a creation and only the moved fields for an edit. `taxCountryChangedFields` is
 * where the one shape difference from the bank-account reader lives: `rateBp` and `treatment`
 * print as a single `ภาษี` row, not two, because the CHECK that ties them together means an
 * edit that moves one very often moves both.
 */

const at = (iso: string): string =>
  new Date(iso).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

type HistoryState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly problem: string }
  | { readonly status: 'ready'; readonly changes: readonly TaxCountryChangeRow[] };

export function TaxCountryHistoryDialog({
  country,
  onClose,
}: {
  readonly country: TaxCountryWire;
  readonly onClose: () => void;
}) {
  const [state, setState] = useState<HistoryState>({ status: 'loading' });

  useEffect(() => {
    let live = true;

    void (async () => {
      try {
        const changes = await listTaxCountryChanges(country.code);
        if (live) setState({ status: 'ready', changes });
      } catch (cause) {
        if (live) setState({ status: 'failed', problem: failureMessage(cause) });
      }
    })();

    return () => {
      live = false;
    };
  }, [country.code]);

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>ประวัติการแก้ไข — {country.nameTh}</DialogTitle>
          <DialogDescription>
            รหัสประเทศ {country.code} — บันทึกทุกครั้งที่มีการแก้ไข พร้อมผู้แก้และเวลา แก้ไขหรือลบภายหลังไม่ได้
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
          <p className="text-muted-foreground text-sm">ยังไม่มีประวัติการแก้ไขของประเทศนี้</p>
        )}

        {state.status === 'ready' && state.changes.length > 0 && (
          <ol className="flex flex-col gap-3">
            {state.changes.map((change) => {
              const creation = isTaxCountryCreation(change);
              return (
                <li key={change.id} className="border-border/60 rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{creation ? 'เพิ่มประเทศ' : 'แก้ไขข้อมูลภาษี'}</span>
                    <span className="text-muted-foreground text-xs">{at(change.changedAt)}</span>
                  </div>

                  <p className="text-muted-foreground mt-0.5 text-xs">
                    โดย{' '}
                    {change.changedByUserId === null
                      ? 'ระบบ'
                      : `ผู้ใช้ ${change.changedByUserId.slice(0, 8)}`}
                  </p>

                  <dl className="mt-2 flex flex-col gap-1">
                    {taxCountryChangedFields(change).map((field) => (
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
