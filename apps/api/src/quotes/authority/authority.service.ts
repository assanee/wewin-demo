import { Inject, Injectable } from '@nestjs/common';
import type { TaxRule } from '@wewin/core/vat';
import { APPROVAL_DIMENSIONS, type ApprovalDimension } from '@wewin/db/schema';

import { AppError } from '../../common/errors/app-error';
import { DEFAULT_VAT_RULE } from '../../orders/defaults';
/* The one definition of a live obligation, as the pure function it is — see `write-off.service.ts`. */
import { isLiveOrder } from '../../orders/live-order';
import { OrderRepository } from '../../orders/order.repository';
import { GATE_COVERAGE_BP_DEFAULT } from '../../payments/schedule';
import { scopeHolds, type Scope } from '../../rbac';
import { approvalRights, WRITE_OFF_PERMISSION, type ApprovalRights } from './approval-rights';
import { DEPOSIT_POLICY, type DepositPolicyPort } from './deposit-policy.port';
import {
  ConcessionIntegrityError,
  measureCashflow,
  measureMargin,
  type DimensionMeasurement,
  type DocumentConcessions,
} from './concession';
import {
  AuthorityRepository,
  type ApprovalRow,
  type AuthorityLimitChangeRow,
  type AuthorityLimitRow,
  type AuthorityLimitSnapshot,
  type AuthorityTx,
  type GroupFacts,
  type OrderFacts,
} from './authority.repository';

/**
 * Who may reduce what the customer pays, and by how much.
 *
 * ── The one rule, and everything else is a consequence of it ─────────────────────
 *
 *     a concession is allowed when it is at or below the ceiling of the person making it,
 *     or when somebody **who is not that person and whose own ceiling covers it** has
 *     approved it.
 *
 * The second clause is the one that is easy to leave out and is load-bearing. Without it the
 * approval route is a way around the authority table: on a database with zero rows in
 * `authority_limits` — which is how this ships, and plan 13 says so — anybody holding the
 * decision permission could approve any figure, and *"fail closed"* would be a comment. With
 * it, no rows means **nothing can be granted and nothing can be approved**, which is what plan
 * 13's *"ยังไม่มีแถว = ยังลดราคาไม่ได้"* actually asks for.
 *
 * ── Two dimensions, one table, and no fifth mechanism ────────────────────────────
 *
 * `margin` and `cashflow` from `approvals`, imported and not redeclared. The two-person rule
 * is `approvals_decider_is_not_requester`, which already exists — this file refuses the same
 * thing first so that the answer is a Thai sentence rather than a 23514, and the CHECK is what
 * makes the refusal true rather than merely usual. `tests/payments/payment.test.ts` fails if a
 * fifth two-person mechanism appears anywhere, and nothing here adds one.
 *
 * ── At the document level, on submit ─────────────────────────────────────────────
 *
 * `gate` is called once, with the whole quote, inside the submit transaction. Per-row
 * evaluation is the hole plan 7.13 names and it is not merely weaker — it is *defeated by
 * arithmetic*: ten lines at 10% each is a 22% document that ten individually-legal decisions
 * produced and nobody reviewed.
 *
 * ── ⚠️ Three things this file cannot do, stated rather than worked around ────────
 *
 * 1. **There is no `quotes.approve` permission.** `rbac/permissions.ts` is not this agent's
 *    file. The decision route is behind `quotes.write` — which every salesperson holds — so
 *    what separates an approver from a requester today is (a) the two-person CHECK and (b) the
 *    decider's own ceiling, which is the real control. The permission that should exist is
 *    `quotes.approve`, held by fewer people, and it is reported rather than invented here.
 *    Same call the refund module made about `payments.refund_other_account`, for the same
 *    reason.
 *
 * 2. ~~**The cashflow floor is plan 13's placeholder, and it collides with plan 13's smoke
 *    path.**~~ Closed. The floor was `GATE_COVERAGE_BP_DEFAULT` — 10,000 bp, payment in full —
 *    so a 30% deposit measured as a 70% `cashflow` concession, while plan 13's smoke path says
 *    *"มัดจำ 30%"* and must run with no approval. Both could not be true. **The owner has now set
 *    the floor**: it is `organisation_profile.deposit_bp`, applied to the submit's schedule and to
 *    this measurement by the same value, so the two are one setting rather than two opinions.
 *
 *    ⭐ And it is **pinned onto the order at submit** — `orders.deposit_floor_bp`, written by
 *    `applySubmission` beside `scheduled_deposit_thb_minor`, read here in preference to the live
 *    setting. Reading `DepositPolicyPort` on every measurement made the reported concession a
 *    function of when you asked: move the policy from 30% to 100% next month and last month's
 *    order retroactively reports a 70% concession. Same class of defect as note 3 below, same
 *    remedy, and `measureFor` says what the fallback covers.
 *
 *    ⚠️ The consequence, stated in both directions, because the old sentence said only one of
 *    them and was half wrong the moment the setting became live: a deposit **at** policy is not
 *    a concession at all — the schedule gates exactly what the floor requires, the measurement
 *    is ฿0.00 and no approval is asked for. A deposit **below** policy still is one, and with
 *    `authority_limits` empty — which is how this ships, and what plan 13 documents — it will
 *    demand an approval that fail-closed cannot grant. Authoring a schedule below the company's
 *    own policy is the company extending credit (plan 7.10); needing somebody's authority for
 *    that is the feature, and there is no route that can author one yet.
 *
 * 3. ~~**Nothing here can tell whether an approval was needed *at the time*.**~~ Closed:
 *    `approvals.decided_ceiling_thb_minor` records the decider's own ceiling at the moment they
 *    approved, so raising a limit next month no longer makes last month's approvals look
 *    unnecessary. `approvals_ceiling_shape` makes it present exactly on an approval, and
 *    `approvals_ceiling_covers_concession` makes the CHECK say what this file's 403 says.
 */

/** What the ceiling comparison concluded, per dimension. */
export type DimensionOutcome =
  | { readonly kind: 'nothing_conceded' }
  | { readonly kind: 'within_authority'; readonly ceilingThbMinor: bigint }
  | {
      readonly kind: 'covered_by_approval';
      readonly approvalId: string;
      readonly approvedThbMinor: bigint;
      /** The quote this approval was measured against — and it is this one. See `judge`. */
      readonly quoteRevision: string;
    }
  | {
      readonly kind: 'needs_approval';
      /** `null` means the actor's roles carry no authority row at all — plan 13's fail-closed. */
      readonly ceilingThbMinor: bigint | null;
      readonly pendingApprovalId: string | null;
    };

export interface DimensionAssessment {
  readonly measurement: DimensionMeasurement;
  readonly outcome: DimensionOutcome;
}

/**
 * How far back the queue reads.
 *
 * The filtering is done here rather than in SQL so that `approvalRights` is the *only* statement
 * of who may decide what — a WHERE clause comparing `concession_thb_minor` against a ceiling
 * would be a second one, in a second language, and the two would eventually disagree about
 * `>=`. The cost is that the queue reads pending rows and discards some, which is why the read
 * is bounded and why exceeding the bound is reported (`isTruncated`) rather than silently
 * truncating a count somebody is about to reconcile against the overview.
 *
 * 200 matches the maximum `approvalQuerySchema` allows the unfiltered list, deliberately: two
 * different ideas of "too many pending approvals to show at once" would be one more thing to
 * keep in step.
 */
export const APPROVAL_QUEUE_SCAN_MAX = 200;

/** What one approver may decide right now, and how much they are not being shown. */
export interface ApprovalQueue {
  readonly approvals: readonly ApprovalRow[];
  readonly ceilings: Readonly<Record<ApprovalDimension, bigint | undefined>>;
  readonly beyondYourAuthority: number;
  readonly yourOwnRequests: number;
  readonly isTruncated: boolean;
}

export interface AuthorityAssessment {
  readonly orderId: string;
  readonly orderNo: string | null;
  /** The digest of the quote every figure below was measured from. */
  readonly quoteRevision: string;
  readonly margin: DimensionAssessment;
  readonly cashflow: DimensionAssessment;
  /** False when any dimension is `needs_approval`. The one boolean submit branches on. */
  readonly allowed: boolean;
}

@Injectable()
export class AuthorityService {
  constructor(
    private readonly repository: AuthorityRepository,
    /**
     * The company's deposit percentage — the `cashflow` floor, and nothing else.
     *
     * One method, read-only, declared by this module in `deposit-policy.port.ts` and implemented
     * by `OrganisationModule`. See that file for why the floor arrives this way rather than as a
     * parameter on `measureFor`: two of its three callers are HTTP controllers with no deposit in
     * scope, and threading it from them would put a settings read into a controller.
     */
    @Inject(DEPOSIT_POLICY) private readonly depositPolicy: DepositPolicyPort,
    /**
     * ⭐ 0051, and used for exactly one call: `appendEvent`, to put an approved write-off on the
     * order's timeline.
     *
     * The repository and not `OrdersService`. This module's header records that it deliberately
     * does not import `OrdersModule`, and that still holds — the class is listed in this module's
     * own `providers`, the way `SlipsModule` does it, so no module edge appears and nothing here
     * can drive the state machine. `appendEvent`'s own note is the licence: *"There is one way
     * onto the spine and it is this method"*, because the outbox reads that table and nothing
     * else. A write-off that skipped it would be an event nobody could be notified about.
     */
    private readonly orders: OrderRepository,
  ) {}

  /* ---------------------------------------------------------------- *
   * Measuring
   * ---------------------------------------------------------------- */

  /**
   * What this quote concedes, in both dimensions, read from the rows.
   *
   * `tx` is optional and the submit path must pass one: measuring outside the transaction that
   * is about to pin the document measures a quote that may already have changed.
   *
   * **It takes no measurement input of any kind, and that is deliberate.** Every figure comes
   * from rows read here. A gate with a parameter that changes the figure is a gate with a
   * parameter for getting past it, and the one such parameter that existed — `settlementShortfalls`
   * — had no producer anywhere in the application and could be threaded into `gate` without
   * being threaded into `request`, which would have made an order permanently unsubmittable.
   */
  async measure(orderId: string, tx?: AuthorityTx): Promise<DocumentConcessions> {
    const order = await this.repository.readOrder(orderId, tx);
    if (order === undefined) throw AppError.notFound('ไม่พบใบเสนอราคานี้');

    return this.measureFor(order, tx);
  }

  private async measureFor(order: OrderFacts, tx?: AuthorityTx): Promise<DocumentConcessions> {
    /*
     * ⭐ THE FLOOR THIS ORDER WAS JUDGED AGAINST — THE PIN FIRST, THE LIVE SETTING ONLY IF THERE
     * ISN'T ONE.
     *
     * ── What the live read got wrong ─────────────────────────────────────────────
     *
     * This was `await this.depositPolicy.depositBp(tx)`, unconditionally, and that made the
     * `cashflow` figure a function of *when you asked*. An order submitted while the policy was
     * 30% and re-read after the owner moved it to 100% reported a 70% concession nobody ever
     * asked for — on `GET /quotes/authority/orders/:orderId` and on the `live` figure in
     * `approval` below, both of which are the audit surfaces.
     *
     * Enforcement never moved: `gate` has one production caller and it runs inside the submit
     * transaction, where the setting cannot have moved yet. So this was display and audit rather
     * than money, and an audit trail that answers a different question each time it is asked is
     * still not one.
     *
     * ── Why the answer is a column on `orders` and not an argument ───────────────
     *
     * `measure`, `assess` and `request` all reach here, and two of them arrive from HTTP
     * controllers with no submit transaction and no deposit in scope — which is why the port
     * exists and why threading a `floorBp` down from every entry point was rejected when the
     * floor became live (see `deposit-policy.port.ts`). None of that changes: the floor still
     * does not appear in this signature. It arrives on the row that is already being read,
     * pinned by `applySubmission` in the same statement that pins the document totals and the
     * deposit it is compared against.
     *
     * `??` and not a hard requirement, in two cases that are different facts with one honest
     * answer:
     *
     *   before submit   `grand_total_thb_minor` is NULL, so `measureCashflow` is handed a zero
     *                   total and an empty schedule and returns ฿0.00 whatever the floor is. The
     *                   value read here is not consulted; the fallback keeps the draft path
     *                   working without pretending a floor exists.
     *   already submitted, no pin
     *                   every order that predates the column. There is no recorded floor and
     *                   `0034` refused to invent one, so the live setting is the only figure
     *                   available — which is exactly the behaviour those rows have today.
     *
     * `tx` is still forwarded on the fallback, for the reason it always was: a gate measuring the
     * floor on a different connection from the one it is about to commit reads a setting this
     * transaction cannot see.
     */
    const floorBp = order.depositFloorBp ?? (await this.depositPolicy.depositBp(tx));

    const [lines, overrides, instalments] = await Promise.all([
      this.repository.liveLines(order.id, tx),
      this.repository.liveOverrides(order.id, tx),
      this.repository.instalments(order.id, tx),
    ]);

    const vat = await this.vatRuleFor(order, tx);

    let margin: DimensionMeasurement;
    try {
      margin = measureMargin({ vat, lines, overrides });
    } catch (error) {
      /*
       * Plan 7.9(จ)'s category: an override whose line is not live cannot happen — the line
       * guard refuses the removal — so it is an integrity alarm and not a 409. It is a 500 on
       * purpose: there is no client action that recovers from it, and answering 409 would
       * invite a retry loop against a database that needs a person.
       */
      if (error instanceof ConcessionIntegrityError) {
        throw new AppError('INTERNAL', 500, 'ข้อมูลส่วนลดของใบเสนอราคานี้ไม่สอดคล้องกัน กรุณาติดต่อผู้ดูแลระบบ', {
          overrideId: error.overrideId,
          quoteLineId: error.quoteLineId,
        });
      }
      throw error;
    }

    /*
     * Before submit there is no pinned total, so the schedule has nothing to be a percentage
     * of and the cashflow dimension has nothing to measure. Zero here is "not yet", not "fine"
     * — and it cannot hide anything, because `gate` runs after the document is pinned.
     */
    const grandTotal = order.grandTotalThbMinor;
    const cashflow =
      grandTotal === null
        ? measureCashflow(0n, [], floorBp)
        : measureCashflow(grandTotal, instalments, floorBp);

    return { margin, cashflow };
  }

  /**
   * The document's rule once pinned, the current default before that.
   *
   * Plan 13's 700 bp `standard` is a placeholder, and using it to gross up a concession on a
   * document pinned at some other rate would measure a quote that does not exist.
   */
  private async vatRuleFor(order: OrderFacts, tx?: AuthorityTx): Promise<TaxRule> {
    if (order.documentId === null) return DEFAULT_VAT_RULE;

    const pinned = await this.repository.pinnedVat(order.documentId, tx);
    if (pinned === undefined) return DEFAULT_VAT_RULE;
    return { rateBp: pinned.rateBp, treatment: pinned.treatment };
  }

  /* ---------------------------------------------------------------- *
   * Deciding — the ceiling comparison
   * ---------------------------------------------------------------- */

  /**
   * The largest ceiling this principal carries in this dimension, or `undefined` for none.
   *
   * A non-user scope has no groups and therefore no authority. That is not an oversight for
   * the `system` scope either: a worker that could concede money on its own authority is a
   * worker with a ceiling nobody granted.
   */
  async ceilingFor(scope: Scope, dimension: ApprovalDimension, tx?: AuthorityTx): Promise<bigint | undefined> {
    if (scope.kind !== 'user') return undefined;
    return this.repository.ceiling(scope.groupIds, dimension, tx);
  }

  /**
   * The whole question, answered for one order: what does it concede, and may this person do it?
   *
   * ── ⭐ AN APPROVAL COVERS ONE QUOTE, AND THE QUOTE IS NAMED ──────────────────────
   *
   * This used to look up any `approved` row **on the order** in the dimension carrying at least
   * this much, and the module's own note defended the cost of that: *"rewriting the quote to a
   * much smaller order afterwards keeps the same absolute headroom"*. The red team spent it:
   *
   *   an approver approves ฿9,630 against a ฿138,240 line — 6.97%, entirely defensible, and the
   *   approver's own ceiling is exactly that. Sales then revokes the override, removes the line,
   *   adds a ฿6,912 line and sets it to ฿0.00. The new concession is ฿7,395.84 ≤ ฿9,630, so it
   *   is "covered", and a 100% discount on a quote the approver never saw leaves the building.
   *
   * That is not a cost, it is a standing line of credit. So an approval now names the
   * `quote_revision` it was measured against — a digest of the live lines and overrides — and
   * covers that quote and no other. Edit anything and the digest moves and the approval stops
   * covering, which is what *"the approver approved this document"* means when it is enforced.
   *
   * The figure comparison stays as a second condition. It is not redundant: the digest covers
   * the quote's rows, and the VAT rule the concession is grossed up with comes from the pinned
   * document, so two measurements of one revision can differ if the document is pinned in
   * between. `>=` keeps the fail-closed direction in that window.
   *
   * ── And what this does NOT do: expire on time ────────────────────────────────────
   *
   * There is no clock here. An approval against an untouched quote is good next month. Plan 13
   * has no answer for quote validity and this round refuses to invent one — see `blocked`.
   */
  async assess(scope: Scope, orderId: string, tx?: AuthorityTx): Promise<AuthorityAssessment> {
    const order = await this.repository.readOrder(orderId, tx);
    if (order === undefined) throw AppError.notFound('ไม่พบใบเสนอราคานี้');

    const measured = await this.measureFor(order, tx);
    const revision = await this.repository.quoteRevision(order.id, tx);
    const decisions = await this.repository.approvalsForOrder(order.id, tx);

    const margin = await this.judge(scope, measured.margin, revision, decisions, tx);
    const cashflow = await this.judge(scope, measured.cashflow, revision, decisions, tx);

    return {
      orderId: order.id,
      orderNo: order.orderNo,
      quoteRevision: revision,
      margin,
      cashflow,
      allowed: margin.outcome.kind !== 'needs_approval' && cashflow.outcome.kind !== 'needs_approval',
    };
  }

  /**
   * Is this concession allowed, and if not, has somebody with the authority said yes to *this*
   * quote?
   *
   * ── ⚠️ THE ONE ATTACK THIS MECHANISM DOES NOT STOP, STATED RATHER THAN IMPLIED ───
   *
   * The ceiling is compared **per order**. Splitting per line is defeated — `measureMargin`
   * sums, so ten lines at 10% each add up and are judged once, which is plan 7.13's
   * *"ประเมินที่ระดับเอกสาร … ไม่ใช่ต่อแถว"*. Splitting per **order** is not: with a ฿10,000
   * ceiling one salesperson may concede ฿10,000 on each of N quotes to the same customer, and
   * every one of those quotes passes here. Quoting one job as two is also a thing a salesperson
   * does for entirely ordinary reasons, so the two cases are indistinguishable from the rows.
   *
   * Closing it needs a figure nobody has yet: a concession budget *per person per period*, and
   * plan 13's rule is that a number the owner has not given is not a number this code invents.
   * A budget with an invented denominator would be worse than none — it would read as a control
   * while granting whatever the invented figure happens to allow. So the limit is written down
   * here, is in plan 13's authority row, and the day there is a monthly figure it belongs in
   * `authority_limits` beside the ceiling, measured over `approvals` and the quotes each person
   * submitted, not over one order.
   *
   * What does hold today: nothing is granted without a row, an approval covers exactly the
   * revision it was measured against, and the person who asked cannot be the person who agreed.
   */
  private async judge(
    scope: Scope,
    measurement: DimensionMeasurement,
    quoteRevision: string,
    decisions: readonly ApprovalRow[],
    tx?: AuthorityTx,
  ): Promise<DimensionAssessment> {
    const conceded = measurement.concessionThbMinor;
    if (conceded <= 0n) return { measurement, outcome: { kind: 'nothing_conceded' } };

    const ceiling = await this.ceilingFor(scope, measurement.dimension, tx);
    if (ceiling !== undefined && conceded <= ceiling) {
      return { measurement, outcome: { kind: 'within_authority', ceilingThbMinor: ceiling } };
    }

    /*
     * ⚠️ `kind === 'quote_concession'`, and it is the term that keeps a forgiven debt from
     * licensing a discount.
     *
     * A write-off is `dimension: 'cashflow'` — it forgives cash, so it draws on the cashflow
     * ceiling — and without this term an approved ฿20,000 write-off on an order would *cover* a
     * ฿20,000 `gate_below_floor` concession on the same order's quote: a schedule with no deposit
     * at all would pass the submit gate on the authority of a decision about an unrelated debt.
     * Nobody would have approved that; the two mechanisms simply share a column.
     */
    const covering = decisions.find(
      (row) =>
        row.dimension === measurement.dimension &&
        row.kind === 'quote_concession' &&
        row.status === 'approved' &&
        row.quoteRevision === quoteRevision &&
        row.concessionThbMinor >= conceded,
    );
    if (covering !== undefined) {
      return {
        measurement,
        outcome: {
          kind: 'covered_by_approval',
          approvalId: covering.id,
          approvedThbMinor: covering.concessionThbMinor,
          quoteRevision: covering.quoteRevision,
        },
      };
    }

    /*
     * Same term, for the same reason facing the other way: a pending write-off is not the quote's
     * approval arriving. Reporting its id as `pendingApprovalId` would point the quote editor's
     * *"your request is being considered"* banner at a decision about a debt, and pressing through
     * to it would show the salesperson a screen about money they were not asking about.
     */
    const pending = decisions.find(
      (row) =>
        row.dimension === measurement.dimension &&
        row.kind === 'quote_concession' &&
        row.status === 'pending',
    );

    return {
      measurement,
      outcome: {
        kind: 'needs_approval',
        ceilingThbMinor: ceiling ?? null,
        pendingApprovalId: pending?.id ?? null,
      },
    };
  }

  /**
   * The gate the submit path calls, inside its own transaction, after the document is pinned.
   *
   * ⚠️ **Order of operations, and it is not negotiable.** The caller must (1) take the lock on
   * the order, (2) pin the document, (3) call this, (4) roll back if it throws. Measuring
   * before the pin measures a quote the pin may still change, and the VAT rule a concession is
   * grossed up with is the *pinned* one.
   *
   * The refusal rolls the pin back with it, which is why `approvals` can no longer be keyed to
   * `order_documents`: the row a request would have had to point at ceases to exist at the
   * moment the request becomes necessary. `quote_revision` is the subject instead, and it exists
   * before submit — see the note on `approvals` in `packages/db`.
   *
   * It throws rather than returning a boolean because there is exactly one correct reaction to
   * a refusal and a caller that has to remember to check a flag is a caller that will not.
   */
  async gate(
    tx: AuthorityTx,
    input: { readonly orderId: string; readonly scope: Scope },
  ): Promise<AuthorityAssessment> {
    const order = await this.repository.lockOrder(tx, input.orderId);
    if (order === undefined) throw AppError.notFound('ไม่พบใบเสนอราคานี้');

    const assessment = await this.assess(input.scope, order.id, tx);
    if (assessment.allowed) return assessment;

    const blocking = ([assessment.margin, assessment.cashflow] as const).filter(
      (dimension) => dimension.outcome.kind === 'needs_approval',
    );

    throw AppError.conflict(
      'ใบเสนอราคานี้ลดยอดเกินอำนาจอนุมัติของคุณ — ต้องให้ผู้มีอำนาจอนุมัติก่อนจึงจะส่งให้ลูกค้าได้',
      {
        dimensions: blocking.map((dimension) => ({
          dimension: dimension.measurement.dimension,
          concessionThbMinor: dimension.measurement.concessionThbMinor.toString(),
          ceilingThbMinor:
            dimension.outcome.kind === 'needs_approval' && dimension.outcome.ceilingThbMinor !== null
              ? dimension.outcome.ceilingThbMinor.toString()
              : null,
        })),
      },
    );
  }

  /* ---------------------------------------------------------------- *
   * Requesting, and answering
   * ---------------------------------------------------------------- */

  /**
   * Ask for a concession to be approved.
   *
   * **The body carries no amount.** The figure is measured from the rows in this transaction,
   * exactly as `refunds` derives the refundable amount rather than accepting one: a request
   * that could name its own concession is a request for ฿100 that licenses ฿100,000.
   *
   * Recording the ask is always permitted, whatever authority the requester has. Refusing to
   * record it would make the inbox empty on a database with no authority rows — which is every
   * database on day one — and an approver who cannot see the queue is plan 7.13's finding
   * repeated: approval requests with nowhere to arrive.
   */
  async request(
    scope: Scope,
    input: { readonly orderId: string; readonly dimension: ApprovalDimension; readonly reasonTh: string },
  ): Promise<ApprovalRow> {
    const requestedByUserId = staffUserId(scope);

    const approvalId = await this.repository.transaction(async (tx) => {
      const order = await this.repository.lockOrder(tx, input.orderId);
      if (order === undefined) throw AppError.notFound('ไม่พบใบเสนอราคานี้');

      const measured = await this.measureFor(order, tx);
      const dimension = input.dimension === 'margin' ? measured.margin : measured.cashflow;

      if (dimension.concessionThbMinor <= 0n) {
        throw AppError.conflict('ใบเสนอราคานี้ไม่ได้ลดยอดในมิตินี้ จึงไม่มีอะไรให้อนุมัติ', {
          dimension: input.dimension,
        });
      }

      const revision = await this.repository.quoteRevision(order.id, tx);

      const existing = await this.repository.approvalsForOrder(order.id, tx);
      /*
       * ⚠️ NOT filtered by `kind`, unlike `judge` above, and the asymmetry is deliberate.
       *
       * `approvals_one_open_per_order_dimension` is `(order_id, dimension) WHERE status =
       * 'pending'` — it does not know about `kind` — so a pending **write-off** really does
       * occupy the cashflow slot on this order and the insert below really would raise 23505.
       * Filtering it out here to "be precise about mechanisms" would turn a Thai sentence into a
       * 500 from a unique index.
       *
       * The two cases are told apart in the *message*, because they are different news: one is
       * "your own dimension already has a question waiting", the other is "somebody is asking to
       * write this order's balance off, and until that is answered nothing else about this order's
       * cashflow can be". Widening the index to include `kind` was considered and rejected: an
       * order with a pending write-off and a pending below-floor schedule is two people asking
       * about the same money, and one answer at a time is the fail-closed order to take them in.
       */
      const open = existing.find(
        (row) => row.status === 'pending' && row.dimension === input.dimension,
      );
      if (open !== undefined) {
        /*
         * One open question per dimension per order, which is what
         * `approvals_one_open_per_order_dimension` enforces. A *decided* row against an older
         * revision is not in the way: the quote was edited, the approval stopped covering, and
         * asking again is the correct next step rather than a duplicate.
         */
        throw AppError.conflict(
          open.kind === 'write_off'
            ? 'ออเดอร์นี้มีคำขออนุมัติตัดยอดค้างทิ้งที่ยังรอการตัดสินอยู่ ต้องตัดสินคำขอนั้นก่อน'
            : 'ใบเสนอราคานี้มีคำขออนุมัติในมิตินี้ที่ยังรอการตัดสินอยู่แล้ว',
          {
            approvalId: open.id,
            status: open.status,
            kind: open.kind,
          },
        );
      }

      return this.repository.insertApproval(tx, {
        orderId: order.id,
        /* Evidence when the quote has been pinned once, NULL before that. Not the key. */
        orderDocumentId: order.documentId,
        quoteRevision: revision,
        dimension: input.dimension,
        /*
         * ⭐ Stated, not defaulted. This route measures a concession from `quote_lines` and
         * `quote_overrides` and is the only thing that may write that kind of row; the write-off
         * path is `WriteOffService`, on its own route, with its own guard. Writing the literal
         * here means a reader of either method can see which one they are in.
         */
        kind: 'quote_concession',
        concessionThbMinor: dimension.concessionThbMinor,
        reasonTh: input.reasonTh,
        requestedByUserId,
      });
    });

    const row = await this.repository.approvalById(approvalId);
    if (row === undefined) throw new Error('the approval that was just inserted cannot be read back');
    return row;
  }

  /**
   * Approve or refuse — one route, because it is one decision with two answers.
   *
   * Two refusals stand in front of an approval and they are different rules:
   *
   *   the decider is not the requester   the two-person rule that already exists. Refused here
   *                                      with a sentence; `approvals_decider_is_not_requester`
   *                                      is what makes the refusal true.
   *   the decider's ceiling covers it    the rule that keeps fail-closed honest. Without it,
   *                                      an empty `authority_limits` would stop nothing at all,
   *                                      because approving would be a permission and not an
   *                                      authority.
   *
   * A **rejection** requires no ceiling. Saying no is not an exercise of authority, and a
   * request that can only be answered by somebody senior enough to say yes is a request that
   * sits in the queue for ever.
   *
   * ── ⭐ AND TWO MORE, FOR A WRITE-OFF ONLY ────────────────────────────────────────
   *
   *   `payments.write_off`               forgiving cash the company is owed is a different power
   *                                      from approving a discount at quote time. Checked here
   *                                      and not by the decorator because which extra code a
   *                                      decision needs is a fact about the row, and the guard
   *                                      runs before the row is read. It blocks a **refusal**
   *                                      too — see `approval-rights.ts`.
   *   the balance still covers it        ⚠️ and this is the one that is easy to leave out.
   *
   * ── ⚠️ THE BALANCE MOVES BETWEEN THE ASK AND THE ANSWER ──────────────────────────
   *
   * `approvals_write_off_within_balance` refuses a request larger than the debt, so every pending
   * write-off was valid **when it was raised**. It does not stay valid: a customer may transfer
   * part of what they owe while the request sits in the inbox, and a ฿20,000 write-off asked
   * against a ฿20,000 debt is an over-write-off by the time ฿8,000 arrives.
   *
   * Two answers were available and this one refuses:
   *
   *   ✗ **approve only what is left.** Rejected. `approvals.concession_thb_minor` is frozen while
   *     pending by `approvals_guard_write()` for the reason that guard exists — *what is being
   *     approved cannot change while it is being approved* — so this would mean either defeating
   *     that guard or writing a decision whose recorded figure is not the figure anybody agreed
   *     to. `approvals_ceiling_covers_concession` would then be checked against a number nobody
   *     requested, and the audit row would read as though the approver had chosen ฿12,000.
   *
   *   ✓ **refuse the approval, and say why.** The money that arrived is *new information about
   *     the customer* — they are paying after all, and the remainder may now be worth chasing, or
   *     the settlement they agreed to has been part-performed. That is a decision for a person,
   *     not an arithmetic adjustment. The approver may still **reject**, which is the correct
   *     next step: the requester reads the note and raises a smaller request against the balance
   *     as it now stands.
   *
   * Neither answer may silently create a negative outstanding, and the database says so
   * independently: the AFTER trigger re-folds the balance and rolls the statement back.
   */
  async decide(
    scope: Scope,
    approvalId: string,
    input: { readonly decision: 'approved' | 'rejected'; readonly noteTh: string | null },
  ): Promise<ApprovalRow> {
    const decidedByUserId = staffUserId(scope);

    await this.repository.transaction(async (tx) => {
      const row = await this.repository.lockApproval(tx, approvalId);
      if (row === undefined) throw AppError.notFound('ไม่พบคำขออนุมัตินี้');

      /*
       * ⭐ The second permission, before the status check, so that the order of refusals here is
       * the order `approvalRights` reports — a caller who both lacks the code and is looking at a
       * decided row must be told the same first thing by both.
       */
      if (row.kind === 'write_off' && !scopeHolds(scope, WRITE_OFF_PERMISSION)) {
        throw new AppError(
          'FORBIDDEN',
          403,
          'การตัดยอดค้างทิ้งต้องมีสิทธิ์เฉพาะ บทบาทของคุณยังไม่ได้รับสิทธิ์นี้',
          { kind: row.kind },
        );
      }

      if (row.status !== 'pending') {
        throw AppError.conflict('คำขออนุมัตินี้ถูกตัดสินไปแล้ว', {
          status: row.status,
          decidedByUserId: row.decidedByUserId,
        });
      }

      if (row.requestedByUserId === decidedByUserId) {
        throw AppError.conflict('ผู้อนุมัติต้องไม่ใช่ผู้ขออนุมัติ');
      }

      let decidedCeilingThbMinor: bigint | null = null;

      if (input.decision === 'approved') {
        const ceiling = await this.ceilingFor(scope, row.dimension, tx);
        if (ceiling === undefined) {
          throw new AppError(
            'FORBIDDEN',
            403,
            'บทบาทของคุณยังไม่ได้รับกำหนดเพดานอำนาจอนุมัติ จึงอนุมัติรายการนี้ไม่ได้',
            { dimension: row.dimension },
          );
        }
        if (row.concessionThbMinor > ceiling) {
          throw new AppError(
            'FORBIDDEN',
            403,
            'ยอดที่ขอลดเกินเพดานอำนาจอนุมัติของคุณ',
            {
              dimension: row.dimension,
              concessionThbMinor: row.concessionThbMinor.toString(),
              ceilingThbMinor: ceiling.toString(),
            },
          );
        }

        /*
         * ⭐ AND — for a write-off — the balance as it stands right now, inside this transaction,
         * under the lock. See the header for why this refuses rather than reducing the figure.
         *
         * ⛔ `order_outstanding_thb_minor()`, read through the repository. Not `grandTotal` minus
         * a sum assembled here: the fold's third term is this table's own approved write-offs, so
         * a second implementation would have to re-derive a sum over rows this transaction is in
         * the middle of writing.
         */
        if (row.kind === 'write_off') {
          /*
           * ⭐ AND THE ORDER IS STILL SOMEBODY'S LIVE OBLIGATION — the balance is not the only
           * thing that moves while a request sits in the inbox. The order can be **cancelled**,
           * and then its remainder stops being a debt: the cancellation disposes of it through
           * `forfeit_policy_rules` and the refund module, and a superseded order's remainder was
           * carried to the order that replaced it. Approving here would spend this role's cashflow
           * ceiling on a debt somebody else already dealt with, and record the forgiven figure on
           * an order whose wire states no money at all.
           *
           * `WriteOffService.request` refuses the same thing at the ask, and
           * `approvals_write_off_order_is_live` (0049) refuses it at the row — this check exists so
           * that an approver pressing the button reads a Thai sentence instead of the trigger's
           * `check_violation`.
           *
           * ⛔ `isLiveOrder`, the one list (`src/orders/live-order.ts`). Not a status comparison
           * written here.
           *
           * ⚠️ Read without a lock, deliberately: the row that decides the outcome is the trigger's
           * read at write time, and taking `for update` on `orders` here would add a second lock
           * order (approval → order) against `WriteOffService.request`'s (order → approval).
           *
           * ⚠️ Only the **approval** is refused. Rejecting a write-off on a cancelled order stays
           * available — this whole branch is inside `if (input.decision === 'approved')` — because
           * a pending request holds the order's one cashflow slot until somebody answers it.
           */
          const order = await this.repository.readOrder(row.orderId, tx);
          if (order === undefined) throw AppError.notFound('ไม่พบออเดอร์นี้');
          if (!isLiveOrder(order.status)) {
            throw AppError.conflict(
              'ออเดอร์นี้ถูกยกเลิกหรือถูกแทนที่แล้ว ยอดคงค้างจึงไม่ใช่หนี้ที่ต้องตัดทิ้ง — ให้ไม่อนุมัติคำขอนี้',
              { status: order.status },
            );
          }

          const balance = await this.repository.outstandingThbMinor(row.orderId, tx);
          if (row.concessionThbMinor > balance) {
            throw AppError.conflict(
              'ยอดคงค้างของออเดอร์นี้ลดลงหลังจากมีการยื่นคำขอ จึงตัดยอดตามจำนวนที่ขอไม่ได้ — ให้ไม่อนุมัติคำขอนี้แล้วยื่นใหม่ตามยอดคงค้างปัจจุบัน',
              {
                concessionThbMinor: row.concessionThbMinor.toString(),
                outstandingThbMinor: balance.toString(),
              },
            );
          }
        }

        /*
         * Pinned, so that a limit raised next month does not make this decision look
         * unnecessary and a limit lowered does not make it look like an abuse. Neither reading
         * is recoverable from `authority_limits`, which holds only today's number.
         */
        decidedCeilingThbMinor = ceiling;
      }

      const recorded = await this.repository.recordDecision(tx, {
        approvalId,
        status: input.decision,
        decidedByUserId,
        decisionNoteTh: input.noteTh,
        decidedCeilingThbMinor,
      });

      /* Zero rows means somebody else decided it between the lock and the update. */
      if (!recorded) throw AppError.conflict('คำขออนุมัตินี้ถูกตัดสินไปแล้ว');

      /*
       * ⭐ 0051. A forgiven debt joins the order's timeline, in this transaction.
       *
       * In this transaction and not after it: `order_outstanding_thb_minor()` folds an approved
       * write-off, so between committing the decision and appending the row there is a window in
       * which the balance has already moved and nothing says why. Sharing the transaction makes
       * that window not exist — the same argument `remindBalance` makes for its own append.
       *
       * ⚠️ `actorKind: 'staff'` is passed directly rather than through `orderActor(scope)`. That
       * helper types a caller as staff only when they hold `orders.read` AND `orders.write`, and
       * this route is gated on `quotes.approve` plus `payments.write_off` — so an approver with no
       * orders permissions would be typed `customer`, and `order_events_guard_insert()` would then
       * refuse the row with "user % does not own order %". Staffness is already proved here, twice:
       * `staffUserId(scope)` above, and the write-off permission check that let this branch run.
       *
       * Only on approval. A refused request moved no money; `approvals` already records that it
       * was considered, which is the point of keeping refusals as rows.
       */
      if (row.kind === 'write_off' && input.decision === 'approved') {
        await this.orders.appendEvent(tx, {
          orderId: row.orderId,
          eventType: 'balance_written_off',
          fromStatus: null,
          toStatus: null,
          actorKind: 'staff',
          actorUserId: decidedByUserId,
          actorGuestId: null,
          payload: {
            written_off_thb_minor: row.concessionThbMinor.toString(),
            reason: row.reasonTh,
            ...(input.noteTh === undefined || input.noteTh === null
              ? {}
              : { note_th: input.noteTh }),
          },
        });
      }
    });

    const decided = await this.repository.approvalById(approvalId);
    if (decided === undefined) throw new Error('the approval that was just decided cannot be read back');
    return decided;
  }

  /* ---------------------------------------------------------------- *
   * The inbox, and the ceilings themselves
   * ---------------------------------------------------------------- */

  async inbox(
    filter: { readonly status: 'pending' | 'approved' | 'rejected'; readonly orderId?: string | undefined },
    limit: number,
  ): Promise<readonly ApprovalRow[]> {
    return this.repository.inbox(filter, limit);
  }

  /**
   * ⭐ THE APPROVER'S OWN QUEUE — pending requests **this** person may decide, and a count of
   * the ones they may not.
   *
   * ── The one property this method exists to have ───────────────────────────────────
   *
   * **Every row it returns is one `decide` would accept.** Not "probably": the same function
   * answers both, over the same two facts (the requester, and this caller's ceiling in that
   * row's dimension), so the queue cannot offer a decision the endpoint refuses without
   * `approvalRights` being wrong for both at once. An approver who is shown a request they lack
   * the authority to approve learns the ceiling by being refused, and the request that needed
   * *them* is in the same list.
   *
   * ⚠️ The ceilings are read **once per dimension**, not per row. Two rows in one dimension are
   * judged against one number by construction, and a per-row read would put a window between
   * them in which the owner could withdraw the ceiling and half the queue would be judged under
   * the old authority.
   *
   * ⚠️ It is a queue and **not a notification**, exactly as `GET /quotes/approvals` is not:
   * nothing here tells an approver that something arrived, and an approver who does not open the
   * screen sees nothing. That gap is the controller's note and it is not papered over here.
   */
  async queue(scope: Scope): Promise<ApprovalQueue> {
    /*
     * Refused with the same sentence `request` and `decide` use, before anything is read. The id
     * itself is not needed here — `approvalRights` reads it off the scope for the two-person
     * comparison, so there is one place that knows which field identifies the requester.
     */
    staffUserId(scope);

    const [margin, cashflow] = await Promise.all([
      this.ceilingFor(scope, 'margin'),
      this.ceilingFor(scope, 'cashflow'),
    ]);
    const ceilings: Record<ApprovalDimension, bigint | undefined> = { margin, cashflow };

    /*
     * One more than the bound, so "there are further requests" is a fact rather than an
     * inference from a full page. Oldest first — `inbox` reads `approvals_pending_idx` in the
     * order the index is built, which is the order an approver has to notice.
     */
    const pending = await this.repository.inbox(
      { status: 'pending' },
      APPROVAL_QUEUE_SCAN_MAX + 1,
    );
    const isTruncated = pending.length > APPROVAL_QUEUE_SCAN_MAX;
    const scanned = isTruncated ? pending.slice(0, APPROVAL_QUEUE_SCAN_MAX) : pending;

    /*
     * ⭐ The balances the write-off rows are bounded by — one statement, and only when there is a
     * write-off in the scan.
     *
     * ⚠️ Read here rather than per row for the same reason the ceilings are: two rows about one
     * order must be judged against one number, and a per-row read would put a window between them
     * in which a slip could be accepted and half the queue judged against the old balance. An
     * ordinary queue of quote concessions issues no extra statement at all — see
     * `outstandingByOrder`.
     */
    const writeOffOrderIds = [
      ...new Set(scanned.filter((row) => row.kind === 'write_off').map((row) => row.orderId)),
    ];
    const balances = await this.repository.outstandingByOrder(writeOffOrderIds);

    const approvals: ApprovalRow[] = [];
    let beyondYourAuthority = 0;
    let yourOwnRequests = 0;

    for (const row of scanned) {
      const rights = approvalRights(scope, {
        status: row.status,
        kind: row.kind,
        requestedByUserId: row.requestedByUserId,
        concessionThbMinor: row.concessionThbMinor,
        ceilingThbMinor: ceilings[row.dimension],
        outstandingThbMinor: row.kind === 'write_off' ? balances.get(row.orderId) : undefined,
      });

      if (rights.mayApprove) {
        approvals.push(row);
        continue;
      }

      /*
       * `own_request` is counted apart from the ceiling cases because the two are different
       * news: one is the two-person rule working (somebody else has to answer this, and that is
       * the feature), the other is a request nobody with this authority can answer at all —
       * which is a message for the owner about a ceiling, not about this approver.
       *
       * ⚠️ `own_request` and not `requestedByUserId === userId`: the reason comes from the same
       * function the filter does, so a change to the rule cannot leave the tally describing the
       * old one.
       */
      /*
       * ⚠️ `not_a_write_off_approver` and `above_balance` land in `beyondYourAuthority`, which is
       * the right bucket for both — one is authority this caller has not been granted, the other
       * is a request nobody can approve any longer — but note what that means: a **stale
       * write-off is withheld from this queue and can still be rejected**, because `mayRefuse`
       * stays true. That is the queue's existing shape rather than a new hole (`no_ceiling` and
       * `above_ceiling` rows have always been withheld while remaining refusable), and it matters
       * more here because a pending write-off occupies the order's cashflow slot until somebody
       * answers it. The route to it is the order itself: the write-off panel on the order detail
       * reads `GET /quotes/approvals?orderId=`, shows the stale request and links to the decision.
       */
      if (rights.because === 'own_request') yourOwnRequests += 1;
      else beyondYourAuthority += 1;
    }

    return { approvals, ceilings, beyondYourAuthority, yourOwnRequests, isTruncated };
  }

  /**
   * One request, with the concession measured **again, now**.
   *
   * The stored figure is what was asked for; the live figure is what the quote concedes at the
   * moment the approver is looking at it. They differ when sales kept editing, and an approver
   * shown only the stored one approves a document that no longer exists.
   *
   * `quoteRevisionNow` is the sharper form of the same warning, and it is the one an approver
   * can act on: when it differs from `row.quoteRevision`, approving this request grants nothing
   * at all, because `judge` will not match it against the quote as it now stands.
   *
   * ⭐ `rights` is what **this caller** may do about it, from `approvalRights` — the same function
   * the queue filters on and the same rule `decide` enforces. It is on the read so that a screen
   * reached by URL rather than through the queue still shows the buttons the server would honour,
   * instead of comparing a ceiling against a concession on its own.
   */
  async approval(
    scope: Scope,
    approvalId: string,
  ): Promise<{
    readonly row: ApprovalRow;
    readonly live: DocumentConcessions;
    readonly quoteRevisionNow: string;
    readonly rights: ApprovalRights;
    /** The caller's ceiling in this request's dimension. `undefined` is no live row at all. */
    readonly ceilingThbMinor: bigint | undefined;
    /**
     * ⭐ What the order owes **now** — read for a `write_off` request and `undefined` otherwise.
     *
     * The write-off equivalent of `hasMovedSinceRequest`, and the sharper one: a quote concession
     * that has moved still grants *something*, whereas a write-off whose balance has fallen below
     * the figure asked for cannot be approved at all. The inbox has to say that before the button
     * is pressed rather than after — see `decide`, which refuses.
     */
    readonly outstandingThbMinor: bigint | undefined;
  }> {
    const row = await this.repository.approvalById(approvalId);
    if (row === undefined) throw AppError.notFound('ไม่พบคำขออนุมัตินี้');

    const live = await this.measure(row.orderId);
    const quoteRevisionNow = await this.repository.quoteRevision(row.orderId);
    const ceilingThbMinor = await this.ceilingFor(scope, row.dimension);
    const outstandingThbMinor =
      row.kind === 'write_off'
        ? await this.repository.outstandingThbMinor(row.orderId)
        : undefined;

    return {
      row,
      live,
      quoteRevisionNow,
      ceilingThbMinor,
      outstandingThbMinor,
      rights: approvalRights(scope, {
        status: row.status,
        kind: row.kind,
        requestedByUserId: row.requestedByUserId,
        concessionThbMinor: row.concessionThbMinor,
        ceilingThbMinor,
        outstandingThbMinor,
      }),
    };
  }

  async limits(): Promise<readonly AuthorityLimitRow[]> {
    return this.repository.listLimits();
  }

  /**
   * The roles a ceiling can be granted to.
   *
   * Read-only, three columns, and behind `groups.read` — see `AuthorityRepository.listGroups`
   * for why this exists at all rather than the screen calling `GET /admin/groups`.
   */
  async groups(): Promise<readonly GroupFacts[]> {
    return this.repository.listGroups();
  }

  /**
   * Grant, change or reinstate a ceiling.
   *
   * Behind `groups.write` and not `quotes.write`, and the reason is the obvious attack:
   * authority attaches to a group, so a salesperson who could edit this table could raise their
   * own ceiling and then need nobody's approval for anything. Changing what a role may do is
   * group administration.
   *
   * ⚠️ **One transaction, and the history row is its last statement.** The same essential rule
   * `TaxCountryService` and `OrganisationService` state about their own tables:
   * `authority_limit_changes_append_only` (0038) stops a history row being edited or deleted
   * after the fact, and nothing in the database stops one being *skipped*. That half is this
   * method's job. The order is fixed — lock the group, read the pre-image, write, record —
   * and each step exists for a reason written on it in the repository.
   */
  async setLimit(
    scope: Scope,
    input: {
      readonly groupId: string;
      readonly dimension: ApprovalDimension;
      readonly maxConcessionThbMinor: bigint;
      readonly noteTh: string | null;
    },
  ): Promise<readonly AuthorityLimitRow[]> {
    const actor = staffUserId(scope);

    await this.repository.transaction(async (tx) => {
      const group = await this.repository.lockGroup(tx, input.groupId);
      if (group === undefined) throw AppError.notFound('ไม่พบบทบาทนี้');

      const before = await this.repository.readLimit(tx, input.groupId, input.dimension);

      await this.repository.upsertLimit(tx, { ...input, grantedByUserId: actor });

      const after = await this.repository.readLimit(tx, input.groupId, input.dimension);
      if (after === undefined) throw new Error('authority_limits upsert wrote nothing');

      /* Last statement, always. See `insertLimitChange` for why the clock is not the default. */
      await this.repository.insertLimitChange(tx, {
        groupId: input.groupId,
        groupCode: group.code,
        dimension: input.dimension,
        changedByUserId: actor,
        before: before === undefined ? null : snapshot(before),
        after: snapshot(after),
      });
    });

    return this.limits();
  }

  /**
   * Withdraw a ceiling.
   *
   * ⭐ **Not a delete, and not merely by convention** — `authority_limits_block_delete` (0038)
   * refuses one at the database. The row is what records who granted this role its authority;
   * `approvals.decided_ceiling_thb_minor` answers *"what was the number?"*, and nothing
   * answered *"who gave it, and who took it away?"* while a `DELETE` removed the granter along
   * with the ceiling.
   *
   * Revoking is still the fail-closed direction, so it needs no second person — but it does
   * need a record, and it is written in the same transaction as the flag.
   */
  async removeLimit(
    scope: Scope,
    groupId: string,
    dimension: ApprovalDimension,
  ): Promise<readonly AuthorityLimitRow[]> {
    const actor = staffUserId(scope);

    await this.repository.transaction(async (tx) => {
      const group = await this.repository.lockGroup(tx, groupId);
      if (group === undefined) throw AppError.notFound('ไม่พบบทบาทนี้');

      const before = await this.repository.readLimit(tx, groupId, dimension);
      /*
       * A ceiling that is already withdrawn is `notFound` and not a silent success, for the
       * same reason a missing one is: the caller asked to take authority away and needs to know
       * whether their act is the one that did it.
       */
      if (before === undefined || before.revokedAt !== null) {
        throw AppError.notFound('ไม่พบเพดานอำนาจของบทบาทนี้ในมิตินี้');
      }

      const revoked = await this.repository.revokeLimit(tx, {
        groupId,
        dimension,
        revokedByUserId: actor,
      });

      /*
       * ⚠️ **Not a 404 — an invariant failure, and the difference is what makes both guards
       * testable.**
       *
       * `revokeLimit` carries `revoked_at IS NULL` in its own WHERE, so a second withdrawal
       * updates zero rows rather than restamping the first one with a new name and time. That
       * guard and the pre-image check above are genuinely redundant *for a caller holding the
       * group lock*, which is why a review found that either one could be deleted with the
       * whole suite still green: each was hiding the other's absence behind an identical 404.
       *
       * They are kept — the WHERE clause is the one that still holds if a future path reaches
       * the repository without the lock — but they no longer say the same thing. Reaching here
       * means the pre-image said *live* and the UPDATE then matched nothing, under a lock that
       * exists precisely to make that impossible. That is a broken lock, not a missing row, and
       * reporting it as `notFound` would tell the caller their request was wrong when the
       * database is. `tests/quotes/authority/authority-limits.pg.test.ts` pins both arms: the
       * HTTP test wants a 404 from the check above, and a repository-level test drives
       * `revokeLimit` twice with no service in front of it.
       */
      if (!revoked) {
        throw new Error('authority_limits revoke matched no live row under the group lock');
      }

      const after = await this.repository.readLimit(tx, groupId, dimension);
      if (after === undefined) throw new Error('authority_limits revoke lost the row');

      await this.repository.insertLimitChange(tx, {
        groupId,
        groupCode: group.code,
        dimension,
        changedByUserId: actor,
        before: snapshot(before),
        after: snapshot(after),
      });
    });

    return this.limits();
  }

  /** Oldest first — the repository orders by `changed_at` ascending, and a chain reads forwards. */
  async limitChanges(
    groupId: string,
    dimension: ApprovalDimension,
  ): Promise<readonly AuthorityLimitChangeRow[]> {
    return this.repository.limitChanges(groupId, dimension);
  }
}

/**
 * What a change records. Ordering, timestamps and `granted_by_user_id` are deliberately absent:
 * the first two are not changes worth keeping (the same call `tax-country.service.ts`'s
 * `RECORDED` makes), and the actor is already a column on the history row itself — recording it
 * twice would let the two disagree.
 *
 * `maxConcessionThbMinor` becomes a decimal string because `JSON.stringify` cannot serialise a
 * `bigint` at all — it throws — and `isRevoked` is a boolean rather than the instant, because
 * *that* a ceiling was withdrawn is the change and *when* is `changed_at`.
 */
function snapshot(row: AuthorityLimitRow): AuthorityLimitSnapshot {
  return {
    maxConcessionThbMinor: row.maxConcessionThbMinor.toString(),
    noteTh: row.noteTh,
    isRevoked: row.revokedAt !== null,
  };
}

/** The two dimensions, for a caller that wants to iterate them without re-declaring the list. */
export const AUTHORITY_DIMENSIONS: readonly ApprovalDimension[] = APPROVAL_DIMENSIONS;

/**
 * ⚠️ **NOT the floor. Nothing reads this, and editing it changes no behaviour.**
 *
 * It was a re-export of plan 13's placeholder, put here "so a reader can find it" — and a reader
 * who finds it now finds a constant that no code path consults. `grep` says so: this module's own
 * `measureFor` reads `DepositPolicyPort.depositBp()`, and `cashflowConcessionMinor`'s remaining
 * default parameter (`payments/schedule/plan.ts`) is the only other place 10 000 bp still appears
 * as a floor — reachable from `plan.test.ts` and from nowhere in `src`.
 *
 * It is kept rather than deleted because it names plan 13's documented default and the
 * `payments/schedule` constant it forwards is still the seed value of the column. But somebody
 * looking for "where do I change the deposit floor?" must not stop here: a module constant cannot
 * hold a per-row database value, and the answer is `organisation_profile.deposit_bp`, written
 * from the admin profile screen and read on every measurement.
 */
export const CASHFLOW_FLOOR_BP_DEFAULT = GATE_COVERAGE_BP_DEFAULT;

/**
 * A concession is an act by a member of staff. There is no guest variant and there will not
 * be one: a customer cannot set a price, so `guest` and `public` are refused rather than
 * modelled.
 */
function staffUserId(scope: Scope): string {
  if (scope.kind !== 'user') {
    throw AppError.unauthenticated('ต้องเข้าสู่ระบบด้วยบัญชีเจ้าหน้าที่จึงจะดำเนินการเรื่องอำนาจอนุมัติได้');
  }
  return scope.userId;
}
