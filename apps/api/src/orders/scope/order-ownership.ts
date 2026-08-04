import { orders } from '@wewin/db/schema';
// Through @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { sql, type SQL } from '@wewin/db/sql';

import type { OrderReach } from './order-reach';

/**
 * A reach, as the WHERE clause that enforces it.
 *
 * This function is the whole of plan 7.4 trap 2's remedy: **ownership is a term in the
 * query, not a check on the result.** Nothing else in this application is allowed to load
 * an order row, so there is no path on which the term can be missing — not a forgotten
 * `if`, not a helper somebody extracted, not a `findById` added later for a debugging
 * script that stayed.
 *
 * Two properties are deliberate and both are load-bearing:
 *
 *   **It is total.** Every reach produces a predicate, including `none`. There is no
 *   `SQL | undefined` return, because Drizzle *drops* an undefined term out of `and(…)` —
 *   which is precisely how a filter disappears without a diff that looks like a security
 *   change. `none` compiles to `false`, so the query still runs and still returns nothing.
 *
 *   **It never returns `true` by falling through.** `all` says `true` in one branch that
 *   an auditor can find with a grep, and that branch is only reachable from a reach built
 *   by `orderReach` out of a permission the guard resolved from `group_permissions`.
 */
export function ownershipFilter(reach: OrderReach): SQL {
  switch (reach.kind) {
    case 'all':
      /*
       * Staff, or the process. Written as an explicit `true` rather than by omitting the
       * term: an omitted filter and a deliberate one look identical at the call site, and
       * only one of them is a decision.
       */
      return sql`true`;

    case 'none':
      /*
       * A caller with no referent. `false` and not an early return, so that a caller who
       * builds the query anyway gets an empty result rather than every row — the failure
       * mode of a mistake here is "the customer sees nothing", never "the customer sees
       * everything".
       */
      return sql`false`;

    case 'owned':
      return reach.owner.kind === 'customer'
        ? customerFilter(reach.owner.userId)
        : guestFilter(reach.owner.guestId);
  }
}

/**
 * The orders that name this account. One column, one comparison.
 *
 * ── What used to be here, and why it is gone ────────────────────────────────────
 *
 * There was a second branch: "…or the orders of a guest this user has claimed". It existed
 * because claiming revokes the cookie (`GuestRepository.isOpenGuest` refuses a claimed row)
 * while nothing attached the cart to the account — so an order became reachable by
 * *nobody* at the exact moment it converted, permanently, since a submitted order cannot be
 * deleted. The branch was a read-only rescue, hedged three ways, and it was honest about
 * being a workaround: its own comment said "if the backfill is written, this branch should
 * be deleted".
 *
 * The backfill is now written. `IdentityLinkService.claimGuest` attributes the guest's
 * unattributed orders to the account in the same transaction as the claim, which is the
 * repair the schema comment on `orders.customer_user_id` always described. So ownership is
 * one column again, and there is no longer a predicate whose correctness depends on
 * `guests.claimed_by_user_id` being exclusive — the thing that made the workaround
 * uncomfortable was that a second definition of ownership existed at all.
 */
function customerFilter(userId: string): SQL {
  return sql`${orders.customerUserId} = ${userId}`;
}

/**
 * The orders that name this guest, and that no account has taken over.
 *
 * The second term is not a restatement of the revocation rule, and it was worth being
 * careful about which it is. Revocation lives in one place — a claimed guest is not an open
 * guest, so the guard never builds a `guest` scope for one — and repeating *that* here would
 * put one rule in two files. This term says something different: **an order that names an
 * account is that account's, whatever else it also names.**
 *
 * It became load-bearing the moment the claim backfill landed. The backfill sets
 * `customer_user_id` and leaves `guest_id` in place, exactly as the schema intends, so from
 * then on there are rows that carry both — and a cookie for that guest, if one were ever
 * honoured again, would otherwise read an order that now belongs to a signed-in account. The
 * one-term version was safe only for as long as nothing produced that shape, and the repair
 * this round shipped is precisely what produces it.
 *
 * A guest id *is* a bearer capability for its cart; `rbac/guest-cookie.ts` says so, and says
 * what the secret alongside it buys. Nothing here can improve on that, because the row
 * genuinely names this guest as its owner.
 */
function guestFilter(guestId: string): SQL {
  return sql`(${orders.guestId} = ${guestId} and ${orders.customerUserId} is null)`;
}
