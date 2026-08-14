import { z } from 'zod';
import { toBigInt } from '@wewin/contract/exact';
import { moneyWireSchema, type MoneyWire } from '@wewin/contract/money';
import { INSTALMENT_BASES, ORDER_STATUSES, SLIP_STATUSES } from '@wewin/db/schema';

/**
 * What the slip endpoints accept and send.
 *
 * **This belongs in `packages/contract`, and it is here instead** — the same debt
 * `src/media/media.contract.ts` writes down in the same words, for the same reason: that
 * package is another agent's surface this round and a type moved into it mid-flight is a
 * conflict in a file three apps compile against. Everything below is written to survive the
 * move, which is a rename and an export line.
 *
 * ── Money crosses this wire as `MoneyWire<'THB'>`, and not as a bare string ──────
 *
 * `{ "unit": "THB.satang", "digits": "552960" }`. The repository settled this in
 * `packages/contract/src/exact.ts` and the reasoning is worth not re-litigating here: a
 * `bigint` cannot be `JSON.stringify`d, a JSON number silently stops being the number that
 * was sent somewhere above ฿90 trillion, and a bare digit string leaves the *unit* as an
 * agreement between two codebases rather than a fact in the payload. `Exact` has no
 * readable member, so `wire.digits / 100` is a compile error rather than a wrong answer,
 * and the only way in or out is a codec that was handed a value already carrying its unit.
 *
 * Every amount in this module is `THB` and the schema pins it to `THB` — an endpoint that
 * only ever answers in baht must not accept a figure in cents that it would then add up.
 */

/**
 * A positive amount of money in THB minor units.
 *
 * There is deliberately no schema here for a *non-negative* one. Nothing a client sends in
 * this module may be zero: a slip for ฿0 is not evidence of anything (the database says so
 * too — `payment_slips_amount_positive`) and an allocation of ฿0 is a row somebody has to
 * reconcile that settles nothing.
 */
export const positiveThbSchema = moneyWireSchema('THB').refine(
  (value) => toBigInt(value) > 0n,
  'จำนวนเงินต้องมากกว่าศูนย์',
);

/** `2026-08-04T09:30:00+07:00`. An offset is required — see `assertTransferPlausible`. */
const instantSchema = z.string().datetime({ offset: true });

/* ────────────────────────────────────────────────────────────────────────────── *
 * Requests
 * ────────────────────────────────────────────────────────────────────────────── */

/**
 * Create the slip row, naming an image already uploaded.
 *
 * The image goes up first, on its own route, and comes back as an opaque `imageHandle`.
 * Two requests rather than one, and the split is not ceremony:
 *
 *   * the body of the upload **is** the file, so there is no multipart parser between the
 *     network and the bytes (`src/media/read-body.ts` argues this at length);
 *   * the handle is signed, so the storage key cannot be chosen by the caller. An
 *     unsigned key would let somebody attach *another order's slip image* to a slip of
 *     their own and then read it back through the view grant, which is a disclosure of a
 *     stranger's bank details through two endpoints that are each individually correct.
 *
 * `payerName` and `payerAccountLast4` are kept beside the row and never inside the image,
 * which is plan 7.6's PDPA line: the picture can be destroyed on a retention sweep while
 * the four digits that reconcile a bank statement survive.
 *
 * ── `receivedBankAccountId` — which of the company's accounts this transfer names ────
 *
 * Optional in the *schema*, because the column it fills predates it (`0027_organisation.sql`)
 * and a slip a staff member types in from a phone call may have no picker behind it at all.
 * It is not optional in the one caller this round adds: `apps/web`'s payment screen shows a
 * picker with no way to submit without choosing one of the accounts it lists, so every slip
 * that screen produces carries this field. `apps/web/tests/payment.test.ts` pins that the
 * storefront always sends it — the shape here staying `.optional()` is what makes that pin
 * meaningful rather than redundant with the type.
 *
 * Only a UUID is asserted here. Whether it names an account that exists, and whether that
 * account is one a customer may currently be shown, is `SlipsService.createSlip`'s job, not
 * this schema's — the same split `imageHandle`'s signature check makes: shape here, meaning
 * downstream.
 */
export const createSlipRequestSchema = z.strictObject({
  imageHandle: z.string().min(1).max(4096),
  amountThbMinor: positiveThbSchema,
  /** When the bank says the money moved — not when the file was uploaded. */
  transferredAt: instantSchema,
  bankReference: z.string().trim().min(1).max(120).optional(),
  payerName: z.string().trim().min(1).max(200).optional(),
  payerAccountLast4: z
    .string()
    .regex(/^[0-9]{4}$/, 'ต้องเป็นเลขสี่หลักท้ายบัญชีเท่านั้น')
    .optional(),
  receivedBankAccountId: z.string().uuid().optional(),
});

export type CreateSlipRequestWire = z.infer<typeof createSlipRequestSchema>;

/**
 * A reason somebody will read months later, with the money already spent.
 *
 * Ten characters and not `rejectSlipRequestSchema`'s three, and the difference is what the
 * field is *for*. A rejection reason is read by the customer within the hour, beside a slip
 * they are looking at — "เบลอ" is genuinely a complete answer there. The two reasons below are
 * the entire substance of *"สิ่งสำคัญคือต้องสามารถตรวจสอบย้อนหลังได้"*: they are read by an
 * auditor with no image, no customer on the telephone and no memory of the day, and "ok" would
 * satisfy a CHECK while answering nothing. `payment_slips_no_slip_reason_shape` and
 * `payment_slips_self_review_shape` refuse blank in the database; this refuses *thin* at the
 * edge, where the message can name the field.
 */
const auditReasonSchema = z
  .string()
  .trim()
  .min(10, 'เหตุผลต้องยาวพอที่คนอื่นจะอ่านย้อนหลังแล้วเข้าใจ อย่างน้อย 10 ตัวอักษร')
  .max(2000);

/**
 * ⭐ Record a payment that arrived with no slip — the owner's *"ลูกค้าโอนชำระแล้วแต่ไม่ได้
 * แนบสลิปยืนยัน"*.
 *
 * ── ⚠️ THIS IS NOT AN ACCEPTANCE, AND THAT IS THE WHOLE SHAPE OF IT ─────────────
 *
 * What this creates is an ordinary `submitted` slip with no image and a stated reason. It lands
 * in the same queue, is compared on the same two-column screen, and is accepted through the same
 * `POST /payments/slips/:slipId/acceptance` as any other — which is where the allocations are
 * planned, `slip_allocations` written, the footing asserted and the ledger posted.
 *
 * A route that recorded *and* accepted in one call would have been a second way for money to
 * move, and it would have made every use of this feature a self-review by construction: the
 * person who typed the figures would be the person who blessed them, always, with no second
 * pair of eyes even available. Two steps means a company with two staff keeps the two-person
 * rule for free, and a company with one uses `payments.self_review_slip` and leaves a written
 * reason. The owner's ask is satisfied either way; the control survives in the first case.
 *
 * `orderId` is in the body rather than the path because this route hangs off `payments/slips`,
 * where staff already are — `slips.controller.ts` is the customer's surface and its
 * `RequirePrincipal` is not the guard this needs.
 *
 * There is no `imageHandle` and there must not be one. A staff member who *has* the picture has
 * no business here: they are recording an image-less payment, and a route that accepted an
 * optional image would be a second implementation of `createSlip` differing by a permission.
 */
export const recordSlipRequestSchema = z.strictObject({
  orderId: z.string().uuid(),
  amountThbMinor: positiveThbSchema,
  /** When the bank says the money moved — not when this row was typed. */
  transferredAt: instantSchema,
  /** Required, and the reason this route exists. `payment_slips_evidence_exists`'s third arm. */
  noSlipReasonTh: auditReasonSchema,
  bankReference: z.string().trim().min(1).max(120).optional(),
  payerName: z.string().trim().min(1).max(200).optional(),
  payerAccountLast4: z
    .string()
    .regex(/^[0-9]{4}$/u, 'ต้องเป็นเลขสี่หลักท้ายบัญชีเท่านั้น')
    .optional(),
  receivedBankAccountId: z.string().uuid().optional(),
});

export type RecordSlipRequestWire = z.infer<typeof recordSlipRequestSchema>;

/**
 * One line of the reviewer's allocation: this much of this slip closes this instalment.
 *
 * ⚠️ **Untrusted input, and it is the input that decides what got paid.** A reviewer types
 * these figures while looking at a photograph; nothing in the request ties them to the
 * money. `assertAllocationsSettleSlip` in `allocations.ts` is what ties them, and the
 * deferred `slip_allocations_foot` trigger is what holds when that function is bypassed.
 */
export const allocationRequestSchema = z.strictObject({
  instalmentId: z.string().uuid(),
  amountThbMinor: positiveThbSchema,
});

export type AllocationRequestWire = z.infer<typeof allocationRequestSchema>;

/**
 * Accept the slip.
 *
 * The allocations are required and there is no "just accept it" shape. Plan 7.6 asks for a
 * two-column comparison **rather than a confirm button**, and a request body that could be
 * empty is a confirm button however the screen in front of it is drawn.
 */
export const acceptSlipRequestSchema = z.strictObject({
  allocations: z.array(allocationRequestSchema).min(1).max(32),
  noteTh: z.string().trim().max(2000).optional(),
  /**
   * ⚠️ THE PAYER, AS THE REVIEWER READS IT OFF THE IMAGE — 5b red team, RT-2.
   *
   * `payer_name` and `payer_account_last4` arrive on the *customer's own* create-slip body and
   * nothing ever compared them to the picture, to the bank reference, or to anything a bank
   * said. So the party plan 7.12's "refund to the account the money came from" control exists
   * to catch was choosing the account that later read as the original one: name a mule account
   * on the slip, request the refund to the same mule account, and it comes back
   * `payeeIsOriginalAccount: 'yes'` — no reason required, no separate acknowledgement, absent
   * from the different-account report.
   *
   * Optional, because a slip whose payer nobody can read is a real slip and refusing it would
   * push the money outside the system. Omitting it leaves the payer *unverified*, and
   * `deriveOriginalAccount` treats unverified as `no` — which fails closed into the customer's
   * inconvenience rather than into somebody else's bank account.
   */
  payer: z
    .strictObject({
      name: z.string().trim().min(1).max(200),
      accountLast4: z.string().regex(/^[0-9]{4}$/u, 'ต้องเป็นเลขสี่หลักท้ายบัญชีเท่านั้น'),
    })
    .optional(),
  /**
   * The excess this transfer could place nowhere, stated exactly.
   *
   * A ฿20,000.00 transfer against a ฿19,722.24 order used to be unacceptable, undeletable and
   * un-rejectable: the money was in the bank and the system held ฿0.00. It is accepted now, and
   * only when the reviewer names the ฿277.76 — a figure that has to match, so a mistyped
   * allocation is refused rather than quietly absorbed as "excess".
   */
  acknowledgeOverpaymentThbMinor: positiveThbSchema.optional(),
  /**
   * 🔒 THE DECLARED BYPASS OF THE TWO-PERSON RULE — `0047_slip_without_evidence.sql`.
   *
   * Present only when the reviewer is also the submitter. Supplying it is *not* what makes the
   * self-review allowed — `payments.self_review_slip` is — and holding that permission is not
   * enough either: `SlipsService.accept` demands **both**, and `payment_slips_guard_write()`
   * refuses the write outright if the column is null and the reviewer is a submitter, whatever
   * the application decided.
   *
   * Optional here rather than conditionally required, because the schema cannot know who the
   * caller is or who uploaded the slip. The service can, and does, and answers in Thai.
   *
   * ⚠️ Supplying it on a slip somebody *else* uploaded is accepted and ignored — see
   * `SlipsService.assertReviewerIsNotSubmitter`, which only writes it when it is true. A reason
   * recorded against a bypass that never happened would put a self-review marker on the audit
   * list for a slip two people handled correctly, which is the audit lying in the direction
   * nobody would check.
   */
  selfReviewReasonTh: auditReasonSchema.optional(),
});

export type AcceptSlipRequestWire = z.infer<typeof acceptSlipRequestSchema>;

/**
 * Reject it.
 *
 * The reason is required and reaches the customer. Plan 7.3: a rejection nobody can read is
 * a rejection that produces a telephone call, and the telephone call is what this whole
 * feature exists to avoid.
 */
export const rejectSlipRequestSchema = z.strictObject({
  reasonTh: z.string().trim().min(3).max(2000),
  /**
   * The same declared bypass as on the acceptance, and it is needed here for the same reason
   * the original rule covered rejection: a person who could refuse their own upload could clear
   * their own mistake off the queue before anybody else saw it. That is the control failing in
   * the quieter direction, and a bypass that covered only acceptance would leave it open.
   */
  selfReviewReasonTh: auditReasonSchema.optional(),
});

export type RejectSlipRequestWire = z.infer<typeof rejectSlipRequestSchema>;

/** `?purpose=view` mints an inline URL; `?purpose=download` mints an attachment one. */
export const imageGrantRequestSchema = z.strictObject({
  purpose: z.enum(['view', 'download']).default('view'),
});

export type ImageGrantRequestWire = z.infer<typeof imageGrantRequestSchema>;

export const slipQueueQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type SlipQueueQuery = z.infer<typeof slipQueueQuerySchema>;

/**
 * The audit list's query — see `RecordedSlipListWire`.
 *
 * `only` is an enum and not a boolean, and that is not fussiness: `z.coerce.boolean()` turns the
 * string `"false"` into `true`, so a query string is the one place a boolean flag reliably means
 * the opposite of what was typed. Two named values cannot do that.
 */
export const recordedSlipQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  only: z.enum(['all', 'self_reviewed']).default('all'),
});

export type RecordedSlipQuery = z.infer<typeof recordedSlipQuerySchema>;

/* ────────────────────────────────────────────────────────────────────────────── *
 * Responses
 * ────────────────────────────────────────────────────────────────────────────── */

export type SlipStatusWire = (typeof SLIP_STATUSES)[number];
export type OrderStatusWire = (typeof ORDER_STATUSES)[number];
export type InstalmentBasisWire = (typeof INSTALMENT_BASES)[number];

export interface SlipAllocationWire {
  readonly instalmentId: string;
  /** The instalment's `seq`, so a client can render "งวดที่ 1" without a second request. */
  readonly instalmentSeq: number;
  readonly amountThbMinor: MoneyWire<'THB'>;
  /** Set only on money carried from a superseded ancestor — plan 7.8. Never written here. */
  readonly carriedFromOrderId: string | null;
}

export interface SlipWire {
  readonly id: string;
  readonly orderId: string;
  readonly status: SlipStatusWire;
  readonly amountThbMinor: MoneyWire<'THB'>;
  readonly currency: string;
  readonly transferredAt: string;
  readonly bankReference: string | null;
  readonly payerName: string | null;
  readonly payerAccountLast4: string | null;
  /**
   * Whether an image is still on this row, and whether it was erased or never existed.
   *
   * Two fields rather than a nullable key because they answer different questions and plan
   * 7.6 needs both: `hasImage: false, imageErasedAt: null` is a slip nobody photographed,
   * and `hasImage: false, imageErasedAt: <date>` is one a retention sweep destroyed. The
   * storage key itself never crosses this wire — it is a private object-store path, and a
   * client that had one would be a client asking for a route that serves by key.
   */
  readonly hasImage: boolean;
  readonly imageErasedAt: string | null;
  readonly reviewedAt: string | null;
  readonly rejectedReasonTh: string | null;
  readonly allocations: readonly SlipAllocationWire[];
  readonly createdAt: string;
  /**
   * Who uploaded it and who reviewed it — **staff only**, and `null` in a customer's copy.
   *
   * The same rule `encodeEvent` applies to the spine: a customer is entitled to know that
   * their slip was rejected and why, and is not entitled to the internal user id of the
   * person who rejected it. The audience is derived from the caller's reach, never from a
   * flag on the request.
   */
  /** Money on this slip that closed no instalment — see `acknowledgeOverpaymentThbMinor`. */
  readonly unallocatedThbMinor: MoneyWire<'THB'>;
  /** True when a reviewer read the payer off the image. False means the payer typed it. */
  readonly payerVerified: boolean;
  /**
   * ⚠️ **The identity, and never the answer to "is this mine?"**
   *
   * It is one of the two columns behind that question and not the question: a slip uploaded from
   * a guest cart carries `null` here whoever eventually claimed the cart, so
   * `submittedByUserId === viewer` is false for the person who really did submit it. Ask
   * `SlipReviewWire.viewerIsSubmitter`, which the server computes from
   * `slip_submitter_user_ids()`; the same reason `RecordedSlipEntryWire.selfReviewed` is not
   * `recordedBy.userId === reviewedBy.userId`.
   *
   * What it is for is the trail — who entered this row — which is why it survives on the 201 of
   * `POST /payments/slips/recorded`, where it is the only field naming the person who recorded a
   * payment nobody sent a slip for.
   */
  readonly submittedByUserId: string | null;
  readonly reviewedByUserId: string | null;
  /**
   * ⭐ Why this payment has no image — `0047_slip_without_evidence.sql`.
   *
   * `null` on every slip a customer photographed, and on a slip whose picture was erased for
   * PDPA (`imageErasedAt` is the one that says so). Non-null exactly on the rows this feature
   * creates, which is what makes it the marker the review queue and the audit list both key on.
   *
   * **Not audience-gated.** The rule this file already follows is that *reasons* cross to the
   * customer and *identities* do not — `rejectedReasonTh` is on a customer's copy and
   * `reviewedByUserId` is not. A customer looking at their own order and finding a payment
   * against it that they never uploaded a slip for is owed the company's sentence explaining it,
   * and withholding it produces exactly the telephone call this whole feature exists to avoid.
   */
  readonly noSlipReasonTh: string | null;
  /**
   * 🔒 Why the reviewer was also the submitter — **staff only**, `null` in a customer's copy.
   *
   * The exception to the rule the field above follows, and it is worth saying why rather than
   * leaving it looking inconsistent. This sentence is not about the customer's payment; it is
   * about how the company staffs its payments desk on a given day — "คนเดียวอยู่เวรเสาร์" is an
   * internal control note, and the customer can neither act on it nor is entitled to it. What
   * they *are* entitled to, and get, is `noSlipReasonTh`.
   *
   * Non-null is the definition of a self-reviewed slip for every reader of this wire.
   */
  readonly selfReviewReasonTh: string | null;
  /**
   * Which of the company's own accounts this transfer names — resolved to what reconciliation
   * actually reads, not the raw id. The column (`0027_organisation.sql`) used to be write-only:
   * persisted on every slip a customer submits through the picker, surfaced on no read path at
   * all. This is that surfacing, for the staff slip-review screen where reconciliation happens.
   *
   * `null` covers two cases this wire does not distinguish, because a reviewer acts on them the
   * same way — read the image instead: a slip written before the column existed, and (in
   * principle only; the FK is `on delete restrict`) an account since deleted. Not audience-
   * gated like `submittedByUserId` — this names one of the company's *own* accounts, which a
   * customer already sees on the picker that produced this slip in the first place.
   */
  readonly receivedBankAccount: { readonly bankCode: string; readonly accountName: string } | null;
}

export interface SlipListWire {
  readonly slips: readonly SlipWire[];
}

/** The four numbers a payments screen shows, each one named so it cannot be mistaken for another. */
export interface SlipOrderMoneyWire {
  /** `paidMinor` — cash received, the fold of `bank_thb`. Plan 7.8's lime-green number. */
  readonly paidThbMinor: MoneyWire<'THB'>;
  /**
   * Money in hand, the negated fold of `deposit_held`.
   *
   * ⚠️ Not the same as `paid`, and it is the one every "have we been paid?" decision must
   * ask: a revision order carrying money from its ancestor has **no cash leg at all**, so
   * its `paid` is zero for ever while it really does hold the customer's deposit.
   */
  readonly heldThbMinor: MoneyWire<'THB'>;
  /** `settledMinor` — the fold of allocations. Diverges from `paid` the first time a bank fee is written off. */
  readonly settledThbMinor: MoneyWire<'THB'>;
  /** Derived, never a status. Plan 7.5(ข) forbids an `awaiting_balance` for exactly this. */
  readonly outstandingThbMinor: MoneyWire<'THB'>;
  /**
   * `MAX(seq)` over the settled prefix — **never a count**, and null when there is no schedule.
   *
   * One implementation, in `order_settled_through()`. A count and a max agree only while
   * `seq` is dense from 1, and on a schedule where 1 and 3 are paid a count says "two" and
   * opens the gate on the instalment nobody paid.
   */
  readonly settledThroughSeq: number | null;
  /**
   * Which bucket of the staff queue this order is in.
   *
   * `order_payment_queue_bucket()` tests the terminal statuses on its first line, so a
   * cancelled order still holding a deposit reports `terminal_holding_money` rather than
   * sitting in "waiting for the customer to transfer" for ever.
   */
  readonly queueBucket: string;
}

export interface InstalmentSummaryWire {
  readonly id: string;
  readonly seq: number;
  readonly basis: InstalmentBasisWire;
  readonly dueThbMinor: MoneyWire<'THB'>;
  readonly allocatedThbMinor: MoneyWire<'THB'>;
  readonly remainingThbMinor: MoneyWire<'THB'>;
  /** Null means this instalment gates nothing — the 70 of a 30/70. */
  readonly gatesEntryTo: OrderStatusWire | null;
  readonly isSettled: boolean;
}

/**
 * The right-hand column: what the money *should* be, against what the photograph claims.
 *
 * Plan 7.6 asks for a comparison and not a button, because forged slips are a known problem
 * and manual review is the only control this design has. So the API's job is to make the
 * discrepancy computable on the server and impossible to miss on the screen —
 * `differenceThbMinor` is signed, and a client that renders nothing else must still render
 * that.
 */
export interface SlipReviewWire {
  readonly slip: SlipWire;
  /**
   * 🔒 Is the person who asked for this screen one of the people who submitted this slip?
   *
   * ⚠️ **Computed by `slip_submitter_user_ids()` against the requesting user, and never by
   * comparing `slip.submittedByUserId` to whoever the client thinks is signed in.** That
   * comparison is the same bug `selfReviewed` on the audit wire already refuses to make: the
   * function unions the direct submitter with the user who claimed the submitting *guest*, so a
   * slip uploaded from an anonymous cart that the reviewer later signed into is one person — and
   * a client comparing one nullable column sees `null !== me` and concludes it is not theirs.
   *
   * The consequence of getting it wrong is not a security hole; the service and
   * `payment_slips_guard_write()` both refuse a self-review without the permission and without
   * the reason, whatever a screen decided. It is a *dead end*: a review dialog that concludes
   * "not mine" renders no declaration box, the reviewer presses รับรอง, the API answers 403
   * `self_review_needs_reason`, and there is no field on the screen to put that reason in. The
   * review cannot be completed at all.
   *
   * So the fact is computed once, here, where `slip_submitter_user_ids()` is — the same argument
   * that put `orderIsLive` on `PaymentInstructionsWire` instead of shipping a status for every
   * client to interpret with its own copy of the rule.
   *
   * `false` for a customer's or a guest's reading of a slip: they are not the people this
   * two-person rule is about, and there is no self-review screen for them to see.
   */
  readonly viewerIsSubmitter: boolean;
  readonly order: {
    readonly id: string;
    readonly orderNo: string | null;
    readonly status: OrderStatusWire;
    readonly grandTotalThbMinor: MoneyWire<'THB'> | null;
    /** Pinned at submit. The ceiling on a forfeit, and never recomputed here. */
    readonly scheduledDepositThbMinor: MoneyWire<'THB'> | null;
    readonly frozenAt: string | null;
    readonly contactName: string | null;
  };
  readonly money: SlipOrderMoneyWire;
  readonly instalments: readonly InstalmentSummaryWire[];
  readonly gate: {
    readonly status: OrderStatusWire;
    /** `order_gate_is_open()` — *ever entered this status* OR the money gate is open now. */
    readonly isOpenNow: boolean;
    readonly gatingInstalmentSeqs: readonly number[];
  };
  readonly comparison: {
    readonly slipAmountThbMinor: MoneyWire<'THB'>;
    /** What the unsettled prefix still wants. Null when nothing is outstanding. */
    readonly expectedNextDueThbMinor: MoneyWire<'THB'> | null;
    /** `slip − expected`. Negative is short, positive is over. Null when there is no expectation. */
    readonly differenceThbMinor: MoneyWire<'THB'> | null;
  };
  /**
   * The allocation the server would make, offered and never applied.
   *
   * Null when the slip cannot be allocated exactly — an overpayment, most often — and then
   * `unallocatableReasonTh` says why in a sentence the reviewer can act on.
   */
  readonly suggestedAllocations: readonly AllocationRequestWire[] | null;
  readonly unallocatableReasonTh: string | null;
}

export interface SlipQueueEntryWire {
  readonly slip: SlipWire;
  readonly orderNo: string | null;
  readonly orderStatus: OrderStatusWire;
  readonly queueBucket: string;
}

export interface SlipQueueWire {
  readonly entries: readonly SlipQueueEntryWire[];
}

/**
 * ⭐ THE AUDIT SURFACE THE OWNER IS TRUSTING — `GET /payments/slips/recorded`.
 *
 * *"สิ่งสำคัญคือต้องสามารถตรวจสอบย้อนหลังได้ ถ้าทำได้ก็โอเค"*. This shape is that sentence made
 * answerable, and every clause of the question has a field:
 *
 *     which payments were recorded with no slip   every row in this list, and only those
 *     who recorded them                           `recordedBy`
 *     who accepted them                           `reviewedBy`
 *     why                                         `slip.noSlipReasonTh` · `slip.selfReviewReasonTh`
 *     which were self-reviewed                    `selfReviewed`
 *
 * ⚠️ `selfReviewed` is computed by `slip_submitter_user_ids()` — the same SQL function the
 * trigger uses — and **not** by comparing `reviewedByUserId` to `submittedByUserId` on this
 * wire. That comparison is the bug 5b red team RT-1 found: it misses the guest cart that was
 * later signed into an account, and an audit list that under-reports is worse than none, because
 * somebody checked it.
 *
 * Every status, not only `accepted`. A slip recorded with no evidence and then *rejected* is
 * still an evidence-free entry somebody made, and a list that showed only the ones that worked
 * would hide exactly the pattern an auditor is looking for.
 */
export interface RecordedSlipActorWire {
  readonly userId: string;
  /**
   * `users.display_name`. Null on an account with no name — which on an **erased** one is a
   * guarantee rather than an omission (`users_erased_has_no_name`), and the id above is then the
   * whole of what the trail can honestly say about them.
   */
  readonly name: string | null;
}

export interface RecordedSlipEntryWire {
  readonly slip: SlipWire;
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly orderStatus: OrderStatusWire;
  /** Null only if the row was written by something other than a signed-in staff member. */
  readonly recordedBy: RecordedSlipActorWire | null;
  /** Null while the entry is still waiting in the queue. */
  readonly reviewedBy: RecordedSlipActorWire | null;
  /** From `slip_submitter_user_ids()`, never from comparing two columns on this wire. */
  readonly selfReviewed: boolean;
}

export interface RecordedSlipListWire {
  readonly entries: readonly RecordedSlipEntryWire[];
}

/** What an accepted slip moved, when it moved anything. */
export interface OrderTransitionWire {
  readonly from: OrderStatusWire;
  readonly to: OrderStatusWire;
  readonly eventId: string;
}

/**
 * ⚠️ **THE ASYMMETRY, IN THE TYPES** — plan 7.3, restated by 7.5(ข).
 *
 * Accepting the slip that closes the *gating* instalment is a transition of the order.
 * Accepting any other slip is a payment-level event and moves nothing. **Rejecting one is
 * not a transition at all** — the order stays exactly where it was, and making rejection a
 * transition would require inventing a status that means the same thing as the previous
 * status, which the plan calls poison.
 *
 * So there are two result types and not one with a flag. `RejectSlipResultWire` has nowhere
 * to put a transition, which is a stronger statement than a `null`: a future edit that made
 * a rejection move an order would have to change this type first, in a diff, on purpose.
 */
export interface AcceptSlipResultWire {
  readonly slip: SlipWire;
  /** Null on every acceptance that was not the one closing the gate. */
  readonly orderTransition: OrderTransitionWire | null;
  /** True exactly when *this* acceptance is what opened it. */
  readonly gateOpened: boolean;
  readonly money: SlipOrderMoneyWire;
}

export interface RejectSlipResultWire {
  readonly slip: SlipWire;
}

/** What the upload route hands back: an opaque, signed, short-lived reference to bytes. */
export interface SlipImageUploadWire {
  readonly imageHandle: string;
  readonly expiresAt: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
  /** Which metadata containers were removed. A slip photograph carries GPS more often than not. */
  readonly stripped: readonly string[];
}

/**
 * A short-lived URL for one image, for one purpose.
 *
 * Plan 7.6: private object storage, read through short-lived audited URLs. The path is
 * relative for the reason `MediaObjectWire.path` gives — an absolute URL frozen into a
 * client is a hostname the company may not own next year.
 */
export interface SlipImageGrantWire {
  readonly path: string;
  readonly purpose: 'view' | 'download';
  readonly expiresAt: string;
}
