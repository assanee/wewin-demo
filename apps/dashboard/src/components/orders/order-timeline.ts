import { baht, signedBaht } from '@/components/quotes/amounts';

import { statusLabel, type OrderStatus } from './order-language';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ What the spine knows that a list of rows does not.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── ⚠️⭐ THE LINE THIS WHOLE FILE IS ORGANISED AROUND ────────────────────────
 *
 * There are **two readings of one row**, and they have different obligations.
 *
 *     the reading    what happened, in Thai, at a glance. An *interpretation*. It is expected
 *                    to get better — a clumsy sentence here should be fixable next week and
 *                    the fix should reach every row ever written, including rows written
 *                    years ago.
 *
 *     the record     what was stored: `seq`, the raw `event_type`, `from_status` → `to_status`,
 *                    `actor_kind` and the full actor uuid, `write_txid`, the precise
 *                    `created_at`, and the payload key by key. The **citable** thing. It must
 *                    not change, and nothing here can change it, because nothing here writes.
 *
 * ⚠️ **The rendered sentence is therefore never stored alongside the event, and must not be.**
 * The temptation is obvious — freeze the wording and a citation can never drift. It is the
 * wrong trade twice over. First, it would mean a better sentence could never reach an old row:
 * plan 10.6's rule is that a *document* which reprints differently is one nobody can cite, and
 * a document is a thing with a revision and a hash; a screen's phrasing is not. Second, it is
 * unnecessary, because the payload underneath is already frozen and already inspectable — which
 * is what citation actually needs. Same reasoning as keeping `entered_value_text` verbatim in
 * the discount work: store the input, derive the presentation, never store the presentation.
 *
 * So: every function in this file is a *derivation*, total, and safe to change. The record layer
 * is a rendering of stored bytes and adds nothing to them.
 *
 * ── What is decided here ─────────────────────────────────────────────────────
 *
 * Four decisions, none of them about layout, all of them previously either absent or done in
 * the reader's head:
 *
 *   1. **The gap.** How long the order sat between two events. Two adjacent rows of the old
 *      `<ol>` carried two timestamps and left the subtraction to whoever was looking — and the
 *      subtraction is the story. In the history this file was written against, seq 2→3 is six
 *      and a half hours (how long the customer took to pay) and 3→4→5 is under a minute (one
 *      staff member clicking through three steps in one sitting). A screen that prints both
 *      pairs the same way has hidden the only fact that distinguishes them.
 *   2. **The payload, as sentences.** `{"slip_amount_thb_minor":"860152"}` in a `<pre>` is the
 *      system talking to itself: satang, and a reader who divides by 100 by hand.
 *   3. **What was atomic.** `write_txid` is the only column that answers it; see
 *      `groupByTransaction`, and read its warning before believing the grouping does anything
 *      today.
 *   4. **How much of a long spine to show at once**, so the transition buttons at the end of
 *      the rail are not thirty rows below the fold.
 *
 * No React here, for the reason every `*-fields.ts` in `components/organisation` gives:
 * `apps/dashboard`'s vitest is `environment: 'node'` with no jsdom and no `.test.tsx`
 * collection, so anything that decides what a value *means* has to live in a `.ts` module or it
 * cannot be proved at all. The component is left with nothing to get wrong but layout.
 */

/* ------------------------------------------------------------------ *
 * The gap
 * ------------------------------------------------------------------ */

/**
 * ⚠️ Below this, no label at all — and the number is a judgement, so it is written down.
 *
 * **Two minutes.** Under it, the two events were one person's consecutive clicks rather than a
 * wait, and "32 วินาที" on the rail is noise in the one column that exists to make waits
 * visible. The displayed timestamps are minute-precision (`timeStyle: 'short'`), so a gap this
 * small is already indistinguishable there — printing it would be the rail claiming a precision
 * the rest of the row does not have.
 *
 * It is a floor on the *label*, never on the row: every event still gets its marker, its
 * timestamp and its `seq`. Nothing is hidden by this, only left unannotated.
 */
export const GAP_FLOOR_MS = 120_000;

const MINUTE_MS = 60_000;

/**
 * How long the order sat between two events, in Thai — or `null` when saying so would mislead.
 *
 * ⚠️ **Label only. There is deliberately no proportional-height counterpart to this function**,
 * and no caller may derive one from it. A production step is routinely three weeks and an
 * installation slot two months out; a rail whose segments scaled with elapsed time would push
 * the transition buttons — the reason a staff member opened the screen — kilometres below the
 * fold, and a log scale that fixed the geometry would be a chart nobody can read a duration off.
 *
 * ⚠️ **Truncated, never rounded.** 59 minutes 59 seconds is `59 นาที` and not `1 ชม.`: the two
 * timestamps either side of the label are on screen, and a label that rounds *up* past an hour
 * boundary the visible clock times contradict is a label the reader learns to distrust.
 *
 * ⚠️ **`null` when `later` precedes `earlier`.** `seq` is the order of the audit trail, not
 * `created_at`, so a clock that went backwards between two rows is possible and is not a
 * negative duration — it is an absence of one. Same for an unparseable timestamp: this
 * returns nothing rather than `NaN นาที`.
 *
 * Units stop at วัน. No สัปดาห์, no เดือน — lead times in this business are quoted in days
 * ("ผลิต 21 วัน" on the quotation), so `21 วัน` is the figure a reader compares against a
 * contract, and `3 สัปดาห์` would make them convert it back.
 */
export function gapLabelTh(earlierIso: string, laterIso: string): string | null {
  const from = Date.parse(earlierIso);
  const to = Date.parse(laterIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;

  const elapsed = to - from;
  if (elapsed < GAP_FLOOR_MS) return null;

  const minutes = Math.floor(elapsed / MINUTE_MS);
  if (minutes < 60) return `${minutes} นาที`;

  const hours = Math.floor(minutes / 60);
  const minutesOver = minutes % 60;
  if (hours < 24) {
    return minutesOver === 0 ? `${hours} ชม.` : `${hours} ชม. ${minutesOver} นาที`;
  }

  const days = Math.floor(hours / 24);
  const hoursOver = hours % 24;
  if (days < 7) return hoursOver === 0 ? `${days} วัน` : `${days} วัน ${hoursOver} ชม.`;

  return `${days} วัน`;
}

/* ------------------------------------------------------------------ *
 * The markers
 * ------------------------------------------------------------------ */

/**
 * Three shapes, and no fourth.
 *
 * `globals.css` caps the lime accent at two places per screen on purpose, so this encodes with
 * shape rather than colour — which is the better encoding anyway, because there is a true
 * three-way distinction here and there is no true ranking of event types by hue.
 *
 *   `step`    a transition that happened, and could in principle be walked back
 *   `gate`    a transition past which the order cannot return — see `GATE_EVENTS`
 *   `offered` the row that does not exist yet: the terminus where the buttons live
 */
export type MarkerKind = 'step' | 'gate' | 'offered';

/**
 * ⚠️ Two events, and the transition table names both of them itself.
 *
 * `order_status_transitions.description_th` calls `draft → awaiting_payment`
 * *"จุดที่ตรึงเอกสาร"* and `awaiting_payment → production_confirmed` *"จุด freeze"*. Those are
 * the two irreversible points in the lifecycle: the first pins the quotation revision a customer
 * agreed to, the second pins the deposit and opens the door to aluminium being cut. Everything
 * either side of them is a state an order can leave and re-enter — `redesign` and
 * `production_confirmed` are a genuine cycle in that table.
 *
 * ⚠️ **`cancelled`, `superseded` and `delivered` are deliberately *not* rings.** They are
 * terminal, which is a different fact and one this screen already states in a way no marker
 * could improve on: a terminal order has no available transitions, so the rail simply ends —
 * there is no `offered` marker and the card says "เป็นสถานะปลายทาง". Ringing them too would
 * spend the shape vocabulary on a distinction that is already carried, and leave "irreversible"
 * meaning two things.
 *
 * An event type this build has never heard of is a `step`: something happened, and a filled dot
 * is the true statement about it. Compare `statusLabel`, which falls back to the raw code rather
 * than to nothing, for the same reason — the API is versioned separately from this bundle.
 */
const GATE_EVENTS: ReadonlySet<string> = new Set(['submitted_for_payment', 'payment_confirmed']);

export const markerFor = (eventType: string): Exclude<MarkerKind, 'offered'> =>
  GATE_EVENTS.has(eventType) ? 'gate' : 'step';

/** The one-word note beside a gate's status label, or `null` for an ordinary step. */
const GATE_NOTE_TH: Readonly<Record<string, string>> = {
  submitted_for_payment: 'ตรึงเอกสาร',
  payment_confirmed: 'เปิดประตูผลิต',
};

export const gateNoteTh = (eventType: string): string | null => GATE_NOTE_TH[eventType] ?? null;

/* ------------------------------------------------------------------ *
 * How much of a long spine to show
 * ------------------------------------------------------------------ */

/**
 * How many recent events stay visible when a spine is folded.
 *
 * **Five.** An order that has done everything normal and nothing unusual is exactly five events
 * — created, submitted, paid, production started, installation scheduled — so the ordinary case
 * shows its whole life with no control in it at all. Past that, five is enough for the shape of
 * "what has happened lately" while keeping the terminus and its buttons on the first screen.
 */
export const RECENT_COUNT = 5;

/**
 * ⚠️ A fold that hides fewer than this many rows is not offered.
 *
 * **Three.** A control that costs a click and a decision in order to save two lines of scroll is
 * a worse trade than the two lines, and it also *removes* information from the default view to
 * buy nothing. So a six- or seven-event history renders whole, and the control appears at eight.
 */
export const MIN_HIDDEN = 3;

/**
 * How many of the oldest events are folded away, given the total. `0` means "render all of it,
 * and show no control" — which is the answer for every history short enough that folding would
 * cost more than it saves.
 *
 * The *oldest* are the ones folded: the buttons live at the newest end of the rail, and a person
 * who opened an order to move it is reading backwards from there.
 */
export function hiddenCount(total: number): number {
  const surplus = total - RECENT_COUNT;
  return surplus >= MIN_HIDDEN ? surplus : 0;
}

/* ------------------------------------------------------------------ *
 * What was atomic
 * ------------------------------------------------------------------ */

export interface TransactionGroup<T> {
  /** `null` when the server withheld it — see below, this never groups. */
  readonly writeTxid: string | null;
  readonly events: readonly T[];
}

/**
 * Fold **adjacent** events that share a `write_txid` into one moment.
 *
 * Two rows written by one transaction are one act, and presenting them as two steps a person
 * took is untrue. Nothing else on the row can tell: `created_at` defaults to `now()`, which in
 * Postgres is the *transaction's start*, so rows written together carry an identical instant —
 * and the screen's `timeStyle: 'short'` drops seconds, so rows written 22 seconds apart in
 * separate transactions also print the same minute. Neither the clock nor its rendering can
 * distinguish the two cases. This can.
 *
 * ⚠️ **ADJACENCY IS PART OF THE RULE, not an optimisation.** Grouping by txid through a `Map`
 * would let two non-neighbouring rows collapse together and silently reorder an append-only
 * spine. `seq` is the ordering authority; this function may merge neighbours and may never move
 * anything.
 *
 * ⚠️ **`null` never groups with anything, including another `null`.** `encodeEvent` sends
 * `writeTxid: null` to a customer audience, so on a customer's spine *every* row is null — and a
 * rule that folded equal values would collapse an entire order's history into a single moment
 * claiming it was one transaction. `null` is "the server did not say", which is the opposite of
 * "the same as its neighbour".
 *
 * ⚠️⚠️ **NO API PATH PRODUCES A GROUP LARGER THAN ONE TODAY, and this was checked rather than
 * assumed.** There are two inserts into `order_events` (`order.repository.ts` `createDraft` and
 * `appendEvent`) and five callers, and every one of them writes exactly one event per order per
 * transaction: `record()` is one `appendEvent` plus one `moveStatus`, and each HTTP transition is
 * its own transaction. The one request that writes two events — `supersede` — writes `created`
 * to the **successor** order and `superseded` to the **predecessor**, so they share a txid across
 * two different `order_id`s and this function, which only ever sees one order's spine, correctly
 * groups neither.
 *
 * It is built anyway, because the grouping is what makes the `writeTxid` field mean something the
 * moment a batch path exists, and because a rail that would present a future atomic write as
 * three separate human steps is a wrong screen waiting for a backend change. The multi-event
 * branch is proved by `renderToStaticMarkup` in the tests rather than by a browser, since no
 * fixture in the dev database can reach it.
 */
export function groupByTransaction<T extends { readonly writeTxid: string | null }>(
  events: readonly T[],
): readonly TransactionGroup<T>[] {
  const groups: { writeTxid: string | null; events: T[] }[] = [];

  for (const event of events) {
    const open = groups.at(-1);

    if (open !== undefined && event.writeTxid !== null && open.writeTxid === event.writeTxid) {
      open.events.push(event);
      continue;
    }

    groups.push({ writeTxid: event.writeTxid, events: [event] });
  }

  return groups;
}

/* ------------------------------------------------------------------ *
 * The transition, as a sentence
 * ------------------------------------------------------------------ */

/**
 * Where the order came from, when it came from anywhere.
 *
 * ⚠️ `from_status` has been decoded in `order-api.ts` since that file was written and the old
 * spine never rendered it, which is why every row said "this became X" and none said "from
 * where". It is `null` in two honest cases and the caller must not print "จาก null" for either:
 * `seq = 1` (`order_events_status_pair_shape` permits a null `from_status` only there) and the
 * two events that move nothing at all (`change_requested`, `change_resolved`, whose
 * `to_status` is null too).
 */
export const fromLabelTh = (fromStatus: OrderStatus | null): string | null =>
  fromStatus === null ? null : statusLabel(fromStatus);

const ACTOR_TH: Readonly<Record<string, string>> = {
  customer: 'ลูกค้า',
  guest: 'ผู้เยี่ยมชม',
  staff: 'เจ้าหน้าที่',
  system: 'ระบบ',
};

/**
 * Who did it, **by kind**.
 *
 * ⚠️ A kind and not a name, and that is the endpoint's limit rather than this screen's choice.
 * `GET /orders/:id/events` answers with `actorUserId` straight off the row and joins nothing to
 * `users`; resolving a uuid to a person is a real feature with its own review. Identical position
 * to `authority-limit-history.tsx` and `bank-account-history.tsx`, which say so about the same
 * gap. The reading layer therefore shows the kind, and the record layer shows the full uuid — the
 * honest rendering of what arrived.
 */
export const actorLabelTh = (actorKind: string): string => ACTOR_TH[actorKind] ?? actorKind;

/* ------------------------------------------------------------------ *
 * ⭐ The payload, as Thai
 * ------------------------------------------------------------------ */

/**
 * One row of a payload, read.
 *
 * `known: false` is the visible fallback and the whole reason this interface has the field: see
 * `payloadLines`.
 */
export interface PayloadLine {
  /** The stored key, `snake_case`, verbatim. The record layer prints this. */
  readonly key: string;
  readonly labelTh: string;
  readonly valueText: string;
  /** Whether this build has both a label for the key and a reading of its value. */
  readonly known: boolean;
}

/**
 * ⚠️ `snake_case`, because that is what arrives — and the envelope around it is `camelCase`.
 *
 * `encodeEvent` splices the stored jsonb into the response untouched and there is no
 * case-converting middleware anywhere in the API, so one response carries both conventions:
 * `{ "eventType": "payment_confirmed", "payload": { "slip_amount_thb_minor": "860152" } }`.
 * A table written in `camelCase` here would match nothing and every line would fall through to
 * the unknown-key branch — quietly, and looking like the API had changed.
 */
const PAYLOAD_ORDER = [
  /* Prose first: it is what a person wrote, and it is what another person is looking for. */
  'reason',
  'note_th',
  /* Money and the decisions attached to it. */
  'slip_amount_thb_minor',
  'absorbed_delta_thb_minor',
  'fault',
  'resolution',
  /* What was pinned. */
  'line_count',
  'contracted_revision',
  'approved_revision',
  /* Pointers at other rows — least interesting to read, most useful to quote. */
  'slip_id',
  'successor_order_id',
  'document_hash',
] as const;

const PAYLOAD_LABEL_TH: Readonly<Record<(typeof PAYLOAD_ORDER)[number], string>> = {
  reason: 'เหตุผล',
  note_th: 'หมายเหตุ',
  slip_amount_thb_minor: 'ยอดในสลิป',
  absorbed_delta_thb_minor: 'ส่วนต่างที่บริษัทรับไว้',
  fault: 'ผู้รับภาระ',
  resolution: 'ผลการตัดสิน',
  line_count: 'จำนวนรายการ',
  contracted_revision: 'ฉบับตามสัญญา',
  approved_revision: 'ฉบับที่อนุมัติ',
  slip_id: 'สลิป',
  successor_order_id: 'ออเดอร์ใบใหม่',
  document_hash: 'ลายนิ้วมือเอกสาร',
};

/**
 * ⚠️ Payload money is a **bare digit string**, not the `{unit,digits}` envelope.
 *
 * Every other amount on this API is a `MoneyWire` and `order-api.ts` checks its `unit` tag
 * before believing it, precisely because a rate rendered as a total is a number nobody catches
 * by looking. Event payloads predate that convention and bypass it: `slip_amount_thb_minor` is
 * `bigint.toString()`, and its unit is carried only by the `_thb_minor` in its name. So the
 * suffix is the contract, and reading one of these as anything but satang is the mistake to
 * avoid — `"860152"` is ฿8,601.52 and not ฿860,152.
 *
 * `null` on anything unparseable rather than a throw or a guess: a formatter that threw would
 * blank the whole card over one odd row, and the caller's fallback prints the raw value with the
 * key beside it, which is strictly more information than a wrong amount.
 */
const readSatang = (value: unknown): bigint | null => {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
};

const FAULT_TH: Readonly<Record<string, string>> = {
  customer: 'ลูกค้า',
  company: 'บริษัท',
};

/* Deliberately the words the resolution buttons on this same screen use. A person who clicked
 * "รับคำขอ" should read "รับคำขอ" in the history, not a synonym that makes them wonder. */
const RESOLUTION_TH: Readonly<Record<string, string>> = {
  accepted: 'รับคำขอ',
  rejected: 'ปฏิเสธ',
  withdrawn: 'ลูกค้าถอนคำขอ',
};

/** `02d7c770…f4038` — enough to recognise, not enough to pretend it is readable. */
const shortHash = (value: string): string =>
  value.length <= 20 ? value : `${value.slice(0, 8)}…${value.slice(-5)}`;

/**
 * The **reading** of one value: `null` means "this build cannot read it", never "it is empty".
 *
 * Every branch is defensive about the type because the payload is `Record<string, unknown>` all
 * the way from the jsonb column — the API validates keys on the way *in* against
 * `required_payload_keys` and validates nothing about them on the way out.
 */
function readValue(key: (typeof PAYLOAD_ORDER)[number], value: unknown): string | null {
  switch (key) {
    case 'reason':
    case 'note_th':
      return typeof value === 'string' && value.trim() !== '' ? value : null;

    case 'slip_amount_thb_minor': {
      const minor = readSatang(value);
      return minor === null ? null : baht(minor);
    }

    case 'absorbed_delta_thb_minor': {
      /* Signed, and the sign is the point: this is what the company gave away, and `0` is the
       * commonest and most reassuring answer. `signedBaht` prints `฿0` for zero rather than
       * `+฿0`, which is the reading somebody wants. */
      const minor = readSatang(value);
      return minor === null ? null : signedBaht(minor);
    }

    case 'fault':
      return typeof value === 'string' ? (FAULT_TH[value] ?? null) : null;

    case 'resolution':
      return typeof value === 'string' ? (RESOLUTION_TH[value] ?? null) : null;

    case 'line_count':
      return typeof value === 'number' && Number.isInteger(value) ? `${value} รายการ` : null;

    case 'contracted_revision':
    case 'approved_revision':
      return typeof value === 'number' && Number.isInteger(value) ? `ฉบับที่ ${value}` : null;

    case 'slip_id':
    case 'successor_order_id':
      /* A uuid truncated the way every other history on this dashboard truncates one. */
      return typeof value === 'string' && value !== '' ? value.slice(0, 8) : null;

    case 'document_hash':
      return typeof value === 'string' && value !== '' ? shortHash(value) : null;
  }
}

/** What a value that cannot be read looks like, so it is *shown* rather than dropped. */
const rawText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/**
 * ⭐ A payload as labelled Thai lines — **every stored key, always, with a visible fallback**.
 *
 * Same shape as `authority-limits.ts`'s `changedFields`, and the same reason for existing: raw
 * JSON in a `<pre>` is the system talking to itself. `{"slip_amount_thb_minor":"860152"}` asks
 * a person to know that the field is satang and then to divide by a hundred in their head.
 *
 * ⚠️⚠️ **AN UNKNOWN KEY IS RENDERED, NEVER SKIPPED.** This is the one rule the function exists
 * to enforce, and the failure it prevents is silent: the API is versioned separately from this
 * bundle, so a newer one adding a payload key is expected rather than hypothetical, and a table
 * lookup that returned only its hits would drop that key off the screen with nothing to indicate
 * anything was missing — on an audit trail, whose entire value is that it is complete. So an
 * unrecognised key comes back with `known: false`, its own `snake_case` name as its label, and
 * its value as raw text; the component gives that a visible marker. The precedents are
 * `statusLabel`, which renders an unknown status as its own code ("ugly, obviously wrong,
 * reportable" beats an empty cell), and `transitionForm`, which refuses an unknown `payloadKind`
 * out loud rather than guessing a body.
 *
 * A key that is *known* but whose value cannot be read is also `known: false` — the label is the
 * Thai one, but the value is printed raw. A recognised name is not a licence to claim the value
 * was understood.
 *
 * Ordered by `PAYLOAD_ORDER` and not by `Object.keys`, for the reason `changedFields` gives:
 * arrival order makes the same field jump around the screen from one entry to the next.
 * Unrecognised keys follow, in the order they arrived — there is no better order for a key
 * nothing is known about, and alphabetising would be inventing one.
 */
export function payloadLines(payload: Readonly<Record<string, unknown>>): readonly PayloadLine[] {
  const lines: PayloadLine[] = [];

  for (const key of PAYLOAD_ORDER) {
    if (!Object.hasOwn(payload, key)) continue;

    const value = payload[key];
    const read = readValue(key, value);

    lines.push({
      key,
      labelTh: PAYLOAD_LABEL_TH[key],
      valueText: read ?? rawText(value),
      known: read !== null,
    });
  }

  const recognised = new Set<string>(PAYLOAD_ORDER);
  for (const key of Object.keys(payload)) {
    if (recognised.has(key)) continue;

    lines.push({ key, labelTh: key, valueText: rawText(payload[key]), known: false });
  }

  return lines;
}
