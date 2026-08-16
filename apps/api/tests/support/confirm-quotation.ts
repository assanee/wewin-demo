import { sql } from '@wewin/db/sql';
import type { Database } from '@wewin/db/client';

/**
 * ⭐ Move a submitted order from `awaiting_confirmation` to `awaiting_payment` — the staff act.
 *
 * ── Why this exists, and why it is SQL rather than HTTP ─────────────────────────
 *
 * A quotation request used to land in `awaiting_payment`: the customer was asked to transfer
 * money against a figure no member of staff had seen. 0056 retired that road, so a submit now
 * arrives in `awaiting_confirmation` and a person decides when the customer may pay.
 *
 * Twenty test files submit an order and then do something that requires a *payable* one — accept
 * a slip, confirm a payment, walk the lifecycle. None of them is about the confirmation; they
 * need an order past it. This is that step, as a fixture, in the same spirit as
 * `payments/support/money-fixture.ts`: written the way the application writes it (an event on
 * the spine, then the row), so a test built on it exercises the same triggers, but reached
 * without a token, a permission grant and a second HTTP round trip in every one of those files.
 *
 * ⚠️ The one thing it must NOT become is a way for production code to skip the confirmation.
 * It lives under `tests/`, it takes a `Database` rather than a transaction from a service, and
 * `orders/transitions.pg.test.ts` covers the real route.
 */
export async function confirmQuotation(
  db: Database,
  orderId: string,
  options: { readonly actorUserId?: string } = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    /*
     * A staff actor is required by the transition row (`{staff}`) and by
     * `order_events_guard_insert`, which reads `allowed_actor_kinds` off it. Any staff user will
     * do — the confirmation is not scoped to an owner the way a customer's own acts are — so one
     * is minted here rather than threaded through twenty call sites that have no other use for it.
     */
    let actorUserId = options.actorUserId;
    if (actorUserId === undefined) {
      const created = await tx.execute(sql`
        insert into users (display_name, status) values ('fixture: quotation confirmer', 'active')
        returning id::text as id
      `);
      const rows = (created as { rows?: readonly Record<string, unknown>[] }).rows ?? [];
      actorUserId = String(rows[0]?.['id']);
    }

    const appended = await tx.execute(sql`
      insert into order_events
        (order_id, event_type, from_status, to_status, actor_kind, actor_user_id, payload)
      values (${orderId}::uuid, 'quotation_confirmed', 'awaiting_confirmation', 'awaiting_payment',
              'staff', ${actorUserId}::uuid, '{}'::jsonb)
      returning id::text as id
    `);

    const eventRows = (appended as { rows?: readonly Record<string, unknown>[] }).rows ?? [];
    const eventId = String(eventRows[0]?.['id']);

    /*
     * `status_event_id` as well as `status`: `orders_status_event_matches` (0007) refuses a row
     * whose status does not agree with the event it names, so setting one without the other is a
     * fixture that fails at the constraint rather than a fixture that quietly lies.
     */
    await tx.execute(sql`
      update orders
         set status = 'awaiting_payment', status_event_id = ${eventId}::uuid, updated_at = now()
       where id = ${orderId}::uuid
    `);
  });
}
