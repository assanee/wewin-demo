'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Loader2, Plus, Search } from 'lucide-react';
import type { AdminOptionGroupWire } from '@wewin/contract/admin';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '@/lib/auth/session';

import { failureMessage, listOptionGroups } from '@/components/products/catalog-api';
import { groupMatches } from './delta-field';
import { CreateGroupDialog } from './create-group-dialog';
import { OptionGroupCard } from './option-group-card';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The shared vocabulary, and the one switch on it that a customer feels at once.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * An option group is not owned by a product. `GET /admin/catalog/option-groups` answers with
 * the whole vocabulary — profile colours, glass thicknesses, screen types — and each
 * published product version *cites* the values it offers. That shape decides how this screen
 * has to read: renaming a colour renames it everywhere, and the person doing it has to be
 * able to see that before they press anything.
 *
 * ### Everything here except one switch waits for a publish
 *
 * A label, a helper line, a price delta, a new value: all of them are catalogue vocabulary,
 * and a customer sees them only when somebody publishes a product version that cites them.
 *
 * `available` is the exception and it is not a small one. `SetOptionValueAvailabilityRequestWire`
 * is a request type of its own because plan 5 point 2 says stock is the one catalogue fact
 * that changes without a publish — so taking a colour out of stock removes it from *every*
 * published version offering it, for every customer, immediately. This screen therefore
 * gives it its own control, its own colour and its own confirmation line, and never folds
 * it into a form that also edits a label. See `option-group-api.ts`.
 *
 * ### Why the list is not paginated and the DOM is not windowed
 *
 * `product-list.tsx` windows its table because 800 products is a real number. The option
 * vocabulary is different in kind: it is the set of *choices a factory can actually make*,
 * and it is ten groups and twenty-seven values today. It grows when the company starts
 * offering a new finish, which is a handful of times a year. A window here would be
 * machinery guarding against a size this table cannot reach.
 */

type Loading = { readonly status: 'loading' };
type Failed = { readonly status: 'failed'; readonly message: string };
type Ready = { readonly status: 'ready'; readonly groups: readonly AdminOptionGroupWire[] };
type State = Loading | Failed | Ready;

export function OptionGroupList() {
  const { can } = useSession();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [needle, setNeedle] = useState('');
  const [creating, setCreating] = useState(false);

  /*
   * `catalog.write` gates every mutation on this screen, and the API enforces it — a button
   * hidden here is a courtesy, not a control. The permission is checked so the read-only
   * clerk sees a screen that makes sense rather than a row of buttons that all 403.
   */
  const editable = can('catalog.write');

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const body = await listOptionGroups();
        if (!cancelled) setState({ status: 'ready', groups: body.groups });
      } catch (cause) {
        if (!cancelled) setState({ status: 'failed', message: failureMessage(cause) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Re-read the whole vocabulary after a write.
   *
   * ⚠️ **Not a local splice, and the reason is a bug this screen actually had.** The writes
   * answer `204 No Content` — every one of them — so there is nothing to splice *from*. The
   * first version assumed they returned the updated group; the decoder then rejected the
   * empty body and the screen reported "ทำรายการไม่สำเร็จ" over a change that had already
   * been committed to Postgres. See `option-group-api.ts`.
   *
   * Re-listing costs one request against a payload of ten groups. What it buys is that the
   * table shows what the server holds rather than what this client believed it sent, which
   * on a screen whose most dangerous control is "withdraw from sale" is worth more than the
   * request.
   */
  const reload = async (): Promise<void> => {
    try {
      const body = await listOptionGroups();
      setState({ status: 'ready', groups: body.groups });
    } catch (cause) {
      setState({ status: 'failed', message: failureMessage(cause) });
    }
  };

  const visible = useMemo(
    () => (state.status === 'ready' ? state.groups.filter((group) => groupMatches(group, needle)) : []),
    [state, needle],
  );

  const counts = useMemo(() => {
    if (state.status !== 'ready') return null;
    const values = state.groups.flatMap((group) => group.values);
    return {
      groups: state.groups.length,
      values: values.length,
      unavailable: values.filter((value) => !value.available).length,
    };
  }, [state]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <InputGroup className="max-w-sm flex-1">
          <InputGroupAddon>
            <Search className="size-4" />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="ค้นหาชุดตัวเลือก"
            placeholder="ค้นหาชื่อกลุ่ม รหัส หรือชื่อตัวเลือก"
            value={needle}
            onChange={(event) => setNeedle(event.target.value)}
          />
        </InputGroup>

        {editable && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            สร้างกลุ่มใหม่
          </Button>
        )}
      </div>

      {counts !== null && (
        <p className="text-muted-foreground text-sm">
          {counts.groups} กลุ่ม · {counts.values} ตัวเลือก
          {counts.unavailable > 0 && (
            /*
             * Surfaced at the top because it is the number nobody goes looking for. A value
             * that is out of stock is invisible to every customer on every published version,
             * and the most likely way that becomes permanent is somebody switching it off for
             * an afternoon and the afternoon ending.
             */
            <>
              {' · '}
              {/*
               * ⚠️ Two shades, because one amber cannot sit on both a white page and a black
               * one. `text-amber-500` alone measured **2.13:1 on the light background** — a
               * warning nobody can read is worse than no warning, and this is the count the
               * comment above says nobody goes looking for. It passed in dark (9.27:1), which
               * is why it survived: it was never rendered on a light page.
               *
               * It also never rendered *at all* on the seed data — `counts.unavailable` is 0
               * until somebody switches a value off — so this was latent rather than visible,
               * and would have appeared for the first time in front of whoever did that.
               *
               * ⚠️ Both spellings must stay literal in this file. Tailwind emits only the
               * classes it finds in source, so `text-amber-700` exists as CSS *because it is
               * written here*; building the name up at runtime would produce no rule and the
               * text would silently fall back to `--foreground`, which is precisely the trap
               * globals.css describes and the reason this is not a computed class.
               */}
              <span className="text-amber-700 dark:text-amber-500">
                {counts.unavailable} รายการปิดการขายอยู่
              </span>
            </>
          )}
        </p>
      )}

      {state.status === 'loading' && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      )}

      {state.status === 'failed' && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>โหลดชุดตัวเลือกไม่สำเร็จ</AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}

      {state.status === 'ready' && visible.length === 0 && (
        <Empty className="border-border/60 rounded-lg border border-dashed">
          <EmptyHeader>
            <EmptyTitle>{needle === '' ? 'ยังไม่มีชุดตัวเลือก' : 'ไม่พบที่ค้นหา'}</EmptyTitle>
            <EmptyDescription>
              {needle === ''
                ? 'สร้างกลุ่มแรกเพื่อให้สินค้าหยิบไปใช้'
                : `ไม่มีกลุ่มหรือตัวเลือกที่ตรงกับ "${needle}"`}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {state.status === 'ready' &&
        visible.map((group) => (
          <OptionGroupCard key={group.code} group={group} editable={editable} onChanged={reload} />
        ))}

      {creating && (
        <CreateGroupDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            void reload();
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}

/** The two badges that describe what a group *is*, used by the card and the create dialog. */
export function GroupKindBadges({ group }: { readonly group: AdminOptionGroupWire }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant="outline">{group.kind === 'sku' ? 'ตัวเลือก' : 'วัดขนาด'}</Badge>
      <Badge variant="outline">{group.input}</Badge>
      {group.includeInSkuCode && (
        <Badge variant="secondary" title="ค่านี้ปรากฏในรหัส SKU">
          อยู่ใน SKU
        </Badge>
      )}
      {group.authoredUnit !== undefined && <Badge variant="outline">{group.authoredUnit}</Badge>}
    </div>
  );
}

/** Shared spinner-in-a-button, so every mutation on this screen reports itself the same way. */
export function Busy({ busy, children }: { readonly busy: boolean; readonly children: string }) {
  return (
    <>
      {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
      {children}
    </>
  );
}
