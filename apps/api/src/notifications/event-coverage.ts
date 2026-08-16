import { ORDER_EVENT_TYPES } from '@wewin/db/schema';

/**
 * Which events are deliberately silent — and therefore which silences are bugs.
 *
 * The brief for this module is "make it impossible to have a state change that nobody was
 * told about". The database half of that is already structural: the fan-out trigger runs on
 * every `order_events` insert, in the same transaction, so a transition cannot commit
 * without producing whatever the rules say it should. But a rule that was never written
 * produces nothing, and *that* silence looks exactly like a working system — no error, no
 * dead row, no queue, just a customer who was never told.
 *
 * So the second half is this list, and the test that reads it
 * (`tests/notifications/rules-coverage.pg.test.ts`): every value in `ORDER_EVENT_TYPES`
 * must either have at least one enabled row in `notification_rules`, or be named here with
 * a reason. Adding an event type without doing one or the other fails a test rather than
 * shipping a silence.
 *
 * It is stated in TypeScript rather than in the migration because the assertion has to
 * compare two things — the code's list of event types and the database's list of rules —
 * and a claim written inside one of them cannot referee the other.
 *
 * SEAM 5b: `slip_received`, `slip_rejected`, `refund_requested` and `refund_disbursed`
 * arrive as new event types with their own rules (plan 10.3 lists all four recipients).
 * When they land, this file is the thing that fails until somebody decides who hears about
 * them — which is the intended behaviour and not an obstacle to work around.
 */

export type OrderEventType = (typeof ORDER_EVENT_TYPES)[number];

export const DELIBERATELY_SILENT_EVENTS: Readonly<Partial<Record<OrderEventType, string>>> = {
  /*
   * A draft is a cart. Plan 10.2 is explicit that browsing happens before anybody signs in
   * or gives a contact channel, so at `created` there is usually nothing to send a message
   * to — `orders.contact_email` is filled at submit, not before. Notifying here would also
   * mean an email for every abandoned configuration, which is the fastest way to teach a
   * customer that our messages are noise before the one that matters arrives.
   */
  created: 'a draft is a cart: no contact channel exists yet (plan 10.2) and most are abandoned',
  /*
   * ⚠️ SILENT ON PURPOSE — ASKED AND ANSWERED, SO DO NOT RE-OPEN IT LIGHTLY.
   *
   * Thirteen of the fifteen types notify; this is the second exception ever, so it was put to the
   * owner rather than decided here, and the answer was **"ไม่ต้องส่ง"**.
   *
   * The customer is not left uninformed, which is what makes the silence affordable:
   * `payment.writtenOff` says "ยอดคงค้างส่วนที่เหลือได้รับการอนุมัติให้ตัดยอดแล้ว — ไม่มีสิ่งที่ต้อง
   * ชำระเพิ่ม" on their own order screen in all eight locales, and the balance reaching zero is what
   * stops the reminders arriving. What we decline to do is *push* a message.
   *
   * The reasoning: an unprompted email saying the company has forgiven a debt is a commercial
   * statement, not a status update. A write-off is normally the end of a negotiation somebody had
   * by phone, and the person who had it is better placed to confirm it in the terms they agreed
   * than a template is. Sending one anyway puts in writing a concession that was meant to be
   * case-by-case.
   *
   * If that judgement is ever revisited, the work is one row in `notification_rules` plus
   * `order.balance_written_off.customer` in templates.ts, and this entry comes out.
   */
  balance_written_off:
    'a forgiven debt is the end of a negotiation a person had; the staff who agreed it confirm it ' +
    'in their own terms. The customer already sees payment.writtenOff on their order screen and ' +
    'the reminders stop on their own. Owner decided not to push a message as well.',
  /*
   * ⚠️ SILENT BECAUSE THE NEXT EVENT IS THE MESSAGE, not because nobody thought about it.
   *
   * `quotation_reopened` is staff pulling an unpaid quotation back to adjust it — a discount, a
   * different deposit, or a conversation that has not finished. Telling the customer at that
   * moment would say only that something is being changed, which invites the question the change
   * has not answered yet. The thing worth sending is the *result*, and that has its own event and
   * its own mail: `quotation_confirmed` reaches them the moment the figures are agreed.
   *
   * ⛔ The silence is affordable only while the pair holds. If a reopening could ever be
   * abandoned — the order left unconfirmed indefinitely — the customer would be waiting for a
   * confirmation nobody is going to send, and this entry would have to become a rule with a
   * "we are revising your quotation" message. There is no timeout on the status today; that is
   * the condition to watch, not the event count.
   */
  quotation_reopened:
    'the customer hears the result rather than the intention: quotation_confirmed carries its own ' +
    'mail the moment staff finish adjusting. Revisit if an order can sit reopened indefinitely.',
};

export function isDeliberatelySilent(eventType: string): boolean {
  return Object.hasOwn(DELIBERATELY_SILENT_EVENTS, eventType);
}

export { ORDER_EVENT_TYPES };
