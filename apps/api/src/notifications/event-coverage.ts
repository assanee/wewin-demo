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
};

export function isDeliberatelySilent(eventType: string): boolean {
  return Object.hasOwn(DELIBERATELY_SILENT_EVENTS, eventType);
}

export { ORDER_EVENT_TYPES };
