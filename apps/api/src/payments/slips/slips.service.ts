import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { encodeThb } from '@wewin/contract/order';
import type { OrderStatus } from '@wewin/db/schema';

import { AppError } from '../../common/errors/app-error';
import { ImageRejected, normaliseImage } from '../../media/image';
import type { StoredObject } from '../../media/storage/object-storage';
import { OrganisationRepository } from '../../organisation/organisation.repository';
import { OrderRepository } from '../../orders/order.repository';
import { assertActorMayMove } from '../../orders';
import {
  ScopedOrderRepository,
  isOrderUuid,
  orderActor,
  orderReach,
  type OrderActor,
  type ScopedOrder,
} from '../../orders/scope';
import { scopeHolds, type Scope } from '../../rbac';
import { planAllocations, suggestAllocations, thbMinor } from './allocations';
import { SLIP_ATTACHABLE_STATUSES } from './attachable';
import {
  encodeInstalment,
  encodeMoney,
  encodeRecordedSlip,
  encodeSlip,
  type SlipAudience,
} from './encode';
import {
  mintImageGrant,
  mintUploadHandle,
  verifyImageGrant,
  verifyUploadHandle,
  type ImageGrantClaims,
} from './slip-grant';
import { SlipImageStore } from './slip-storage';
import type { SlipStorageConfig } from './slip-storage.config';
import { SLIP_STORAGE_CONFIG } from './slips.tokens';
import { LedgerService } from '../ledger';
import { SlipsRepository, type SlipRow, type Tx } from './slips.repository';
import type {
  AcceptSlipRequestWire,
  AcceptSlipResultWire,
  CreateSlipRequestWire,
  OrderTransitionWire,
  RecordSlipRequestWire,
  RecordedSlipListWire,
  RejectSlipRequestWire,
  RejectSlipResultWire,
  SlipImageGrantWire,
  SlipImageUploadWire,
  SlipListWire,
  SlipQueueWire,
  SlipReviewWire,
  SlipWire,
} from './slips.contract';

/**
 * Payment slips: upload, review, acceptance, rejection.
 *
 * ── The asymmetry this module exists to model — plan 7.3 and 7.5(ข) ──────────────
 *
 *     accepting the slip that closes the GATING instalment  →  the order transition
 *     accepting any other slip                              →  moves nothing
 *     rejecting a slip                                      →  not a transition at all
 *
 * The middle line is what a deposit added. Plan 7.3 said "confirming a slip is a
 * transition", which became ambiguous the moment there were two slips; 7.5(ข) resolves it —
 * *the deposit did not move the freeze point, it changed the condition that opens it.* So
 * the freeze is still entry to `production_confirmed`, and the question "is this slip the
 * one?" is a question about instalments, answered by `order_gate_is_open()`.
 *
 * The bottom line is the older half, and it is the one that must not be tidied up: making a
 * rejection a transition would require inventing a status that means the same as the
 * previous status. There is therefore **no code path in this file that moves an order on a
 * rejection**, `RejectSlipResultWire` has nowhere to report one, and `reject()` never even
 * locks the order — because it never touches it.
 *
 * ── The shape of every mutation, and why it is always this shape ─────────────────
 *
 *     transaction
 *       → lock the ORDER, scoped by ownership          ← trap 2, and trap 6's ordering
 *       → lock the SLIP                                ← always second; see the note below
 *       → refuse on status, on both rows
 *       → plan the reviewer's allocations              ← untrusted input, checked eagerly
 *       → flip the slip as a compare-and-set
 *       → write the allocations, then the ledger
 *       → ask the database whether the gate just opened
 *       → and only then, if it did, move the order through the one door
 *
 * **Order first, slip second, everywhere.** `createSlip` and `accept` both take the two
 * locks; a file where one took them the other way round would deadlock two ordinary
 * requests — a customer uploading a second slip while a reviewer accepts the first — and it
 * would do so under load rather than in a test.
 *
 * ── Why the transition is written through `OrderRepository` and not by hand ──────
 *
 * `order.repository.ts` names this seam in its own words: *"This is also the seam 5c writes
 * `quote_revised` through, and 5b writes its payment events through. There is one way onto
 * the spine and it is this method, because the outbox is a consumer of that table and of
 * nothing else."* So the move here is exactly the move `OrdersService` makes — read the
 * legal transition from `order_status_transitions`, check the actor kind against it, append
 * the event, then move the order — using the same three methods, in the same order, inside
 * the transaction that accepted the slip.
 *
 * It is emphatically **not** `OrdersService.transition()`. That method opens a transaction
 * of its own, on a different pooled connection, and would sit waiting for the `FOR UPDATE`
 * this transaction is already holding on the same order row until `statement_timeout`
 * killed it. Calling it after committing would be worse: the money accepted and the order
 * not frozen, with a crash window in between.
 */

/*
 * ⚠️ `SLIP_ATTACHABLE_STATUSES` used to be declared here. It moved to `./attachable` when
 * `OrdersService.paymentInstructions` became a second reader of it; that reader has since
 * gone (the wire carries `orderIsLive` alone), and the list stays where it is because the
 * remaining outside reader cannot import at all — `apps/web/tests/payment-entry.test.ts`
 * *parses* the declaration out of that file's source, `apps/web` having no dependency on
 * `apps/api`. Read that file's header for why it is a file rather than an export from this
 * one, `slips.pg.test.ts` for the assertion that the database refuses what the list refuses,
 * and `attachable-drift.pg.test.ts` for the one that holds the two lists equal.
 */

/** The freeze point. Plan 7.5(ข): the deposit changed the condition, not the place. */
const FREEZE_STATUS: OrderStatus = 'production_confirmed';

/**
 * How far in the future a claimed transfer time may be. Two minutes of clock skew.
 *
 * ⚠️ Not a plan 13 number — the plan does not ask this one. A slip claiming a transfer that
 * has not happened yet is either a wrong clock or a fabrication, and both are worth a 422
 * that names the field rather than a row a reviewer has to notice by eye.
 */
const TRANSFER_CLOCK_SKEW_MS = 2 * 60 * 1000;

/** ⚠️ A default with no owner's answer behind it — see `assertRoomForAnotherSlip`. */
export const MAX_SLIPS_PER_ORDER_DEFAULT = 20;

@Injectable()
export class SlipsService {
  private readonly logger = new Logger('SlipsService');

  constructor(
    private readonly slips: SlipsRepository,
    /**
     * Every load of an order goes through this and through nothing else.
     *
     * The boundary is the point (plan 7.4 trap 2): this decides *which rows this caller may
     * touch* and returns a branded `ScopedOrder` no other query can produce. A review
     * handler physically cannot be handed a row no filter ever ran against.
     */
    private readonly scoped: ScopedOrderRepository,
    /** The spine, the transition table and the status move — the one door. See the module note. */
    private readonly orders: OrderRepository,
    private readonly images: SlipImageStore,
    /**
     * The chart of accounts, and the only thing in this application that names one.
     *
     * This module used to write the `slip_accepted` entry itself, in `SlipsRepository`, while
     * `LedgerService.recordSlipAccepted` sat unused with the same two legs in it — plan 7.13's
     * third seam, twice in one phase.
     */
    private readonly ledger: LedgerService,
    /**
     * The one place this module checks a `receivedBankAccountId` against — task 13 fix
     * round 1. `activeAccounts()`/`account()` are the same two queries `OrdersService`
     * already reads for `GET .../payment-instructions`; nothing new is asked of this
     * repository, only a second caller for what it already exposes.
     */
    private readonly organisation: OrganisationRepository,
    @Inject(SLIP_STORAGE_CONFIG) private readonly config: SlipStorageConfig,
  ) {}

  /* ---------------------------------------------------------------- *
   * Uploading
   * ---------------------------------------------------------------- */

  /**
   * Store the bytes and hand back a signed reference to them.
   *
   * The image is normalised by the *media* module's reader, which is not code reuse for its
   * own sake: it dispatches on magic bytes rather than on the declared content type,
   * refuses SVG by name, and **strips every metadata container**. A photograph of a bank
   * slip taken on a telephone carries GPS coordinates in its Exif more often than not, and
   * plan 7.6's PDPA line is about exactly this file.
   *
   * No row is written here. A crash between the object and the slip leaves bytes nobody
   * references — the failure `MediaService` deliberately chooses over the alternative, and
   * the same content-addressed key makes the next attempt reclaim them.
   */
  async uploadImage(scope: Scope, orderId: string, bytes: Buffer): Promise<SlipImageUploadWire> {
    const order = await this.scoped.findOrFail(scope, orderId, 'act');
    this.assertSlipAttachable(order);
    await this.assertRoomForAnotherSlip(order);

    const image = rejectedImageToAppError(() => normaliseImage(bytes));
    const checksum = createHash('sha256').update(image.bytes).digest('hex');
    const storageKey = this.images.keyFor(order.id, checksum, image.extension);

    await this.images.put(storageKey, image.bytes, image.contentType);

    const handle = mintUploadHandle(
      {
        orderId: order.id,
        storageKey,
        contentType: image.contentType,
        byteSize: image.bytes.byteLength,
        width: image.width,
        height: image.height,
      },
      this.config.grantKey,
      Date.now(),
    );

    if (image.stripped.length > 0) {
      this.logger.log(
        `Slip image for order ${order.id} stored after removing: ${image.stripped.join(', ')}`,
      );
    }

    return {
      imageHandle: handle.token,
      expiresAt: new Date(handle.expiresAtMs).toISOString(),
      contentType: image.contentType,
      byteSize: image.bytes.byteLength,
      width: image.width,
      height: image.height,
      stripped: image.stripped,
    };
  }

  /** Bytes only — the ceiling `readBoundedBody` enforces as the upload arrives. */
  get maxImageBytes(): number {
    return this.images.maxBytes;
  }

  /* ---------------------------------------------------------------- *
   * Creating the slip
   * ---------------------------------------------------------------- */

  async createSlip(scope: Scope, orderId: string, body: CreateSlipRequestWire): Promise<SlipWire> {
    const actor = requireActor(scope);

    return this.slips.transaction(async (tx) => {
      /*
       * ⚠️ PLAN 7.4 TRAP 6. The trap is *"uploading a slip has no guard on the status —
       * `FOR UPDATE` merely orders the race, it does not forbid it; a slip is still inserted
       * after the acceptance has committed."* Both halves are needed and this is the first:
       * the lock makes the status this transaction read the status it will still be at the
       * INSERT. The second half is `payment_slips_live_orders_only` in the migration, which
       * holds for a path that forgets to take the lock at all.
       */
      const order = await this.scoped.lockOrFail(tx, scope, orderId, 'act');
      this.assertSlipAttachable(order);

      const claims = verifyUploadHandle(body.imageHandle, this.config.grantKey, Date.now());
      if (!claims.ok) {
        throw AppError.badRequest(
          claims.reason === 'expired'
            ? 'ลิงก์รูปสลิปหมดอายุแล้ว กรุณาอัปโหลดรูปใหม่อีกครั้ง'
            : 'ข้อมูลอ้างอิงรูปสลิปไม่ถูกต้อง กรุณาอัปโหลดรูปใหม่อีกครั้ง',
          { reason: claims.reason },
        );
      }

      /*
       * 🔒 The handle names its order, and this is the comparison that makes that mean
       * something. Without it a caller could upload against an order of their own, then
       * present a handle minted for *another* order — or, if the key were unsigned, name a
       * stranger's slip image outright and read it back through their own view grant. Every
       * check downstream would pass, because every check downstream is about the slip they
       * legitimately own.
       */
      if (claims.claims.orderId !== order.id) {
        throw AppError.badRequest('รูปสลิปนี้ถูกอัปโหลดไว้สำหรับออร์เดอร์อื่น', {
          reason: 'handle_order_mismatch',
        });
      }

      const transferredAt = new Date(body.transferredAt);
      this.assertTransferPlausible(order, transferredAt);

      const receivedBankAccountId = await this.assertKnownActiveAccount(
        tx,
        body.receivedBankAccountId,
      );

      const slipId = await this.slips.insertSlip(tx, {
        orderId: order.id,
        amountThbMinor: thbMinor(body.amountThbMinor),
        transferredAt,
        bankReference: body.bankReference ?? null,
        storageKey: claims.claims.storageKey,
        payerName: body.payerName ?? null,
        payerAccountLast4: body.payerAccountLast4 ?? null,
        receivedBankAccountId,
        /*
         * 🔒 BOTH HALVES OF WHO UPLOADED IT — 5b red team, RT-1.
         *
         * The user id is null for a guest, and the guest funnel is the *main* funnel (plan 6).
         * That is why `payment_slips_reviewer_is_not_submitter` is written with `IS DISTINCT
         * FROM` — and it is also why, written that way and compared against that column alone,
         * it never fired at all: `null IS DISTINCT FROM x` is true, so every reviewer in the
         * company passed it on every guest slip. One human with one private window walked it:
         * anonymous cart → guest slip → sign in → accept, and the order froze on money nobody
         * independent had looked at.
         *
         * A guest is a real identity here (`guests.secret_hash`, migration 0008) and signing in
         * *claims* it, so recording it makes the link recoverable. `payment_slips_guard_write()`
         * refuses a reviewer who claimed this guest.
         */
        submittedByUserId: actor.actorUserId,
        submittedByGuestId: actor.actorGuestId,
        /* The customer's slip has a picture, so it needs no explanation for the absence of one. */
        noSlipReasonTh: null,
      });

      const slip = await this.slips.findSlip(slipId, tx);
      if (!slip) throw new Error('payments/slips: the slip could not be read back');

      return encodeSlip(slip, [], audienceFor(scope));
    });
  }

  /**
   * ⭐ Record a payment that arrived with no slip — the owner's *"ลูกค้าโอนชำระแล้วแต่ไม่ได้แนบ
   * สลิปยืนยัน"*, and the one route this feature adds.
   *
   * ── ⚠️ WHAT THIS DOES NOT DO, AND WHY THAT IS THE DESIGN ─────────────────────────
   *
   * **It does not accept anything.** What it writes is an ordinary `submitted` slip with no
   * image and a stated reason. The money does not move here; it moves where it has always
   * moved — `accept()`, through `planAllocations`, `slip_allocations`, the deferred footing
   * assertion and `LedgerService.recordSlipAccepted`. There is no second path for money, and
   * this method contains no arithmetic at all.
   *
   * A route that recorded *and* accepted would have made every use of this feature a self-review
   * by construction, because the person who typed the figures would be the only person the
   * request ever saw. Split in two, a company with two staff keeps the two-person rule for free
   * and a company with one uses `payments.self_review_slip` and leaves a reason on the row. The
   * owner's ask is met either way; the control survives in the first case.
   *
   * ── The shape is `createSlip`'s, minus the image and plus the reason ─────────────
   *
   * Same lock (`lockOrFail` on the order, `act`), same status gate, same transfer-time
   * plausibility, same bank-account check, same insert method. The differences are exactly two:
   * there is no `imageHandle` to verify, and `noSlipReasonTh` is required — which is
   * `payment_slips_evidence_exists`'s third arm, and the database refuses the row without it
   * whatever this method forgets.
   */
  async recordSlip(scope: Scope, body: RecordSlipRequestWire): Promise<SlipWire> {
    const actor = requireActor(scope);
    /*
     * A recorded payment is somebody's name against money nobody photographed, so the recorder
     * must be a person — the same assertion `requireReviewer` makes about the other half of the
     * pair, and for a stronger reason: with no image, `submitted_by_user_id` is the *only*
     * accountability on the row until it is reviewed.
     */
    if (actor.actorUserId === null) {
      throw AppError.unauthenticated('การบันทึกการชำระเงินต้องทำในนามผู้ใช้ที่ลงชื่อเข้าใช้แล้ว');
    }

    return this.slips.transaction(async (tx) => {
      const order = await this.scoped.lockOrFail(tx, scope, body.orderId, 'act');
      this.assertSlipAttachable(order);
      await this.assertRoomForAnotherSlip(order);

      const transferredAt = new Date(body.transferredAt);
      this.assertTransferPlausible(order, transferredAt);

      const receivedBankAccountId = await this.assertKnownActiveAccount(
        tx,
        body.receivedBankAccountId,
      );

      const slipId = await this.slips.insertSlip(tx, {
        orderId: order.id,
        amountThbMinor: thbMinor(body.amountThbMinor),
        transferredAt,
        bankReference: body.bankReference ?? null,
        /* ⭐ No image, and the row says so in two columns at once. */
        storageKey: null,
        noSlipReasonTh: body.noSlipReasonTh,
        payerName: body.payerName ?? null,
        payerAccountLast4: body.payerAccountLast4 ?? null,
        receivedBankAccountId,
        submittedByUserId: actor.actorUserId,
        /*
         * Null, and not `actor.actorGuestId`. A staff member holding `payments.record_without_slip`
         * is a signed-in user; carrying a guest id here would put a *second* identity on the row
         * for the two-person rule to resolve, and `slip_submitter_user_ids()` would then union in
         * whoever that guest cookie once belonged to.
         */
        submittedByGuestId: null,
      });

      const slip = await this.slips.findSlip(slipId, tx);
      if (!slip) throw new Error('payments/slips: the recorded payment could not be read back');

      /*
       * A log line as well as a row, because this is the event an auditor asks about first and a
       * log is searchable across a window the queue no longer shows. It is *not* the audit
       * surface — `GET /payments/slips/recorded` is, and it is a query rather than a grep.
       */
      this.logger.log(
        `Payment recorded with no slip: slip=${slip.id} order=${order.id} by=${actor.actorUserId}`,
      );

      return encodeSlip(slip, [], 'staff');
    });
  }

  /* ---------------------------------------------------------------- *
   * Reading
   * ---------------------------------------------------------------- */

  async listForOrder(scope: Scope, orderId: string): Promise<SlipListWire> {
    /*
     * The scoped read runs first and its only purpose is the 404: `payment_slips` has no
     * owner column of its own, so "may this person see these slips" is a question about the
     * order and has to be asked of the order.
     */
    const order = await this.scoped.findOrFail(scope, orderId, 'read');

    const rows = await this.slips.listSlipsByOrder(order.id);
    const allocations = await this.slips.allocationsForSlips(rows.map((row) => row.id));
    const audience = audienceFor(scope);

    return { slips: rows.map((row) => encodeSlip(row, allocations, audience)) };
  }

  /** The reviewer's queue. Guarded by `payments.read` on the route; staff audience throughout. */
  async queue(limit: number): Promise<SlipQueueWire> {
    const rows = await this.slips.listSubmitted(limit);
    const allocations = await this.slips.allocationsForSlips(rows.map((row) => row.slip.id));

    return {
      entries: rows.map((row) => ({
        slip: encodeSlip(row.slip, allocations, 'staff'),
        orderNo: row.orderNo,
        orderStatus: row.orderStatus,
        queueBucket: row.queueBucket,
      })),
    };
  }

  /**
   * ⭐ THE AUDIT SURFACE THE OWNER IS TRUSTING.
   *
   * *"สิ่งสำคัญคือต้องสามารถตรวจสอบย้อนหลังได้ ถ้าทำได้ก็โอเค"* — this is the "ทำได้". Which
   * payments were recorded with no slip, who recorded them, who accepted them, why, and which
   * of those were self-reviewed, in one query, ordered by when the money is claimed to have
   * moved.
   *
   * Nothing is folded, filtered or judged here. `only=self_reviewed` narrows the same list to
   * the rows where one person did both halves; everything else about what the list *means* is
   * `SlipsRepository.listRecordedWithoutSlip`, where `slip_submitter_user_ids()` decides who
   * counts as the same person.
   */
  async recordedWithoutSlip(limit: number, only: 'all' | 'self_reviewed'): Promise<RecordedSlipListWire> {
    const rows = await this.slips.listRecordedWithoutSlip(limit, only === 'self_reviewed');
    return { entries: rows.map(encodeRecordedSlip) };
  }

  /**
   * The two-column comparison — plan 7.6's *"หน้าจอตรวจต้องเป็นการเทียบสองคอลัมน์ ไม่ใช่ปุ่ม
   * 'ยืนยัน'"*.
   *
   * Manual review is the only control in this design and forged slips are a known problem,
   * so the API's contribution is to compute the discrepancy on the server rather than hope
   * a screen renders it: `comparison.differenceThbMinor` is signed, and a client that
   * renders nothing else must still render that.
   *
   * The suggested allocation is offered and never applied. A server that allocated
   * automatically and asked for confirmation would be the confirm button the plan refuses,
   * wearing a table.
   */
  async review(scope: Scope, slipId: string): Promise<SlipReviewWire> {
    const { slip, order } = await this.loadForStaff(scope, slipId);

    const [allocations, instalments, money] = await Promise.all([
      this.slips.allocationsForSlips([slip.id]),
      this.slips.instalments(order.id),
      this.slips.orderMoney(order.id),
    ]);

    if (money === undefined) throw new Error('payments/slips: the order money could not be read');

    const gateIsOpen = await this.slips.gateIsOpen(order.id, FREEZE_STATUS);
    const suggestion = suggestAllocations(slip.amountThbMinor, instalments);
    const expected = suggestion.expectedNextDueThbMinor;

    return {
      slip: encodeSlip(slip, allocations, 'staff'),
      order: {
        id: order.id,
        orderNo: order.orderNo,
        status: order.status,
        grandTotalThbMinor:
          order.grandTotalThbMinor === null ? null : encodeThb(order.grandTotalThbMinor),
        scheduledDepositThbMinor:
          order.scheduledDepositThbMinor === null ? null : encodeThb(order.scheduledDepositThbMinor),
        frozenAt: order.frozenAt === null ? null : order.frozenAt.toISOString(),
        contactName: order.contactName,
      },
      money: encodeMoney(money),
      instalments: instalments.map(encodeInstalment),
      gate: {
        status: FREEZE_STATUS,
        isOpenNow: gateIsOpen,
        gatingInstalmentSeqs: instalments
          .filter((instalment) => instalment.gatesEntryTo === FREEZE_STATUS)
          .map((instalment) => instalment.seq),
      },
      comparison: {
        slipAmountThbMinor: encodeThb(slip.amountThbMinor),
        expectedNextDueThbMinor: expected === null ? null : encodeThb(expected),
        differenceThbMinor: expected === null ? null : encodeThb(slip.amountThbMinor - expected),
      },
      suggestedAllocations: suggestion.allocations,
      unallocatableReasonTh: suggestion.unallocatableReasonTh,
    };
  }

  /* ---------------------------------------------------------------- *
   * The review — the two halves, and they are not symmetric
   * ---------------------------------------------------------------- */

  /**
   * Accept the slip: the money lands, and *sometimes* the order moves.
   *
   * Everything in one transaction. The alternative — accept, commit, then transition — has
   * a window in which the company holds the deposit and the order is not frozen, and the
   * only way to notice is a customer telephoning about a window nobody started making.
   */
  async accept(scope: Scope, slipId: string, body: AcceptSlipRequestWire): Promise<AcceptSlipResultWire> {
    const actor = requireActor(scope);
    const reviewerId = requireReviewer(actor);

    return this.slips.transaction(async (tx) => {
      const { slip, order } = await this.lockForAcceptance(tx, scope, slipId);

      /*
       * Money must not land on a finished contract. The slip could only have been created
       * while the order was live, so reaching this means the order was cancelled,
       * superseded or delivered *while the slip sat in the queue* — which is a real and
       * ordinary race, and the right answer is a refusal that names the status. Plan 7.8's
       * `terminal_holding_money` bucket is about money already accepted; it is not a licence
       * to add more.
       */
      this.assertSlipAttachable(order);
      const selfReviewReasonTh = await this.assertReviewerIsNotSubmitter(
        slip,
        reviewerId,
        scope,
        body.selfReviewReasonTh,
        tx,
      );

      const instalments = await this.slips.instalments(order.id, tx);
      const plan = planAllocations({
        slipAmountThbMinor: slip.amountThbMinor,
        allocations: body.allocations,
        instalments,
        ...(body.acknowledgeOverpaymentThbMinor === undefined
          ? {}
          : { acknowledgeOverpaymentThbMinor: thbMinor(body.acknowledgeOverpaymentThbMinor) }),
      });

      /*
       * ⚠️ THE GATE, BEFORE AND AFTER, FROM ONE IMPLEMENTATION.
       *
       * "Did *this* slip close the gating instalment?" is not answerable from the after
       * state alone: an order whose gate was already open — paid in full a week ago, or
       * already in production — must not be moved by a balance slip. So the predicate is
       * evaluated on both sides of the write, and both evaluations are the same SQL
       * function. A TypeScript reimplementation of either would be plan 7.13's finding
       * happening again, with the two answers disagreeing about somebody's freeze date.
       */
      const gateOpenBefore = await this.slips.gateIsOpen(order.id, FREEZE_STATUS, tx);
      const hasGate = await this.slips.hasGate(order.id, FREEZE_STATUS, tx);

      const accepted = await this.slips.markAccepted(tx, {
        slipId: slip.id,
        reviewerId,
        unallocatedThbMinor: plan.unallocatedThbMinor,
        /*
         * The payer is attested in the same statement as the review, or not at all. See
         * `acceptSlipRequestSchema.payer`: the columns arrive on the *customer's* create-slip
         * body, so until a reviewer has read them off the image they are a field the payer
         * typed, and plan 7.12's whole fraud control was being set by the party it is a control
         * against.
         */
        payer: body.payer ?? null,
        /*
         * 🔒 Null unless this really is a self-review. `assertReviewerIsNotSubmitter` returns the
         * reason only when the reviewer is in `slip_submitter_user_ids()`, so a reason supplied
         * against somebody else's slip is dropped rather than written — a self-review marker on
         * the audit list for a slip two people handled correctly is the audit lying in the
         * direction nobody would think to check.
         */
        selfReviewReasonTh,
      });
      if (!accepted) {
        /* Somebody else reviewed it between the lock and the write — or, more likely, before it. */
        throw AppError.conflict('สลิปใบนี้ถูกตรวจไปแล้ว กรุณาโหลดคิวใหม่', {
          reason: 'slip_already_reviewed',
        });
      }

      await this.slips.insertAllocations(
        tx,
        plan.allocations.map((allocation) => ({
          slipId: slip.id,
          instalmentId: allocation.instalmentId,
          amountThbMinor: allocation.amountThbMinor,
        })),
      );

      /*
       * ⚠️ ONE IMPLEMENTATION OF THIS POSTING, AND IT IS NOT IN THIS MODULE.
       *
       * `SlipsRepository.postSlipAccepted` used to assemble the two legs here, while
       * `LedgerService.recordSlipAccepted` assembled the same two legs and had no caller. That
       * is plan 7.13's third seam happening *inside one round*: two places deciding what
       * accepting a slip means in the ledger, agreeing today because somebody copied one into
       * the other. The accounts appear in `LedgerService` and nowhere else in this application,
       * and this call is what makes that true rather than aspirational.
       */
      await this.ledger.recordSlipAccepted(tx, {
        orderId: order.id,
        slipId: slip.id,
        amountThbMinor: slip.amountThbMinor,
        landed: true,
      });

      const gateOpenAfter = await this.slips.gateIsOpen(order.id, FREEZE_STATUS, tx);
      const gateOpened = hasGate && !gateOpenBefore && gateOpenAfter;

      const orderTransition = gateOpened
        ? await this.freeze(tx, { order, actor, slip, note: body.noteTh })
        : null;

      /*
       * Read back inside the transaction, sequentially. A pooled transaction is one
       * connection and `pg` queues statements on it, so a `Promise.all` here would be three
       * statements pretending to be concurrent — no faster, and a stack trace that no
       * longer says which one failed.
       */
      const reread = await this.slips.findSlip(slip.id, tx);
      const allocations = await this.slips.allocationsForSlips([slip.id], tx);
      const money = await this.slips.orderMoney(order.id, tx);

      if (!reread || money === undefined) {
        throw new Error('payments/slips: the accepted slip could not be read back');
      }

      return {
        slip: encodeSlip(reread, allocations, 'staff'),
        orderTransition,
        gateOpened,
        money: encodeMoney(money),
      };
    });
  }

  /**
   * Reject it. **The order does not move, and this method cannot move it.**
   *
   * Plan 7.3 in full: making a rejection a transition would require inventing a status that
   * means the same thing as the previous status, which is poison. So there is no lock on
   * the order here, no transition lookup, no event on the spine, and the return type has
   * nowhere to put any of them.
   *
   * ⚠️ **The customer is not notified, and that is a gap rather than a decision.** The
   * outbox is a consumer of `order_events` and of nothing else (plan 10.1), and
   * `ORDER_EVENT_TYPES` is a closed CHECK with no slip-level member — so this module cannot
   * append a `slip_rejected` row without a migration it does not own. The record of the
   * rejection is the slip itself: who reviewed it, when, and the Thai reason, which is at
   * least visible on the customer's own `GET /orders/:id/payment-slips`. Reported rather
   * than worked around, because the workaround would be `sendEmail()` in a service, which
   * is the exact thing the outbox exists to prevent.
   */
  async reject(scope: Scope, slipId: string, body: RejectSlipRequestWire): Promise<RejectSlipResultWire> {
    const actor = requireActor(scope);
    const reviewerId = requireReviewer(actor);

    return this.slips.transaction(async (tx) => {
      const slip = await this.lockSlipOrFail(tx, slipId);

      /*
       * Read, not act. The order is loaded to answer "may this caller see this slip" and for
       * nothing else — a rejection touches no column of it — and asking for the `act` reach
       * would be asking for an authority this path does not use. The row is not locked
       * either, which is the same statement one layer down.
       */
      await this.scoped.findOrFail(scope, slip.orderId, 'read');

      const selfReviewReasonTh = await this.assertReviewerIsNotSubmitter(
        slip,
        reviewerId,
        scope,
        body.selfReviewReasonTh,
        tx,
      );

      const rejected = await this.slips.markRejected(tx, {
        slipId: slip.id,
        reviewerId,
        reasonTh: body.reasonTh,
        selfReviewReasonTh,
      });

      if (!rejected) {
        throw AppError.conflict('สลิปใบนี้ถูกตรวจไปแล้ว กรุณาโหลดคิวใหม่', {
          reason: 'slip_already_reviewed',
        });
      }

      const reread = await this.slips.findSlip(slip.id, tx);
      if (!reread) throw new Error('payments/slips: the rejected slip could not be read back');

      return { slip: encodeSlip(reread, [], 'staff') };
    });
  }

  /* ---------------------------------------------------------------- *
   * The image: short-lived grants, and erasure
   * ---------------------------------------------------------------- */

  /**
   * Mint a short-lived URL for one image — plan 7.6.
   *
   * ── ⚠️ "View" and "download" ARE THE SAME ACT, AND PRETENDING OTHERWISE WAS WORSE ─
   *
   * Plan 7.6 asks for *"แยกสิทธิ์ 'ดู' ออกจาก 'ดาวน์โหลด'"* and this module used to claim it:
   * `purpose=download` required `payments.verify`, `purpose=view` did not. The red team took
   * ten seconds over it — the **view** grant serves identical bytes from the anonymous
   * `GET /payments/slip-images/:grant`, and the only difference between the two responses is
   * `Content-Disposition: inline` versus `attachment`. Staff refused the download minted a view
   * and `curl`'d the whole PNG byte for byte. Right-click → Save As does the same.
   *
   * A control that a browser's context menu defeats is not a control, and a *decorative* one is
   * worse than none, because the next person reads the permission check and believes it. So the
   * split is gone and the honest rule is written instead: **any grant on a slip image is a copy
   * of the image**, and it takes the same authority whatever the header says.
   *
   *   the customer or guest who owns the order  →  their own slip, either disposition
   *   staff                                     →  `payments.verify`, either disposition
   *
   * `purpose` survives as what it actually is — a rendering hint for the response header —
   * which is why it is still on the wire and no longer on the permission check.
   *
   * ⚠️ A real view/download split needs the bytes to differ: a watermarked, downscaled render
   * for viewing and the original for download. That is a feature, not a permission, and it is
   * reported rather than approximated. The permission itself should also be
   * `payments.download_slip` rather than `payments.verify`; `src/rbac/permissions.ts` is the
   * whole application's catalogue and adding a code there is a decision about the role model,
   * so the reuse is recorded and left.
   */
  async mintGrant(
    scope: Scope,
    slipId: string,
    purpose: 'view' | 'download',
  ): Promise<SlipImageGrantWire> {
    const slip = await this.findSlipOrFail(slipId);
    await this.scoped.findOrFail(scope, slip.orderId, 'read');

    const reach = orderReach(scope, 'read');
    if (reach.kind === 'all' && !scopeHolds(scope, 'payments.verify')) {
      throw new AppError(
        'FORBIDDEN',
        403,
        'การเปิดรูปสลิปของลูกค้าต้องใช้สิทธิ์ตรวจสลิป — การ "ดู" กับการ "ดาวน์โหลด" ส่งไบต์ชุดเดียวกัน',
        { purpose },
      );
    }

    if (slip.storageKey === null) {
      throw AppError.notFound(
        slip.storageKeyErasedAt === null
          ? 'สลิปใบนี้ไม่มีรูปแนบ'
          : 'รูปของสลิปใบนี้ถูกลบตามระยะเวลาการเก็บรักษาแล้ว',
        { reason: slip.storageKeyErasedAt === null ? 'never_had_an_image' : 'erased' },
      );
    }

    const audience = audienceIdOf(scope);
    const grant = mintImageGrant(
      { slipId: slip.id, storageKey: slip.storageKey, audience, purpose },
      this.config.grantKey,
      Date.now(),
    );

    /*
     * ⚠️ THE AUDIT, AND WHAT IT IS NOT.
     *
     * Plan 7.6 asks for short-lived URLs *ที่ถูก audit*. This is a structured log line and
     * not a table, and the difference matters: a log is searchable, is not queryable beside
     * the slip, and is subject to whatever retention the log sink has. A durable
     * `slip_access_log` — issued at, by whom, purpose, redeemed at — is schema this module
     * does not own, and it is the honest answer. Reported rather than approximated.
     */
    this.logger.log(
      `Slip image grant issued: slip=${slip.id} order=${slip.orderId} purpose=${purpose} audience=${audience}`,
    );

    return {
      path: `/payments/slip-images/${grant.token}`,
      purpose,
      expiresAt: new Date(grant.expiresAtMs).toISOString(),
    };
  }

  /**
   * Redeem a grant.
   *
   * The route that calls this is anonymous, because a browser attaches no `Authorization`
   * header to an `<img>` request — the grant *is* the credential, exactly as an S3
   * presigned URL is. What that buys and what it costs are both stated in
   * `slip-grant.ts`; what it must never become is an authentication mechanism, so
   * everything below the signature check is read from the database now rather than trusted
   * from the token:
   *
   *   * the slip still exists;
   *   * its `storage_key` still matches the one that was signed — so a grant minted before
   *     a PDPA erasure is dead the moment the erasure commits, rather than continuing to
   *     serve bytes for its remaining minutes.
   */
  async openImage(token: string): Promise<{
    readonly claims: ImageGrantClaims;
    readonly object: StoredObject;
  }> {
    const verified = verifyImageGrant(token, this.config.grantKey, Date.now());

    if (!verified.ok) {
      /*
       * One answer for every failure, and 404 rather than 401 or 403. A token that never
       * verified, one that expired and one for a slip that does not exist are the same
       * answer to the caller, because distinguishing them is an oracle: "expired" tells a
       * holder of a stolen URL that the URL was real.
       */
      throw grantNotFound(verified.reason);
    }

    /*
     * The id in the token is one we signed, so it is a uuid — and it is checked anyway.
     * `findSlip` puts it straight into a `uuid` column, where anything else is SQLSTATE
     * 22P02: a 500 with a stack, on the one route in this feature that anybody can reach.
     * "We only ever sign uuids" is a claim about every other function in this file.
     */
    if (!isOrderUuid(verified.claims.slipId)) throw grantNotFound('malformed_subject');

    const slip = await this.slips.findSlip(verified.claims.slipId);
    if (!slip || slip.storageKey === null || slip.storageKey !== verified.claims.storageKey) {
      throw grantNotFound('stale');
    }

    this.logger.log(
      `Slip image served: slip=${slip.id} purpose=${verified.claims.kind} audience=${verified.claims.audience}`,
    );

    return { claims: verified.claims, object: await this.images.open(slip.storageKey) };
  }

  /**
   * Destroy the image and keep the row — plan 7.6, and the schema's own hint on
   * `payment_slips_guard_write()`.
   *
   * The row survives because it is an accounting record: the amount, the bank reference and
   * the four digits that reconcile a statement are what makes a payment auditable years
   * later, and none of them is in the picture. Deleting the row instead would be refused by
   * the database, which is correct.
   *
   * ⚠️ **There is no clock behind this.** Plan 7.16 says so directly — the columns exist,
   * the retention period is a number the company's accountant has to supply, and a sweep
   * that runs on an invented interval would destroy evidence to a schedule nobody agreed
   * to. So this is a deliberate act by a person holding `users.erase`, and the scheduled
   * half is reported as missing.
   */
  async eraseImage(scope: Scope, slipId: string): Promise<SlipWire> {
    const erasedKey = await this.slips.transaction(async (tx) => {
      const slip = await this.lockSlipOrFail(tx, slipId);
      await this.scoped.findOrFail(scope, slip.orderId, 'read');

      if (slip.storageKey === null) return null;

      const erased = await this.slips.eraseImage(tx, slip.id);
      if (!erased) return null;

      this.logger.log(`Slip image erased: slip=${slip.id} order=${slip.orderId}`);
      return slip.storageKey;
    });

    /*
     * The object goes after the row, and its failure is not the caller's problem: the
     * reference is already gone, so what is left is bytes nobody can reach. The reverse
     * order would, for the duration of one failed statement, leave a row pointing at an
     * image that is not there — which is a review screen returning 503 on a slip somebody is
     * trying to look at.
     */
    if (erasedKey !== null) await this.images.forget(erasedKey);

    const slip = await this.findSlipOrFail(slipId);
    return encodeSlip(slip, await this.slips.allocationsForSlips([slip.id]), audienceFor(scope));
  }

  /* ---------------------------------------------------------------- *
   * Helpers
   * ---------------------------------------------------------------- */

  /**
   * Append the event, then move the order — the two halves of every transition, in that
   * order, through the methods `order.repository.ts` designates as 5b's seam.
   *
   * The event carries the slip that caused it. That is not bookkeeping: the freeze is the
   * single most consequential moment in an order's life, and "which payment opened it" is
   * the first question anybody asks about a disputed one. `payment_confirmed` requires no
   * payload keys, so these are additions rather than substitutions, and
   * `order_events_guard_insert()` accepts extra keys.
   */
  private async freeze(
    tx: Tx,
    input: {
      readonly order: ScopedOrder;
      readonly actor: OrderActor;
      readonly slip: SlipRow;
      readonly note: string | undefined;
    },
  ): Promise<OrderTransitionWire> {
    const row = await this.orders.findTransition(tx, input.order.status, FREEZE_STATUS);

    if (!row) {
      /*
       * The gate opened on an order that cannot legally enter `production_confirmed` from
       * where it is — `redesign`, whose route to the freeze is `redesign_approved` and is a
       * decision about a *design*, not about money. The money is accepted and recorded; the
       * order stays where it is, which is the correct outcome and not a failure.
       */
      throw AppError.conflict(
        'เงินงวดที่ถือประตูครบแล้ว แต่ออร์เดอร์อยู่ในสถานะที่เข้าสู่การผลิตด้วยการยืนยันสลิปไม่ได้ — ' +
          'กรุณาดำเนินการตามขั้นตอนของสถานะปัจจุบัน',
        { from: input.order.status, to: FREEZE_STATUS, reason: 'no_transition_from_here' },
      );
    }

    /* A necessary condition, never a sufficient one — and the database checks it again. */
    assertActorMayMove(row, input.actor);

    const eventId = await this.orders.appendEvent(tx, {
      orderId: input.order.id,
      eventType: row.eventType,
      fromStatus: input.order.status,
      toStatus: FREEZE_STATUS,
      actorKind: input.actor.actorKind,
      actorUserId: input.actor.actorUserId,
      actorGuestId: input.actor.actorGuestId,
      payload: {
        slip_id: input.slip.id,
        /* A string and not a JSON number: this is money in minor units. */
        slip_amount_thb_minor: input.slip.amountThbMinor.toString(),
        ...(input.note === undefined ? {} : { note_th: input.note }),
      },
    });

    await this.orders.moveStatus(tx, {
      orderId: input.order.id,
      toStatus: FREEZE_STATUS,
      statusEventId: eventId,
    });

    return { from: input.order.status, to: FREEZE_STATUS, eventId };
  }

  /**
   * Order first, slip second — the lock order this whole file keeps. See the module note.
   *
   * The intent is `act` and is not a parameter, because there is exactly one caller and
   * making it configurable would be an invitation to reuse this for the rejection path.
   * Rejection does not lock the order at all, and that is the asymmetry, not an oversight.
   */
  private async lockForAcceptance(
    tx: Tx,
    scope: Scope,
    slipId: string,
  ): Promise<{ readonly slip: SlipRow; readonly order: ScopedOrder }> {
    const unlocked = await this.findSlipOrFail(slipId);

    /*
     * The order id read here is used only to *find* the row to lock, and it cannot go stale:
     * `payment_slips_guard_write()` refuses any change to `order_id`, so a slip belongs to
     * the order it was uploaded against for ever.
     */
    const order = await this.scoped.lockOrFail(tx, scope, unlocked.orderId, 'act');
    const slip = await this.lockSlipOrFail(tx, slipId);

    if (slip.status !== 'submitted') {
      throw AppError.conflict('สลิปใบนี้ถูกตรวจไปแล้ว', {
        reason: 'slip_already_reviewed',
        status: slip.status,
      });
    }

    return { slip, order };
  }

  private async loadForStaff(
    scope: Scope,
    slipId: string,
  ): Promise<{ readonly slip: SlipRow; readonly order: ScopedOrder }> {
    const slip = await this.findSlipOrFail(slipId);
    const order = await this.scoped.findOrFail(scope, slip.orderId, 'read');
    return { slip, order };
  }

  private async findSlipOrFail(slipId: string): Promise<SlipRow> {
    /*
     * A path segment reaches a `uuid` column, and one that is not a uuid is SQLSTATE 22P02 —
     * neither an `AppError` nor an `HttpException`, so it would fall through the filter as a
     * 500 with a logged stack. The same rule `ScopedOrderRepository` applies to `:orderId`,
     * and the same answer a caller gets for any id that names nothing.
     */
    if (!isOrderUuid(slipId)) throw slipNotFound();

    const slip = await this.slips.findSlip(slipId);
    if (!slip) throw slipNotFound();
    return slip;
  }

  private async lockSlipOrFail(tx: Tx, slipId: string): Promise<SlipRow> {
    if (!isOrderUuid(slipId)) throw slipNotFound();

    const slip = await this.slips.lockSlip(tx, slipId);
    if (!slip) throw slipNotFound();
    return slip;
  }

  /**
   * ⚠️ A PLAN 13 DEFAULT — and a hole this module would otherwise open by itself.
   *
   * `POST …/payment-slips/image` writes bytes to a bucket, and a customer or guest may call
   * it as many times as they like against an order they own. Nothing in the schema bounds
   * it: `payment_slips` has no per-order limit, the funnel throttle covers only
   * `POST /orders`, and the ceiling on a *single* upload is a ceiling on one request. Twenty
   * megabytes per order is not a problem; unbounded is.
   *
   * So the count of slips already on the order is the bound, and it is generous on purpose.
   * A real order takes one slip, or two with a deposit; a rejected slip and a re-transfer
   * make four; a customer paying an instalment plan in six parts with one mistake apiece
   * makes twelve. Twenty is well past every honest case and well short of a bucket.
   *
   * The number is this module's and nobody has agreed it — plan 13 does not ask for it,
   * which is exactly why it is stated as a default with its reasoning rather than tuned
   * quietly. The right long-term answer is a rate limit on the upload route beside the
   * funnel throttle, which is `src/orders/funnel-throttle.middleware.ts`'s territory.
   */
  private async assertRoomForAnotherSlip(order: ScopedOrder): Promise<void> {
    const existing = await this.slips.countSlips(order.id);
    if (existing < MAX_SLIPS_PER_ORDER_DEFAULT) return;

    throw AppError.conflict(
      'ออร์เดอร์นี้มีสลิปมากเกินจำนวนที่ระบบรับไว้แล้ว กรุณาติดต่อฝ่ายขายโดยตรง',
      { reason: 'too_many_slips', existing, limit: MAX_SLIPS_PER_ORDER_DEFAULT },
    );
  }

  /** The mirror of `payment_slips_live_orders_only`. See the constant. */
  private assertSlipAttachable(order: ScopedOrder): void {
    if (SLIP_ATTACHABLE_STATUSES.includes(order.status)) return;

    throw AppError.conflict(
      'ออร์เดอร์นี้ปิดสัญญาไปแล้ว จึงรับสลิปเพิ่มไม่ได้ — เงินที่โอนเข้ามาหลังจากนี้ต้องเข้ากระบวนการกระทบยอด',
      { reason: 'order_not_accepting_slips', status: order.status },
    );
  }

  /**
   * 🔒 Two-person rule #1 of the four this phase spends — plan 7.7's single control, and the
   * one declared bypass the owner asked for.
   *
   * The database holds it too, in two places (`payment_slips_reviewer_is_not_submitter` and
   * `payment_slips_guard_write()`). This exists so the refusal is a sentence rather than a
   * CHECK violation, and it is deliberately *not* the enforcement: a reviewer approving their
   * own upload is the one thing that makes the whole manual-payment model worthless, and it
   * should be impossible for a second code path as well as for this one.
   *
   * ── ⭐ THE BYPASS NEEDS BOTH HALVES, AND NEITHER ALONE ───────────────────────────
   *
   *     holds `payments.self_review_slip`, no reason      →  403. Nothing is written.
   *     supplies a reason, holds no permission            →  403. Nothing is written.
   *     both                                              →  allowed, and the reason goes on
   *                                                          the row in the same statement as
   *                                                          the review, for ever.
   *
   * The two refusals say different things on purpose. "You may not do this at all" and "you may,
   * but not silently" are different instructions to the person reading them, and collapsing them
   * into one message would make the second look like a permissions problem to somebody who
   * simply forgot to type a sentence.
   *
   * ⚠️ Returns the reason to be written, or `null`, rather than writing it — because it must be
   * written in the *same UPDATE* as the review. `payment_slips_self_review_shape` refuses the
   * column beside a null reviewer and the freeze refuses it afterwards, so there is no ordering
   * of two statements that works. That is not an inconvenience; it is what makes the trail
   * non-optional rather than a follow-up somebody can fail to make.
   *
   * ⚠️ Returns `null` on a slip somebody else uploaded, whatever was supplied. A reason recorded
   * against a bypass that never happened would put a self-review marker on the audit list for a
   * slip two people handled correctly — the audit lying in the direction nobody would check.
   */
  private async assertReviewerIsNotSubmitter(
    slip: SlipRow,
    reviewerId: string,
    scope: Scope,
    declaredReasonTh: string | undefined,
    tx: Tx,
  ): Promise<string | null> {
    /*
     * ⚠️ THE COMPARISON IS AGAINST `slip_submitter_user_ids()`, NOT AGAINST ONE COLUMN.
     *
     * `slip.submittedByUserId !== reviewerId` is what this used to be, and it was the whole of
     * the finding: a guest-submitted slip has that column NULL, `null !== x` is true for every
     * reviewer in the company, and the guest funnel is the *main* funnel. The SQL function
     * unions the direct submitter with whoever claimed the submitting guest, and calling it
     * rather than reimplementing the union is what keeps this refusal and the trigger's
     * refusal about the same set of people.
     */
    const submitters = await this.slips.submitterUserIds(slip.id, tx);
    if (!submitters.includes(reviewerId)) return null;

    if (!scopeHolds(scope, 'payments.self_review_slip')) {
      throw new AppError(
        'FORBIDDEN',
        403,
        'ผู้ที่บันทึกสลิปใบนี้ตรวจสลิปของตัวเองไม่ได้ — ต้องให้อีกคนตรวจ · ตะกร้าที่เปิดแบบไม่ล็อกอินแล้วมาล็อกอินภายหลัง ถือเป็นคนเดียวกัน',
        { reason: 'reviewer_is_submitter' },
      );
    }

    if (declaredReasonTh === undefined) {
      throw new AppError(
        'FORBIDDEN',
        403,
        'คุณเป็นผู้บันทึกสลิปใบนี้เอง จะตรวจเองได้ต้องระบุเหตุผลที่ต้องทำทั้งสองขั้นตอนด้วยตนเอง — เหตุผลนี้จะถูกบันทึกไว้ถาวรเพื่อการตรวจสอบย้อนหลัง',
        { reason: 'self_review_needs_reason' },
      );
    }

    this.logger.warn(
      `Two-person rule bypassed by declaration: slip=${slip.id} order=${slip.orderId} reviewer=${reviewerId}`,
    );

    return declaredReasonTh;
  }

  /**
   * A claimed transfer time that cannot have happened.
   *
   * Two refusals, both cheap and both about data a person would otherwise have to notice by
   * eye on a review screen: a transfer in the future is a wrong clock or a fabrication, and
   * a transfer from before the order existed is a slip for something else — very often a
   * genuine one, pasted onto the wrong order.
   */
  private assertTransferPlausible(order: ScopedOrder, transferredAt: Date): void {
    const now = Date.now();

    if (transferredAt.getTime() > now + TRANSFER_CLOCK_SKEW_MS) {
      throw AppError.validationFailed('เวลาที่โอนเงินอยู่ในอนาคต กรุณาตรวจสอบอีกครั้ง', {
        reason: 'transfer_in_the_future',
        transferredAt: transferredAt.toISOString(),
      });
    }

    if (transferredAt.getTime() < order.createdAt.getTime()) {
      throw AppError.validationFailed(
        'เวลาที่โอนเงินอยู่ก่อนวันที่เปิดออร์เดอร์นี้ — สลิปใบนี้อาจเป็นของรายการอื่น',
        {
          reason: 'transfer_precedes_order',
          transferredAt: transferredAt.toISOString(),
          orderCreatedAt: order.createdAt.toISOString(),
        },
      );
    }
  }

  /**
   * `null`, or the id the customer picked — never a UUID this caller merely typed.
   *
   * ── Why this checks *active*, and not merely *exists* ────────────────────────────
   *
   * `payment_slips_received_bank_account_id_bank_accounts_id_fk` already refuses a UUID that
   * names no row (`ON DELETE restrict`, so it cannot even go stale under the caller). That
   * is existence, and existence is not the invariant this column is for. `apps/web`'s picker
   * offers exactly `GET .../payment-instructions`' `activeAccounts()` — never a retired one —
   * so the *only* honest values a customer's own request can carry are ids from that same
   * list. Accepting anything wider would let a customer's request name an account nobody
   * showed them: an id they read off an old invoice, a retired account still sitting in the
   * table for the audit trail `bank_account_changes` keeps, or simply a guess. A reviewer
   * reading `received_bank_account_id` off a slip is meant to trust it as "the destination
   * this customer was shown and picked" — not "any account that has ever existed" — so this
   * checks the same predicate the picker itself is built from, inside the same transaction
   * that is about to write the row, rather than trusting a value that was true when the page
   * loaded and might not be true a submission later.
   *
   * `undefined` (the field was omitted) passes through as `null` without a query — a slip a
   * staff member keys in from a phone call carries no picker behind it and this checks
   * nothing to do with the customer flow; see the contract's own note on why the field stays
   * `.optional()` there while `apps/web` never omits it.
   */
  private async assertKnownActiveAccount(tx: Tx, receivedBankAccountId: string | undefined): Promise<string | null> {
    if (receivedBankAccountId === undefined) return null;

    const [account] = await this.organisation.account(receivedBankAccountId, tx);
    if (!account || !account.isActive) {
      throw AppError.badRequest('บัญชีที่เลือกไม่ถูกต้อง หรือปิดรับโอนไปแล้ว กรุณาเลือกใหม่อีกครั้ง', {
        reason: 'bank_account_not_recognised',
      });
    }

    return account.id;
  }
}

/**
 * Staff see two extra columns; everybody else sees the same slip without them.
 *
 * `orderReach(scope, 'read').kind === 'all'` is exactly "this caller holds `orders.read`
 * over the whole table", which is the same fact that let them load the order at all. There
 * is no way to ask for the staff view without holding it, and no flag on the request that
 * could.
 */
function audienceFor(scope: Scope): SlipAudience {
  return orderReach(scope, 'read').kind === 'all' ? 'staff' : 'customer';
}

/** `user:<id>` or `guest:<id>` — who a grant was minted for, for the log line. */
function audienceIdOf(scope: Scope): string {
  const actor = orderActor(scope);
  if (actor === undefined) return 'public';
  if (actor.actorUserId !== null) return `user:${actor.actorUserId}`;
  if (actor.actorGuestId !== null) return `guest:${actor.actorGuestId}`;
  return actor.actorKind;
}

/**
 * The principal, or 401.
 *
 * `RequirePrincipal` on the route means this cannot be reached without one, so this is the
 * second lock rather than the first — and it is a `throw` and not a non-null assertion,
 * because "the guard would have stopped them" is a claim about a decorator in another file.
 */
function requireActor(scope: Scope): OrderActor {
  const actor = orderActor(scope);
  if (!actor) {
    throw AppError.unauthenticated('ต้องเข้าสู่ระบบก่อนจึงจะทำรายการนี้ได้');
  }
  return actor;
}

/**
 * A review is somebody's name against a decision, so the reviewer must be a person.
 *
 * The route requires permissions, which the guard only grants to a `user` scope, so this
 * cannot fail in practice — and `reviewed_by_user_id` is the entire accountability of the
 * only control this design has, so a null there because somebody widened a decorator later
 * is worth failing loudly over. The same assertion `media-admin.controller.ts` makes about
 * `uploaded_by_user_id`, for a column that matters more.
 */
function requireReviewer(actor: OrderActor): string {
  if (actor.actorUserId === null) {
    throw AppError.unauthenticated('การตรวจสลิปต้องทำในนามผู้ใช้ที่ลงชื่อเข้าใช้แล้ว');
  }
  return actor.actorUserId;
}

/** The same 404 for every reason a slip was not returned — see `ScopedOrderRepository`. */
function slipNotFound(): AppError {
  return AppError.notFound('ไม่พบสลิปใบนี้');
}

function grantNotFound(reason: string): AppError {
  return AppError.notFound('ลิงก์รูปสลิปนี้ใช้ไม่ได้แล้ว กรุณาเปิดจากหน้ารายการอีกครั้ง', { reason });
}

/**
 * An image this API will not store is the caller's mistake, not a server fault.
 *
 * 415 rather than 400: the request was well-formed and the *media type* was wrong, which is
 * exactly what 415 means and is a distinction the person holding a telephone can act on —
 * "export it as a JPEG" rather than "fix the form".
 */
function rejectedImageToAppError<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof ImageRejected) {
      throw new AppError('BAD_REQUEST', 415, error.messageTh, { reason: error.reason });
    }
    throw error;
  }
}
