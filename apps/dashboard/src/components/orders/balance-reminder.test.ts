import { describe, expect, it } from 'vitest';

import {
  BALANCE_REMINDER_COOLDOWN_HOURS,
  lastBalanceReminderAt,
  reminderAvailability,
  reminderButtonLabelTh,
  reminderOutcome,
} from './balance-reminder';

/**
 * ⭐ แจ้งเตือนยอดค้างชำระ, on the screen: when the button appears and what it says afterwards.
 *
 * ⚠️ A `.test.ts`, never a `.test.tsx`. This app's vitest is `environment: 'node'` and a `.tsx`
 * test is **silently never collected** — it does not fail, it does not run, and the suite still
 * prints a green tick. Every decision this feature makes on the client is therefore in the `.ts`
 * module beside this file, and the component is layout and a fetch.
 *
 * ── What is actually at risk ─────────────────────────────────────────────────
 *
 * Not the wording. Three things:
 *
 *   ⓵ **offering a button that can only answer 409** — a settled order, or one chased an hour
 *     ago. Wasted clicks are cheap; the second one also teaches somebody that the button is
 *     broken.
 *   ⓶ **hiding a button and saying nothing**, which reads as a permission problem or a bug. The
 *     two hidden states are deliberately different: nothing owed says nothing, chased-recently
 *     says when.
 *   ⓷ ⭐ **claiming a message went out when the outbox suppressed it.** A phone-only customer
 *     produces a `suppressed` row with `no_contact_channel`, which is correct and invisible —
 *     and a toast reading "ส่งแล้ว" over it costs a week of silence nobody explains.
 */

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-08-14T10:00:00.000Z');
const OWED = 552_960n;

const remindedAt = (iso: string) => ({ eventType: 'balance_reminded', createdAt: iso });

describe('when the reminder button is offered', () => {
  it('offers it on a live balance that has never been chased', () => {
    const availability = reminderAvailability({
      outstandingThbMinor: OWED,
      events: [{ eventType: 'submitted_for_payment', createdAt: NOW.toISOString() }],
      now: NOW,
    });

    expect(availability.kind).toBe('available');
    expect(availability.kind === 'available' && availability.outstandingThbMinor).toBe(OWED);
  });

  it('hides it, silently, when there is nothing owed', () => {
    /*
     * Three wires produce this and they are one sentence on the screen: no figure at all (a cart
     * or a cancelled order), ฿0.00 settled, and ฿0.00 because the balance was written off. A
     * disabled control under any of them invites somebody to work out what is wrong with an
     * order that has nothing wrong with it.
     */
    for (const outstanding of [null, 0n, -1n]) {
      expect(reminderAvailability({ outstandingThbMinor: outstanding, events: [], now: NOW }).kind).toBe(
        'nothingOwed',
      );
    }
  });

  it('⭐ withholds it inside the cooldown, and says when the next one may go', () => {
    /*
     * The state that has to carry a sentence. A missing button with no explanation reads as a
     * permission problem; "we asked them this morning, you may ask again tomorrow" is a fact
     * about the *customer* that the person looking at this screen needs either way.
     */
    const lastAt = new Date(NOW.getTime() - 2 * HOUR);
    const availability = reminderAvailability({
      outstandingThbMinor: OWED,
      events: [remindedAt(lastAt.toISOString())],
      now: NOW,
    });

    expect(availability.kind).toBe('remindedRecently');
    if (availability.kind !== 'remindedRecently') throw new Error('unreachable');
    expect(availability.lastAt.toISOString()).toBe(lastAt.toISOString());
    expect(availability.nextAllowedAt.getTime()).toBe(
      lastAt.getTime() + BALANCE_REMINDER_COOLDOWN_HOURS * HOUR,
    );
  });

  it('offers it again once the cooldown has passed', () => {
    /*
     * The other side of the boundary, and the reason it is asserted: a cooldown that never
     * expires is a feature that works once per order, and nothing on the screen would say so.
     */
    const lastAt = new Date(NOW.getTime() - (BALANCE_REMINDER_COOLDOWN_HOURS + 1) * HOUR);

    expect(
      reminderAvailability({
        outstandingThbMinor: OWED,
        events: [remindedAt(lastAt.toISOString())],
        now: NOW,
      }).kind,
    ).toBe('available');
  });

  it('measures from the most recent reminder, not the first', () => {
    /*
     * An order chased in March and again an hour ago must be blocked. Reading the first row —
     * or the first one the events array happens to contain — is the bug this catches, and the
     * API's own `max(created_at)` is the rule this mirrors.
     */
    const availability = reminderAvailability({
      outstandingThbMinor: OWED,
      events: [
        remindedAt(new Date(NOW.getTime() - 90 * 24 * HOUR).toISOString()),
        remindedAt(new Date(NOW.getTime() - 1 * HOUR).toISOString()),
      ],
      now: NOW,
    });

    expect(availability.kind).toBe('remindedRecently');
  });

  it('⚠️ treats a timestamp it cannot read as "never chased", not as a refusal', () => {
    /*
     * Fail *open* here, deliberately, and it is the only place in this feature that does. The
     * server refuses correctly whatever this screen decides, so an unreadable date must not
     * remove a control somebody is entitled to — the cost of being wrong is one 409 with a
     * sentence, where the cost the other way is a chase that never happens.
     */
    expect(lastBalanceReminderAt([remindedAt('not a date')])).toBeNull();
    expect(
      reminderAvailability({
        outstandingThbMinor: OWED,
        events: [remindedAt('not a date')],
        now: NOW,
      }).kind,
    ).toBe('available');
  });

  it('ignores every other kind of event on the spine', () => {
    expect(
      lastBalanceReminderAt([
        { eventType: 'payment_confirmed', createdAt: NOW.toISOString() },
        { eventType: 'change_requested', createdAt: NOW.toISOString() },
      ]),
    ).toBeNull();
  });
});

describe('⭐ what the toast says afterwards', () => {
  it('says คิว and not ส่งแล้ว when the message was queued', () => {
    /*
     * The outbox is asynchronous: the worker polls, renders and talks to an SMTP server after
     * this response was written. Claiming delivery here would be claiming something no part of
     * this request knows.
     */
    const outcome = reminderOutcome({ queued: 1, suppressedReason: null });

    expect(outcome.delivered).toBe(true);
    expect(outcome.titleTh).toContain('คิว');
    expect(outcome.titleTh).not.toContain('ส่งแล้ว');
  });

  it('⭐ does not claim a message went out when the fan-out suppressed it', () => {
    /*
     * A phone-only customer. The suppressed row is correct and invisible on every other screen
     * in this application, so this sentence is the only thing standing between a member of staff
     * and the belief that a chase is on its way to an address that does not exist.
     */
    const outcome = reminderOutcome({ queued: 0, suppressedReason: 'no_contact_channel' });

    expect(outcome.delivered).toBe(false);
    expect(outcome.titleTh).toContain('ยังไม่ได้ส่ง');
    expect(outcome.detailTh).toContain('อีเมล');
  });

  it('names an erased recipient as the different fact it is', () => {
    const outcome = reminderOutcome({ queued: 0, suppressedReason: 'recipient_erased' });

    expect(outcome.delivered).toBe(false);
    expect(outcome.detailTh).not.toBe(reminderOutcome({ queued: 0, suppressedReason: 'no_contact_channel' }).detailTh);
  });

  it('⚠️ reports a reason this build has never heard of, rather than swallowing it', () => {
    /*
     * `order_events_fan_out_notifications()` is plpgsql and a migration may add a reason without
     * this bundle being rebuilt. Same posture `payloadLines` takes for an unknown payload key:
     * show it, marked, because an audit surface that silently drops what it does not recognise
     * is worse than one that prints a machine word.
     */
    const outcome = reminderOutcome({ queued: 0, suppressedReason: 'line_not_linked' });

    expect(outcome.delivered).toBe(false);
    expect(outcome.detailTh).toContain('line_not_linked');
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ ⓸ THE BUTTON QUOTES THE FIGURE IT IS ABOUT TO SEND.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The control has no confirmation dialog, and the stated reason is that it *names the figure it
 * is about to quote* so the press is informed. It was naming a different one: `formatBaht`
 * rounds to the whole baht, so the button read ฿14,792 while the email it sends and the timeline
 * row it writes both say ฿14,791.68. A clerk reading the button aloud on the phone gave a number
 * that appears nowhere else — including in that customer's inbox.
 *
 * ⚠️ ฿14,791.68 is the review's own figure, kept, because it is the amount whose two spellings
 * differ: a test written against a round number would pass against either formatter.
 */
describe('⭐ the label on the button', () => {
  const OWED_EXACT = 1_479_168n; // ฿14,791.68

  it('⛔ states the satang, matching the email and the timeline rather than the money card', () => {
    /*
     * The mutation this exists to catch is one character wide — `formatBaht` for `baht` — and it
     * is invisible on every round number in every fixture. `not.toContain('฿14,792')` is the half
     * that fails when somebody rounds it back, because ฿14,792 is a figure no other surface in
     * this system ever prints for this order.
     */
    expect(reminderButtonLabelTh(OWED_EXACT)).toBe('แจ้งเตือนยอดค้างชำระ ฿14,791.68');
    expect(reminderButtonLabelTh(OWED_EXACT)).not.toContain('฿14,792');
  });

  it('says what the button does, not only what the number is', () => {
    /* The figure is an argument for pressing it; the verb is what makes it a control. */
    expect(reminderButtonLabelTh(OWED_EXACT)).toContain('แจ้งเตือนยอดค้างชำระ');
  });

  it('drops the satang when there are none, so a whole-baht balance reads as one', () => {
    /*
     * `baht` prints decimals only when they exist — ฿5,000 and not ฿5,000.00 — which is why the
     * exact formatter costs nothing on the orders where the rounded one was indistinguishable.
     */
    expect(reminderButtonLabelTh(500_000n)).toBe('แจ้งเตือนยอดค้างชำระ ฿5,000');
  });
});
