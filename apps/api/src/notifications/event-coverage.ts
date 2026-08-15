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
   * ⚠️ SILENT BY DEFAULT, AND THIS IS THE OPEN QUESTION, NOT THE ANSWER.
   *
   * Thirteen of the fifteen types notify; this is the second exception ever, so it deserves
   * more than a line. The customer is not left uninformed: `payment.writtenOff` already says
   * "ยอดคงค้างส่วนที่เหลือได้รับการอนุมัติให้ตัดยอดแล้ว — ไม่มีสิ่งที่ต้องชำระเพิ่ม" on their own
   * order screen in all eight locales, and the balance reaching zero is what stops the
   * reminders. What is missing is a message we *push*.
   *
   * The reason for not writing one here is that an unprompted email saying the company has
   * forgiven a debt is a commercial statement, not a status update. A write-off is normally the
   * end of a negotiation somebody had by phone, and the person who had it is better placed to
   * confirm it in the terms they agreed than a template is. Sending one anyway risks putting in
   * writing a concession that was meant to be case-by-case.
   *
   * That is a judgement about how this business talks to its customers, so it is the owner's to
   * make and not this file's. If the answer is "yes, tell them", the work is one row in
   * `notification_rules` plus `order.balance_written_off.customer` in templates.ts, and this
   * entry comes out.
   */
  balance_written_off:
    'a forgiven debt is the end of a negotiation a person had; the staff who agreed it should ' +
    'confirm it in their own terms. The customer already sees payment.writtenOff on their order ' +
    'screen and the reminders stop on their own. Owner to decide whether we also push a message.',
};

export function isDeliberatelySilent(eventType: string): boolean {
  return Object.hasOwn(DELIBERATELY_SILENT_EVENTS, eventType);
}

export { ORDER_EVENT_TYPES };
