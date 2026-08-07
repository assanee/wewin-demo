import type { MoneyWire } from '@wewin/contract/money';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE OVERVIEW ANSWERS WITH.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Nine cards, each optional, each corresponding to one entry in `sections.ts`.
 *
 * ⚠️ **Optional means absent, and absent is the point.** A card the caller may not see is a
 * key that is not there — never a zero, never a null. See `sections.ts` for why: zero is a
 * lie a reader cannot detect, and it still discloses that the queue exists. `?` rather than
 * `| null` is what makes `JSON.stringify` drop the key rather than write it.
 *
 * The cards are flat rather than grouped into "sales" and "system", because a group is a
 * second thing to keep in step with the permission table and the grouping is a question of
 * layout. The dashboard groups them; the API states them.
 */

/**
 * Live orders by status.
 *
 * Six of the nine statuses. `delivered` and `superseded` are finished and `cancelled` is
 * over — none of them is somebody's queue, and a card of numbers that nobody acts on is how
 * a dashboard teaches people not to read it. `draft` is here and is *not* work: it is an
 * abandoned cart, a leading indicator, and it is labelled as such on the screen.
 */
export interface OrdersOverviewWire {
  readonly draft: number;
  readonly awaitingPayment: number;
  readonly productionConfirmed: number;
  readonly inProduction: number;
  readonly awaitingInstallation: number;
  readonly redesign: number;
}

/** `payment_slips.status = 'submitted'` — exactly what `GET /payments/slips` lists. */
export interface SlipsOverviewWire {
  readonly awaitingReview: number;
}

/** `refunds.status = 'requested'` — a decision nobody has taken yet. */
export interface RefundsOverviewWire {
  readonly requested: number;
}

/**
 * ⚠️ TWO NUMBERS THAT ARE BOTH ABOUT MONEY AND ARE NOT THE SAME KIND OF THING.
 *
 * `0011_payment_guards.sql` says it first and says it better: settled and paid differ the
 * first time a bank fee is written off, and **"which one a screen means has to be said out
 * loud, every time."** So:
 *
 *   `receivedThisMonth`  the face value of slips *accepted* this Thai month. Acceptance,
 *                        not transfer: `transferred_at` is the customer's claim, and
 *                        `reviewed_at` is when the company decided the money was real.
 *                        See `business-month.ts` for which month "this" is.
 *
 *   `outstanding`        `order_outstanding_thb_minor()` folded over live orders — the
 *                        database's own function, so this figure and the one an order screen
 *                        shows cannot drift. Draft, cancelled and superseded orders are
 *                        excluded: a draft is not a commitment, and a cancelled order's
 *                        money is a refund or a forfeit rather than a debt.
 *
 * Not `trade_receivable`. That account is real and structurally empty — `walk.pg.test.ts`
 * records why: *"nothing is invoiced before it is paid"*. A receivables figure that is
 * always ฿0 on a dashboard is worse than no figure.
 */
export interface MoneyOverviewWire {
  readonly receivedThisMonth: MoneyWire<'THB'>;
  readonly outstanding: MoneyWire<'THB'>;
}

/** `approvals.status = 'pending'` — a concession waiting on somebody senior. */
export interface QuotesOverviewWire {
  readonly approvalsPending: number;
}

/**
 * `not review_is_moderated(reviews)` — the database function `GET /admin/reviews/queue`
 * filters on, called rather than restated so the two cannot mean different things.
 */
export interface ReviewsOverviewWire {
  readonly awaitingModeration: number;
}

/**
 * The outbox, split the way the queue splits it.
 *
 * `dead` is retryable and `suppressed` never was — a suppressed message had nowhere to send
 * to. Merging them would bury the ones somebody can act on, which is the same reason
 * `notifications.controller.ts` keeps them apart in its own response.
 */
export interface NotificationsOverviewWire {
  readonly dead: number;
  readonly suppressed: number;
}

/**
 * Catalogue health rather than a queue.
 *
 * `unpublishedDrafts` counts `product_versions` in `draft`: work somebody started and did
 * not publish. It is the only number here that tends to grow quietly.
 */
export interface CatalogOverviewWire {
  readonly products: number;
  readonly unpublishedDrafts: number;
  readonly optionGroups: number;
}

/**
 * Who can get in.
 *
 * `closed` and `erased` are deliberately absent: both are endings, neither is a queue, and
 * an erased-account count on a landing page is a number about people who asked to be
 * forgotten.
 */
export interface UsersOverviewWire {
  readonly active: number;
  readonly suspended: number;
}

export interface OverviewWire {
  readonly orders?: OrdersOverviewWire;
  readonly slips?: SlipsOverviewWire;
  readonly refunds?: RefundsOverviewWire;
  readonly money?: MoneyOverviewWire;
  readonly quotes?: QuotesOverviewWire;
  readonly reviews?: ReviewsOverviewWire;
  readonly notifications?: NotificationsOverviewWire;
  readonly catalog?: CatalogOverviewWire;
  readonly users?: UsersOverviewWire;
}
