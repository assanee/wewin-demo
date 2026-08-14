-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ A DEBT NOBODY OWES CANNOT BE FORGIVEN — the write-off's missing precondition.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 0048 bounded a write-off by the balance and by nothing else. `order_outstanding_thb_minor()`
-- answers about an order in **any** status — deliberately, because a refund is priced from
-- exactly that number — so a *cancelled* order that never paid folds to its whole grand total,
-- and a request to forgive it passed every test 0048 wrote:
--
--     grand_total is not null   ✓ it was submitted and invoiced
--     outstanding > 0           ✓ the whole contract, unpaid
--     amount <= outstanding     ✓
--
-- What that row records is a fiction with a cost. The cancellation already disposed of the
-- remainder — `forfeit_policy_rules` decides what the company keeps and `src/payments/refunds`
-- prices what it gives back — so approving the write-off spends the approver's `cashflow`
-- ceiling on a debt somebody else has already dealt with, and drives the ceiling's audit trail
-- (`approvals_write_off_idx`, the answer to *"how much did we write off this year?"*) away from
-- the truth by that amount. A `superseded` order is the same sentence twice over: its remainder
-- was **carried** to the order that replaced it (`refunds.service.ts` at length), so forgiving it
-- here forgives money that is still owed on the other order. And the figure is invisible while it
-- happens: `encodeOrderSummary` nulls every money field on a non-live order, so no screen in the
-- system would show what had been given away.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- ⓵ `order_status_is_live()` — and why this list is allowed to exist in SQL at all
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `apps/api/src/orders/live-order.ts` holds the definition: `NON_LIVE_ORDER_STATUSES` is
-- `draft`, `cancelled`, `superseded`, and its header says — accurately, until this migration —
-- *"NOT a mirror of a database function … there is no `order_status_is_live()` in Postgres to
-- drift from"*. That sentence is now false and the file has been corrected, because the guard
-- below cannot be written without the notion existing in SQL.
--
-- ⚠️ The choice was between two duplications and there is no third option:
--
--   ✗ inline `NEW.status not in ('draft','cancelled','superseded')` in the trigger. A **fifth**
--     statement of the list, unnamed and unpinned, in the one language where nothing typechecks
--     against it. `delivered` is the status this gets wrong — it is live, it is where a debt
--     most often has to be forgiven, and a list written from memory drops it into the wrong bag
--     exactly once and then refuses every write-off on a delivered order for a year.
--
--   ✓ a named function, mirrored the way `order_status_is_post_freeze()` and
--     `POST_FREEZE_STATUSES` already are — with a drift test that asks Postgres about **all
--     nine** statuses and compares each answer against `isLiveOrder`
--     (`tests/orders/contract-drift.pg.test.ts`). A mirror with a test is a duplication that
--     cannot drift silently; that is the whole argument that file's header makes.
--
-- ⛔ NOT money. This function compares a status to a list; it computes, adjusts and returns no
-- amount, which is why it may exist in this form at all under the money-in-Postgres rule.
--
-- `IMMUTABLE` because it is a comparison against a literal list — no table is read — which lets
-- the planner fold it away inside the trigger below.
CREATE FUNCTION order_status_is_live(p_status text) RETURNS boolean AS $$
  SELECT p_status NOT IN ('draft', 'cancelled', 'superseded');
$$ LANGUAGE sql IMMUTABLE;
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- ⓶ THE GUARD, AND WHY IT IS HERE AS WELL AS IN THE SERVICE
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `WriteOffService.request` refuses this at the ask and `AuthorityService.decide` refuses it at
-- the yes, both with a Thai sentence a member of staff can act on. Neither is a substitute for
-- this trigger, for the reason 0048 gives about the balance guard one screen above: **the service
-- is not the only writer.** `db:seed`, a psql session and a future worker all reach this table,
-- and every other rule about a write-off row — the balance, the four-eyes, the ceiling shape, the
-- frozen columns — is enforced here as well. A precondition that lives only in TypeScript is a
-- precondition that holds until somebody writes the row a different way.
--
-- ── ⚠️ WHICH MOMENTS IT FIRES AT, AND THE ONE IT DELIBERATELY DOES NOT ────────
--
--   INSERT, any status   a write-off may not be **created** against a dead order. `pending` and
--                        born-`approved` both, because nothing in this schema requires an
--                        approval to pass through `pending` and a guard that watched only one
--                        would be bypassed by the other.
--   UPDATE → 'approved'  the order can be cancelled *while the request sits in the inbox*, which
--                        is the same shape as 0048's "the balance MOVES between them". A request
--                        that was honest on Monday is a forgiveness of nothing by Wednesday.
--
--   UPDATE → 'rejected'  **allowed, on purpose.** A pending write-off occupies the order's one
--                        cashflow slot (`approvals_one_open_per_order_dimension`) until somebody
--                        answers it, and refusing the rejection too would leave every cancelled
--                        order with a request nobody can clear. Saying no to a request about a
--                        dead order is the correct outcome, not a second offence.
--
-- ⚠️ AFTER rather than BEFORE, matching `approvals_write_off_within_balance` — not because this
-- rule needs the statement's other rows to be visible (a status is not a fold) but because two
-- triggers on one table that disagree about when they run are two triggers whose interaction
-- nobody can reason about. The exception still rolls the statement back.
--
-- ⚠️ `order_status_is_live()` is asked about `orders.status` read fresh here, and never about a
-- copy of the status on the approval row: there is no such column, and adding one would be a
-- second opinion about which order this is.
CREATE FUNCTION approvals_write_off_order_is_live() RETURNS trigger AS $$
DECLARE
  current_status text;
BEGIN
  -- A quote concession is not about a debt at all. It is measured from `quote_lines` against a
  -- ceiling, and a discount recorded on a cancelled quotation is an ordinary historical fact —
  -- constraining it here would refuse plain quote approvals.
  IF NEW.kind <> 'write_off' THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status <> 'approved' THEN
    RETURN NULL;
  END IF;

  SELECT o.status INTO current_status FROM orders o WHERE o.id = NEW.order_id;

  -- The FK already refuses an approval against an order that does not exist. Nothing to add.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF NOT order_status_is_live(current_status) THEN
    RAISE EXCEPTION
      'write-off % on order % is not allowed: the order is %, so its remainder is nobody''s debt',
      NEW.id, NEW.order_id, current_status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "approvals_write_off_order_is_live"
  AFTER INSERT OR UPDATE ON "approvals"
  FOR EACH ROW EXECUTE FUNCTION approvals_write_off_order_is_live();
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- ⓷ WHAT IS NOT WEAKENED, AND WHAT IS NOT CLOSED
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Nothing in 0048 is replaced or re-created by this file: `order_written_off_thb_minor()`,
-- `order_outstanding_thb_minor()`, `order_next_due_thb_minor()`,
-- `approvals_write_off_within_balance()` and `approvals_guard_write()` are all untouched, and
-- this is a *new* trigger beside the balance one rather than a rewrite of it. Two rules, two
-- functions, each refusing its own sentence — a merged function would have had to restate the
-- balance arithmetic to add a status test to it.
--
-- ⚠️ NOT closed here, and named rather than left to be discovered: an approver's **queue** will
-- still offer the approve button on a write-off whose order was cancelled after the ask.
-- `approvalRights` (`approval-rights.ts`) is what the queue filters on and what
-- `GET /quotes/approvals/:id` reports, and it decides from facts about the *approval* — status,
-- kind, requester, ceiling, balance. Teaching it this rule means a new `because` reason on the
-- wire and the order's status reaching it for every row in the queue, which is a change to the
-- queue's one batched statement (`outstandingByOrder`) and to the dashboard that renders the
-- reason. The endpoint refuses the press with a sentence naming the cancellation, and the
-- rejection it directs the approver to is available — so the cost of not doing it is a wasted
-- click, not a wrong figure. It is the honest next round, in one place, rather than half of it
-- smuggled in here.
