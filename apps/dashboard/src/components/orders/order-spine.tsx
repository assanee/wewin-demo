'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { AvailableTransition, OrderEvent } from './order-api';
import { eventLabelTh, statusLabel, transitionForm } from './order-language';
import {
  actorLabelTh,
  fromLabelTh,
  gapLabelTh,
  gateNoteTh,
  hiddenCount,
  markerFor,
  payloadLines,
} from './order-timeline';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ One spine. The past is written; the future is offered.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This rail replaces two cards that a staff member always read together and the page presented
 * apart: `เปลี่ยนสถานะ`, a box of buttons, and `ลำดับเหตุการณ์`, a list of rows. They are the same
 * table. `availableTransitions` and the events both come from `order_status_transitions` — the
 * history is the rows that exist and the buttons are the rows that could — so the buttons are the
 * terminus of the rail rather than a separate box, and the old separation hid that they were one
 * thing.
 *
 * ── ⚠️ The Card around it is gone, and the rail is *more* whole for it ───────
 *
 * **Still one rail. Nothing was split.** What changed is that the region no longer has a ring
 * around it, so the status statement `order-detail.tsx` now renders directly above — the same
 * fact the first event on this rail records — is continuous with it instead of being a separate
 * peer above a box. The join this file exists to make now extends one element further up.
 *
 * The heading moved from `CardTitle` (`text-base`, i.e. 16px, two pixels above the 14px body
 * underneath it) to `type-section` at 18px. That 2px step, repeated in 39 of the app's 41 card
 * titles, is what the owner was reading as ไม่มีจุดเด่น.
 *
 * ── ⚠️ What this component may and may not do ────────────────────────────────
 *
 * It may lay things out. It decides nothing: the elapsed-time label, the payload reading, the
 * marker shape and the fold arithmetic are all in `order-timeline.ts`
 * with no React in them, because `apps/dashboard`'s vitest is `environment: 'node'` and a
 * `.test.tsx` is silently never collected — logic in a `.tsx` here is logic that cannot be
 * proved. Read that file's header for the line between *the reading* (an interpretation, free to
 * improve) and *the record* (the citable bytes, which nothing here writes to).
 *
 * ⚠️ **`setMoving` is not touched.** The transition dialog, the per-`payloadKind` forms and the
 * post-freeze cancellation that needs both a reason and a fault all live in `order-detail.tsx`
 * exactly as they did; this card receives `onMove` and calls it with the same
 * `AvailableTransition` the old buttons passed. The one load-bearing path on this screen was
 * moved by reference, not rewritten.
 *
 * ── ⚠️ Colour, and why there is none ────────────────────────────────────────
 *
 * `globals.css` caps the lime accent at two places per screen on purpose, so nothing here is
 * colour-coded by event type. Every class in this file resolves to a **token** — `bg-foreground`,
 * `bg-background`, `border-border`, `text-muted-foreground` — each of which is redefined in the `.dark`
 * block, so the rail, the markers, the disclosure and the gap labels are all defined in both
 * themes by construction rather than by inspection.
 *
 * ⚠️ Every conditional class below is a **complete literal string** chosen by a ternary, never a
 * template built from parts. Tailwind emits a rule only for a class it can see written in the
 * source; `` `border-${tone}-600` `` compiles, renders, and paints nothing, and an element whose
 * colour class produced no CSS silently inherits — which looks like a design choice rather than
 * a bug. Hence the four `RAIL_*` constants and the three `MARKER_*` constants.
 */

/*
 * The rail, in four states. `left-2.5` is the centre of the 1.25rem marker column, and the
 * segments stop at a marker's centre (`h-3` / `top-3`) so the line reads as beginning and ending
 * at an event rather than running off the ends of the card.
 */
const RAIL_FULL = 'bg-border absolute top-0 bottom-0 left-2.5 w-px';
const RAIL_FROM_MARKER = 'bg-border absolute top-3 bottom-0 left-2.5 w-px';
const RAIL_TO_MARKER = 'bg-border absolute top-0 left-2.5 h-3 w-px';
/* Dashed, and only ever behind a gap label: the rail is thinner evidence where time passed. */
const RAIL_GAP = 'border-border absolute top-0 bottom-0 left-2.5 border-l border-dashed';

/*
 * Shape, not colour — and three shapes, not an icon vocabulary.
 *
 *   step     a transition that happened and could in principle be walked back
 *   gate     one of the two irreversible points the transition table names itself
 *   offered  the row that does not exist yet
 *
 * The fill on the two hollow markers is load-bearing: it breaks the rail behind them so a ring
 * reads as a ring rather than as a line passing through a circle.
 *
 * ⚠️ **`bg-background` and not `bg-card` — this moved when the Card around the rail did, and
 * getting it wrong is invisible in the light theme.** These markers have to be filled with
 * whatever is actually behind them. While the spine lived in a `Card` that was `--card`; on the
 * page ground it is `--background`. In light both are `oklch(1 0 0)` and the mistake shows
 * nothing at all, but in dark `--card` is `oklch(0.205 0 0)` against a `--background` of
 * `oklch(0.145 0 0)` — the markers would have been three lighter-grey discs sitting on a darker
 * page, and only a dark-theme screenshot could have told anybody. Verified in the browser in
 * both themes rather than reasoned about.
 */
const MARKER_STEP = 'bg-foreground size-2.5 rounded-full';
const MARKER_GATE = 'border-foreground bg-background size-3.5 rounded-full border-2';
const MARKER_OFFERED =
  'border-muted-foreground bg-background size-3.5 rounded-full border border-dashed';

/* A row of the rail: the marker column, then everything else. */
const ROW = 'relative grid grid-cols-[1.25rem_1fr] gap-x-3';

/*
 * ⚠️ `relative` on the marker wrapper is load-bearing, and it was a visible bug before it was
 * there.
 *
 * The rail is `absolute` and the marker was `static`, so within the row's stacking context the
 * rail painted *over* it: every filled dot came out with a hairline through its middle and every
 * ring read as a circle with a line drawn across it — the `bg-card` that is supposed to break the
 * rail behind a hollow marker was underneath the thing it was meant to hide. Positioning the
 * wrapper puts it after the rail in paint order at the same z-index, which is the whole fix. Only
 * a browser could show this; it is invisible to a markup assertion.
 */
const MARKER_CELL = 'relative flex h-6 items-center justify-center';

/*
 * The two real controls in this card.
 *
 * ⚠️ `focus-visible:outline-*` and not a `ring-*` halo. `globals.css` records that
 * `ring-ring/50` — what shadcn's own variants use for the soft 3px ring — cannot reach the 3:1 a
 * focus indicator needs at *any* lightness, because 50% of a grey over a background tops out
 * near 2.1:1. A solid outline in `--ring` is the value that file measured at 4.5:1+ in both
 * themes, so that is what both of these use.
 */
const FOCUSABLE =
  'focus-visible:outline-ring rounded focus-visible:outline-2 focus-visible:outline-offset-2';

const at = (iso: string): string =>
  new Date(iso).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

export function OrderTimeline({
  events,
  availableTransitions,
  onMove,
}: {
  readonly events: readonly OrderEvent[];
  readonly availableTransitions: readonly AvailableTransition[];
  readonly onMove: (available: AvailableTransition) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const hidden = expanded ? 0 : hiddenCount(events.length);
  const shown = events.slice(hidden);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="type-section">ลำดับเหตุการณ์และการเปลี่ยนสถานะ</h3>
        <p className="text-muted-foreground type-body max-w-2xl">
          {/*
           * Both halves of the rail in one sentence, because the point of merging them is that
           * they are one table read in two directions.
           */}
          ทุกบรรทัดเขียนโดยการเปลี่ยนสถานะที่ทำให้เกิดขึ้น — แก้ไม่ได้ ปุ่มที่ปลายเส้นคือแถวที่ยังไม่ได้เขียน
          และมาจากตารางสถานะของ API โดยตรง
        </p>
      </div>

      <div>
        {events.length === 0 && <p className="text-muted-foreground text-sm">ยังไม่มีเหตุการณ์</p>}

        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className={`text-muted-foreground hover:text-foreground mb-3 inline-flex w-fit items-center gap-1.5 text-xs ${FOCUSABLE}`}
          >
            <ChevronDown className="size-3.5" aria-hidden />
            ดูอีก {hidden} รายการก่อนหน้า
          </button>
        )}

        <ol>
          {shown.map((event, index) => {
            /*
             * ⚠️ No label above the first visible row — a gap sits *between* two rows on screen,
             * and above the first one there is nothing to sit between. When rows are folded away, a
             * label there would attribute the hidden wait to a boundary the reader cannot see
             * either side of.
             *
             * ⚠️ Indexed into `events` rather than `shown` **and the two are equivalent today**,
             * because the `index === 0` guard is exactly what makes them so — `events[hidden + 0 - 1]`
             * is the only subscript where they differ, and it is never read. Written in the `events`
             * form deliberately: it is the one that stays correct if that guard is ever relaxed to
             * show the wait that straddles the fold, which is a defensible thing to want.
             */
            const previous = events[hidden + index - 1];
            const gap =
              previous === undefined || index === 0
                ? null
                : gapLabelTh(previous.createdAt, event.createdAt);

            const last = index === shown.length - 1;
            /* The rail stops at the terminus when there is one, and at the final event when the
             * order is terminal and there is nothing more to offer. */
            const capped = last && availableTransitions.length === 0;

            return (
              <li key={event.id}>
                {gap !== null && (
                  <div className={`${ROW} py-1`}>
                    <span className={RAIL_GAP} aria-hidden />
                    <span className="text-muted-foreground col-start-2 text-xs">{gap}</span>
                  </div>
                )}

                <div className={ROW}>
                  <span
                    className={
                      index === 0 && gap === null
                        ? RAIL_FROM_MARKER
                        : capped
                          ? RAIL_TO_MARKER
                          : RAIL_FULL
                    }
                    aria-hidden
                  />
                  <span className={MARKER_CELL}>
                    <span
                      className={markerFor(event.eventType) === 'gate' ? MARKER_GATE : MARKER_STEP}
                      aria-hidden
                    />
                  </span>

                  <div className="col-start-2 min-w-0 pb-4">
                    <Moment event={event} />
                  </div>
                </div>
              </li>
            );
          })}
        </ol>

        {/*
         * The terminus. No marker at all when the order is terminal: the *absence* of an unwritten
         * row is the statement, which is why `markerFor` has no fourth shape for "finished" — a
         * ring on `delivered` would spend the vocabulary on a fact the ending rail already tells.
         */}
        <div className={ROW}>
          {availableTransitions.length > 0 && (
            <>
              <span className={RAIL_TO_MARKER} aria-hidden />
              <span className={MARKER_CELL}>
                <span className={MARKER_OFFERED} aria-hidden />
              </span>
            </>
          )}

          <div className="col-start-2 flex min-w-0 flex-col gap-2">
            {availableTransitions.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                ออเดอร์นี้เดินต่อไม่ได้แล้ว — เป็นสถานะปลายทาง
              </p>
            ) : (
              <>
                <span className="text-muted-foreground text-sm">ทำต่อได้จากที่นี่</span>
                <div className="flex flex-wrap gap-2">
                  {availableTransitions.map((available) => {
                    const form = transitionForm(available.payloadKind);

                    return form.offered ? (
                      <Button
                        key={available.toStatus}
                        variant="outline"
                        onClick={() => onMove(available)}
                      >
                        {available.descriptionTh}
                      </Button>
                    ) : (
                      <div
                        key={available.toStatus}
                        className="border-border text-muted-foreground rounded-md border border-dashed px-3 py-2 text-xs"
                      >
                        {available.descriptionTh} — {form.whyNotTh}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * One event on the rail: **the reading**, with the record folded behind a disclosure.
 *
 * One event, one row — see the "One event per row" block in `order-timeline.ts` for the finding
 * that removed the transaction grouping this used to render.
 */
function Moment({ event }: { readonly event: OrderEvent }) {
  const from = fromLabelTh(event.fromStatus);
  const note = gateNoteTh(event.eventType);

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-sm font-medium">
          {/*
           * ⚠️ The Thai label leads and the machine string does not appear here at all.
           *
           * `toStatus` is null on the two events that move nothing — `change_requested` and
           * `change_resolved` — so a heading of `statusLabel(toStatus)` alone would be blank for
           * exactly the rows a person is most likely to be hunting for. `eventLabelTh` covers
           * both cases: for a move it names the act, and the destination follows it.
           */}
          {event.toStatus === null ? eventLabelTh(event.eventType) : statusLabel(event.toStatus)}
          {note !== null && <span className="text-muted-foreground font-normal"> · {note}</span>}
        </span>
        <span className="text-muted-foreground text-xs">{at(event.createdAt)}</span>
      </div>

      <div className="text-muted-foreground flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
        <span>
          {eventLabelTh(event.eventType)}
          {from !== null && ` · จาก ${from}`}
          {` · ${actorLabelTh(event.actorKind)}`}
        </span>
        {/*
         * `seq` kept and demoted. This is an append-only audit trail and citability is the whole
         * of its value, so the number stays — but small, monospace and muted, because the fact a
         * reader scanning the rail wants is the time.
         */}
        <span className="font-mono tabular-nums">{event.seq}</span>
      </div>

      <Record event={event} lines={payloadLines(event.payload)} />
    </>
  );
}

/**
 * **The record**, opened on demand: everything `order_events` stored about this row.
 *
 * ⚠️ A native `<details>`/`<summary>`, deliberately. It is focusable, it toggles on Enter *and*
 * Space, it exposes its expanded state to a screen reader, and it needs no JavaScript — four
 * things a `<div onClick>` would each have had to reimplement, and the fourth is why the old
 * `<pre>` was the only detail view this screen had. `globals.css` already gives `summary` a
 * pointer cursor in its base layer, which is the house saying this is the intended element.
 *
 * The chevron's rotation is the only animation in the card and it is dropped under
 * `prefers-reduced-motion` (`motion-reduce:transition-none`) — the rotation itself still happens,
 * so the control's state is never conveyed by motion alone.
 *
 * ── What is inside, in two parts, and why in this order ───────────────────────
 *
 * First **the reading of the payload**: Thai labels and formatted values, so
 * `slip_amount_thb_minor: "860152"` reads `ยอดในสลิป ฿8,601.52` instead of asking a person to
 * know the field is satang and divide by a hundred. Then **the stored row**, verbatim, because a
 * reading is an interpretation and an audit trail has to be quotable past it. A key this build
 * has no label for still appears in both halves, marked — `payloadLines` exists to guarantee it.
 */
function Record({
  event,
  lines,
}: {
  readonly event: OrderEvent;
  readonly lines: readonly {
    readonly key: string;
    readonly labelTh: string;
    readonly valueText: string;
    readonly known: boolean;
  }[];
}) {
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

      <div className="mt-2 flex flex-col gap-3">
        {lines.length > 0 && (
          <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-xs">
            {lines.map((line) => (
              <div key={line.key} className="col-span-2 grid grid-cols-subgrid items-baseline">
                <dt className="text-muted-foreground min-w-0 wrap-break-word">
                  {line.known ? line.labelTh : <span className="font-mono">{line.key}</span>}
                </dt>
                <dd className="min-w-0 wrap-break-word whitespace-pre-wrap">
                  {line.valueText}
                  {/*
                   * ⚠️ The visible fallback, and it is a *sentence* rather than a symbol.
                   *
                   * A newer API adding a payload key must not make it vanish from an audit trail,
                   * and it must not appear indistinguishable from a key this build understands
                   * either — a reader has to know which of the two they are looking at before
                   * they quote it. Same posture as `transitionForm` refusing an unknown
                   * `payloadKind` out loud instead of guessing a body.
                   */}
                  {!line.known && (
                    <span className="text-muted-foreground block">
                      แดชบอร์ดรุ่นนี้ยังไม่รู้จักค่านี้ — แสดงตามที่บันทึกไว้
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}

        <div className="border-border/60 rounded border border-dashed p-2">
          <p className="text-muted-foreground mb-1.5 text-xs">ข้อมูลที่บันทึกไว้</p>
          <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 font-mono text-xs">
            <dt className="text-muted-foreground">seq</dt>
            <dd className="tabular-nums">{event.seq}</dd>

            <dt className="text-muted-foreground">event_type</dt>
            <dd className="break-all">{event.eventType}</dd>

            <dt className="text-muted-foreground">status</dt>
            <dd className="break-all">
              {event.fromStatus ?? '—'} → {event.toStatus ?? '—'}
            </dd>

            <dt className="text-muted-foreground">actor</dt>
            <dd className="break-all">
              {event.actorKind}
              {event.actorUserId !== null && ` · ${event.actorUserId}`}
            </dd>

            {/*
             * ⚠️ `null` here is not a missing value, it is the audience gate: `encodeEvent`
             * withholds the txid from a customer. This screen holds `orders.read`, so seeing a dash
             * would itself be worth reporting.
             *
             * It is also the field whose grouping was removed and which stays anyway: it is the
             * only column that says which transaction wrote this row, and that is what an audit
             * layer wants to cite. `redteam5-lifecycle` A9 pins both halves — staff see it, the
             * customer gets null, and every txid on a spine is distinct.
             */}
            <dt className="text-muted-foreground">write_txid</dt>
            <dd className="break-all">{event.writeTxid ?? '—'}</dd>

            <dt className="text-muted-foreground">created_at</dt>
            <dd className="break-all">{event.createdAt}</dd>

            <dt className="text-muted-foreground">payload</dt>
            <dd className="break-all">
              {Object.keys(event.payload).length === 0
                ? '{}'
                : Object.entries(event.payload).map(([key, value]) => (
                    <span key={key} className="block">
                      {key}: {typeof value === 'string' ? value : JSON.stringify(value)}
                    </span>
                  ))}
            </dd>
          </dl>
        </div>
      </div>
    </details>
  );
}
