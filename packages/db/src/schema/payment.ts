import {
  bigint,
  char,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { desc, sql } from 'drizzle-orm';
import { guests, users } from './auth.js';
import { ORDER_STATUSES, orderDocuments, orderEvents, orders } from './order.js';
import { bankAccounts } from './organisation.js';

/**
 * Money that has actually moved — phase 5b.
 *
 * The schedule, the slips and their review, the two-legged ledger, forfeits and refunds.
 * The sales-editable quote is 5c and its seam is `approvals` plus `order_documents`;
 * nothing here needs rewriting when it lands.
 *
 * Everything `order.ts` says about conventions holds here and is not repeated per column:
 * money is `bigint` minor units with the currency beside it and `_thb_` in the name,
 * closed sets are `text` + CHECK and never `pgEnum`, times are `timestamptz`, and a
 * comment says WHY.
 *
 * ── The five seams, settled once, before any table below ─────────────────────────
 *
 * Plan 7.13 found four independent designs writing one mechanism four times under four
 * names. These are the four names, and they are used nowhere else in this file:
 *
 *   `grand_total_thb_minor`   the single base. Instalments foot to it, the forfeit is a
 *                             fraction of a deposit derived from it, the ledger posts it.
 *                             Never derived backwards from a presentment currency.
 *
 *   `scheduled_deposit_thb_minor`  ONE function, pinned onto `orders` at submit (already
 *                             there since 5a). Nothing in this file recomputes it — it is
 *                             a term of the contract, and the ceiling on a forfeit.
 *
 *   paid vs settled           `order_cash_thb_minor()` folds `bank_thb`;
 *                             `order_settled_thb_minor()` folds allocations. They diverge
 *                             the first time a bank fee is written off, so they are two
 *                             functions with two names and never one column.
 *
 *   the nine accounts         named once, in `LEDGER_ACCOUNTS`, and enforced by CHECK.
 *
 *   the approvals table       one table, two dimensions. Six column pairs in six places
 *                             was the finding; this is the one pair.
 *
 * ── How many two-person rules this ships with, counted ───────────────────────────
 *
 * Plan 7.13 warns that eight two-person gates in one workflow kills the single control
 * that means anything, and plan 13 says nobody has answered how many people the company
 * actually has. So the count is stated rather than accumulated. **Four rules, in three
 * tables**, and every one of them is a plain CHECK on two columns of the same row:
 *
 *   `payment_slips`   reviewer ≠ submitter   — the single control plan 7.7 names
 *   `refunds`         approver ≠ requester
 *   `refunds`         disburser ≠ approver
 *   `approvals`       decider  ≠ requester
 *
 * And **nothing in this file requires an approval to exist.** Plan 13's smoke path —
 * one THB order, 30% deposit, one slip, accept, produce, deliver — touches none of the
 * four, because none of them fires until a second person is *named*. That is deliberate:
 * a schema that demanded an approver would be a schema that cannot be run by the company
 * that exists today, and the answer to "how many people" is still open.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** `in ('a', 'b')` for a CHECK, built from the literal list the TypeScript union comes from. */
const inList = (values: readonly string[]) =>
  sql.raw(`(${values.map((value) => `'${value}'`).join(', ')})`);

// ─────────────────────────────────────────────────────────────────────────────
// The chart of accounts — plan 7.13, named once
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Nine accounts. This list is the naming, and there is no other.
 *
 * The finding it closes: one bank fee was posted to `settlement_variance` on the way in
 * and to `revenue` on the way out, by two designs that each believed they were the only
 * one. A chart of accounts spread across four documents is four charts.
 *
 * What each one is for, because an account whose meaning is not written down is an
 * account somebody posts to for the wrong reason:
 *
 *   `bank_thb`               money in the company's baht account. Cash, and only cash.
 *   `remittance_in_transit`  an accepted slip for a transfer that has not landed yet
 *                            (plan 7.11: 1–2 working days for a cross-border wire). The
 *                            reason a refund may not be disbursed while it is non-zero.
 *   `deposit_held`           customer money received against an obligation not yet earned.
 *   `refund_payable`         approved and not yet transferred. A promise the company made,
 *                            and plan 7.12's reason it must be a visible queue.
 *   `credit_clearing`        the leg money moves through when it is carried from a
 *                            superseded order to its revision. No cash moves; this is why.
 *   `trade_receivable`       billed and not received.
 *   `revenue`                earned.
 *   `forfeited`              kept on a cancellation, within the deposit obligation.
 *   `settlement_variance`    the difference between what the rate said and what the bank
 *                            credited — FX spread, bank fee, refund FX. Not a bug; plan
 *                            7.11 calls it an accounting fact and sizes it at 2–3%.
 */
export const LEDGER_ACCOUNTS = [
  'bank_thb',
  'remittance_in_transit',
  'deposit_held',
  'refund_payable',
  'credit_clearing',
  'trade_receivable',
  'revenue',
  'forfeited',
  'settlement_variance',
] as const;

export type LedgerAccount = (typeof LEDGER_ACCOUNTS)[number];

/**
 * Why an entry was made. `text` + CHECK, so 5c adds one with a reversible migration.
 *
 * Not free text: the reconciliation screen plan 7.6 asks for groups by this, and a
 * free-text reason produces one group per typist.
 */
export const LEDGER_ENTRY_KINDS = [
  'slip_accepted',
  'remittance_landed',
  'revenue_recognised',
  'carried_forward',
  'forfeited',
  'refund_accrued',
  'refund_disbursed',
  'variance',
] as const;

export type LedgerEntryKind = (typeof LEDGER_ENTRY_KINDS)[number];

/** Plan 7.11: the difference has a *kind*, or every write-off looks like the same mistake. */
export const VARIANCE_KINDS = ['fx_spread', 'bank_fee', 'refund_fx'] as const;

// ─────────────────────────────────────────────────────────────────────────────
// The instalment model — plan 7.5(ก): a basis and a gate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How an instalment's amount is arrived at.
 *
 * Separating this from the gate is what makes the edge cases disappear without an `if`:
 * no deposit is one `remainder` row gating `production_confirmed`; payment in full is the
 * same one row; 30/70 is a `percent` row with the gate and a `remainder` row without one.
 * Three shapes, one code path.
 *
 * `remainder` is the one that moves. At most one per schedule and always last, because it
 * is defined as "whatever is left" — two of them is an unanswerable question, and one in
 * the middle would have to absorb a difference that later rows then change.
 */
export const INSTALMENT_BASES = ['percent', 'fixed', 'remainder'] as const;

export type InstalmentBasis = (typeof INSTALMENT_BASES)[number];

/**
 * Why a schedule stopped having to foot.
 *
 * Plan 7.5(ก) is explicit that the footing assertion must have an exemption or
 * cancellation-after-deposit is unrepresentable — and unrepresentable in a way that cannot
 * be fixed without a migration, on the day somebody needs to cancel an order that already
 * holds money. So the exemption is a *stamp on the schedule*, not a special case inside
 * the assertion: the schedule is closed, with a reason and a date, and a closed schedule
 * is exempt.
 */
export const SCHEDULE_CLOSE_REASONS = ['cancelled', 'superseded'] as const;

/**
 * The schedule as a row of its own, which exists for exactly one column.
 *
 * `closed_at` cannot live on `orders` — that file belongs to 5a and this is 5b's fact —
 * and it cannot live on the instalments, because closing is a property of the set and not
 * of any member. One row per order, created when the first instalment is written.
 *
 * It is also the join every "does this foot?" query starts from, which is why the
 * assertion trigger can be cheap: it looks here first and returns immediately for the two
 * terminal statuses.
 */
export const orderPaymentSchedules = pgTable(
  'order_payment_schedules',
  {
    orderId: uuid('order_id')
      .primaryKey()
      .references(() => orders.id, { onUpdate: 'cascade', onDelete: 'cascade' }),
    /**
     * When this schedule stopped being an obligation. Null while the order is live.
     *
     * Set in the same transaction as the move to `cancelled` or `superseded`. The
     * assertion refuses a terminal order whose schedule is still open *and* a live order
     * whose schedule is closed, so the two facts cannot drift apart in either direction.
     */
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedReason: text('closed_reason', { enum: SCHEDULE_CLOSE_REASONS }),
    ...timestamps,
  },
  (table) => [
    check(
      'order_payment_schedules_closed_shape',
      sql`num_nonnulls(${table.closedAt}, ${table.closedReason}) in (0, 2)`,
    ),
    check(
      'order_payment_schedules_close_reason_known',
      sql`${table.closedReason} is null or ${table.closedReason} in ${inList(SCHEDULE_CLOSE_REASONS)}`,
    ),
  ],
);

/**
 * One instalment: a basis and a gate.
 *
 * ── `seq` is dense from 1, and that is load-bearing ──────────────────────────────
 *
 * Plan 7.5(ค): the frontier is `MAX(seq) over the settled prefix`, written once and used
 * by both SQL and TypeScript. The rival formula is `COUNT(*) of settled instalments`, and
 * the two agree only while `seq` is dense and 1-based — the moment a schedule is edited
 * and leaves a hole, a count says "two paid" about instalments 1 and 3 and lets the gate
 * on 2 open. Rather than ban the count (which nobody can enforce), the schema makes the
 * two formulas identical by construction: `order_instalments_dense_seq` asserts
 * `min(seq) = 1 AND max(seq) = count(*)` over the whole schedule, deferred to commit so a
 * recompute may renumber freely inside its transaction.
 *
 * ── What is locked when money arrives, and what is not ───────────────────────────
 *
 * Plan 7.5(ง): an instalment money has touched is locked; the `remainder` absorbs the
 * difference. Both halves matter and the second is the one that surprises — **a
 * `remainder` cannot be locked**, because being the absorber is what it is for. Which is
 * also why "a gate, once open, never closes" is FALSE (see `order_gate_is_open()` in the
 * guards migration): a price rise after full payment can move the frontier backwards.
 *
 * The lock is a trigger and not a `locked_due_thb_minor` column, deliberately. A column
 * holding a copy of `due_thb_minor` is one more thing that can disagree with it, and
 * disagreeing silently is how this project's earlier phases lost data. The question the
 * column would answer — "was this locked?" — is `EXISTS (an allocation)`, which is a fact
 * already stored exactly once.
 */
export const orderInstalments = pgTable(
  'order_instalments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orderPaymentSchedules.orderId, {
        onUpdate: 'cascade',
        onDelete: 'cascade',
      }),
    /** 1-based and dense. See the block comment; the assertion is deferred to commit. */
    seq: integer('seq').notNull(),

    basis: text('basis', { enum: INSTALMENT_BASES }).notNull(),
    /** Basis points of `orders.grand_total_thb_minor`. 3000 is the 30 of a 30/70. */
    percentBp: integer('percent_bp'),
    /** A figure sales typed. Plan 7.10: it stays put when the price moves, and the remainder absorbs. */
    fixedThbMinor: bigint('fixed_thb_minor', { mode: 'bigint' }),

    /**
     * The amount owed, in the contract currency, after the basis has been applied.
     *
     * Stored rather than derived because the last instalment is *defined* as the
     * difference (plan 7.5(ก): ฿4,396 + ฿4,395, not ฿4,396 + ฿4,396) and because a
     * schedule that recomputes on read is a schedule whose past cannot be reconstructed.
     */
    dueThbMinor: bigint('due_thb_minor', { mode: 'bigint' }).notNull(),

    /**
     * The status this instalment must be settled through before the order may enter it.
     *
     * Null means "this instalment gates nothing" — the 70 of a 30/70. Plan 7.5(ข): the
     * freeze point did not move, the *condition* on it changed, so the ordinary gate is
     * `production_confirmed` and accepting the slip that closes it is the transition.
     * Later slips are payment-level events that move no order.
     *
     * ⚠️ There is deliberately no `awaiting_balance` status to gate. Outstanding balance is
     * derived — `order_outstanding_thb_minor()` — and a status parallel to `in_production`
     * differing only by a sum is a status that has to be kept in step with a sum.
     */
    gatesEntryTo: text('gates_entry_to', { enum: ORDER_STATUSES }),

    ...timestamps,
  },
  (table) => [
    unique('order_instalments_order_seq_key').on(table.orderId, table.seq),
    /* The handle `slip_allocations` hangs off, so an allocation can be proved to be this order's. */
    unique('order_instalments_id_order_key').on(table.id, table.orderId),

    check('order_instalments_seq_positive', sql`${table.seq} >= 1`),
    check('order_instalments_basis_known', sql`${table.basis} in ${inList(INSTALMENT_BASES)}`),
    check(
      'order_instalments_gate_known',
      sql`${table.gatesEntryTo} is null or ${table.gatesEntryTo} in ${inList(ORDER_STATUSES)}`,
    ),
    /*
     * ⚠️ A GATE ONLY MEANS SOMETHING ON A STATUS THE ORDER HAS NOT REACHED — 5b red team, a5.
     *
     * `order_gate_is_open()` is *"already entered this status OR the money gate is open"*,
     * and the first half is what makes a gate on `draft` or `awaiting_payment` permanently
     * open: the order is standing in one of them while the schedule is being written. So
     * those two are the same hole as a ฿0 gate, spelled differently, and `cancelled` /
     * `superseded` / `redesign` are worse — `redesign` is only reachable *through*
     * `production_confirmed`, so gating it gates nothing at all.
     *
     * The four that remain are the four a payment can legitimately stand in front of.
     */
    check(
      'order_instalments_gate_is_ahead_of_payment',
      sql`${table.gatesEntryTo} is null
          or ${table.gatesEntryTo} in ('production_confirmed', 'in_production', 'awaiting_installation', 'delivered')`,
    ),
    /*
     * ⚠️ AND A GATE THAT ASKS FOR NOTHING IS NOT A GATE — the same finding's other half.
     *
     * `order_settled_through()` is `due <= allocated`, so a `fixed 0` row gating
     * `production_confirmed` reports itself settled with ฿0.00 received and hands out the
     * freeze free, while the whole grand total sits outstanding. Plan 7.10 asks for a
     * *floor* under the gating instalment and plan 13 says the floor is an unanswered
     * business number — but zero is not a floor anybody has to decide, it is the absence of
     * one, and this is the line below which the feature is not a payment gate.
     *
     * The zero-deposit case is unaffected: it is one `remainder` row gating
     * `production_confirmed` whose due is the whole total.
     */
    check(
      'order_instalments_gate_needs_money',
      sql`${table.gatesEntryTo} is null or ${table.dueThbMinor} > 0`,
    ),
    /*
     * The basis carries exactly the parameter it needs and no other. A `percent` row with a
     * `fixed_thb_minor` beside it is a row two readers can disagree about, and one of them
     * is the recompute.
     */
    check(
      'order_instalments_basis_shape',
      sql`case ${table.basis}
            when 'percent'   then ${table.percentBp} between 1 and 10000 and ${table.fixedThbMinor} is null
            when 'fixed'     then ${table.fixedThbMinor} >= 0 and ${table.percentBp} is null
            else ${table.percentBp} is null and ${table.fixedThbMinor} is null
          end`,
    ),
    /* Plan 7.5(ง)(4) and 7.10: never let an instalment go negative — that is the refund path. */
    check('order_instalments_due_nonnegative', sql`${table.dueThbMinor} >= 0`),

    /*
     * At most one `remainder` per schedule. The other half — that it is *last* — needs to
     * compare rows and lives in `order_instalments_dense_seq()`; this index is the half a
     * unique index can carry, and it is the half that fails immediately rather than at
     * commit, which is a better error for the commonest mistake.
     */
    uniqueIndex('order_instalments_one_remainder')
      .on(table.orderId)
      .where(sql`basis = 'remainder'`),

    index('order_instalments_order_seq_idx').on(table.orderId, table.seq),
    /* The gate lookup: "which instalments must be settled before entering X?" */
    index('order_instalments_gate_idx')
      .on(table.gatesEntryTo)
      .where(sql`gates_entry_to is not null`),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Slips — plan 7.6
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where a slip is in the one review that matters.
 *
 * Plan 7.3, restated by 7.5(ข): rejecting a slip is **not** a transition of the order, and
 * neither is accepting one that is not the gating instalment's. Which is why there is no
 * order status here and no foreign key to a transition — a slip's life is its own.
 */
export const SLIP_STATUSES = ['submitted', 'accepted', 'rejected'] as const;

export type SlipStatus = (typeof SLIP_STATUSES)[number];

/**
 * A photograph of a bank transfer, and the human review that is the only control.
 *
 * Plan 7.7 says it plainly: manual payment saves the webhook, the reconciliation, the
 * refund API and the whole of PCI scope, and charges one thing — the person reviewing
 * slips is the bottleneck *and* the single point of failure. Plan 7.6 says the review
 * screen must be a two-column comparison and not a confirm button, because forged slips
 * are a known problem in Thailand.
 *
 * What this table contributes to that:
 *
 *   * `amount_thb_minor` is what the *slip* says, frozen the moment review ends, so the
 *     comparison has a fixed left-hand column;
 *   * the allocations must sum to it (deferred, see the guards migration), so a reviewer
 *     cannot settle instalments with money that never arrived;
 *   * `reviewed_by_user_id <> submitted_by_user_id`, which is the single two-person rule
 *     this phase is willing to spend;
 *   * PDPA (plan 7.6): the image and the identifying details are separate columns, so
 *     `storage_key` can be cleared on a retention sweep while the bank reference that
 *     reconciles the statement survives.
 */
export const paymentSlips = pgTable(
  'payment_slips',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onUpdate: 'cascade', onDelete: 'restrict' }),

    status: text('status', { enum: SLIP_STATUSES }).notNull().default('submitted'),

    /**
     * What the slip says was transferred, in THB minor units.
     *
     * THB and only THB, and the column name says so. Plan 7.11's foreign-currency line is
     * closed by plan 13's default, and the failure it is closed against is subtle: an
     * accumulator that does not name its currency is one somebody adds a USD figure to.
     * SEAM 5c: a presentment amount is *additional* columns beside this one, never a
     * reinterpretation of it.
     */
    amountThbMinor: bigint('amount_thb_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('THB'),

    /** When the bank says the money moved — not when the file was uploaded. */
    transferredAt: timestamp('transferred_at', { withTimezone: true }).notNull(),
    /** The bank's own reference, for the statement reconciliation plan 7.6 asks for. */
    bankReference: text('bank_reference'),

    /**
     * The private object-storage key. Read through a short-lived audited URL, never public.
     *
     * Nullable and clearable on purpose: plan 7.6's PDPA line is "delete the image, keep
     * the account row separately". `storage_key_erased_at` is what distinguishes a slip
     * whose image was deleted on policy from one that never had an image.
     */
    storageKey: text('storage_key'),
    storageKeyErasedAt: timestamp('storage_key_erased_at', { withTimezone: true }),

    /** Kept apart from the image so the image can go and the reconciliation can stay. */
    payerName: text('payer_name'),
    payerAccountLast4: char('payer_account_last4', { length: 4 }),

    /**
     * 🔒 WHO ATTESTED THAT THE TWO COLUMNS ABOVE MATCH THE IMAGE — 5b red team, RT-2.
     *
     * `payer_name` and `payer_account_last4` arrive on the customer's own create-slip body.
     * Nothing compares them to the picture, to the bank reference, or to anything a bank
     * said — so until this column is set they are **a field the payer typed**, and plan
     * 7.12's entire "refund to the account the money came from" control was being switched
     * off by the party it is a control against: name a mule account on the slip, request
     * the refund to the same mule account, and it reads as the original account.
     *
     * So the pair is only evidence once a reviewer has read them off the image and written
     * them back at acceptance. `deriveOriginalAccount` reads *only* verified slips; an
     * unverified payer is `no` — which is the answer that demands a reason and a separate
     * acknowledgement. Fails closed, in the customer's inconvenience and not their loss.
     */
    payerVerifiedByUserId: uuid('payer_verified_by_user_id').references(() => users.id, {
      onUpdate: 'cascade',
      onDelete: 'restrict',
    }),
    payerVerifiedAt: timestamp('payer_verified_at', { withTimezone: true }),

    /**
     * Money on this slip that closed no instalment — plan 7.8's hole, quantified by the red
     * team at ฿277.76 on a ฿19,722.24 order.
     *
     * Allocations must foot to the slip exactly and no instalment may absorb more than it is
     * due, so a ฿20,000 transfer against a ฿19,722.24 order had *nowhere* for the excess to
     * go: the slip could be neither accepted nor deleted nor truthfully rejected, the money
     * was in the bank and the system held zero. This column is where the excess goes. It is
     * held (`deposit_held` carries the whole face value) and it is settled against nothing,
     * which is exactly what it is — and it makes `paidMinor` and `settledMinor` genuinely
     * different numbers rather than two names for one fold.
     *
     * Zero on every slip that is not overpaid, and the reviewer has to acknowledge it.
     */
    /* `sql\`0\`` and not `0n`: drizzle-kit serialises the snapshot with `JSON.stringify`, which
     * refuses a BigInt outright — a literal here fails migration *generation*, not runtime. */
    unallocatedThbMinor: bigint('unallocated_thb_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),

    /** Who put it there. A customer, the guest they still are, or staff entering it by phone. */
    submittedByUserId: uuid('submitted_by_user_id').references(() => users.id, {
      onUpdate: 'cascade',
      onDelete: 'restrict',
    }),

    /**
     * 🔒 THE OTHER HALF OF THE SUBMITTER — 5b red team, RT-1, and the sharpest finding of
     * the round.
     *
     * `submitted_by_user_id` is NULL for every guest-submitted slip, and the guest funnel is
     * the *main* funnel (plan 6). Both halves of the two-person rule compared against that
     * one nullable column — `null <> reviewerId` in the service and `null IS DISTINCT FROM
     * null` in the CHECK — so both passed for every reviewer in the company, including the
     * one holding the browser that uploaded it. Two copies of one predicate over one
     * nullable column fail together.
     *
     * A guest is a real identity in this system (`guests.secret_hash`, migration 0008) and
     * signing in *claims* it, which is what makes the link recoverable: the slip records the
     * guest, and acceptance refuses a reviewer who is that guest's claimer.
     *
     * ⚠️ It does not close the case of a reviewer who uses a second browser and never
     * claims. Nothing identity-based can: an anonymous submitter is anonymous. What it does
     * close is the case that is actually reachable by one person following the ordinary
     * funnel, and it makes the residual honest rather than invisible.
     */
    submittedByGuestId: uuid('submitted_by_guest_id').references(() => guests.id, {
      onUpdate: 'cascade',
      onDelete: 'restrict',
    }),

    reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, {
      onUpdate: 'cascade',
      onDelete: 'restrict',
    }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    /** Plan 7.3: a rejection the customer cannot read is a rejection that produces a phone call. */
    rejectedReasonTh: text('rejected_reason_th'),

    /**
     * Which of the company's accounts received this transfer.
     *
     * Nullable: no slip existed when the column was added, and a retired account must stay
     * referenceable. `on delete restrict` is redundant beside `bank_accounts_block_delete`
     * and is written anyway, because a guard and a constraint fail differently and the
     * constraint is the one a reader finds.
     */
    receivedBankAccountId: uuid('received_bank_account_id').references(() => bankAccounts.id, {
      onDelete: 'restrict',
    }),

    /**
     * ⭐ WHY THIS PAYMENT HAS NO PICTURE — `0047_slip_without_evidence.sql`.
     *
     * The owner's report: *"เจ้าหน้าที่สามารถปิดยอดการชำระได้โดยไม่มีการยืนยันสลิป แต่ต้องระบุ
     * เหตุผล เพราะอาจมีกรณีที่ลูกค้าโอนชำระแล้วแต่ไม่ได้แนบสลิปยืนยัน"* — the customer really did
     * transfer, and really did not attach the slip.
     *
     * `storage_key` was already nullable, so a row with no image was *representable* before this
     * column existed; what it was not was **explicable**. This is the third arm of
     * `payment_slips_evidence_exists`: an image, an image that was erased, or a reason. Set by
     * staff at INSERT and frozen by `payment_slips_guard_write()` the moment the slip is
     * reviewed, because a reason somebody can improve after the money landed is not a trail.
     */
    noSlipReasonTh: text('no_slip_reason_th'),

    /**
     * 🔒 WHY THE REVIEWER IS ALSO THE SUBMITTER — a DECLARED bypass of the two-person rule.
     *
     * ⚠️ The database cannot see permissions, so this column does not mean "allowed". Whether
     * this reviewer may declare a bypass at all is `payments.self_review_slip`, checked in
     * `SlipsService.accept`. What the two enforcement points guarantee — the CHECK below and
     * `payment_slips_guard_write()`, which resolves a claimed guest to the same person — is that
     * reviewer = submitter is **refused unless this column is filled**, through every code path
     * there will ever be. The app decides whether; the database guarantees the trail.
     *
     * Null on every ordinary slip, which is what makes it the marker the audit list is built on
     * (`GET /payments/slips/recorded`).
     */
    selfReviewReasonTh: text('self_review_reason_th'),

    ...timestamps,
  },
  (table) => [
    unique('payment_slips_id_order_key').on(table.id, table.orderId),

    check('payment_slips_status_known', sql`${table.status} in ${inList(SLIP_STATUSES)}`),
    check('payment_slips_currency_is_thb', sql`${table.currency} = 'THB'`),
    /* A slip for nothing is not evidence of anything, and a negative one is a refund. */
    check('payment_slips_amount_positive', sql`${table.amountThbMinor} > 0`),
    check(
      'payment_slips_payer_last4_shape',
      sql`${table.payerAccountLast4} is null or ${table.payerAccountLast4} ~ '^[0-9]{4}$'`,
    ),
    check(
      'payment_slips_erasure_shape',
      sql`${table.storageKeyErasedAt} is null or ${table.storageKey} is null`,
    ),

    /*
     * The excess is money, so it obeys the same two rules every other amount here does: it
     * is never negative and it never exceeds the slip. `= amount` is allowed and means a
     * transfer that closed nothing at all — a customer paying an order that was already
     * settled — which is a real reconciliation case and not a reason to refuse the money.
     */
    check('payment_slips_unallocated_nonnegative', sql`${table.unallocatedThbMinor} >= 0`),
    check(
      'payment_slips_unallocated_within_amount',
      sql`${table.unallocatedThbMinor} <= ${table.amountThbMinor}`,
    ),
    /*
     * A slip nobody has accepted holds no excess, for the same reason it holds no
     * allocations: it is a photograph, not money. Without this an unreviewed slip could
     * carry a figure that `assert_slip_allocations()` would later measure against.
     */
    check(
      'payment_slips_unallocated_needs_acceptance',
      sql`${table.status} = 'accepted' or ${table.unallocatedThbMinor} = 0`,
    ),

    /*
     * The payer attestation is two columns and one fact, exactly like the review above.
     * Verified-by with no timestamp is a claim with no date on it.
     */
    check(
      'payment_slips_payer_verified_shape',
      sql`num_nonnulls(${table.payerVerifiedByUserId}, ${table.payerVerifiedAt}) in (0, 2)`,
    ),
    /*
     * There is nothing to attest to on a slip that names no payer, and attesting to nothing
     * would let `deriveOriginalAccount` treat an empty pair as corroborated.
     */
    check(
      'payment_slips_payer_verified_needs_payer',
      sql`${table.payerVerifiedByUserId} is null
          or (${table.payerName} is not null and ${table.payerAccountLast4} is not null)`,
    ),

    /*
     * Review is three columns and one fact. A slip marked accepted with no reviewer is a
     * slip nobody is accountable for, which is the entire control this design has.
     */
    check(
      'payment_slips_review_shape',
      sql`case ${table.status}
            when 'submitted' then ${table.reviewedByUserId} is null and ${table.reviewedAt} is null
                                  and ${table.rejectedReasonTh} is null
            when 'accepted'  then ${table.reviewedByUserId} is not null and ${table.reviewedAt} is not null
                                  and ${table.rejectedReasonTh} is null
            else ${table.reviewedByUserId} is not null and ${table.reviewedAt} is not null
                                  and ${table.rejectedReasonTh} is not null
          end`,
    ),
    /*
     * 🔒 Two-person rule #1 of the four this phase spends. The reviewer is the control
     * (plan 7.7); a reviewer approving their own upload is no control at all. `IS DISTINCT
     * FROM` and not `<>`: a customer-submitted slip has a null submitter when the customer
     * is a guest, and `null <> x` is null, which a CHECK passes.
     *
     * ⚠️ AND ON ITS OWN THAT MEANS THIS CHECK NEVER FIRES ON THE MAIN FUNNEL. A guest slip
     * has a null submitter, so this passes for every reviewer alive — red team RT-1, which
     * walked it end to end with one human and one private window. The half that closes it is
     * `submitted_by_guest_id` above plus `payment_slips_guard_write()` in
     * `0013_payment_closure.sql`, which refuses a reviewer who claimed the submitting guest.
     * A CHECK cannot do it because it needs a second table.
     *
     * ⭐ THE THIRD ARM IS `0047_slip_without_evidence.sql`, and it is not a hole. The owner chose
     * that a high permission may bypass this rule; the database has no way to read a permission,
     * so what it insists on instead is that the bypass is never *silent* — a self-review with no
     * `self_review_reason_th` is refused here and again in the trigger. Both had to move
     * together: amend one and the other still refuses, which is a feature that passes a unit test
     * and fails on the first real order.
     */
    check(
      'payment_slips_reviewer_is_not_submitter',
      sql`${table.reviewedByUserId} is null
          or ${table.reviewedByUserId} is distinct from ${table.submittedByUserId}
          or ${table.selfReviewReasonTh} is not null`,
    ),

    /*
     * ⭐ EVIDENCE EXISTS IN ONE OF THREE FORMS — `0047_slip_without_evidence.sql`.
     *
     *     an image · an image that was erased · a stated reason
     *
     * The middle arm is the one that is easy to leave out and expensive to leave out: a slip
     * whose picture the PDPA erasure destroyed has neither a `storage_key` nor a reason, is an
     * ordinary customer slip, and must stay legal. `payment_slips_erasure_shape` already refuses
     * the two erasure columns disagreeing, so that arm can only be true of a row that did once
     * carry an image.
     */
    check(
      'payment_slips_evidence_exists',
      sql`${table.storageKey} is not null
          or ${table.storageKeyErasedAt} is not null
          or ${table.noSlipReasonTh} is not null`,
    ),
    /* A reason made of spaces is the absence of a reason wearing a value. */
    check(
      'payment_slips_no_slip_reason_shape',
      sql`${table.noSlipReasonTh} is null or btrim(${table.noSlipReasonTh}) <> ''`,
    ),
    /*
     * A declared bypass belongs to a review. `payment_slips_review_shape` already holds
     * `reviewed_by_user_id` null on a `submitted` row, so this pins the declaration to the
     * decision it excuses — and makes `self_review_reason_th is not null` a *truthful* marker for
     * the audit list rather than a field anybody can fill in advance.
     */
    check(
      'payment_slips_self_review_shape',
      sql`${table.selfReviewReasonTh} is null
          or (btrim(${table.selfReviewReasonTh}) <> '' and ${table.reviewedByUserId} is not null)`,
    ),

    /* The reviewer's queue: oldest unreviewed first, and it costs nothing to look at. */
    index('payment_slips_review_queue_idx')
      .on(table.transferredAt)
      .where(sql`status = 'submitted'`),
    index('payment_slips_order_idx').on(table.orderId, table.transferredAt),
    /*
     * The audit surface the owner is trusting, and the reason it is cheap. "Which payments were
     * recorded with no slip" is a highly selective question over a table that grows with every
     * transfer, so the list is a scan of the exceptions rather than of the payments.
     */
    index('payment_slips_no_slip_idx')
      .on(desc(table.transferredAt))
      .where(sql`no_slip_reason_th is not null`),
  ],
);

/**
 * Which instalment this slip's money closed, and how much of it.
 *
 * ── The constraint that makes a reviewer's typing mean something ─────────────────
 *
 * `SUM(amount_thb_minor) = payment_slips.amount_thb_minor` for an accepted slip, as a
 * DEFERRED constraint trigger (plan 7.8). Without it the reviewer types the allocation
 * figures with nothing tying them to the slip, and instalments can be settled with money
 * that never arrived — a hole that produces no anomaly for a referential check to find,
 * because every row involved is individually valid.
 *
 * Deferred rather than immediate because a slip is allocated across two instalments in one
 * transaction and the first INSERT is legitimately short.
 *
 * ── Carrying money to a revision — plan 7.8 ──────────────────────────────────────
 *
 * When a frozen order is superseded, the money it holds moves to the revision **as an
 * allocation pointing back at the ancestor's slip**, never as a new instalment row on the
 * new order. As an instalment row the old order keeps folding its own slips forever, so
 * one payment is reported by two orders — and both reports are internally consistent.
 *
 * `carried_from_order_id` is what makes that visible rather than implicit: it is set
 * exactly when the slip's order is not the instalment's order, and the guards migration
 * checks it names a genuine ancestor by walking `orders.supersedes_order_id`.
 *
 * ⚠️ And the branch that reads this must be `held`, not `cash`. A carried allocation has
 * no `bank_thb` leg — the money was received by the ancestor — so a revision order's cash
 * is zero forever, and every "have we been paid?" that asks about cash answers wrongly.
 * `order_held_thb_minor()` exists for that question and is the one the forfeit clamp uses.
 */
export const slipAllocations = pgTable(
  'slip_allocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slipId: uuid('slip_id')
      .notNull()
      .references(() => paymentSlips.id, { onUpdate: 'cascade', onDelete: 'restrict' }),
    instalmentId: uuid('instalment_id')
      .notNull()
      .references(() => orderInstalments.id, { onUpdate: 'cascade', onDelete: 'restrict' }),

    amountThbMinor: bigint('amount_thb_minor', { mode: 'bigint' }).notNull(),

    /**
     * The ancestor whose money this is, when it is not this order's own.
     *
     * Null on the ordinary allocation. Non-null exactly when the slip belongs to a
     * different order from the instalment, and then it must equal the slip's order and
     * that order must be an ancestor of the instalment's — all three checked in
     * `slip_allocations_guard_write()`, because none of them is expressible as a CHECK.
     */
    carriedFromOrderId: uuid('carried_from_order_id').references(() => orders.id, {
      onUpdate: 'cascade',
      onDelete: 'restrict',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /*
     * One allocation per (slip, instalment). Two rows for the same pair would sum to the
     * same money and be twice as hard to reconcile against a statement line.
     */
    unique('slip_allocations_slip_instalment_key').on(table.slipId, table.instalmentId),
    /* Money moves towards an instalment; a zero row is noise and a negative one is a refund. */
    check('slip_allocations_amount_positive', sql`${table.amountThbMinor} > 0`),
    index('slip_allocations_instalment_idx').on(table.instalmentId),
    index('slip_allocations_slip_idx').on(table.slipId),
    index('slip_allocations_carried_idx')
      .on(table.carriedFromOrderId)
      .where(sql`carried_from_order_id is not null`),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// The ledger — plan 7.8: append-only, two-legged, a balance is a fold
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One movement of money, as a header. Its legs are `ledger_postings`.
 *
 * Append-only, enforced by trigger the way `order_events` is: no UPDATE, no DELETE, ever,
 * including on the postings. **A balance is a fold and never a column** — the moment a
 * running balance is stored, the stored number and the sum of the entries are two answers
 * to one question, and the wrong one is the one on the screen.
 *
 * Two legs minimum and they sum to zero, asserted at COMMIT (`ledger_entries_balance`).
 * Deferred because an entry and its legs are three statements, and an immediate check
 * would fail on the first one every time.
 */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Every movement in this system is about an order. There is no general ledger without one. */
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onUpdate: 'cascade', onDelete: 'restrict' }),
    kind: text('kind', { enum: LEDGER_ENTRY_KINDS }).notNull(),

    /** The slip this entry records, when it records one. */
    slipId: uuid('slip_id').references(() => paymentSlips.id, {
      onUpdate: 'cascade',
      onDelete: 'restrict',
    }),
    /**
     * The event on the order's spine that caused it, when there was one.
     *
     * A cancellation's forfeit points at the `cancelled` event, so "why is ฿5,530 in
     * `forfeited`?" is answerable without a join through dates. Composite FK below ties it
     * to this entry's own order.
     */
    eventId: uuid('event_id'),

    /** Plan 7.11: a variance without a kind is a write-off nobody can categorise later. */
    varianceKind: text('variance_kind', { enum: VARIANCE_KINDS }),

    memoTh: text('memo_th'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'ledger_entries_event_fk',
      columns: [table.eventId, table.orderId],
      foreignColumns: [orderEvents.id, orderEvents.orderId],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'ledger_entries_slip_fk',
      columns: [table.slipId, table.orderId],
      foreignColumns: [paymentSlips.id, paymentSlips.orderId],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),

    check('ledger_entries_kind_known', sql`${table.kind} in ${inList(LEDGER_ENTRY_KINDS)}`),
    check(
      'ledger_entries_variance_kind_known',
      sql`${table.varianceKind} is null or ${table.varianceKind} in ${inList(VARIANCE_KINDS)}`,
    ),
    /* A `variance` entry says which kind; nothing else may claim to be one. */
    check(
      'ledger_entries_variance_shape',
      sql`(${table.kind} = 'variance') = (${table.varianceKind} is not null)`,
    ),
    /* Slip-shaped kinds name their slip. An acceptance with no slip is an unsourced credit. */
    check(
      'ledger_entries_slip_required',
      sql`${table.kind} not in ('slip_accepted', 'remittance_landed') or ${table.slipId} is not null`,
    ),
    /* The unique the `ledger_postings` composite FK needs, so a leg cannot cross orders. */
    unique('ledger_entries_id_order_key').on(table.id, table.orderId),

    index('ledger_entries_order_idx').on(table.orderId, table.occurredAt),
    index('ledger_entries_kind_idx').on(table.kind, table.occurredAt),
  ],
);

/**
 * One leg. Debit positive, credit negative, and the legs of an entry sum to zero.
 *
 * A single signed column rather than a `direction` word plus a magnitude: the sum that
 * proves the entry balances is then `sum(amount_thb_minor) = 0`, which is one expression a
 * constraint trigger can run, instead of a CASE that gets the sign wrong once.
 */
export const ledgerPostings = pgTable(
  'ledger_postings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => ledgerEntries.id, { onUpdate: 'cascade', onDelete: 'restrict' }),
    /**
     * Denormalised from the entry, and tied to it by the composite FK below.
     *
     * Every fold in the guards migration is `WHERE order_id = $1 AND account = $2`; without
     * this column each of them is a join, and the balance of an order becomes the query
     * nobody wants to write on a dashboard.
     */
    orderId: uuid('order_id').notNull(),
    legNo: integer('leg_no').notNull(),
    account: text('account', { enum: LEDGER_ACCOUNTS }).notNull(),
    amountThbMinor: bigint('amount_thb_minor', { mode: 'bigint' }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ledger_postings_entry_fk',
      columns: [table.entryId, table.orderId],
      foreignColumns: [ledgerEntries.id, ledgerEntries.orderId],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    unique('ledger_postings_entry_leg_key').on(table.entryId, table.legNo),
    check('ledger_postings_account_known', sql`${table.account} in ${inList(LEDGER_ACCOUNTS)}`),
    check('ledger_postings_leg_no_positive', sql`${table.legNo} >= 1`),
    /* A zero leg is a leg that says nothing and still has to be reconciled by somebody. */
    check('ledger_postings_amount_nonzero', sql`${table.amountThbMinor} <> 0`),

    /* The fold. Every balance in this phase is this index plus a `sum()`. */
    index('ledger_postings_order_account_idx').on(table.orderId, table.account),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Forfeits — plan 7.8, and plan 13's "0 bps in every cell"
// ─────────────────────────────────────────────────────────────────────────────

/** Who caused the cancellation. 🔒 Never read from a request body — see the guards migration. */
export const FAULT_PARTIES = ['customer', 'company'] as const;

export type FaultParty = (typeof FAULT_PARTIES)[number];

/**
 * The statuses an order may be cancelled from — the row set the forfeit table must cover.
 *
 * ⚠️ A **mirror**, like `POST_FREEZE_STATUSES`. The definition is the six `→ cancelled`
 * rows in `order_status_transitions`, and `forfeit_policies_complete()` asserts coverage
 * against *those rows*, not against this array, so a seventh cancellable status added by
 * migration makes an incomplete policy fail at commit rather than silently forfeit zero.
 *
 * `redesign` is in the list. Plan 7.8 calls it the one everybody forgets.
 */
export const CANCELLABLE_STATUSES = [
  'draft',
  'awaiting_payment',
  'production_confirmed',
  'in_production',
  'awaiting_installation',
  'redesign',
] as const;

/**
 * ⚠️ A DEFAULT, NOT A DECISION — plan 13: "ริบ 0 ทุกช่อง = คืนเต็มเสมอ".
 *
 * Zero in every cell means every cancellation refunds in full. That is safe for the
 * customer and it is a real business exposure for the company, and shipping it is a choice
 * somebody has to make knowingly rather than discover. It is deliberately not a column
 * default: a `DEFAULT 0` is how a placeholder becomes a fact nobody remembers choosing.
 */
export const FORFEIT_BPS_DEFAULT = 0;

/**
 * A named set of forfeit rates, pinned onto an order at submit.
 *
 * A table and not a constant because plan 7.13 lists `forfeit_policy` among the seven
 * things one transaction pins: the rate that applied when the customer agreed is the rate
 * that applies when they cancel, and editing a live policy would rewrite past contracts.
 * Changing the numbers is therefore a new policy row, not an UPDATE.
 */
export const forfeitPolicies = pgTable(
  'forfeit_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(),
    descriptionTh: text('description_th').notNull(),
    /** Null while a policy is being written; non-null makes it usable and freezes its rules. */
    effectiveFrom: timestamp('effective_from', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('forfeit_policies_code_shape', sql`${table.code} ~ '^[a-z][a-z0-9_]*$'`)],
);

/**
 * One cell of (cancellable status × fault). Every cell, or the policy is not usable.
 *
 * Plan 7.8: **no `'ANY'` wildcard in the unique key.** A wildcard row is a value no CHECK
 * can define — is `('in_production', 'ANY')` beaten by `('in_production', 'customer')`? by
 * `('ANY', 'customer')`? — and every answer is somebody's refund. So the table is dense,
 * and `forfeit_policies_complete` (a DEFERRED constraint trigger) refuses an effective
 * policy with a missing cell.
 *
 * `production_confirmed` is **0 bps and that is structural**, not a default: nothing has
 * been cut at the freeze point — aluminium is cut in `in_production` — so a customer who
 * confirms and changes their mind five minutes later must not lose what a customer who
 * waited for the finished goods loses. The CHECK below makes a non-zero value there
 * unrepresentable, so nobody can set it by filling in a form.
 */
export const forfeitPolicyRules = pgTable(
  'forfeit_policy_rules',
  {
    policyId: uuid('policy_id')
      .notNull()
      .references(() => forfeitPolicies.id, { onUpdate: 'cascade', onDelete: 'cascade' }),
    fromStatus: text('from_status', { enum: ORDER_STATUSES }).notNull(),
    fault: text('fault', { enum: FAULT_PARTIES }).notNull(),
    /** Of `min(received, scheduled_deposit)` — never of the total, and never of cash alone. */
    forfeitBp: integer('forfeit_bp').notNull(),
    noteTh: text('note_th'),
  },
  (table) => [
    primaryKey({
      name: 'forfeit_policy_rules_pkey',
      columns: [table.policyId, table.fromStatus, table.fault],
    }),
    /*
     * ⚠️ THIS IS WHAT MAKES "NO `'ANY'` WILDCARD" A RULE AND NOT A STYLE.
     *
     * Found by the test: without it, `INSERT … ('ANY', 'customer', 0)` succeeds. Drizzle's
     * `{ enum }` narrows the TypeScript type and narrows nothing in Postgres, so the row
     * arrives, the completeness assertion still passes (it counts real statuses), and the
     * table now contains a value that every reader has to have an opinion about — which is
     * exactly the wildcard plan 7.8 forbids, inserted by the path nobody was watching.
     */
    check('forfeit_policy_rules_from_status_known', sql`${table.fromStatus} in ${inList(ORDER_STATUSES)}`),
    check('forfeit_policy_rules_fault_known', sql`${table.fault} in ${inList(FAULT_PARTIES)}`),
    check('forfeit_policy_rules_bp_in_range', sql`${table.forfeitBp} between 0 and 10000`),
    /* Nothing is cut until `in_production`. Plan 7.8, and not overridable by data entry. */
    check(
      'forfeit_policy_rules_freeze_point_forfeits_nothing',
      sql`${table.fromStatus} <> 'production_confirmed' or ${table.forfeitBp} = 0`,
    ),
    /*
     * The company's own fault is never the customer's cost. A bounce from the factory that
     * ends in a cancellation refunds in full, in every status.
     */
    check(
      'forfeit_policy_rules_company_fault_forfeits_nothing',
      sql`${table.fault} <> 'company' or ${table.forfeitBp} = 0`,
    ),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Refunds — plan 7.12
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `requested` → `approved` → `disbursed`, or `rejected`. Nothing returns to `requested`.
 *
 * The one-way rule is what makes the freeze below meaningful: if a refund could be sent
 * back for editing, "frozen once it leaves `requested`" would be a lock with a key beside
 * it.
 */
export const REFUND_STATUSES = ['requested', 'approved', 'rejected', 'disbursed'] as const;

export type RefundStatus = (typeof REFUND_STATUSES)[number];

/**
 * Money going back out, with the same standard of evidence as money coming in.
 *
 * ── Why the amount and the payee freeze at `requested` ───────────────────────────
 *
 * Plan 7.12, and it is the sharpest finding in the round: approve ฿3,594, then edit the
 * row to ฿359,400 and change the destination account, and **the approval approved
 * nothing**. So `refunds_freeze_after_requested()` refuses any change to the amount, the
 * currency, the order, the accrual entry or any payee column once the status has left
 * `requested`. The status column itself still moves — that is the whole point of the row.
 *
 * ── Three separate people, and why that is only two rules ────────────────────────
 *
 * Approver ≠ requester and disburser ≠ approver, both as CHECKs on this row. Not
 * disburser ≠ requester: with three roles and possibly two employees that is the rule that
 * makes refunds impossible, and plan 7.13 is explicit that a control everybody has to
 * click past is worse than no control.
 *
 * ── The two rules that are not about people ──────────────────────────────────────
 *
 *   `accrual_entry_id NOT NULL` and the amount must equal what that entry accrued into
 *   `refund_payable`. A refund whose figure is typed rather than derived is a figure with
 *   no obligation behind it — plan 7.12's "อนุมัติแล้วยังไม่โอน = คำสัญญาที่บริษัทให้ไว้"
 *   only means anything if the promise and the payable are the same number.
 *
 *   `currency = 'THB'`, always (plan 7.12). The company never holds another currency;
 *   refunding in đồng means buying đồng, which is taking an FX position nobody decided to
 *   take. The *ceiling* is computed in the currency received — that is `core`'s job and it
 *   happens before this row exists.
 */
export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onUpdate: 'cascade', onDelete: 'restrict' }),
    status: text('status', { enum: REFUND_STATUSES }).notNull().default('requested'),

    /**
     * The ledger entry that put this amount into `refund_payable`. Required, always.
     *
     * The refund exists because an obligation was recorded; it does not create one. Tied
     * to this refund's order by the composite FK below, so a refund cannot be accrued on
     * one order and paid against another.
     */
    accrualEntryId: uuid('accrual_entry_id').notNull(),
    amountThbMinor: bigint('amount_thb_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('THB'),

    /**
     * Where it goes. Frozen with the amount, for the same reason.
     *
     * `payee_is_original_account` exists because plan 7.12 names the sentence exactly:
     * *"please refund to a different account"* is what a fraudster says. False is not
     * forbidden here — it is made *visible*, so the API can require the separate approval
     * and the report can count them.
     */
    payeeName: text('payee_name').notNull(),
    payeeBankCode: text('payee_bank_code').notNull(),
    payeeAccountLast4: char('payee_account_last4', { length: 4 }).notNull(),
    payeeIsOriginalAccount: text('payee_is_original_account', { enum: ['yes', 'no'] })
      .notNull()
      .default('yes'),

    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id, { onUpdate: 'cascade', onDelete: 'restrict' }),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),

    approvedByUserId: uuid('approved_by_user_id').references(() => users.id, {
      onUpdate: 'cascade',
      onDelete: 'restrict',
    }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),

    disbursedByUserId: uuid('disbursed_by_user_id').references(() => users.id, {
      onUpdate: 'cascade',
      onDelete: 'restrict',
    }),
    disbursedAt: timestamp('disbursed_at', { withTimezone: true }),
    /** The outbound transfer's own evidence. Plan 7.12: the way out is as documented as the way in. */
    disbursementReference: text('disbursement_reference'),

    rejectedReasonTh: text('rejected_reason_th'),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: 'refunds_accrual_entry_fk',
      columns: [table.accrualEntryId, table.orderId],
      foreignColumns: [ledgerEntries.id, ledgerEntries.orderId],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    /* One refund per accrual. Two refunds against one payable is the payable paid twice. */
    unique('refunds_accrual_entry_key').on(table.accrualEntryId),

    check('refunds_status_known', sql`${table.status} in ${inList(REFUND_STATUSES)}`),
    check('refunds_currency_is_thb', sql`${table.currency} = 'THB'`),
    check('refunds_amount_positive', sql`${table.amountThbMinor} > 0`),
    check(
      'refunds_payee_last4_shape',
      sql`${table.payeeAccountLast4} ~ '^[0-9]{4}$'`,
    ),
    check(
      'refunds_payee_original_known',
      sql`${table.payeeIsOriginalAccount} in ('yes', 'no')`,
    ),

    check(
      'refunds_status_shape',
      sql`case ${table.status}
            when 'requested' then ${table.approvedByUserId} is null and ${table.disbursedByUserId} is null
                                  and ${table.rejectedReasonTh} is null
            when 'rejected'  then ${table.rejectedReasonTh} is not null and ${table.disbursedByUserId} is null
            when 'approved'  then ${table.approvedByUserId} is not null and ${table.approvedAt} is not null
                                  and ${table.disbursedByUserId} is null
            else ${table.approvedByUserId} is not null and ${table.disbursedByUserId} is not null
                 and ${table.disbursedAt} is not null and ${table.disbursementReference} is not null
          end`,
    ),
    /* 🔒 Two-person rules #2 and #3. See the block comment for why there is no third. */
    check(
      'refunds_approver_is_not_requester',
      sql`${table.approvedByUserId} is null
          or ${table.approvedByUserId} <> ${table.requestedByUserId}`,
    ),
    check(
      'refunds_disburser_is_not_approver',
      sql`${table.disbursedByUserId} is null
          or ${table.disbursedByUserId} <> ${table.approvedByUserId}`,
    ),

    /* Plan 7.12's visible queue. Approved and not yet transferred is a promise, not a state to hide. */
    index('refunds_payable_queue_idx')
      .on(table.approvedAt)
      .where(sql`status = 'approved'`),
    index('refunds_order_idx').on(table.orderId, table.requestedAt),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Approvals — plan 7.13: ONE table, two dimensions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two dimensions, and nothing else.
 *
 *   `margin`    anything that reduces what the customer pays — a discount, a price
 *               override, an FX concession accepted as closing an instalment.
 *   `cashflow`  anything that reduces the money in hand before production opens — a
 *               deposit below the floor, or a schedule with no gate at all, which is the
 *               company extending credit and plan 7.10 says so.
 *
 * Six designs produced this rule six times with six column pairs, one of which passed
 * whenever `approved_by IS NULL`. One table, one pair, one CHECK.
 */
export const APPROVAL_DIMENSIONS = ['margin', 'cashflow'] as const;

export type ApprovalDimension = (typeof APPROVAL_DIMENSIONS)[number];

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;

/**
 * One decision about one **quote revision**, in one dimension.
 *
 * Assessed **at the document level at submit**, not per line: plan 7.13 found per-row
 * evaluation losing to the obvious attack of splitting one concession across five lines.
 *
 * ── ⭐ WHY THE SUBJECT IS `quote_revision` AND NOT `order_document_id` ─────────────
 *
 * It was `order_document_id`, keyed `(document, dimension)`, and the 5c red team walked
 * straight through it:
 *
 *   an approver approves ฿9,630 against a ฿138,240 line — 6.97%, entirely defensible;
 *   sales then revokes that override, removes the line, adds a ฿6,912 line and sets it
 *   to ฿0.00. The new concession is ฿7,395.84, which is ≤ ฿9,630, so it is "covered"
 *   and the order leaves the building at a 100% discount nobody looked at.
 *
 * An absolute figure attached to an *order* is a standing line of credit. It never expires,
 * is never consumed, and does not name the thing it was measured against — so it licenses
 * any later concession that happens to be smaller.
 *
 * There is a second reason, and it is structural rather than adversarial: `order_documents`
 * only exists after a submit pins one, and the gate that refuses the submit **rolls that pin
 * back**. Keying on the document therefore made the request that answers a refusal impossible
 * to record — the row it needed to point at had ceased to exist. Both problems have one fix:
 * the subject is the quote revision, which exists before submit, is a digest of the live
 * lines and overrides, and changes if and only if the quote is different.
 *
 * `order_document_id` stays, nullable, as *evidence*: when the request is raised against a
 * quote that has already been pinned once, it records which revision the approver was looking
 * at. It is no longer what the decision is keyed to.
 *
 * ⚠️ Nothing requires a row here. Plan 13's authority table is empty on day one and the
 * documented default is fail-closed — *sales cannot discount until the owner fills it in*
 * — which is a rule about what the API refuses, not about what the database demands. A
 * trigger demanding an approval would make plan 13's smoke path impossible, and a feature
 * that cannot be smoke-tested on day one is the feature that dies quietly.
 */
export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onUpdate: 'cascade', onDelete: 'restrict' }),
    /** Evidence, not the key. NULL when the quote has never been pinned — see the note above. */
    orderDocumentId: uuid('order_document_id'),
    /**
     * ⭐ The subject: `quoteRevision(lines, overrides)`, 16 lowercase hex.
     *
     * A digest of the live quote, so an approval covers **that quote** and nothing else. Edit
     * one line afterwards and the digest moves, the approval stops covering, and the request
     * has to be made again — which is what "the approver approved this document" means when it
     * is enforced rather than assumed.
     */
    quoteRevision: char('quote_revision', { length: 16 }).notNull(),
    dimension: text('dimension', { enum: APPROVAL_DIMENSIONS }).notNull(),
    status: text('status', { enum: APPROVAL_STATUSES }).notNull().default('pending'),

    /**
     * How big the concession is, in THB minor units, always positive.
     *
     * `margin`: how much less the customer pays than the computed price.
     * `cashflow`: how much less arrives before production than the deposit floor requires.
     * One column because the authority ceiling plan 13 asks the owner for is one number
     * per dimension per role, and a ceiling compared against two columns is two ceilings.
     */
    concessionThbMinor: bigint('concession_thb_minor', { mode: 'bigint' }).notNull(),
    reasonTh: text('reason_th').notNull(),

    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id, { onUpdate: 'cascade', onDelete: 'restrict' }),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, {
      onUpdate: 'cascade',
      onDelete: 'restrict',
    }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNoteTh: text('decision_note_th'),
    /**
     * The decider's own ceiling **at the moment they approved**, in THB minor.
     *
     * Without it, an owner who raises a limit next month makes last month's approvals look
     * unnecessary, and one who lowers it makes them look like abuses. Both readings are wrong
     * and neither is recoverable from `authority_limits`, which holds only today's number.
     * Two agents recommended this column in 5c and neither owned the file; this is it.
     *
     * NULL on `pending` and on `rejected`: saying no is not an exercise of authority, and
     * `AuthorityService.decide` deliberately needs no ceiling to reject.
     */
    decidedCeilingThbMinor: bigint('decided_ceiling_thb_minor', { mode: 'bigint' }),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: 'approvals_document_fk',
      columns: [table.orderDocumentId, table.orderId],
      foreignColumns: [orderDocuments.id, orderDocuments.orderId],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    /*
     * At most one OPEN request per order per dimension. Not `(revision, dimension)` unique:
     * a quote that is edited, refused, edited again and refused again accumulates a decided
     * row per revision, which is the history an auditor needs — what must not accumulate is
     * two questions waiting for one answer.
     */
    uniqueIndex('approvals_one_open_per_order_dimension')
      .on(table.orderId, table.dimension)
      .where(sql`status = 'pending'`),

    check('approvals_dimension_known', sql`${table.dimension} in ${inList(APPROVAL_DIMENSIONS)}`),
    check(
      'approvals_quote_revision_is_hex',
      sql`${table.quoteRevision} ~ '^[0-9a-f]{16}$'`,
    ),
    /* A pinned ceiling exists exactly when there is an approval it belonged to. */
    check(
      'approvals_ceiling_shape',
      sql`(${table.status} = 'approved') = (${table.decidedCeilingThbMinor} is not null)`,
    ),
    /* 🔒 And it covered the figure. The service refuses first, for the sentence; this is the rule. */
    check(
      'approvals_ceiling_covers_concession',
      sql`${table.decidedCeilingThbMinor} is null
          or ${table.decidedCeilingThbMinor} >= ${table.concessionThbMinor}`,
    ),
    check('approvals_status_known', sql`${table.status} in ${inList(APPROVAL_STATUSES)}`),
    check('approvals_concession_positive', sql`${table.concessionThbMinor} > 0`),
    check(
      'approvals_decision_shape',
      sql`case ${table.status}
            when 'pending' then ${table.decidedByUserId} is null and ${table.decidedAt} is null
            else ${table.decidedByUserId} is not null and ${table.decidedAt} is not null
          end`,
    ),
    /* 🔒 Two-person rule #4 — the last one this phase spends. */
    check(
      'approvals_decider_is_not_requester',
      sql`${table.decidedByUserId} is null
          or ${table.decidedByUserId} <> ${table.requestedByUserId}`,
    ),
    /* The approver's inbox plan 7.13 lists as a screen nobody had designed. */
    index('approvals_pending_idx')
      .on(table.createdAt)
      .where(sql`status = 'pending'`),
    index('approvals_order_idx').on(table.orderId),
  ],
);
