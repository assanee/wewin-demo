import { Inject, Injectable } from '@nestjs/common';
import type { TaxRule } from '@wewin/core/vat';
import { APPROVAL_DIMENSIONS, type ApprovalDimension } from '@wewin/db/schema';

import { AppError } from '../../common/errors/app-error';
import { DEFAULT_VAT_RULE } from '../../orders/defaults';
import { GATE_COVERAGE_BP_DEFAULT } from '../../payments/schedule';
import type { Scope } from '../../rbac';
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

    const covering = decisions.find(
      (row) =>
        row.dimension === measurement.dimension &&
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

    const pending = decisions.find(
      (row) => row.dimension === measurement.dimension && row.status === 'pending',
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
        throw AppError.conflict('ใบเสนอราคานี้มีคำขออนุมัติในมิตินี้ที่ยังรอการตัดสินอยู่แล้ว', {
          approvalId: open.id,
          status: open.status,
        });
      }

      return this.repository.insertApproval(tx, {
        orderId: order.id,
        /* Evidence when the quote has been pinned once, NULL before that. Not the key. */
        orderDocumentId: order.documentId,
        quoteRevision: revision,
        dimension: input.dimension,
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
   * One request, with the concession measured **again, now**.
   *
   * The stored figure is what was asked for; the live figure is what the quote concedes at the
   * moment the approver is looking at it. They differ when sales kept editing, and an approver
   * shown only the stored one approves a document that no longer exists.
   *
   * `quoteRevisionNow` is the sharper form of the same warning, and it is the one an approver
   * can act on: when it differs from `row.quoteRevision`, approving this request grants nothing
   * at all, because `judge` will not match it against the quote as it now stands.
   */
  async approval(approvalId: string): Promise<{
    readonly row: ApprovalRow;
    readonly live: DocumentConcessions;
    readonly quoteRevisionNow: string;
  }> {
    const row = await this.repository.approvalById(approvalId);
    if (row === undefined) throw AppError.notFound('ไม่พบคำขออนุมัตินี้');

    const live = await this.measure(row.orderId);
    const quoteRevisionNow = await this.repository.quoteRevision(row.orderId);
    return { row, live, quoteRevisionNow };
  }

  async limits(): Promise<readonly AuthorityLimitRow[]> {
    return this.repository.listLimits();
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
