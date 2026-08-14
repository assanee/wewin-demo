import { baht } from '@/components/quotes/amounts';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ แจ้งเตือนยอดค้างชำระ — whether to offer the button, and what to say afterwards.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Five rounds made the balance payable, visible, recordable and forgivable. Nothing asked the
 * customer for it. This is the screen half of the ask: `POST /orders/:orderId/balance-reminders`
 * appends a `balance_reminded` row to the spine and the fan-out turns it into an email.
 *
 * ── ⚠️ WHO DECIDES WHEN — and it is not this file, and not a cron ────────────
 *
 * A person. Asked when the business collects the balance the owner answered *"แล้วแต่งาน
 * ไม่ตายตัว"*, and there is no due-date column anywhere in the schema for anything to be late
 * against. So the button sits beside ค้างชำระ on the order's money card, and the person who
 * knows what was agreed for that job presses it. Nothing here schedules anything.
 *
 * ── ⚠️ NEITHER OF THE TWO CHECKS BELOW IS A GUARD ────────────────────────────
 *
 * Same position `write-off-request.ts` states about its own comparison, and for the same
 * reason. The balance is a **snapshot** off the order read, and the last-reminded time is
 * whatever was in the spine when this page loaded; a slip accepted a second ago makes the first
 * stale and a colleague pressing the button in the next room makes the second stale. The server
 * refuses both cases in the transaction that holds the order's row lock, in Thai, and that
 * refusal is what the dialog shows.
 *
 * What these buy is a screen that does not offer a control which can only answer 409, and a
 * sentence explaining a control that is missing. Removing this file would change no invariant.
 *
 * No React here on purpose: `apps/dashboard`'s vitest is `environment: 'node'` and a `.test.tsx`
 * is **silently never collected**, so a decision left in the markup is a decision no test in
 * this repository can reach. Same reason `order-outstanding.ts` and `write-off-request.ts`
 * exist; the `.tsx` beside this file is layout, a fetch, and nothing else.
 */

/**
 * ⚠️ A MIRROR of the API's `BALANCE_REMINDER_COOLDOWN_HOURS_DEFAULT`, and it is a mirror in the
 * direction that fails safe.
 *
 * The API's copy is the one that decides; this one only decides whether a button is offered. If
 * they drift, the two failures are not symmetric and that is why the copy is acceptable here:
 * a value **too small** here offers a button that answers 409 with the server's own sentence,
 * which is a wasted click; a value **too large** hides a button somebody could have used, and
 * the screen says why and when. Neither can send a message the server would have refused, and
 * neither can suppress one it would have sent.
 *
 * Twenty-four hours is the API's reasoning, restated in one line: long enough that no accident
 * (a double-press, two clerks on one queue) gets through, short enough that a real chase
 * tomorrow is never blocked.
 */
export const BALANCE_REMINDER_COOLDOWN_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

/** Just enough of an order event for this module. `OrderEvent` structurally satisfies it. */
export interface SpineEvent {
  readonly eventType: string;
  readonly createdAt: string;
}

/**
 * When this order was last chased, from the spine the page already loaded.
 *
 * ⚠️ Read off `order_events` and not off a field on the order, because there is no such field
 * and there must not be: the ask is a spine row, and a `lastRemindedAt` column would be a second
 * record of it that a service keeps in step. The API decides the cooldown from the same table.
 *
 * ⚠️ `null` for an unparseable timestamp as well as for "never", and the caller treats both as
 * *offer the button*: a date this screen cannot read must not become a refusal, because the
 * server will answer correctly either way.
 */
export function lastBalanceReminderAt(events: readonly SpineEvent[]): Date | null {
  let latest: Date | null = null;

  for (const event of events) {
    if (event.eventType !== 'balance_reminded') continue;

    const at = new Date(event.createdAt);
    if (Number.isNaN(at.getTime())) continue;
    if (latest === null || at > latest) latest = at;
  }

  return latest;
}

export type ReminderAvailability =
  /** A live balance, and nothing sent recently. The button is offered. */
  | { readonly kind: 'available'; readonly outstandingThbMinor: bigint }
  /**
   * ฿0.00, or no figure at all — a cart, a settled order, a cancelled one, one written off.
   * ⚠️ The button is **hidden and nothing is said**: a disabled control under a settled balance
   * invites somebody to work out what is wrong with an order that has nothing wrong with it.
   * Same call `writeOffAvailability` makes about its own `nothingOwed`.
   */
  | { readonly kind: 'nothingOwed' }
  /**
   * Chased already, within the cooldown. ⚠️ This one **does** carry a sentence, unlike
   * `nothingOwed`: the reader needs to know the customer has already been asked, and by when
   * they may ask again — otherwise the missing button reads as a bug or as a permission problem.
   */
  | { readonly kind: 'remindedRecently'; readonly lastAt: Date; readonly nextAllowedAt: Date };

export function reminderAvailability(facts: {
  /** ค้างชำระ, straight off the order read — Postgres's fold, never arithmetic done here. */
  readonly outstandingThbMinor: bigint | null;
  readonly events: readonly SpineEvent[];
  /** Injected so the boundary is testable without freezing a clock. */
  readonly now: Date;
}): ReminderAvailability {
  const outstanding = facts.outstandingThbMinor;

  /*
   * `<= 0n` and not `=== 0n`, the same as everywhere else this app reads a balance: an overpaid
   * order is a modelled state (`0011_payment_guards.sql`) and has nothing to chase either.
   * `null` is the wire withholding a figure — a cart, or a cancelled order — and the API refuses
   * those with a better-worded sentence than this screen could write.
   */
  if (outstanding === null || outstanding <= 0n) return { kind: 'nothingOwed' };

  const lastAt = lastBalanceReminderAt(facts.events);
  if (lastAt !== null) {
    const nextAllowedAt = new Date(lastAt.getTime() + BALANCE_REMINDER_COOLDOWN_HOURS * HOUR_MS);
    if (nextAllowedAt > facts.now) return { kind: 'remindedRecently', lastAt, nextAllowedAt };
  }

  return { kind: 'available', outstandingThbMinor: outstanding };
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE BUTTON QUOTES THE FIGURE IT IS ABOUT TO SEND — TO THE SATANG.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `แจ้งเตือนยอดค้างชำระ ฿14,791.68`. The button's whole justification for having no confirmation
 * dialog is that it *states the figure it is about to quote*, so the press is informed — and it
 * was stating a different one. `formatBaht` rounds to the whole baht (`divRoundHalfUp`), so the
 * control read ฿14,792 while the email it sends says ฿14,791.68 and the timeline row it writes
 * says ฿14,791.68. A clerk reading the button to a customer on the phone gave a number that
 * appeared nowhere else, including in that customer's inbox.
 *
 * ── ⚠️ The trade, and which way it goes ─────────────────────────────────────
 *
 * The money card above the button rounds — `order-outstanding.ts` prints ค้างชำระ through
 * `formatBaht`, because a quotation is never issued in satang and a column of whole baht is
 * what staff scan. Matching that column is a real reason to round, and it is the reason the
 * button did.
 *
 * It loses anyway. **A figure that matches the card but not the message is a figure that
 * contradicts the customer**, and this control's own text is a promise about the message: it
 * says what is about to be sent, not what is displayed above it. Two baht of visual mismatch
 * inside one screen costs a glance; two baht between a phone call and an inbox costs a
 * reconciliation. So `baht` — the exact formatter `order-timeline.ts` already reads
 * `outstanding_thb_minor` with, and the same figure `formatMoney(locale, …, 'exact')` writes
 * into the email.
 *
 * ⚠️ It lives here and not in the `.tsx` because `apps/dashboard`'s vitest is
 * `environment: 'node'` and a `.test.tsx` is **silently never collected** — a rounding decision
 * left in the markup is a rounding decision no test in this repository can reach, which is
 * exactly how the wrong one shipped.
 */
export function reminderButtonLabelTh(outstandingThbMinor: bigint): string {
  return `แจ้งเตือนยอดค้างชำระ ${baht(outstandingThbMinor)}`;
}

/**
 * ⭐ What came of pressing it — the sentence the toast shows.
 *
 * ── ⚠️ WHY THIS IS THREE SENTENCES AND NOT "SENT" ────────────────────────────
 *
 * Because two of the three outcomes are not a message going out, and both are correct:
 *
 *   **queued** — the outbox has the message. It is not *sent*: the worker polls, renders and
 *   talks to an SMTP server afterwards, so คิว is the honest word and ส่งแล้ว is not one this
 *   screen is entitled to. `/admin/notifications` is where delivery is actually visible.
 *
 *   **suppressed, `no_contact_channel`** — the customer has only ever given a telephone number.
 *   `orders_submitted_has_a_contact_channel` permits that, the fan-out writes a suppressed row
 *   on purpose, and without this sentence a member of staff walks away believing a chase is on
 *   its way to somebody who has no address. That belief costs a week of silence.
 *
 *   **suppressed, `recipient_erased`** — the account was erased under PDPA. There is nobody to
 *   write to and there never will be again.
 *
 * ⚠️ An unrecognised reason is **reported, not swallowed**: the API is versioned separately from
 * this bundle and `order_events_fan_out_notifications()` may grow a reason in a migration. The
 * raw code is shown beside a generic sentence, which is the same posture `payloadLines` takes
 * for a payload key this build has never seen.
 */
export interface ReminderOutcome {
  readonly titleTh: string;
  readonly detailTh: string | null;
  /** `false` when the ask was recorded and nothing was sent — the caller styles it as a warning. */
  readonly delivered: boolean;
}

/**
 * ⛔ **`balance_settled` is deliberately absent, and this is the note saying so.**
 *
 * It is a real `suppressed_reason` — the newest one — but it cannot reach this map, because this
 * map only ever sees the **ask-time** answer and that reason is only ever written at **drain
 * time**. Two different writers, and they are not interchangeable:
 *
 *   `no_contact_channel` / `channel_disabled` / `recipient_erased` are written by
 *   `order_events_fan_out_notifications()`, inside the transaction that appended the event — so
 *   they are already on the row when `POST /orders/:orderId/balance-reminders` answers, and
 *   `reminderOutcome` is handed them as `suppressedReason` on that response.
 *
 *   `balance_settled` is written by the notification worker, minutes later, from
 *   `sendSuppression()` reading the balance **at claim time** (`templates/templates.ts`). At the
 *   moment this response is built the row is `pending` and `suppressedReason` is null. The API
 *   also refuses the ask outright when nothing is owed, and `reminderAvailability` above hides
 *   the button in that case, so the state cannot be reached from this direction at all.
 *
 * ⚠️ Adding a sentence for it anyway is the tempting move and it is the wrong one: it would put a
 * claim about a state this response cannot carry into the one place a member of staff reads
 * immediately after pressing the button, and nothing in this repository could ever exercise it.
 * Where that reason *is* readable is `/outbox`, which now has a section of its own for it —
 * `components/outbox/outbox-suppression.ts`.
 *
 * ⚠️ And if the two writers are ever merged, nothing breaks quietly: `reminderOutcome` falls back
 * to naming the raw code rather than swallowing it, which is the posture the header describes.
 */
const SUPPRESSED_TH: Readonly<Record<string, string>> = {
  no_contact_channel: 'ออเดอร์นี้ไม่มีอีเมลผู้ติดต่อ จึงยังไม่มีช่องทางส่ง — ติดต่อลูกค้าทางโทรศัพท์แทน',
  recipient_erased: 'บัญชีของลูกค้ารายนี้ถูกลบข้อมูลตามคำขอแล้ว จึงไม่มีปลายทางให้ส่ง',
};

export function reminderOutcome(result: {
  readonly queued: number;
  readonly suppressedReason: string | null;
}): ReminderOutcome {
  if (result.queued > 0) {
    return {
      titleTh: 'ส่งคำแจ้งเตือนเข้าคิวแล้ว',
      /* ⚠️ คิว, not ส่งแล้ว. The worker delivers afterwards; this screen must not claim it did. */
      detailTh: 'ระบบจะส่งอีเมลแจ้งยอดค้างชำระให้ลูกค้า และบันทึกไว้ในลำดับเหตุการณ์ของออเดอร์แล้ว',
      delivered: true,
    };
  }

  const reason = result.suppressedReason;

  return {
    titleTh: 'บันทึกการแจ้งเตือนแล้ว แต่ยังไม่ได้ส่ง',
    detailTh:
      reason === null
        ? 'ระบบยังไม่ได้สร้างข้อความสำหรับออเดอร์นี้'
        : (SUPPRESSED_TH[reason] ?? `ระบบไม่ได้ส่งข้อความ เหตุผลที่บันทึกไว้คือ ${reason}`),
    delivered: false,
  };
}
