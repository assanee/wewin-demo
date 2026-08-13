'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, ChevronRight } from 'lucide-react';

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

import { gapLabelTh } from './elapsed';
import { railSegment, recordLines, type RailSegment } from './settings-history';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ One settings history, rendered once — the timeline treatment, minus the parts that misfit.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Four dialogs — tax country, bank account, company profile, authority ceiling — were four
 * near-identical implementations of one idea: about 21 structurally identical lines each, differing
 * only in which fetch they call, what their heading says, and whether their actor column is
 * nullable. They were **already good** (a labelled before → after per changed field, in Thai, and
 * each carrying a note that it deliberately avoids a `<pre>` of raw JSON) and nothing about that
 * reading changes here. What changes is that there is now one of them, and it reads like the order
 * page's spine: a staff member who has learned to read one history has learned to read all five.
 *
 * ── ⚠️⭐ WHAT DID NOT TRANSFER FROM THE ORDER SPINE, AND WHY ──────────────────
 *
 * These are *settings* histories, not a lifecycle. Forcing them into the order page's shape would
 * have been worse than leaving them alone, so three of its parts are deliberately absent:
 *
 *   **The merged past-and-future spine.** `order-spine.tsx` exists because `availableTransitions`
 *   and the events are the same table read in two directions — the history is the rows that exist
 *   and the buttons are the rows that could — so the buttons belong at the terminus of the rail.
 *   A settings history has no counterpart: there is no next action to offer, no status to move
 *   through, and nothing this dialog could put at the end of the rail. So the rail simply **ends at
 *   the last entry**, which is the order spine's own terminal case (`capped`) made permanent. No
 *   "ทำต่อได้จากที่นี่", and no sentence about being at a terminus either — a settings log is not
 *   *finished*, it is merely up to date, and saying otherwise would be a claim about the future.
 *
 *   **The `gate` and `offered` marker shapes.** The spine's three-shape vocabulary is earned by
 *   `order_status_transitions` naming its own two irreversible points ("จุดที่ตรึงเอกสาร", "จุด
 *   freeze"). A settings change has no gate: no edit to a bank account is harder to undo than any
 *   other, and inventing a heavier marker for, say, deactivating a destination would be this screen
 *   asserting a hierarchy the schema does not have. `offered` has nothing to point at at all.
 *
 *   So **two shapes, not three**, and the distinction they draw is a different one — see
 *   `MARKER_ORIGIN`. It is not `gate`/`step` relabelled, and it is worth being explicit that the
 *   vocabulary did not carry, only the *idea* of encoding with shape rather than colour.
 *
 *   **The fold.** `hiddenCount` folds a long spine's oldest rows, and its own docstring gives the
 *   reason: "the buttons live at the newest end of the rail, and a person who opened an order to
 *   move it is reading backwards from there." Neither clause holds here. There are no buttons, so
 *   nothing is being kept above the fold; and these lists are oldest-first (the API's ordering),
 *   so a reader goes *forwards* through the chain. Measured before deciding — the dev database's
 *   deepest single subject is 12 entries (tax country SG), then 6 (an authority ceiling), 5 (the
 *   profile) and 3 (a bank account) — so at the order page's own threshold of 8 the control would
 *   appear on one subject of one of these four dialogs, inside a container that already scrolls.
 *   And it would hide the wrong end: entry N's `before` equals entry N−1's `after`, so the head of
 *   the chain is the **original value**, which is exactly what "changed it and changed it back" is
 *   measured against. Folding it away would remove the comparison the bank-account log exists to
 *   support. ⚠️ If a settings history ever routinely passes ~25 entries, the fold to reach for is
 *   one that hides the *middle*, because both ends are load-bearing here in a way neither is on an
 *   order.
 *
 * ── What did transfer ────────────────────────────────────────────────────────
 *
 *   **The rail and markers**, minus the vocabulary above. **The elapsed time between entries** —
 *   see `elapsed.ts`, which is where that function now lives precisely because it was never about
 *   orders. And **the record layer on demand**, for the reason `settings-record.ts` points at
 *   rather than restates.
 *
 * ── ⚠️ Ordering: read, never derived ────────────────────────────────────────
 *
 * Entries render in the order the API returned them, full stop. Nothing here sorts, and nothing may
 * — `changed_at` is written with `clock_timestamp()` rather than `now()` on all four tables
 * (migration `0039_history_clock`) precisely because a clock-derived order can be one that never
 * happened. `gapLabelTh` *reads* two already-ordered timestamps to print a label and returns `null`
 * if they disagree with the list; that is the only thing any clock value is used for.
 *
 * ── ⚠️ Append-only, and nothing here suggests otherwise ─────────────────────
 *
 * Triggers on all four tables refuse UPDATE and DELETE. There is no control in this component that
 * acts on an entry — the only two interactive elements are the dialog's own close and a
 * `<summary>` that reveals text — and the header says so in words.
 *
 * ── ⚠️ Colour, tokens, and the one class that is *not* copied from the spine ─
 *
 * Every class here resolves to a **token** redefined in globals.css's `.dark` block, so the rail,
 * the markers and the disclosure are defined in both themes by construction rather than by
 * inspection. Every conditional class is a **complete literal string** chosen by a ternary, never a
 * template built from parts: Tailwind emits a rule only for a class it can see written in source,
 * so `` `border-${tone}-600` `` compiles, renders and paints nothing, and an element whose colour
 * class produced no CSS silently inherits `--foreground` — which reads as a design choice rather
 * than a bug. That has bitten this repository twice. Hence the constants below.
 */

/*
 * The rail, in three states plus absent. `left-2.5` is the centre of the 1.25rem marker column,
 * and a segment stops at a marker's centre (`h-3` / `top-3`) so the line reads as beginning and
 * ending at an entry rather than running off the ends of the list.
 *
 * ⚠️ There is a fourth state the order spine does not have: **no rail at all**. A spine always has
 * a terminus below its last event, so every row there has something to connect to. A settings
 * history with exactly one entry — three of the four subjects in the dev database are at one, two
 * or three — has nothing above and nothing below, and a stub of line hanging off a lone marker is
 * a rail claiming a sequence that does not exist.
 */
const RAIL_FULL = 'bg-border absolute top-0 bottom-0 left-2.5 w-px';
const RAIL_FROM_MARKER = 'bg-border absolute top-3 bottom-0 left-2.5 w-px';
const RAIL_TO_MARKER = 'bg-border absolute top-0 left-2.5 h-3 w-px';
/* Dashed, and only ever behind a gap label: the rail is thinner evidence where time passed. */
const RAIL_GAP = 'border-border absolute top-0 bottom-0 left-2.5 border-l border-dashed';

/**
 * `null` is `'none'`: the lone-entry case renders no rail element at all rather than an empty one.
 * The arithmetic that picks between the four is `railSegment`, in the `.ts` beside this file, so
 * that the `to-marker`/`full` off-by-one is provable rather than screenshot-only.
 */
const RAIL_CLASS: Readonly<Record<RailSegment, string | null>> = {
  'from-marker': RAIL_FROM_MARKER,
  full: RAIL_FULL,
  'to-marker': RAIL_TO_MARKER,
  none: null,
};

/*
 * Shape, not colour — and **two** shapes, drawing a distinction the order spine does not have.
 *
 *   change   an edit: something was moved from one value to another
 *   origin   the entry with no `before` at all — the subject coming into existence
 *
 * `origin` is not `gate` relabelled. A gate is *irreversible*; an origin is *unprecedented*, which
 * is a fact about the chain rather than about the act. It is the one true binary in every one of
 * these four logs, and all four already branched on it before this component existed
 * (`isCreation`, `isTaxCountryCreation`, `isProfileCreation`, `isGrant`) in order to suppress the
 * "จาก … → เป็น" half of a row that has no before. The marker now says out loud what that
 * suppression already implied.
 *
 * ⚠️ `bg-popover`, **not** the `bg-card` the order spine uses. The hollow marker's fill is
 * load-bearing — it breaks the rail behind itself so a ring reads as a ring rather than as a line
 * passing through a circle — which means it has to be the colour of *the surface it sits on*.
 * `order-spine.tsx` renders into a `Card` (`bg-card`); this renders into a `DialogContent`, which
 * is `bg-popover`. The two tokens happen to hold the same value in both themes today
 * (`oklch(1 0 0)` / `oklch(0.205 0 0)`), so copying the spine's class would have looked correct
 * indefinitely and then broken the day somebody tinted one surface and not the other. The token
 * that names the actual container is the one that stays right.
 */
const MARKER_CHANGE = 'bg-foreground size-2.5 rounded-full';
const MARKER_ORIGIN = 'border-foreground bg-popover size-3.5 rounded-full border-2';

/* A row of the rail: the marker column, then everything else. */
const ROW = 'relative grid grid-cols-[1.25rem_1fr] gap-x-3';

/*
 * ⚠️ `relative` on the marker wrapper is load-bearing, and it was a visible bug on the order spine
 * before it was there. The rail is `absolute` and a `static` marker loses to it inside the row's
 * stacking context: every filled dot came out with a hairline through its middle, and the
 * `bg-popover` that is supposed to break the rail behind a ring sat *underneath* the thing it was
 * meant to hide. Positioning the wrapper puts it after the rail in paint order at the same
 * z-index. Only a browser can show this; it is invisible to a markup assertion.
 */
const MARKER_CELL = 'relative flex h-6 items-center justify-center';

/*
 * ⚠️ `focus-visible:outline-*` and not a `ring-*` halo. `globals.css` records that `ring-ring/50` —
 * what shadcn's own variants use for the soft 3px ring — cannot reach the 3:1 a focus indicator
 * needs at *any* lightness, because 50% of a grey over a background tops out near 2.1:1. A solid
 * outline in `--ring` is the value that file measured at 4.5:1+ in both themes.
 */
const FOCUSABLE =
  'focus-visible:outline-ring rounded focus-visible:outline-2 focus-visible:outline-offset-2';

/*
 * ⚠️ The record layer's key column, **one constant for two `<dl>`s that must agree**, and it was a
 * measured collision before it was a constant.
 *
 * The two lists inside the disclosure — the row's own metadata, then the snapshot pair — sit in one
 * bordered box and read as one table, so their key columns have to line up. They were two separate
 * `grid-cols-[7rem_…]` literals copied from `order-spine.tsx`, which is exactly the shape of thing
 * that drifts. It was also **too narrow**: measured in the browser, `changed_by_user_id` needs 130px
 * of `font-mono` `text-xs` and `7rem` is 112, so the label overflowed its own column and printed
 * *on top of* the uuid beside it — two monospace strings with no gap, which reads as one corrupt
 * value rather than as a layout fault. `order-spine.tsx` never hit it because its longest record key
 * is `event_type`.
 *
 * `9rem` is 144px: it clears the 130 with room, and it is the widest of these four dialogs' keys by
 * some margin. ⚠️ The `wrap-break-word` on every `<dt>` below is the guard rather than the fix —
 * `maxConcessionThbMinor` on the authority log is longer still (21 characters) and is *expected* to
 * wrap. A snapshot key from a newer API can be any length, so no width is a promise; what matters is
 * that a long one wraps inside its column instead of overprinting the value.
 */
const RECORD_KEY_COLUMN = 'grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 font-mono text-xs';

const at = (iso: string): string =>
  new Date(iso).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

/**
 * One changed field, read. Structurally the `ChangedFieldView` all four readers already return —
 * declared inline rather than imported from any of them, for the reason `authority-limits.ts`
 * writes down about that very type: importing it from `bank-account-changes.ts` would make the
 * bank-account history the de-facto owner of a shape five features now depend on.
 */
export interface HistoryFieldView {
  readonly key: string;
  readonly labelTh: string;
  readonly beforeText: string;
  readonly afterText: string;
}

/** One entry of a settings history, as this component needs it. */
export interface HistoryEntryView {
  /** The `*_changes` row id. Shown in the record layer, because it is the citable handle. */
  readonly id: string;
  /** Verbatim off the row — printed to the minute in the reading, in full in the record. */
  readonly changedAt: string;
  /**
   * ⚠️ An **id**, never a name, and that is deliberate rather than a gap this screen should close.
   * None of the four endpoints joins `users`; the column is also PDPA-relevant — three of the four
   * tables have a nullable actor that erasure scrubs, which is what `null` means here. Resolving it
   * to a person is a real feature with its own review.
   */
  readonly changedByUserId: string | null;
  /** The verb, in Thai. `changeHeadlineTh` on the authority log; a two-way ternary on the others. */
  readonly headlineTh: string;
  /** `before === null`: the subject coming into existence. Draws the ring, drops the "จาก" half. */
  readonly isOrigin: boolean;
  readonly fields: readonly HistoryFieldView[];
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>>;
}

type State<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly problem: string }
  | { readonly status: 'ready'; readonly changes: readonly T[] };

export function SettingsHistoryDialog<T>({
  headingTh,
  subjectTh,
  emptyTh,
  load,
  toEntry,
  onClose,
}: {
  readonly headingTh: string;
  /** The subject line, before the shared append-only sentence this component adds. */
  readonly subjectTh: ReactNode;
  readonly emptyTh: string;
  /**
   * ⚠️ Must be `useCallback`-stable on whatever identifies the subject. It is this effect's only
   * dependency, so an inline arrow would refetch on every render. The dep list stays at each call
   * site because that is where the subject's identity is known — `country.code`, `account.id`,
   * `[limit.groupId, limit.dimension]`, or nothing at all for the singleton profile.
   */
  readonly load: () => Promise<readonly T[]>;
  readonly toEntry: (row: T) => HistoryEntryView;
  readonly onClose: () => void;
}) {
  const [state, setState] = useState<State<T>>({ status: 'loading' });

  useEffect(() => {
    let live = true;

    void (async () => {
      try {
        const changes = await load();
        if (live) setState({ status: 'ready', changes });
      } catch (cause) {
        if (live) setState({ status: 'failed', problem: failureMessage(cause) });
      }
    })();

    return () => {
      live = false;
    };
  }, [load]);

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{headingTh}</DialogTitle>
          <DialogDescription>
            {/*
             * The append-only sentence is stated here rather than four times. All four tables
             * refuse UPDATE and DELETE by trigger, so it is one fact about one mechanism, and a
             * caller cannot accidentally omit it or word it differently.
             */}
            {subjectTh} — บันทึกทุกครั้งที่มีการเปลี่ยนแปลง พร้อมผู้แก้และเวลา แก้ไขหรือลบภายหลังไม่ได้
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
          <p className="text-muted-foreground text-sm">{emptyTh}</p>
        )}

        {state.status === 'ready' && state.changes.length > 0 && (
          <Rail entries={state.changes.map(toEntry)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The spine itself.
 *
 * ⚠️ **No per-entry card.** All four dialogs used to wrap each entry in
 * `border-border/60 rounded-lg border p-3`, which was the right call when a flat `<ol>` had nothing
 * else to separate its rows. With a rail threading down the left, a column of boxes is two
 * separation mechanisms competing — and the rail cannot pass *behind* a bordered card without
 * either being clipped by it or drawing over its edge. The marker and the gap label do the work the
 * border was doing, which is what the order spine already demonstrates.
 */
function Rail({ entries }: { readonly entries: readonly HistoryEntryView[] }) {
  return (
    <ol>
      {entries.map((entry, index) => {
        /*
         * ⚠️ No label above the first entry — a gap sits *between* two entries on screen, and above
         * the first one there is nothing for it to sit between.
         */
        const previous = entries[index - 1];
        const gap =
          previous === undefined ? null : gapLabelTh(previous.changedAt, entry.changedAt);

        const rail = RAIL_CLASS[railSegment(index, entries.length)];

        return (
          <li key={entry.id}>
            {gap !== null && (
              <div className={`${ROW} py-1`}>
                <span className={RAIL_GAP} aria-hidden />
                <span className="text-muted-foreground col-start-2 text-xs">{gap}</span>
              </div>
            )}

            <div className={ROW}>
              {rail !== null && <span className={rail} aria-hidden />}
              <span className={MARKER_CELL}>
                <span
                  className={entry.isOrigin ? MARKER_ORIGIN : MARKER_CHANGE}
                  aria-hidden
                />
              </span>

              <div className="col-start-2 min-w-0 pb-4">
                <Entry entry={entry} />
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** One entry: **the reading**, with the record folded behind a disclosure. */
function Entry({ entry }: { readonly entry: HistoryEntryView }) {
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-sm font-medium">{entry.headlineTh}</span>
        <span className="text-muted-foreground text-xs">{at(entry.changedAt)}</span>
      </div>

      <p className="text-muted-foreground mt-0.5 text-xs">
        {/*
         * Truncated to eight characters, exactly as all four dialogs already did it. The full uuid
         * is in the record layer below — the reading needs enough to recognise a repeat actor, the
         * record needs enough to cite.
         */}
        โดย{' '}
        {entry.changedByUserId === null
          ? 'ระบบ'
          : `ผู้ใช้ ${entry.changedByUserId.slice(0, 8)}`}
      </p>

      {/*
       * ⚠️ The reading, unchanged from what all four dialogs already rendered — one `w-24` label
       * column and a before → after per changed field. The one difference is that it is now
       * `w-24` on all four: the authority dialog used `w-16` because its three labels are short,
       * and matching the other three removes a difference rather than parameterising it.
       */}
      <dl className="mt-2 flex flex-col gap-1 text-sm">
        {entry.fields.map((field) => (
          <div key={field.key} className="flex flex-wrap items-baseline gap-2">
            <dt className="text-muted-foreground w-24 shrink-0">{field.labelTh}</dt>
            <dd className="flex flex-wrap items-baseline gap-1.5 font-mono text-xs">
              {!entry.isOrigin && (
                <>
                  {/*
                   * F4's fix, kept verbatim: the strikethrough and the arrow are both
                   * `aria-hidden` in effect (the arrow explicitly, the strikethrough because CSS
                   * text-decoration announces nothing) — a screen reader heard two values with
                   * nothing saying which was which. "จาก"/"เป็น" are read text, not decoration,
                   * so that holds without them.
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

      <Record entry={entry} />
    </>
  );
}

/**
 * **The record**, opened on demand: everything the `*_changes` row stored about this entry.
 *
 * ⚠️ A native `<details>`/`<summary>`, deliberately and for the four reasons `order-spine.tsx`
 * gives: it is focusable, it toggles on Enter *and* Space, it exposes its expanded state to a
 * screen reader, and it needs no JavaScript. `globals.css` already gives `summary` a pointer cursor
 * in its base layer, which is the house saying this is the intended element.
 *
 * The chevron's rotation is the only animation here and its transition is dropped under
 * `prefers-reduced-motion`; the rotation itself still happens, so the control's state is never
 * conveyed by motion alone.
 *
 * ── ⚠️ What is inside, and why every bit of it is *more* than the reading shows ──
 *
 * The reading above truncates the actor to eight characters, rounds `changed_at` to the minute, and
 * filters out every field that did not move. All three are right for reading and wrong for quoting,
 * which is the whole reason this layer exists — see `settings-history.ts`'s header for the line, and
 * `order-timeline.ts` for where it is stated at length. `recordLines` guarantees the completeness
 * half: every key in either snapshot appears, in one sorted order shared by both columns.
 */
function Record({ entry }: { readonly entry: HistoryEntryView }) {
  const lines = recordLines(entry.before, entry.after);

  return (
    <details className="group mt-1.5">
      <summary
        className={`text-muted-foreground hover:text-foreground inline-flex w-fit list-none items-center gap-1 text-xs [&::-webkit-details-marker]:hidden ${FOCUSABLE}`}
      >
        <ChevronRight
          className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none"
          aria-hidden
        />
        รายละเอียด
      </summary>

      <div className="border-border/60 mt-2 rounded border border-dashed p-2">
        <p className="text-muted-foreground mb-1.5 text-xs">ข้อมูลที่บันทึกไว้</p>

        <dl className={RECORD_KEY_COLUMN}>
          <dt className="text-muted-foreground min-w-0 wrap-break-word">id</dt>
          <dd className="break-all">{entry.id}</dd>

          <dt className="text-muted-foreground min-w-0 wrap-break-word">changed_at</dt>
          <dd className="break-all">{entry.changedAt}</dd>

          {/* The full uuid. `null` is a real answer on three of the four tables: the actor column
            * is nullable and `erase_user()` scrubs it, so a dash here is an erased staff member
            * rather than a missing field. */}
          <dt className="text-muted-foreground min-w-0 wrap-break-word">changed_by_user_id</dt>
          <dd className="break-all">{entry.changedByUserId ?? '—'}</dd>
        </dl>

        {/*
         * The two snapshots, key by key, in the one sorted order `recordLines` gives both of them
         * so the columns can be compared line by line. `grid-cols-subgrid` keeps the key column
         * aligned with the three rows above without repeating the width.
         */}
        <dl className={`mt-2 ${RECORD_KEY_COLUMN}`}>
          {lines.map((line) => (
            <div key={line.key} className="col-span-2 grid grid-cols-subgrid items-baseline">
              <dt className="text-muted-foreground min-w-0 wrap-break-word">{line.key}</dt>
              <dd className="min-w-0 wrap-break-word">
                {entry.isOrigin ? (
                  <Stored present={line.inAfter} text={line.afterText} />
                ) : (
                  <>
                    <span className="text-muted-foreground block">
                      {'before: '}
                      <Stored present={line.inBefore} text={line.beforeText} />
                    </span>
                    <span className="block">
                      {'after:  '}
                      <Stored present={line.inAfter} text={line.afterText} />
                    </span>
                  </>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </details>
  );
}

/**
 * One stored value, or a **sentence** saying the key was not in that snapshot at all.
 *
 * ⚠️ A sentence rather than a symbol, and the distinction it draws is the point: the services
 * snapshot a fixed field list on every write, so a key present in one side and absent from the
 * other is an anomaly worth naming, and it must not be confusable with a stored empty string or a
 * stored `null` — both of which are ordinary values that print as themselves. Same posture as
 * `payloadLines`' unknown-key branch on the order spine: say which of the two this is, out loud,
 * before anybody quotes it.
 */
function Stored({ present, text }: { readonly present: boolean; readonly text: string }) {
  if (!present) {
    return <span className="text-muted-foreground italic">ไม่มีคีย์นี้ในสแนปช็อต</span>;
  }
  return <span>{text === '' ? "''" : text}</span>;
}
