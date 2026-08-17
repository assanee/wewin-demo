'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Plus, Search } from 'lucide-react';
import type { AdminOptionGroupWire } from '@wewin/contract/admin';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '@/lib/auth/session';

import { failureMessage, listOptionGroups } from '@/components/products/catalog-api';
import { groupMatches } from './delta-field';
import { CreateGroupDialog } from './create-group-dialog';
import { optionGroupFocus } from './option-group-focus';
import { OptionGroupSection } from './option-group-section';

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

  /*
   * ⚠️ Derived from **every** group, not from `visible`. The headline is a statement about the
   * catalogue; filtering it by the search box would mean typing a product name silently changed
   * how many values the company has switched off, which is the one number on this screen that
   * must not move for a reason the reader did not intend.
   */
  const focus = useMemo(
    () => (state.status === 'ready' ? optionGroupFocus(state.groups) : null),
    [state],
  );

  return (
    <div className="flex flex-col gap-6">
      {/*
       * ⭐ THE PRIMARY THING — and it replaced a colour.
       *
       * This count used to sit at `text-sm` inside a muted paragraph, tinted
       * `text-amber-700 dark:text-amber-500` to make it stand out. Two things were wrong with
       * that, and the second is the real one: the house does not use colour for emphasis
       * (`globals.css` caps the accent at two places per screen and keeps `--primary` neutral on
       * purpose), and a tint on a `text-sm` line is emphasis you can only see *once you are
       * already reading the sentence* — on the one number the code's own comment said nobody
       * goes looking for. It was colour standing in for a focal point rather than a focal point.
       *
       * ⚠️ **Above the search box, not below it.** The filter is how you get to an answer; this
       * is the answer, and it is true of the whole catalogue regardless of what is typed in the
       * box. `order-list.tsx` makes the same argument for keeping its filter row quieter than the
       * table it filters.
       *
       * See `option-group-focus.ts` for why this is the number that earns the top of the screen:
       * `available` is the only field in this area that reaches a customer without a publish.
       */}
      {focus !== null && (
        <div className="flex flex-col gap-1">
          <p className="type-focal text-balance">{focus.headlineTh}</p>
          <p className="text-muted-foreground type-body max-w-3xl">{focus.detailTh}</p>
        </div>
      )}

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

      {/*
       * The dashed-bordered `Empty` that used to be here is gone with the Cards. An empty state
       * has nothing to be separated *from* — the sentence is the whole content, and a dashed
       * rectangle around it is one more edge on the screen this pass exists to take edges off.
       */}
      {state.status === 'ready' && visible.length === 0 && (
        <div className="flex flex-col gap-1 py-10 text-center">
          <p className="type-body font-medium">
            {needle === '' ? 'ยังไม่มีชุดตัวเลือก' : 'ไม่พบที่ค้นหา'}
          </p>
          <p className="text-muted-foreground type-body">
            {needle === ''
              ? 'สร้างกลุ่มแรกเพื่อให้สินค้าหยิบไปใช้'
              : `ไม่มีกลุ่มหรือตัวเลือกที่ตรงกับ “${needle}”`}
          </p>
        </div>
      )}

      {/*
       * ⭐ ~10 peer `<Card>`s became one divided list.
       *
       * This file held **one** `<Card>` literal and rendered about ten of them — one per group,
       * each identical, each ringed, each wrapping its own `<Table>`. That is the owner's
       * original complaint in its purest form: once every region is a Card, nothing is primary,
       * and ten of them in a column is ten statements that these things might be confused with
       * one another. A hairline between rows says the same thing with one edge instead of forty.
       */}
      {state.status === 'ready' && visible.length > 0 && (
        <div className="divide-border/60 flex flex-col divide-y">
          {visible.map((group) => (
            <OptionGroupSection key={group.code} group={group} editable={editable} onChanged={reload} />
          ))}
        </div>
      )}

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

/** The two badges that describe what a group *is*, used by the group section and the create dialog. */
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
      {busy ? <Spinner /> : <Check className="size-4" />}
      {children}
    </>
  );
}
