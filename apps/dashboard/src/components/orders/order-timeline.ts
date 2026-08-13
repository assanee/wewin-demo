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
 * Three decisions, none of them about layout, all of them previously either absent or done in
 * the reader's head:
 *
 *   1. **The gap.** How long the order sat between two events. Two adjacent rows of the old
 *      `<ol>` carried two timestamps and left the subtraction to whoever was looking — and the
 *      subtraction is the story. In the history this file was written against, seq 2→3 is six
 *      and a half hours (how long the customer took to pay) and 3→4→5 is under a minute (one
 *      staff member clicking through three steps in one sitting). A screen that prints both
 *      pairs the same way has hidden the only fact that distinguishes them.
 *   2. **The payload, as sentences.** `{"slip_amount_thb_minor":"860152"}` in a `<pre>` is the
 *      system talking to itself: satang, and a reader who divides by 100 by hand. Read
 *      `SATANG_READERS` before adding a key — deciding a payload number is money is done in
 *      exactly one place on purpose.
 *   3. **How much of a long spine to show at once**, so the transition buttons at the end of
 *      the rail are not thirty rows below the fold.
 *
 * A fourth — folding rows written by one transaction into one moment — was built and then removed.
 * See the block headed "One event per row" for the finding that settled it; `write_txid` itself
 * stays.
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
 * ⚠️ One event per row, and why there is no grouping here
 * ------------------------------------------------------------------ *
 *
 * There was a `groupByTransaction` in this file that folded adjacent events sharing a
 * `write_txid` into one "moment", on the reasoning that two rows written by one transaction are
 * one act and showing them as two steps a person took is untrue. **It was removed because nothing
 * produces the state it handled** — not because wanting it was wrong.
 *
 * The finding, so the next person to reach for it does not repeat the investigation:
 *
 *   **Every writer appends exactly one event per order per transaction.** There are two inserts
 *   into `order_events` (`order.repository.ts`'s `createDraft` and `appendEvent`) and five
 *   callers — `orders.service.ts` at `record()`, submit, `change_requested`, `change_resolved`,
 *   and `slips.service.ts`'s acceptance. `record()` is one `appendEvent` plus one `moveStatus`,
 *   and each HTTP transition runs in its own transaction.
 *
 *   **The one request that writes two events puts them on two different orders.** `supersede`
 *   writes `created` to the *successor* and `superseded` to the *predecessor*. They do share a
 *   txid — but `GET /orders/:id/events` returns one order's spine, so the two never appear in the
 *   same list and there is nothing to group.
 *
 * `redteam5-lifecycle`'s A9 asserts the consequence directly: every txid on a spine is distinct.
 * That assertion is the tripwire — if a batching path is ever added, it fails, and this comment is
 * what to read next.
 *
 * ⚠️ **The observation that originally motivated the grouping was a formatting artefact, and it is
 * worth naming so it is not re-derived.** WW-1045's seq 4 and 5 both display `21:56`, which looked
 * like two rows written in one transaction stamped with `now()` — the transaction's start time.
 * They are 22 seconds apart (`14:56:23.302Z` and `14:56:45.087Z`) with txids `3034438` and
 * `3034439`. They print alike because `at()` uses `timeStyle: 'short'`, which drops seconds.
 * `created_at DEFAULT now()` *is* transaction-start time; that is simply not what those two rows
 * were showing.
 *
 * `writeTxid` stays on the wire and in the record layer. It stopped being grouping input and is
 * what it always was on its own terms: which transaction wrote this row, which is exactly the fact
 * an audit layer wants to be able to cite.
 */

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
 * ⚠️⚠️⭐ THE ONE PLACE THAT DECIDES A PAYLOAD NUMBER IS MONEY, AND WHICH MONEY.
 *
 * Payload money is a **bare digit string**, not the `{unit,digits}` envelope. Every other amount
 * on this API is a `MoneyWire` whose `unit` tag `order-api.ts` checks before believing it,
 * precisely because a rate rendered as a total is a number nobody catches by looking. Event
 * payloads predate that convention and bypass it: `slip_amount_thb_minor` is `bigint.toString()`,
 * and its unit is carried **only by the `_thb_minor` in its name**.
 *
 * So the key name is the entire contract, and reading one wrong is a hundredfold error. This
 * repository has already shipped one of exactly that family: `money()` dividing by a hardcoded
 * `100n`, which was right for THB and wrong for VND and LAK. That bug was possible because the
 * "this is satang" inference sat at each call site instead of in one table.
 *
 * Hence this table, and two guarantees from it:
 *
 *   1. **The currency is checked by the compiler.** The `satisfies` clause types every key as
 *      `` `${string}_thb_minor` ``, so a key that does not say `_thb_minor` — a hypothetical
 *      `refund_amount_vnd_minor`, or a plain `amount` — **cannot be added to this table**. Verified
 *      by mutation: adding one is `TS2353`, not a code-review conversation. `baht()` is a THB-only
 *      formatter and this is what keeps it pointed only at THB.
 *   2. **Anything not in the table refuses.** There is deliberately no suffix-matching fallback:
 *      a key that merely *looks* like money is not read as money. It falls through to
 *      `payloadLines`' unknown branch, which prints the raw digits with the key beside them and
 *      marks it — strictly more information than a confidently wrong amount, and it makes a new
 *      money key from a newer API a visible "add me here" rather than a silent misreading.
 *
 * `absorbed_delta_thb_minor` gets `signedBaht` because its sign is the point — it is what the
 * company gave away — and `signedBaht` prints `฿0` rather than `+฿0` for the commonest answer.
 */
const SATANG_READERS = {
  slip_amount_thb_minor: baht,
  absorbed_delta_thb_minor: signedBaht,
} as const satisfies Readonly<Record<`${string}_thb_minor`, (minor: bigint) => string>>;

/**
 * Satang off the wire, or `null` when the text is not an integer.
 *
 * `null` rather than a throw or a coercion: a formatter that threw would blank the whole card over
 * one odd row, and `Number()`-style coercion would turn `"8,601.52"` or `"1e3"` into a plausible
 * wrong number. The caller's fallback prints the raw value with its key, which is honest.
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

    /* Both money keys go through `SATANG_READERS` and nothing else may. See its header. */
    case 'slip_amount_thb_minor':
    case 'absorbed_delta_thb_minor': {
      const minor = readSatang(value);
      return minor === null ? null : SATANG_READERS[key](minor);
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
