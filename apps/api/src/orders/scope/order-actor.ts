import { matchScope, scopeHolds, type Scope } from '../../rbac';

import { STAFF_PERMISSION } from './order-reach';

/**
 * Who is acting, as the three columns `order_events` stores — derived from the scope and
 * from nothing a caller sends.
 *
 * ── Never from the request body ─────────────────────────────────────────────────
 *
 * `order_events.actor_kind` decides what a transition is allowed to be: the transition
 * table lists `allowed_actor_kinds` per (from, to) pair, and `redesign → superseded` says
 * `{staff}` while `draft → awaiting_payment` says `{customer,guest,staff}`. A body field
 * called `actorKind` would therefore be a body field that grants staff authority. It does
 * not exist, and this function is why: the actor is a *projection of the authenticated
 * scope*, computed on the server, with no input from the request.
 *
 * ── It agrees with the reach by construction ────────────────────────────────────
 *
 * The kind here is decided by the same permission that decides `orderReach(scope, 'act')`:
 * `orders.write`. That is deliberate and it is the property that makes the whole module
 * consistent — the row you could load for `act` is exactly the row your actor kind is
 * allowed to have written an event about:
 *
 *   holds `orders.write` → reach `all`   → actor `staff`    → the database imposes no
 *                                                             ownership rule on staff
 *   plain user           → reach `owned` → actor `customer` → `order_events_guard_insert()`
 *                                                             demands
 *                                                             `actor_user_id = orders.customer_user_id`,
 *                                                             which the `act` predicate has
 *                                                             already guaranteed
 *   guest                → reach `owned` → actor `guest`    → same, for `orders.guest_id`
 *   public               → reach `none`  → no actor         → nothing to write
 *
 * So the database's trap-2 backstop and this module's filter cannot disagree; they are two
 * expressions of one rule, and `tests/orders/scope/order-actor.test.ts` pins the
 * correspondence so a change to one shows up as a failure about the other.
 *
 * ── A staff member acting on their own order acts as staff ──────────────────────
 *
 * They hold `orders.write`, so they get `staff` even on an order they placed personally.
 * The alternative — demoting them to `customer` on their own row — reads like segregation
 * of duties and is not: it would silently block the one-person company plan 13 warns about
 * (`⚠️ ตอบก่อนเขียน trigger` — if there is one person, a two-person rule becomes a ritual
 * everybody clicks through), while doing nothing about the real question, which is whether
 * a salesperson may approve their own discount. That question is 5c's, and plan 7.13
 * settled where it is answered: one `approvals` table, two dimensions, evaluated at the
 * document level. Not a special case invented here.
 *
 * `actor_user_id` is populated for staff regardless, so "who did this" is answerable from
 * the spine either way.
 */

export type OrderActorKind = 'customer' | 'guest' | 'staff' | 'system';

export interface OrderActor {
  readonly actorKind: OrderActorKind;
  /** `order_events.actor_user_id`. Null for a guest and for the process itself. */
  readonly actorUserId: string | null;
  /** `order_events.actor_guest_id`. Null for anybody with an account. */
  readonly actorGuestId: string | null;
}

/**
 * `undefined` for the public — there is nobody to record.
 *
 * Not a throw. A caller that reaches this with no principal has a route policy problem
 * (`RequirePrincipal` exists for exactly that), and returning an absence lets the caller
 * answer with its own 401 rather than a 500 from a layer that cannot know the route.
 */
export function orderActor(scope: Scope): OrderActor | undefined {
  return matchScope<OrderActor | undefined>(scope, {
    /*
     * The same conjunction `orderReach` uses for the `act` intent, and it has to be the same
     * one: this function decides what `order_events.actor_kind` says, and that column is the
     * database's own trap-2 backstop. If this said `staff` where the reach said `owned`, the
     * event would claim an authority the query had already refused — and the correspondence
     * asserted in `order-reach.test.ts` ("staff exactly when the acting reach is the whole
     * table") would stop holding. Two expressions of one rule, or neither is worth anything.
     */
    user: (user) =>
      scopeHolds(user, STAFF_PERMISSION.read) && scopeHolds(user, STAFF_PERMISSION.act)
        ? { actorKind: 'staff', actorUserId: user.userId, actorGuestId: null }
        : { actorKind: 'customer', actorUserId: user.userId, actorGuestId: null },

    guest: (guest) => ({ actorKind: 'guest', actorUserId: null, actorGuestId: guest.guestId }),

    public: () => undefined,

    /*
     * The outbox worker, a migration, a retry job. `system` is in `ORDER_ACTOR_KINDS` and
     * in `allowed_actor_kinds` for the two transitions a machine may make on its own
     * (abandoning a draft, confirming a payment a reconciliation matched), and it carries
     * no user id because there is no person — a service account with a password nobody
     * rotates is the thing this avoids.
     */
    system: () => ({ actorKind: 'system', actorUserId: null, actorGuestId: null }),
  });
}
