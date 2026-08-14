/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ WHY A SUPPRESSED MESSAGE WAS NOT SENT — and the two answers are not one answer.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `suppressed` is one status covering two unrelated facts, and until now this screen was built
 * as though it covered one:
 *
 *   **we could not reach them** — `no_contact_channel`, `channel_disabled`, `recipient_erased`.
 *   Nobody gave us an address, or the address we had is gone. Undelivered, and somebody has to
 *   go and get a contact before anything can be sent.
 *
 *   **there was no longer anything to say** — `balance_settled`. The customer settled the
 *   balance between the ask and the drain, so the reminder the worker picked up had nothing
 *   left to chase. Undelivered, and *nothing is wrong*. See `sendSuppression` in the API's
 *   `templates/templates.ts` for why this is `suppressed` rather than `dead`.
 *
 * ── ⚠️ What went wrong, and why it went wrong here rather than anywhere else ──
 *
 * The screen had a Figure labelled `ไม่มีที่อยู่ให้ส่ง` over the whole `suppressed` count, a
 * section titled the same, and a description reading *"ต้องไปหาที่อยู่หรือเบอร์ของลูกค้ามาก่อน"*.
 * A customer who paid promptly therefore appeared three times over as a contact-details problem,
 * and `suppress()` nulls `recipient_key` (`notifications_addressed_unless_suppressed`), so the
 * row itself corroborated the story. The only thing contradicting it was the machine word in the
 * เหตุผล column.
 *
 * ⭐ It went wrong in a `.tsx`, which is the whole reason this file exists. `apps/dashboard`'s
 * vitest is `environment: 'node'` and a `.test.tsx` is **silently never collected** — so a
 * sentence written into the markup is a sentence no test in this repository can read, and one
 * that instructs staff to go and find an address is exactly the kind that has to be readable by
 * something other than a person's eye. The copy lives here, pinned as whole strings, for the
 * same reason `outbox-focus.ts` holds the focal sentence.
 *
 * ── ⚠️ The counts cannot be split, and the lists can ─────────────────────────
 *
 * `GET /admin/notifications` sends **one** `summary.suppressed` total with no breakdown, and
 * sends the rows themselves capped at `limit` (50 by default). So:
 *
 *   ⓵ anything counting the total — the Figure, and `outboxFocus`'s clause — must be worded so
 *     that it is true of every reason, because this screen cannot honestly divide that number;
 *   ⓶ anything grouping *rows* may split freely, because grouping rows already in hand invents
 *     no number. That is why the sections below carry **no counts in their headings**: a count
 *     derived from a truncated list would silently disagree with the Figure above it.
 *
 * ── ⚠️ `unknown` is the fail-closed arm, and it claims nothing ───────────────
 *
 * This bundle is versioned separately from the API and `suppressed_reason` is plain `text` with
 * no CHECK on it (`packages/db/src/schema/order.ts` says so), so a migration can add a reason
 * this build has never seen. Neither known group is a safe home for one:
 *
 *   filing it under `unreachable` sends somebody hunting for an address — the defect above,
 *   recurring on the next reason instead of this one;
 *   filing it under `nothingToSend` says *nothing is wrong* about a message that may well have
 *   failed to reach somebody, which is the sentence plan 10.5(3) exists to prevent.
 *
 * So it gets an arm that asserts neither, and a section that says the screen does not know —
 * the same posture `order-outstanding.ts` takes with its dash, and the same one
 * `orders/balance-reminder.ts` takes when `SUPPRESSED_TH` has no entry: reported, not swallowed.
 */

/** Which of the three sentences a `suppressed_reason` belongs under. */
export type SuppressionGroup = 'unreachable' | 'nothingToSend' | 'unknown';

/**
 * The reasons that mean *there was nobody to write to*.
 *
 * All three are written by `order_events_fan_out_notifications()` at fan-out time, before a
 * worker ever sees the row, and all three share one remedy: obtain a contact. `recipient_erased`
 * is in here because it is the same *kind* of fact — no address, and terminal — even though the
 * erasure makes it the one case where obtaining one is not on offer.
 */
const UNREACHABLE_REASONS: ReadonlySet<string> = new Set([
  'no_contact_channel',
  'channel_disabled',
  'recipient_erased',
]);

/**
 * The reasons that mean *there was no longer anything to send*.
 *
 * One today, and it is written by the **worker** rather than by the fan-out — `sendSuppression`
 * answers on the balance read at claim time, which is the whole point of the feature.
 */
const NOTHING_TO_SEND_REASONS: ReadonlySet<string> = new Set(['balance_settled']);

/**
 * ⚠️ `null` is `unknown` and deliberately not either known group. The column is nullable, and a
 * suppressed row that never recorded why it was suppressed is precisely a row this screen has no
 * grounds to explain.
 */
export function suppressionGroup(reason: string | null): SuppressionGroup {
  if (reason === null) return 'unknown';
  if (UNREACHABLE_REASONS.has(reason)) return 'unreachable';
  if (NOTHING_TO_SEND_REASONS.has(reason)) return 'nothingToSend';
  return 'unknown';
}

export interface GroupedSuppressed<T> {
  readonly unreachable: readonly T[];
  readonly nothingToSend: readonly T[];
  readonly unknown: readonly T[];
}

/**
 * Split the suppressed list the API sent into the sections the screen renders.
 *
 * Generic and structural: `SuppressedMessage` from `outbox-api.ts` satisfies it, the same
 * arrangement `OwedFigures` and `OutboxCounts` use. Order within each group is preserved, so
 * each section stays in the newest-first order the API sorted the list into.
 */
export function groupSuppressed<T extends { readonly reason: string | null }>(
  rows: readonly T[],
): GroupedSuppressed<T> {
  const unreachable: T[] = [];
  const nothingToSend: T[] = [];
  const unknown: T[] = [];

  for (const row of rows) {
    const group = suppressionGroup(row.reason);
    if (group === 'unreachable') unreachable.push(row);
    else if (group === 'nothingToSend') nothingToSend.push(row);
    else unknown.push(row);
  }

  return { unreachable, nothingToSend, unknown };
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The sentences. Whole strings, pinned by `outbox-suppression.test.ts`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * The Figure over `summary.suppressed`.
 *
 * ⚠️ It was `ไม่มีที่อยู่ให้ส่ง`, which is a cause, over a total that mixes causes. `ไม่ได้ส่ง` is
 * the status itself and nothing more — the word the app already uses for it in
 * `quotation-sheet.tsx` (*"ระบบไม่ได้ส่งอะไรถึงลูกค้า"*) and in `orders/balance-reminder.ts`
 * (*"บันทึกการแจ้งเตือนแล้ว แต่ยังไม่ได้ส่ง"*). It is terminal where `รอส่ง` is not, and it is
 * not a failure where `ส่งไม่สำเร็จ` is; which of the two reasons it was is answered by the
 * sections, which is the only place this screen can answer it truthfully.
 */
export const SUPPRESSED_FIGURE_LABEL_TH = 'ไม่ได้ส่ง';

/**
 * ⭐ Unchanged, word for word, and that is the point of the split.
 *
 * This section's description is an **instruction**, and an instruction is either right for every
 * row under it or it is wrong. Softening it to cover `balance_settled` too would have cost the
 * contact rows — the common case, and the one that genuinely needs somebody to go and do this —
 * their remedy. Removing the rows it was never true of is what makes it true again.
 */
export const UNREACHABLE_TITLE_TH = 'ไม่มีที่อยู่ให้ส่ง — ส่งซ้ำไม่ได้';
export const UNREACHABLE_DESCRIPTION_TH =
  'ตั้งแต่แรกก็ไม่มีช่องทางติดต่อ ส่งซ้ำก็ล้มเหมือนเดิม — ต้องไปหาที่อยู่หรือเบอร์ของลูกค้ามาก่อน';

/**
 * ⚠️ `ไม่มีเรื่องต้องแจ้งแล้ว` parallels `ไม่มีที่อยู่ให้ส่ง` on purpose: same shape, and the word
 * that differs is the whole difference between the two sections. The description states the one
 * case that occurs, in the words this app already uses for it — `ชำระครบแล้ว` is `SETTLED_TH`
 * from `orders/order-outstanding.ts`, and `ยอดคงค้าง` is what the API, the filter heading and the
 * approval inbox all call a balance. No new vocabulary for money, per `apps/dashboard/README.md`.
 *
 * ⛔ And it says outright that this is not an address problem, because the section above it has
 * just told the reader to go and find one.
 */
export const NOTHING_TO_SEND_TITLE_TH = 'ไม่มีเรื่องต้องแจ้งแล้ว — ส่งซ้ำไม่ได้';
export const NOTHING_TO_SEND_DESCRIPTION_TH =
  'พอถึงคิวส่ง ก็ไม่มีเรื่องต้องแจ้งแล้ว — ลูกค้าชำระครบแล้วก่อนที่ข้อความแจ้งยอดคงค้างจะออกไป ' +
  'ไม่ใช่ปัญหาเรื่องช่องทางติดต่อ และไม่มีอะไรต้องตามต่อ';

/**
 * ⚠️ Claims no cause and prescribes no remedy — see the header. It points at the เหตุผล column,
 * which prints `suppressed_reason` verbatim, because the machine word is the only fact the screen
 * actually has about such a row.
 */
export const UNKNOWN_TITLE_TH = 'ไม่ได้ส่ง — เหตุผลที่หน้านี้ยังไม่รู้จัก';
export const UNKNOWN_DESCRIPTION_TH =
  'ระบบปิดรายการเหล่านี้ไปโดยไม่ได้ส่ง ด้วยเหตุผลที่หน้านี้ยังไม่มีคำอธิบายให้ — ' +
  'อ่านรหัสในคอลัมน์เหตุผลก่อน แล้วค่อยตัดสินว่าต้องทำอะไรต่อ';
