import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AvailableTransition, OrderEvent } from './order-api';
import { eventLabelTh, ORDER_EVENT_TYPES } from './order-language';
import { OrderTimeline } from './order-spine';
import {
  GAP_FLOOR_MS,
  MIN_HIDDEN,
  RECENT_COUNT,
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
 * The spine's decisions, proved without a browser.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `apps/dashboard`'s vitest is `environment: 'node'` with no jsdom, no `@testing-library` and no
 * `.test.tsx` collection — so this file is `.ts`, and the component is reached the way
 * `authority-limits.test.ts` reaches its panel: `renderToStaticMarkup`, which is enough because
 * `OrderTimeline` takes everything it renders as a prop.
 *
 * ⚠️ One of the assertions below covers a branch **no fixture in the dev database can reach** — a
 * payload key this build has no label for, which by definition arrives from a *newer* API. That is
 * the reason the component is rendered here at all rather than left to the screenshots.
 *
 * Everything a screenshot can show is left to the screenshots.
 */

/* Real values off the dev database — WW-1045, whose gaps are the case the design was drawn from. */
const HASH = '02d7c770069470eadb4ebc106bfe9e47705e66b74bfb4894d63ce8ea7b0f4038';
const SLIP = '14cea633-85b1-43a6-b211-4cdcadadf024';

const event = (over: Partial<OrderEvent> = {}): OrderEvent => ({
  id: '11111111-1111-4111-8111-111111111111',
  seq: 1,
  eventType: 'created',
  fromStatus: null,
  toStatus: 'draft',
  actorKind: 'customer',
  actorUserId: '22222222-2222-4222-8222-222222222222',
  payload: {},
  writeTxid: '2981065',
  createdAt: '2026-08-13T08:21:17.028Z',
  ...over,
});

/* ------------------------------------------------------------------ *
 * The gap — the one thing a timeline knows that a list does not
 * ------------------------------------------------------------------ */

describe('⭐ the elapsed time between two events', () => {
  it('prints the six and a half hours the customer took to pay', () => {
    /*
     * WW-1045 seq 2 → seq 3, to the millisecond as stored: 06:34:34.063. This is the gap the
     * whole feature exists for — before it, a reader subtracted two timestamps in their head.
     */
    expect(gapLabelTh('2026-08-13T08:21:17.071Z', '2026-08-13T14:55:51.135Z')).toBe(
      '6 ชม. 34 นาที',
    );
  });

  it('⚠️ says nothing about the three steps one person clicked through in a minute', () => {
    /* WW-1045 seq 3 → 4 → 5: 32.1s and 21.7s. Labelling these is noise in the column that
     * exists to make waiting visible, and the minute-precision clock on the row cannot even
     * distinguish them. */
    expect(gapLabelTh('2026-08-13T14:55:51.135Z', '2026-08-13T14:56:23.302Z')).toBeNull();
    expect(gapLabelTh('2026-08-13T14:56:23.302Z', '2026-08-13T14:56:45.087Z')).toBeNull();
  });

  it('⚠️ suppresses at exactly the floor and prints one millisecond later', () => {
    /*
     * The boundary, both sides of it. `GAP_FLOOR_MS` is two minutes: a `<` that was a `<=`, or a
     * floor of 60_000, would change which of these two lines holds.
     */
    const base = Date.parse('2026-08-13T00:00:00.000Z');
    const after = (ms: number) => new Date(base + ms).toISOString();

    expect(GAP_FLOOR_MS).toBe(120_000);
    expect(gapLabelTh(after(0), after(GAP_FLOOR_MS - 1))).toBeNull();
    expect(gapLabelTh(after(0), after(GAP_FLOOR_MS))).toBe('2 นาที');
  });

  it('⚠️ truncates and never rounds up past a unit the visible clock contradicts', () => {
    const base = Date.parse('2026-08-13T00:00:00.000Z');
    const after = (ms: number) => new Date(base + ms).toISOString();

    /* 59m59s is not "1 ชม." — the two timestamps either side of the label are on screen. */
    expect(gapLabelTh(after(0), after(59 * 60_000 + 59_000))).toBe('59 นาที');
    expect(gapLabelTh(after(0), after(60 * 60_000))).toBe('1 ชม.');
    /* An exact hour drops the minutes rather than printing "1 ชม. 0 นาที". */
    expect(gapLabelTh(after(0), after(3 * 60 * 60_000))).toBe('3 ชม.');
  });

  it('carries hours alongside days up to a week, then stops', () => {
    const base = Date.parse('2026-08-13T00:00:00.000Z');
    const hours = (n: number) => new Date(base + n * 3_600_000).toISOString();

    expect(gapLabelTh(hours(0), hours(24))).toBe('1 วัน');
    expect(gapLabelTh(hours(0), hours(53))).toBe('2 วัน 5 ชม.');
    expect(gapLabelTh(hours(0), hours(6 * 24 + 23))).toBe('6 วัน 23 ชม.');
    /* At a week the hours stop earning their place beside the days. */
    expect(gapLabelTh(hours(0), hours(7 * 24))).toBe('7 วัน');
    expect(gapLabelTh(hours(0), hours(7 * 24 + 5))).toBe('7 วัน');
    /* A three-week production step — the case that must never become a rail height. */
    expect(gapLabelTh(hours(0), hours(21 * 24))).toBe('21 วัน');
  });

  it('⚠️ refuses a clock that went backwards rather than printing a negative duration', () => {
    /*
     * `seq` orders an append-only spine, not `created_at`, so this is a shape the data permits.
     * A negative gap is the absence of a duration, not a duration.
     */
    expect(gapLabelTh('2026-08-13T14:55:51.135Z', '2026-08-13T08:21:17.071Z')).toBeNull();
  });

  it('refuses an unparseable timestamp rather than printing NaN', () => {
    expect(gapLabelTh('not a date', '2026-08-13T08:21:17.071Z')).toBeNull();
    expect(gapLabelTh('2026-08-13T08:21:17.071Z', '')).toBeNull();
    expect(gapLabelTh('', '')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * The markers
 * ------------------------------------------------------------------ */

describe('markers encode gates by shape', () => {
  it('rings exactly the two irreversible points the transition table names', () => {
    expect(markerFor('submitted_for_payment')).toBe('gate');
    expect(markerFor('payment_confirmed')).toBe('gate');
    expect(gateNoteTh('submitted_for_payment')).toBe('ตรึงเอกสาร');
    expect(gateNoteTh('payment_confirmed')).toBe('เปิดประตูผลิต');
  });

  it('⚠️ leaves the terminal events as ordinary steps', () => {
    /*
     * The load-bearing half of the decision. `cancelled`, `superseded` and `delivered` are
     * terminal, which the *rail* already says by ending with no offered marker — ringing them
     * too would leave one shape meaning two things.
     */
    for (const type of ['cancelled', 'superseded', 'delivered']) {
      expect(markerFor(type), `${type} should not be a gate`).toBe('step');
      expect(gateNoteTh(type)).toBeNull();
    }
  });

  it('treats an event type from a newer API as a step, because something did happen', () => {
    expect(markerFor('teleported')).toBe('step');
    expect(gateNoteTh('teleported')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * The fold
 * ------------------------------------------------------------------ */

describe('⭐ how much of a long spine is shown at once', () => {
  it('⚠️ shows a whole ordinary history, and folds at eight', () => {
    /*
     * The boundary is the decision. Five events is an order that did everything normal, and the
     * control must not appear for it; a control that hid one or two rows would cost a click to
     * save two lines. `RECENT_COUNT + MIN_HIDDEN` is where it starts earning its keep.
     */
    expect(RECENT_COUNT).toBe(5);
    expect(MIN_HIDDEN).toBe(3);

    for (const total of [0, 1, 5, 6, 7]) {
      expect(hiddenCount(total), `${total} events should render whole`).toBe(0);
    }

    expect(hiddenCount(8)).toBe(3);
    expect(hiddenCount(9)).toBe(4);
    expect(hiddenCount(30)).toBe(25);
  });

  it('always leaves exactly the recent five visible once it folds', () => {
    for (const total of [8, 12, 30, 200]) {
      expect(total - hiddenCount(total)).toBe(RECENT_COUNT);
    }
  });
});

/* ------------------------------------------------------------------ *
 * ⭐ The payload, as Thai
 * ------------------------------------------------------------------ */

describe('⭐ a payload read as Thai sentences', () => {
  it('⚠️ reads satang as satang — ฿8,601.52 and not ฿860,152', () => {
    /*
     * The real `payment_confirmed` payload off WW-1045. Payload money is a bare digit string
     * with no `{unit,digits}` envelope, so the `_thb_minor` suffix is the entire contract, and
     * getting it wrong is a hundredfold error nobody catches by looking.
     */
    const lines = payloadLines({
      note_th: 'pppppp',
      slip_id: SLIP,
      slip_amount_thb_minor: '860152',
    });

    const amount = lines.find((line) => line.key === 'slip_amount_thb_minor');
    expect(amount?.labelTh).toBe('ยอดในสลิป');
    expect(amount?.valueText).toBe('฿8,601.52');
    expect(amount?.known).toBe(true);

    expect(lines.find((line) => line.key === 'note_th')?.valueText).toBe('pppppp');
    expect(lines.find((line) => line.key === 'slip_id')?.valueText).toBe('14cea633');
  });

  it('⭐ reads the balance a reminder recorded, and labels it as the moment it was true', () => {
    /*
     * `balance_reminded`'s whole content — the third key in `SATANG_READERS`, and the first one
     * on an event that moves no status.
     *
     * ⚠️ The label says **ณ ตอนแจ้ง**, and that is load-bearing rather than decorative: this
     * figure is what was owed when a member of staff pressed the button, and the ค้างชำระ on the
     * money card above the rail is what is owed now. They differ by every slip accepted in
     * between, and a reader who could not tell which was which would conclude one of the two
     * screens was wrong.
     *
     * ⚠️ It is a *bare digit string* like every other payload amount, so the `_thb_minor` suffix
     * is the entire contract and a hundredfold error is what a missing table entry looks like.
     */
    const line = payloadLines({ outstanding_thb_minor: '552960' })[0];

    expect(line?.labelTh).toBe('ยอดคงค้าง ณ ตอนแจ้ง');
    expect(line?.valueText).toBe('฿5,529.60');
    expect(line?.known).toBe(true);
  });

  it('⭐ reads the forgiven amount as money, and keeps it distinct from the reminder figure', () => {
    /*
     * 0051. Same trap as `outstanding_thb_minor` above and one step worse, because the two keys can
     * appear on the same order a few minutes apart: `balance_reminded` records what was still owed
     * when we asked, and `balance_written_off` records what the company then gave up. Sharing one
     * key would have been the cheap change and would have left a reader comparing two figures that
     * were never the same quantity.
     *
     * ⚠️ Absent from `SATANG_READERS`, a `_thb_minor` value renders as raw digits — "988680" on a
     * screen where every other number is money. That is the hundredfold error this asserts against.
     */
    const line = payloadLines({ written_off_thb_minor: '988680' })[0];

    expect(line?.labelTh).toBe('ยอดที่ตัดทิ้ง');
    expect(line?.valueText).toBe('฿9,886.80');
    expect(line?.known).toBe(true);
  });

  it('shortens a hash to something recognisable rather than pretending it is readable', () => {
    const lines = payloadLines({ line_count: 1, document_hash: HASH });

    expect(lines.find((line) => line.key === 'document_hash')?.valueText).toBe('02d7c770…f4038');
    expect(lines.find((line) => line.key === 'line_count')?.valueText).toBe('1 รายการ');
  });

  it('keeps the sign on what the company absorbed, and prints zero plainly', () => {
    expect(payloadLines({ absorbed_delta_thb_minor: '0' })[0]?.valueText).toBe('฿0.00');
    expect(payloadLines({ absorbed_delta_thb_minor: '-123456' })[0]?.valueText).toBe('-฿1,234.56');
    expect(payloadLines({ absorbed_delta_thb_minor: '50000' })[0]?.valueText).toBe('+฿500.00');
  });

  it('⚠️⚠️ refuses to read a key that merely looks like money', () => {
    /*
     * THE `money()`-BY-`100n` FAMILY, HELD SHUT. That bug divided by a hardcoded hundred — right
     * for THB, wrong for VND and LAK — and it was possible because "this is satang" was inferred
     * at each call site instead of stated once.
     *
     * `SATANG_READERS` is now the only place that decides a payload number is money, and there is
     * deliberately **no suffix-matching fallback**. So a currency this formatter cannot render, and
     * a new THB key nobody has added to the table yet, both come out as raw digits with the key
     * beside them and `known: false` — which is a visible "add me" rather than a confident
     * hundredfold error. `baht()` is never reached.
     *
     * The compiler holds the other half: `SATANG_READERS` is `satisfies
     * Readonly<Record<`${string}_thb_minor`, …>>`, so a non-THB key cannot be added to it at all.
     */
    for (const key of [
      'refund_amount_vnd_minor',
      'deposit_amount_lak_minor',
      'amount',
      'total_minor',
      /* Even a well-formed THB key: recognised shape is not recognised meaning. */
      'forfeited_amount_thb_minor',
    ]) {
      const line = payloadLines({ [key]: '860152' })[0];

      expect(line?.key, `${key} was dropped`).toBe(key);
      expect(line?.known, `${key} was read as money`).toBe(false);
      expect(line?.valueText, `${key} went through a baht formatter`).toBe('860152');
      expect(line?.valueText).not.toContain('฿');
    }
  });

  it('⚠️ does not coerce a malformed amount into a plausible one', () => {
    /*
     * `Number('8,601.52')` and `Number('1e3')` both produce something; `readSatang` produces
     * nothing. A wrong amount that looks right is the failure mode worth spending a branch on.
     */
    for (const text of ['8,601.52', '1e3', '860152.00', ' 860152', '', '0x10']) {
      const line = payloadLines({ slip_amount_thb_minor: text })[0];
      expect(line?.known, `"${text}" was read as an amount`).toBe(false);
      expect(line?.valueText).toBe(text);
    }

    /* A JSON number where the wire promises a string is also not an amount. */
    expect(payloadLines({ slip_amount_thb_minor: 860152 })[0]?.known).toBe(false);
  });

  it('reads the two enums in the words this screen already uses elsewhere', () => {
    expect(payloadLines({ fault: 'company' })[0]?.valueText).toBe('บริษัท');
    expect(payloadLines({ fault: 'customer' })[0]?.valueText).toBe('ลูกค้า');
    /* The same three words as the resolution buttons on this very screen. */
    expect(payloadLines({ resolution: 'accepted' })[0]?.valueText).toBe('รับคำขอ');
    expect(payloadLines({ resolution: 'rejected' })[0]?.valueText).toBe('ปฏิเสธ');
    expect(payloadLines({ resolution: 'withdrawn' })[0]?.valueText).toBe('ลูกค้าถอนคำขอ');
  });

  it('⚠️⚠️ shows a key from a newer API rather than dropping it', () => {
    /*
     * THE RULE THIS FUNCTION EXISTS FOR. The API is versioned separately from this bundle, so a
     * new payload key is expected rather than hypothetical — and a lookup that returned only its
     * hits would delete it from an audit trail with nothing on screen to say anything was
     * missing.
     */
    const lines = payloadLines({ warranty_years: 5, note_th: 'ok' });

    const unknown = lines.find((line) => line.key === 'warranty_years');
    expect(unknown, 'an unrecognised key was dropped').toBeDefined();
    expect(unknown?.known).toBe(false);
    /* Labelled as itself — ugly, obviously wrong, reportable. Same rule as `statusLabel`. */
    expect(unknown?.labelTh).toBe('warranty_years');
    expect(unknown?.valueText).toBe('5');

    /* And a payload of nothing but unknown keys is still a list of lines. */
    expect(payloadLines({ a_new_thing: 'x', another: null })).toHaveLength(2);
  });

  it('⚠️ a recognised name is not a licence to claim the value was understood', () => {
    /*
     * `known: false` covers both "no label for this key" and "no reading of this value". The
     * label stays Thai, the value is printed raw, and the marker still appears — a malformed
     * amount must not render as an amount.
     */
    const bad = payloadLines({ slip_amount_thb_minor: 'eight thousand' })[0];
    expect(bad?.labelTh).toBe('ยอดในสลิป');
    expect(bad?.valueText).toBe('eight thousand');
    expect(bad?.known).toBe(false);

    /* A float where an integer count belongs, and an enum value nothing maps. */
    expect(payloadLines({ line_count: 1.5 })[0]?.known).toBe(false);
    expect(payloadLines({ fault: 'nobody' })[0]?.known).toBe(false);
    expect(payloadLines({ resolution: 'pending' })[0]?.known).toBe(false);
    /* Prose that is only whitespace is not prose. */
    expect(payloadLines({ note_th: '   ' })[0]?.known).toBe(false);
  });

  it('⚠️ orders by the table and not by arrival, so a field does not move between rows', () => {
    /*
     * `changedFields` in `authority-limits.ts` gives the reason: `Object.keys` order makes the
     * same field jump around the screen from one entry to the next. Prose leads because it is
     * what a person wrote and what another person is looking for.
     */
    const keys = payloadLines({
      document_hash: HASH,
      line_count: 2,
      note_th: 'ok',
      reason: 'ลูกค้าขอยกเลิก',
    }).map((line) => line.key);

    expect(keys).toStrictEqual(['reason', 'note_th', 'line_count', 'document_hash']);
  });

  it('unrecognised keys come after every recognised one', () => {
    const keys = payloadLines({ zzz_unknown: 1, note_th: 'ok' }).map((line) => line.key);
    expect(keys).toStrictEqual(['note_th', 'zzz_unknown']);
  });

  it('an empty payload is no lines at all', () => {
    expect(payloadLines({})).toStrictEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The sentence
 * ------------------------------------------------------------------ */

describe('who did it and where it came from', () => {
  it('has Thai for every event type the API declares', () => {
    /*
     * The same guard `statusLabel` gets, for the same reason: the old spine rendered the machine
     * string `submitted_for_payment` as its heading on a Thai-only screen.
     */
    /*
     * Seventeen since 0062 added `tax_document_issued` and `tax_document_voided`, the sixth and
     * seventh events that move no status.
     *
     * ⚠️ The count is here on purpose. This same enumeration is written out by hand in four
     * places — the guard function, a table CHECK, the drizzle schema and the contract — and this
     * assertion is what noticed the two new members had not reached the fifth.
     */
    expect(ORDER_EVENT_TYPES).toHaveLength(17);
    expect(ORDER_EVENT_TYPES).toContain('balance_reminded');
    expect(ORDER_EVENT_TYPES).toContain('balance_written_off');
    expect(ORDER_EVENT_TYPES).toContain('tax_document_issued');
    expect(ORDER_EVENT_TYPES).toContain('tax_document_voided');

    for (const type of ORDER_EVENT_TYPES) {
      const label = eventLabelTh(type);
      expect(label, `${type} is rendered as its own wire code`).not.toBe(type);
      expect(label, `${type} is labelled in ASCII`).toMatch(/[฀-๿]/);
    }
  });

  it('shows an unknown event type as itself rather than as nothing', () => {
    expect(eventLabelTh('teleported')).toBe('teleported');
  });

  it('⚠️ has no origin to print for the genesis row or for an event that moves nothing', () => {
    expect(fromLabelTh(null)).toBeNull();
    expect(fromLabelTh('awaiting_payment')).toBe('รอชำระเงิน');
  });

  it('names the actor by kind, in Thai', () => {
    expect(actorLabelTh('staff')).toBe('เจ้าหน้าที่');
    expect(actorLabelTh('customer')).toBe('ลูกค้า');
    expect(actorLabelTh('guest')).toBe('ผู้เยี่ยมชม');
    expect(actorLabelTh('system')).toBe('ระบบ');
    expect(actorLabelTh('robot')).toBe('robot');
  });
});

/* ------------------------------------------------------------------ *
 * The rendering — only what a screenshot cannot reach
 * ------------------------------------------------------------------ */

const transitions: readonly AvailableTransition[] = [
  {
    toStatus: 'delivered',
    eventType: 'delivered',
    payloadKind: 'none',
    descriptionTh: 'ติดตั้งและส่งมอบแล้ว',
  },
];

const render = (
  events: readonly OrderEvent[],
  available: readonly AvailableTransition[] = transitions,
): string =>
  renderToStaticMarkup(
    createElement(OrderTimeline, {
      events,
      availableTransitions: available,
      onMove: () => undefined,
    }),
  );

/**
 * The gap labels on the rail, in order.
 *
 * ⚠️ Extracted rather than substring-matched. `expect(markup).not.toContain('3 ชม.')` passes or
 * fails on whether `'13 ชม.'` happens to be elsewhere on the rail, which made an earlier version of
 * the fold test fail against output that was correct. `col-start-2 text-xs` is the gap label's own
 * class pair and nothing else in the card carries it.
 */
const gapLabels = (markup: string): readonly string[] =>
  [...markup.matchAll(/col-start-2 text-xs">([^<]*)</g)].map((match) => match[1] ?? '');

describe('the rail', () => {
  it('⚠️ renders an unknown payload key with its visible fallback', () => {
    const markup = render([event({ payload: { warranty_years: 5 } })]);

    expect(markup).toContain('warranty_years');
    expect(markup).toContain('แดชบอร์ดรุ่นนี้ยังไม่รู้จักค่านี้');
  });

  it('offers the fold at eight events and not at seven', () => {
    const spine = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        event({ id: `e${index}`, seq: index + 1, writeTxid: `${1000 + index}` }),
      );

    expect(render(spine(7))).not.toContain('รายการก่อนหน้า');
    expect(render(spine(8))).toContain('ดูอีก 3 รายการก่อนหน้า');
  });

  it('⚠️ prints no gap above the first visible row, and every gap below it', () => {
    /*
     * A gap label sits *between* two rows on screen. Above the first visible row there is nothing
     * to sit between, so a label there would be timing the fold rather than the order — and with
     * three rows hidden it would attribute the seq 3 → 4 wait to a boundary the reader cannot see
     * either side of.
     *
     * Gaps in hours: 1→2 = 4, 2→3 = 6, 3→4 = 5, 4→5 = 7, 5→6 = 11, 6→7 = 19, 7→8 = 23. Chosen so
     * that no label is a substring of another — `'3 ชม.'` inside `'13 ชม.'` made an earlier version
     * of this test fail against correct output, which is why it now compares the extracted list
     * exactly rather than asking `toContain`.
     */
    const offsets = [0, 4, 10, 15, 22, 33, 52, 75];
    const spine = offsets.map((hours, index) =>
      event({
        id: `e${index}`,
        seq: index + 1,
        writeTxid: `${1000 + index}`,
        createdAt: new Date(
          Date.parse('2026-08-13T00:00:00.000Z') + hours * 3_600_000,
        ).toISOString(),
      }),
    );

    const folded = render(spine);
    expect(folded).toContain('ดูอีก 3 รายการก่อนหน้า');

    /* Exactly the four gaps between the five visible rows — seq 3 → 4's five hours is not one. */
    expect(gapLabels(folded)).toStrictEqual(['7 ชม.', '11 ชม.', '19 ชม.', '23 ชม.']);

    /* Expanded, every gap is on the rail, still one fewer than the rows. */
    expect(gapLabels(render(spine.slice(0, 7)))).toStrictEqual([
      '4 ชม.',
      '6 ชม.',
      '5 ชม.',
      '7 ชม.',
      '11 ชม.',
      '19 ชม.',
    ]);
  });

  it('⭐ puts the transition buttons on the rail, and says so when there are none', () => {
    /* The merge is the design: the buttons are the terminus of the spine, not a separate card. */
    const withMoves = render([event()]);
    expect(withMoves).toContain('ติดตั้งและส่งมอบแล้ว');
    expect(withMoves).toContain('ทำต่อได้จากที่นี่');

    const terminal = render([event()], []);
    expect(terminal).toContain('เป็นสถานะปลายทาง');
    expect(terminal).not.toContain('ทำต่อได้จากที่นี่');
  });

  it('⚠️ still refuses to offer submit, with the reason', () => {
    /* The one transition this screen must not render a button for. Merging the cards must not
     * have quietly turned the refusal into a button. */
    const markup = render([event()], [
      {
        toStatus: 'awaiting_payment',
        eventType: 'submitted_for_payment',
        payloadKind: 'submit',
        descriptionTh: 'ลูกค้ายืนยันใบเสนอราคา',
      },
    ]);

    expect(markup).toContain('ลูกค้าเป็นคนส่งออเดอร์เอง');
    expect(markup).not.toContain('<button');
  });

  it('⚠️ paints: every colour class is a token that both themes define', () => {
    /*
     * A class Tailwind never saw written in source emits no CSS and the element silently
     * inherits — which looks like a design choice. This asserts the literal strings reached the
     * markup, and that they are `--foreground`/`--background`/`--border` tokens, each of which
     * the `.dark` block in globals.css redefines, rather than a stock palette colour that would
     * only be defined once.
     */
    const markup = render([
      event({ id: 'a', seq: 1 }),
      event({
        id: 'b',
        seq: 2,
        eventType: 'submitted_for_payment',
        fromStatus: 'draft',
        toStatus: 'awaiting_payment',
        writeTxid: '2981066',
        createdAt: '2026-08-13T14:55:51.135Z',
      }),
    ]);

    expect(markup).toContain('bg-foreground size-2.5 rounded-full');
    /*
     * ⚠️ `bg-background`, and this assertion is the reason to keep reading.
     *
     * The two hollow markers are filled so that they break the rail behind them — a ring has to
     * read as a ring, not as a line passing through a circle. The fill must therefore match
     * **whatever is actually behind the rail**, and that changed when the `Card` around the spine
     * was removed: it used to be `--card`, and on the page ground it is `--background`.
     *
     * In the light theme both tokens are `oklch(1 0 0)`, so the wrong one of the two looks
     * perfect. In dark, `--card` is `oklch(0.205 0 0)` on a `--background` of `oklch(0.145 0 0)`
     * — three lighter-grey discs on a darker page. This test held the old string and failed the
     * moment the Card came off, which is what caught it; if a future change puts the rail back
     * inside a surface of its own, this line has to move with it.
     */
    expect(markup).toContain('border-foreground bg-background size-3.5 rounded-full border-2');
    expect(markup).toContain('border-muted-foreground bg-background size-3.5 rounded-full');
    expect(markup).toContain('bg-border absolute');
    /* And the gap label between the two, on the rail. */
    expect(markup).toContain('6 ชม. 34 นาที');
    expect(markup).toContain('border-l border-dashed');
  });

  it('the disclosure is a real control with a visible focus ring', () => {
    /*
     * A native `<details>`/`<summary>`: focusable, Enter *and* Space, state exposed without
     * JavaScript. And the focus indicator is a solid outline in `--ring` — globals.css records
     * that shadcn's `ring-ring/50` halo cannot reach 3:1 at any lightness.
     */
    const markup = render([event({ payload: { note_th: 'ok' } })]);

    expect(markup).toContain('<details');
    expect(markup).toContain('<summary');
    expect(markup).toContain('focus-visible:outline-ring');
    /* The one animation in the card, dropped under prefers-reduced-motion. */
    expect(markup).toContain('motion-reduce:transition-none');
  });

  it('⚠️ shows the record: the raw columns, including the txid the wire never used to carry', () => {
    const markup = render([
      event({
        seq: 4,
        eventType: 'production_started',
        fromStatus: 'production_confirmed',
        toStatus: 'in_production',
        actorKind: 'staff',
        actorUserId: '99999999-9999-4999-8999-999999999999',
        writeTxid: '3034438',
      }),
    ]);

    expect(markup).toContain('write_txid');
    expect(markup).toContain('3034438');
    /* The full uuid in the record, where the reading shows only the kind. */
    expect(markup).toContain('99999999-9999-4999-8999-999999999999');
    expect(markup).toContain('production_confirmed');
    /* The precise stored instant, not the minute-precision reading. */
    expect(markup).toContain('2026-08-13T08:21:17.028Z');
  });

  it('an order with no events still renders its actions', () => {
    const markup = render([]);
    expect(markup).toContain('ยังไม่มีเหตุการณ์');
    expect(markup).toContain('ติดตั้งและส่งมอบแล้ว');
  });
});
