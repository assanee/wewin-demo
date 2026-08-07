import type { PermissionCode } from '../rbac/permissions';
import { scopeHolds, type Scope } from '../rbac/scope';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WHICH CARDS OF THE OVERVIEW A CALLER MAY BE SHOWN.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `GET /overview` is `@Authenticated()` and asks for no permission of its own,
 * because there is no single permission that means "may see the overview" — the screen is a
 * different screen for a catalogue editor and for a finance lead. What gates it is this
 * table, one entry per card.
 *
 * ── ⭐ THE RULE ──────────────────────────────────────────────────────────────
 *
 * **Never summarise a queue for somebody the queue itself would refuse.**
 *
 * A count is a disclosure. "3 slips waiting" carries more than the 3: that payment is taken
 * by slip, that a human reviews it, that the company is busy enough to have a backlog. So
 * each entry holds the permissions of *the screen the number is about*, copied deliberately
 * rather than approximated:
 *
 *   `slips` asks for two codes because `GET /payments/slips` asks for two. `payments.read`
 *   alone opens the refunds queue and the ledger and **not** the slip queue, and a card that
 *   ignored the difference would be a way to read a slip backlog by looking at its total.
 *
 * ── ⚠️ AND ABSENCE IS NOT ZERO ───────────────────────────────────────────────
 *
 * A card the caller may not see is a **key that is not in the response**, never a zero. Two
 * reasons, and the second is the one that is easy to miss:
 *
 *   ⓵ Zero is a lie a reader cannot detect. "0 refunds requested" and "you may not know"
 *     look identical on a screen, and the first is the one people act on.
 *   ⓶ Zero still discloses the *queue*. A finance section rendering "—" tells a catalogue
 *     editor that refunds exist here. The empty-section rule in the dashboard's
 *     `visibleNavigation` is the same rule for the same reason: a heading is itself a
 *     disclosure, and an empty one says "and you may not see it".
 *
 * The service therefore *never fetches* an unpermitted count, rather than fetching it and
 * filtering afterwards. A number that was never read cannot be serialised by a later edit.
 *
 * ── The catalogue borrows, and says so ───────────────────────────────────────
 *
 * `notifications` sits under `orders.read`, which is a borrow this application has already
 * made and documented once — see `notifications.controller.ts` on why there is no
 * `notifications.*` code and what the honest split would be. Repeating the borrow here is
 * correct; inventing a different one would put the overview and the queue out of step.
 */
export const OVERVIEW_SECTIONS = {
  orders: ['orders.read'],
  /** ⚠️ Two codes. `slip-review.controller.ts` is `('payments.read', 'orders.read')`. */
  slips: ['payments.read', 'orders.read'],
  refunds: ['payments.read'],
  money: ['payments.read'],
  quotes: ['quotes.read'],
  reviews: ['reviews.moderate'],
  /** Borrowed, deliberately. See the block comment. */
  notifications: ['orders.read'],
  catalog: ['catalog.read'],
  users: ['users.read'],
} as const satisfies Record<string, readonly PermissionCode[]>;

export type OverviewSection = keyof typeof OVERVIEW_SECTIONS;

/**
 * The cards this scope may be shown, in the table's declaration order.
 *
 * Ordered rather than a `Set` so the response's key order is the same for every caller and
 * for every request — a screen that reads the keys in order gets a stable layout, and two
 * responses can be compared without being sorted first.
 *
 * Every code, not any: the same rule `@RequirePermissions` enforces, so a card cannot be
 * opened by holding half of what its queue demands. Asked through `scopeHolds`, so `system`
 * gets the same answer here as everywhere else instead of a second opinion.
 */
export function visibleSections(scope: Scope): readonly OverviewSection[] {
  return (Object.keys(OVERVIEW_SECTIONS) as OverviewSection[]).filter((section) =>
    OVERVIEW_SECTIONS[section].every((code) => scopeHolds(scope, code)),
  );
}
