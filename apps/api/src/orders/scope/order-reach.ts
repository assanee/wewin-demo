import { matchScope, scopeHolds, type Scope } from '../../rbac';

/**
 * Which orders a caller may see, and why — the decision, with no database in it.
 *
 * ── What this file is for ───────────────────────────────────────────────────────
 *
 * Plan 7.4 trap 2, in full, because everything below is shaped by it:
 *
 * > authorization ตรวจแค่ *ประเภท* ผู้กระทำ — `actors: ['customer']` ไม่ได้แปลว่า
 * > "ลูกค้าคนนี้" … **ความเป็นเจ้าของต้องอยู่ใน query ที่โหลด order** ไม่ใช่เช็คทีหลัง
 *
 * The mistake it names is not a missing check. It is a check in the wrong *place*: a
 * handler that loads the row, then asks whether the caller owns it. That code is correct
 * on the day it is written and stops being correct the first time somebody extracts the
 * load into a helper and leaves the `if` behind — and the failure is silent, because the
 * happy path is identical.
 *
 * So this module never produces a boolean about a row. It produces an `OrderReach`, which
 * `order-ownership.ts` turns into a SQL predicate, which is the *only* way an order row is
 * ever obtained (see `scoped-order.repository.ts`). A row that arrived without one cannot
 * be passed to anything downstream, because `ScopedOrder` is a branded type this module is
 * the only producer of. "Check the ownership" is not a step anybody can forget, because it
 * is not a step; it is the shape of the query.
 *
 * ── Why `intent` is a required argument ─────────────────────────────────────────
 *
 * Reading and acting are different questions with different answers, and a single
 * `canAccess` would have to pick one of them as a default. There is no safe default here:
 * defaulting to `read` would let a write path load rows it may not touch, and defaulting
 * to `act` would hide orders a customer is entitled to see. A required argument is a
 * decision somebody made at every call site.
 *
 * What turns on it is **which permission makes a staff member staff**: `orders.read` is
 * required either way, and `orders.write` on top of it for an action. A clerk with read-only
 * access who calls an action path does not get the staff-wide reach; they fall back to their
 * own orders, which is normally none. The route guard would refuse them first — this is the
 * second lock, and it is the one that still holds if a route is ever declared wrongly. The
 * conjunction is not tidiness; see the note in `orderReach` for the two grants it removes.
 *
 * ── Staff authority comes from permissions and from nothing else ────────────────
 *
 * `scopeHolds` reads the permission set the guard already resolved out of
 * `group_permissions`. There is no second table, no `is_staff` flag and no role string
 * here on purpose: plan 7.13 found the two-person approval rule written six times with six
 * different column pairs, each with its own hole, and settled it as one `approvals` table.
 * 5c's approval authority attaches there. A role check invented in this file would be the
 * seventh copy.
 */

/** Reading a row, or acting on it. Never inferred, never defaulted — see above. */
export type OrderIntent = 'read' | 'act';

export const ORDER_INTENTS: readonly OrderIntent[] = ['read', 'act'];

/** The permission that widens each intent to every order in the table. */
export const STAFF_PERMISSION = {
  read: 'orders.read',
  act: 'orders.write',
} as const satisfies Record<OrderIntent, 'orders.read' | 'orders.write'>;

/**
 * The referent a row is matched against.
 *
 * Two variants and not a nullable user id, for the reason `rbac/scope.ts` gives about the
 * scope union it comes from: `where customer_user_id = $1` with a null in `$1` matches
 * nothing on a good day and is a table scan waiting for an `OR` on a bad one.
 */
export type OrderOwner =
  | { readonly kind: 'customer'; readonly userId: string }
  | { readonly kind: 'guest'; readonly guestId: string };

/** Every order in the table. Staff and the process itself. */
export interface OrderReachAll {
  readonly kind: 'all';
  /** For the log line. `describeReach` is the only thing that reads it. */
  readonly why: string;
}

/** The orders that name this referent. The funnel, and every customer. */
export interface OrderReachOwned {
  readonly kind: 'owned';
  readonly owner: OrderOwner;
}

/** No orders at all — not "none found", *none reachable*. A caller with no referent. */
export interface OrderReachNone {
  readonly kind: 'none';
  readonly why: string;
}

export type OrderReach = OrderReachAll | OrderReachOwned | OrderReachNone;

/**
 * Scope + intent → reach. The single place the question is answered.
 *
 * `matchScope` and not a `switch`: a `default` branch would compile for a fifth scope
 * variant and quietly give it whatever the default was, and for a query builder the
 * default is "no filter". Plan section 6's guest is exactly the variant that would have
 * been forgotten — it is neither a user nor the public, it holds no permission, and it is
 * most of the traffic.
 */
export function orderReach(scope: Scope, intent: OrderIntent): OrderReach {
  const staffPermission = STAFF_PERMISSION[intent];

  return matchScope<OrderReach>(scope, {
    user: (user) => {
      /*
       * `orders.read` is required for *both* intents, and `orders.write` additionally for
       * `act`. Read that again as the thing it forbids: **acting on an order you may not
       * read.**
       *
       * The split used to be clean — read widens on `orders.read`, act widens on
       * `orders.write` — and it produced two states nobody would have asked for. A holder of
       * `orders.write` alone got 404 from `GET /orders/:id` on a stranger's order and then
       * received that same order in full, contact details and all four money figures, in the
       * 200 body of `POST …/transitions/cancelled`, because every write path answers with the
       * order it just changed. They read by writing, and the read was a cancellation on the
       * append-only spine with their name on it. Meanwhile the *honest* description of that
       * grant was "may cancel, bounce, supersede or confirm payment on every order in the
       * company, while being unable to look at any of them" — acting blind on the whole table.
       *
       * Neither is a permission anybody meant to define, and both came from treating the two
       * codes as independent axes. They are not: writing is reading plus a change. So
       * `orders.write` on its own now reaches nothing at all (the caller falls back to their
       * own orders, normally none, and gets a 404), which is fail-closed and legible — and
       * `orders.read` alone still reaches every order and can change none, which is the
       * read-only clerk this split existed for.
       */
      if (scopeHolds(user, STAFF_PERMISSION.read) && scopeHolds(user, staffPermission)) {
        return { kind: 'all', why: `staff (${staffPermission})` };
      }

      /*
       * A signed-in customer. Note what is *not* here: no fallback to `all`, no "admin"
       * escape, and no check of the user id against a list. A person without the
       * permission sees the orders that name them, and that is the entire rule.
       */
      return { kind: 'owned', owner: { kind: 'customer', userId: user.userId } };
    },

    /*
     * The funnel. A guest holds no permission by construction (`scopeHolds` gives them
     * nothing), so there is no branch here that could widen them — the guest path cannot
     * become the staff path through a permission grant, a suspended account or a bug in
     * the permission repository, because it never asks.
     */
    guest: (guest) => ({ kind: 'owned', owner: { kind: 'guest', guestId: guest.guestId } }),

    /*
     * Nobody is here. Not an error — most requests to the catalogue are this — but there
     * is no referent, so there is no set of orders to describe. A route that reaches this
     * for a caller who should have had a guest cookie has a cookie problem, not an
     * authorisation problem, and `rbac/guest-cookie.ts` is where that lives.
     */
    public: () => ({ kind: 'none', why: 'no principal: neither a session nor a guest cookie' }),

    /*
     * The process acting on its own behalf — the notification worker draining the outbox,
     * a migration. Never produced from an HTTP request (`rbac/identity.ts`), so this
     * branch cannot be reached by anything a caller sends.
     */
    system: (system) => ({ kind: 'all', why: `system (${system.reason})` }),
  });
}

/** One line for a log. No ids beyond the referent, for the reason `describeScope` gives. */
export function describeReach(reach: OrderReach): string {
  switch (reach.kind) {
    case 'all':
      return `all orders — ${reach.why}`;
    case 'owned':
      return reach.owner.kind === 'customer'
        ? `orders of user:${reach.owner.userId}`
        : `orders of guest:${reach.owner.guestId}`;
    case 'none':
      return `no orders — ${reach.why}`;
  }
}
