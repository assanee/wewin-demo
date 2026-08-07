import { z } from 'zod';
import {
  type MoneyWire,
  encodeMinor,
  moneyWireSchema,
} from './money.js';
import { priceBreakdownWireSchema, priceRequestWireSchema, type PriceBreakdownWire, type PriceRequestWire } from './pricing.js';
import { catalogRefShape, type CatalogRef } from './catalog.js';
import { lengthWireSchema, type LengthWire } from './measure.js';

/**
 * The order lifecycle on the wire — phase 5a.
 *
 * Three things about this module are decisions rather than style, and each of them is a
 * decision the plan forced:
 *
 *   **The nine statuses are restated here, not imported.** `@wewin/db` is server-only by
 *   construction (its package note says so, and `turbo boundaries` enforces it), so the
 *   union a browser reads cannot be the union Postgres holds. Restating is therefore
 *   unavoidable; what is avoidable is *drifting*. `apps/api/tests/orders/contract-drift.test.ts`
 *   compares this list, member for member, with `ORDER_STATUSES` in the schema and with the
 *   rows in `order_status_transitions`, so the day somebody adds a tenth status without
 *   telling the clients is a red test rather than a dashboard that renders a blank chip.
 *
 *   **No request body carries money.** Not one. Plan 7.9(ก) puts `computed` in the machine
 *   layer — the API prices with `calcPrice` and never accepts a number a client typed — and
 *   plan 7.8 marks `fault` 🔒 because it decides how much of a customer's money is kept.
 *   `absorbed_delta_thb_minor` is the same shape of fact: it is the difference between two
 *   documents the server holds, so the server subtracts them. A field that is not on the
 *   wire cannot be forged on the wire.
 *
 *   **A transition names its destination, never its payload.** `POST
 *   /orders/:id/transitions/:toStatus` is the whole mutation surface, and the body's shape
 *   is decided *after* the order has been loaded and locked — plan 7.4 trap 4. The schemas
 *   below are exported one per payload kind so that the API can make that choice late; a
 *   single `orderTransitionRequestSchema` would be the trap in a package.
 *
 * SEAM 5b: slips, instalments and refunds add request shapes here, not statuses. Confirming
 * the slip that closes the *gate* instalment is the one payment event that is a transition
 * (plan 7.5(ข)); the others move money and leave the order where it is.
 * SEAM 5c: the sales-editable quote adds override request shapes and a presentment currency
 * to `OrderDocumentWire`. `documentSchemaVersion` is how a client tells the two apart.
 */

/* ------------------------------------------------------------------ *
 * Closed sets
 * ------------------------------------------------------------------ */

export const ORDER_STATUSES_WIRE = [
  'draft',
  'awaiting_payment',
  'production_confirmed',
  'in_production',
  'awaiting_installation',
  'delivered',
  'redesign',
  'cancelled',
  'superseded',
] as const;

export type OrderStatusWire = (typeof ORDER_STATUSES_WIRE)[number];

/**
 * Past the freeze point — plan 7.5(ข), where aluminium has been committed.
 *
 * `cancelled` and `superseded` are absent from both this list and the database's
 * `order_status_is_post_freeze()`, and for the same reason: they are reachable from either
 * side, so the fact worth reading is `frozenAt`, which survives the cancellation. A client
 * deciding whether to show "ยกเลิกฟรี" must read `isFrozen`, never the status.
 */
export const POST_FREEZE_STATUSES_WIRE = [
  'production_confirmed',
  'in_production',
  'awaiting_installation',
  'delivered',
  'redesign',
] as const;

export const ORDER_EVENT_TYPES_WIRE = [
  'created',
  'quote_revised',
  'submitted_for_payment',
  'payment_confirmed',
  'production_started',
  'installation_scheduled',
  'delivered',
  'bounced_to_redesign',
  'redesign_approved',
  'cancelled',
  'superseded',
  'change_requested',
  'change_resolved',
] as const;

export type OrderEventTypeWire = (typeof ORDER_EVENT_TYPES_WIRE)[number];

export const ORDER_ACTOR_KINDS_WIRE = ['customer', 'guest', 'staff', 'system'] as const;
export type OrderActorKindWire = (typeof ORDER_ACTOR_KINDS_WIRE)[number];

export const ORDER_PAYLOAD_KINDS_WIRE = [
  'none',
  'submit',
  'confirm_payment',
  'cancel_pre_freeze',
  'cancel_post_freeze',
  'bounce',
  'approve_redesign',
  'supersede',
] as const;

export type OrderPayloadKindWire = (typeof ORDER_PAYLOAD_KINDS_WIRE)[number];

export const CHANGE_REQUEST_RESOLUTIONS_WIRE = [
  'accepted',
  'rejected',
  'withdrawn',
  'superseded',
] as const;

export type ChangeRequestResolutionWire = (typeof CHANGE_REQUEST_RESOLUTIONS_WIRE)[number];

export const VAT_TREATMENTS_WIRE = ['standard', 'zero_rated', 'exempt', 'out_of_scope'] as const;
export type VatTreatmentWire = (typeof VAT_TREATMENTS_WIRE)[number];

const orderStatusWireSchema = z.literal(ORDER_STATUSES_WIRE);
const thb = moneyWireSchema('THB');

/** Every amount an order carries is THB minor units, and says so in its own unit tag. */
export const encodeThb = (minor: bigint): MoneyWire<'THB'> => encodeMinor(minor, 'THB');

/* ------------------------------------------------------------------ *
 * The pinned document — trap 3
 * ------------------------------------------------------------------ */

/**
 * What the customer was shown, as it was frozen at submit.
 *
 * Plan 7.4 trap 3: sales opens a slip hours later, and without a pin the contract is built
 * from a catalogue document the customer never saw. So a line here carries the *catalogue
 * handle it was priced from* (`productVersionId` + `documentHash`) and not merely a product
 * id — that pair is what `order_document_product_versions` turns into a real foreign key on
 * the server side, and what makes "which contracts cite this version?" answerable when a
 * catalogue mistake is found.
 *
 * `productId`, `measures` and `qty` are also what plan 7.2's re-approval guard reads, which
 * is why they are stored per line rather than left inside the price breakdown. A bounce is
 * fixed with something *more expensive* — a thicker profile, double glazing, another lock
 * point — so the guard is at the **scope** and never at the price: same product, opening no
 * larger, no lines the customer did not ask for. Those three facts have to survive into the
 * frozen document or there is nothing to compare a revision against a year later.
 */
export interface OrderDocumentLineWire extends CatalogRef {
  readonly lineNo: number;
  readonly productId: string;
  /** As `buildSkuCode` produced it. The production sheet renders from this, never from prose. */
  readonly skuCode: string;
  readonly configHash: string;
  /** The product's own name at pin time, for a reprint that must not chase the catalogue. */
  readonly nameTh: string;
  readonly selections: Readonly<Record<string, string>>;
  readonly measures: Readonly<Record<string, LengthWire>>;
  readonly qty: number;
  /**
   * VAT-exclusive line total — **what the customer is charged for this line**.
   *
   * Equal to `computedNetMinor` unless a human overrode it, in which case this is the human's
   * figure and that one is the machine's. Plan 4.3(ข): the number on the contract is the line
   * total, and there is one of it.
   */
  readonly netMinor: MoneyWire<'THB'>;
  /** ⓵ `calcPrice(...).totalMinor`, always, whether or not it is what was charged. */
  readonly computedNetMinor: MoneyWire<'THB'>;
  /**
   * ⓶ The promise, frozen with the document — plan 7.9(ก)'s three layers, all three present.
   *
   * `null` when the price is the machine's. It carries what the human typed and why, so a quote
   * disputed months later reconstructs the conversation and not merely the arithmetic.
   */
  readonly override: OrderDocumentOverrideWire | null;
  /** Plan 7.9(ค): a line may be taxed or not, and the frozen document has to say which. */
  readonly isVatApplicable: boolean;
  /** 📣 FOR THE CUSTOMER ONLY. ⚠️ Never rendered onto a production sheet — plan 7.9(ค). */
  readonly customerDescriptionTh: string | null;
  readonly price: PriceBreakdownWire;
}

/**
 * A human-set figure, frozen into the contract beside the machine's.
 *
 * Plan 7.9(ก) keeps `computed` and `override` as separate layers and this is where the second
 * one lands at pin time. `enteredValueText` is verbatim — `'8500'` or `'-15%'` — because sales
 * told the customer one of those sentences and which one is what the conversation was.
 */
export interface OrderDocumentOverrideWire {
  readonly overrideId: string;
  readonly enteredAs: string;
  readonly enteredValueText: string;
  readonly reasonCode: string;
  readonly setByUserId: string;
  readonly setByUserName: string | null;
}

/**
 * A free-form line: delivery, installation, a survey, a goodwill credit.
 *
 * A separate array from `lines` and not a nullable product id on one, so that the production
 * sheet — which renders from `lines[].skuCode` and the resolved options — **cannot** be handed a
 * charge to manufacture, and `order_document_product_versions` stays a table of real versions.
 * The amount may be negative: plan 7.13 counts a credit line among the things the `margin`
 * dimension has to catch.
 */
export interface OrderDocumentChargeWire {
  readonly lineNo: number;
  readonly customerDescriptionTh: string;
  readonly netMinor: MoneyWire<'THB'>;
  readonly isVatApplicable: boolean;
  readonly override: OrderDocumentOverrideWire | null;
}

export interface OrderDocumentWire {
  /**
   * Which reading of this payload is in force.
   *
   * Plan 4.5 is a list of stored payloads whose version field and content drifted apart in
   * silence. This one is checked on the way in: a document written under a later recipe is
   * refused rather than read with the fields this build happens to recognise.
   */
  readonly documentSchemaVersion: 2;
  readonly revision: number;
  readonly documentHash: string;
  readonly currency: 'THB';
  /** Plan 10.6: a document reprinted in another language is a document nobody can cite. */
  readonly pinnedLocale: string;
  readonly pinnedCoreVersion: string;
  readonly vat: { readonly rateBp: number; readonly treatment: VatTreatmentWire };
  readonly lines: readonly OrderDocumentLineWire[];
  /** Charges and credits. Empty on a cart that was never edited by sales. */
  readonly charges: readonly OrderDocumentChargeWire[];
  /**
   * The document-level promise, if there is one — plan 7.9(ข)'s single anchor for "a discount",
   * "a document total" and "a percentage off", which are one fact three ways.
   */
  readonly documentOverride: OrderDocumentOverrideWire | null;
  readonly netThbMinor: MoneyWire<'THB'>;
  readonly vatThbMinor: MoneyWire<'THB'>;
  /** Always VAT-inclusive. Plan 4.4: the one thing in this area that is not configurable. */
  readonly grandTotalThbMinor: MoneyWire<'THB'>;
  /** How many days the customer was promised. Plan 7.9(ค) makes it an anchor; this pins it. */
  readonly leadTimeDays: number;
}

/**
 * ⚠️ **2, and the bump is plan 4.5's rule kept rather than plan 4.5's failure repeated.**
 *
 * Version 1 documents were priced from the cart in the submit request body and could hold no
 * charge, no override and no document discount, because there was no way to write one. 5c made
 * every one of those writable and `OrdersService.submit` still priced `body.lines` — so the
 * quote a salesperson edited was **not** the quote that got pinned, measured at ฿1.07 on the
 * screen against ฿14,791.68 in `orders.grand_total_thb_minor` on the same order.
 *
 * The reader refuses a version it does not recognise (`orderDocumentWireSchema` is a literal),
 * which is what stops a v1 row being read with v2's fields absent and silently footing.
 */
export const ORDER_DOCUMENT_SCHEMA_VERSION = 2 as const;

const orderDocumentOverrideWireSchema: z.ZodType<OrderDocumentOverrideWire> = z.object({
  overrideId: z.uuid(),
  enteredAs: z.string().min(1),
  enteredValueText: z.string().min(1),
  reasonCode: z.string().min(1),
  setByUserId: z.uuid(),
  setByUserName: z.string().nullable(),
});

const orderDocumentLineWireSchema: z.ZodType<OrderDocumentLineWire> = z.object({
  ...catalogRefShape,
  lineNo: z.int().min(1),
  productId: z.string().min(1),
  skuCode: z.string().min(1),
  configHash: z.string().min(1),
  nameTh: z.string().min(1),
  selections: z.record(z.string(), z.string()),
  measures: z.record(z.string(), lengthWireSchema),
  qty: z.int().min(1),
  netMinor: thb,
  computedNetMinor: thb,
  override: orderDocumentOverrideWireSchema.nullable(),
  isVatApplicable: z.boolean(),
  customerDescriptionTh: z.string().nullable(),
  price: priceBreakdownWireSchema,
});

const orderDocumentChargeWireSchema: z.ZodType<OrderDocumentChargeWire> = z.object({
  lineNo: z.int().min(1),
  customerDescriptionTh: z.string().min(1),
  netMinor: thb,
  isVatApplicable: z.boolean(),
  override: orderDocumentOverrideWireSchema.nullable(),
});

export const orderDocumentWireSchema: z.ZodType<OrderDocumentWire> = z.object({
  documentSchemaVersion: z.literal(ORDER_DOCUMENT_SCHEMA_VERSION),
  revision: z.int().min(1),
  documentHash: z.string().regex(/^[0-9a-f]{64}$/),
  currency: z.literal('THB'),
  pinnedLocale: z.string().min(2).max(16),
  pinnedCoreVersion: z.string().min(1),
  vat: z.object({
    rateBp: z.int().min(0).max(10_000),
    treatment: z.literal(VAT_TREATMENTS_WIRE),
  }),
  lines: z.array(orderDocumentLineWireSchema),
  charges: z.array(orderDocumentChargeWireSchema),
  documentOverride: orderDocumentOverrideWireSchema.nullable(),
  netThbMinor: thb,
  vatThbMinor: thb,
  grandTotalThbMinor: thb,
  leadTimeDays: z.int().min(0),
});

/* ------------------------------------------------------------------ *
 * The order
 * ------------------------------------------------------------------ */

export interface OrderContactWire {
  readonly email: string | null;
  readonly name: string | null;
  readonly phone: string | null;
  readonly locale: string;
}

export interface OrderMoneyWire {
  readonly netThbMinor: MoneyWire<'THB'>;
  readonly vatThbMinor: MoneyWire<'THB'>;
  readonly grandTotalThbMinor: MoneyWire<'THB'>;
  /**
   * The deposit obligation, pinned at submit. Plan 7.13.
   *
   * Pinned rather than recomputed at cancellation because it is a *term of the contract*:
   * three different formulas produced ฿5,530 and ฿18,432 on the same 30/70 shape, and this
   * number is the ceiling on what may ever be forfeited.
   */
  readonly scheduledDepositThbMinor: MoneyWire<'THB'>;
}

export interface OrderSummaryWire {
  readonly id: string;
  /** Null until submit. A cart is not numbered — see `orders.order_no`. */
  readonly orderNo: string | null;
  readonly status: OrderStatusWire;
  /**
   * Whether aluminium has been committed. Read this, never the status.
   *
   * `cancelled` and `superseded` are reachable from both sides of the freeze, so after the
   * fact the status cannot answer "was anything already cut?" and this flag can.
   */
  readonly isFrozen: boolean;
  readonly frozenAt: string | null;
  readonly submittedAt: string | null;
  readonly grandTotalThbMinor: MoneyWire<'THB'> | null;
  readonly updatedAt: string;
}

export interface OrderWire extends OrderSummaryWire {
  readonly createdAt: string;
  readonly contact: OrderContactWire;
  /** Null before submit: a draft has no contract, which is the whole `draft`/`redesign` split. */
  readonly money: OrderMoneyWire | null;
  readonly documentRevision: number | null;
  readonly supersedesOrderId: string | null;
  readonly supersededByOrderId: string | null;
  /**
   * The moves this actor may make on this order right now, from
   * `order_status_transitions` — not from a map in a client.
   *
   * A dashboard that hides a button is being tidy; the transition table is what makes it
   * authorisation. Sending the list means the two cannot disagree, and it is also the only
   * honest way to render `redesign`, whose outgoing edges depend on data the client has no
   * copy of.
   */
  readonly availableTransitions: readonly AvailableTransitionWire[];
  readonly openChangeRequest: ChangeRequestWire | null;
}

export interface AvailableTransitionWire {
  readonly toStatus: OrderStatusWire;
  readonly eventType: OrderEventTypeWire;
  readonly payloadKind: OrderPayloadKindWire;
  readonly descriptionTh: string;
}

export interface OrderListWire {
  readonly orders: readonly OrderSummaryWire[];
}

export interface OrderEventWire {
  readonly id: string;
  readonly seq: number;
  readonly eventType: OrderEventTypeWire;
  readonly fromStatus: OrderStatusWire | null;
  readonly toStatus: OrderStatusWire | null;
  readonly actorKind: OrderActorKindWire;
  /** The person, when there is one. `system` borrows nobody's name (`order_events_actor_shape`). */
  readonly actorUserId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface OrderEventListWire {
  readonly events: readonly OrderEventWire[];
}

export interface ChangeRequestWire {
  readonly id: string;
  readonly noteTh: string | null;
  readonly openedAt: string;
  readonly resolution: ChangeRequestResolutionWire | null;
  readonly resolvedAt: string | null;
}

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

/**
 * A configured line, exactly as the price endpoint takes one.
 *
 * Reused rather than redefined: an order line and a price request are the same four facts
 * plus the catalogue handle they were drawn from, and two definitions of that would be two
 * things to keep in step — with the divergence showing up as an order priced from a shape
 * the configurator never sends.
 */
export type OrderLineRequestWire = PriceRequestWire;

export interface OrderContactRequestWire {
  /** ⚠️ Optional since a telephone number became a channel — but not *both* optional. */
  readonly email?: string | undefined;
  readonly name?: string | undefined;
  readonly phone?: string | undefined;
  readonly locale?: string | undefined;
}

export interface CreateOrderRequestWire {
  /** Optional even here: a cart may be started before anybody has been asked for anything. */
  readonly contact?: OrderContactRequestWire | undefined;
}

/**
 * Submit — the transaction that pins.
 *
 * The contact channel is required *here* and not at `POST /orders`, which is plan 10.2's
 * exact instruction: browsing must stay anonymous, and the ask happens once, at the moment
 * a quote is requested, or every message in plan 10.3 is undeliverable.
 *
 * The lines carry no money. The server prices them with `calcPrice` from the pinned
 * catalogue documents, and a client that sends a total is sending a field that does not
 * exist in this type.
 */
/**
 * Submit — and ⚠️ `lines` is now **optional**, which is the seam phase 5c left open.
 *
 * The cart the browser holds and the quote sales edits were two different things, and submit
 * priced the first. So a quote whose lines had been rewritten, discounted and re-described was
 * not the quote that got pinned — one order measured ฿1.07 on the quote screen and ฿14,791.68
 * in `orders.grand_total_thb_minor`, and both kept diverging afterwards because
 * `awaiting_payment` is an editable status.
 *
 * The server prices `quote_lines`, always. `lines` is how a client that has never used the quote
 * editor — the storefront configurator, which keeps its cart in the browser — hands its cart over
 * on the way in; it is materialised into `quote_lines` and priced from there. Sending it for an
 * order that **already has** a quote is refused rather than merged, because a stale browser cart
 * silently overwriting a negotiated quote is the failure this whole change exists to end, and
 * because two sources for one document is plan 7.9(ข)'s "which one wins" at the one endpoint
 * where the answer is a contract.
 */
export interface SubmitOrderRequestWire {
  readonly contact: OrderContactRequestWire;
  readonly lines?: readonly OrderLineRequestWire[] | undefined;
}

/** `reason` is prose for the audit trail. `fault` is deliberately not here — plan 7.8 🔒. */
export interface CancelOrderRequestWire {
  readonly reason: string;
}

/**
 * A staff cancellation after the freeze.
 *
 * The only body in this module that can influence money, and it does so as a *claim the
 * server verifies*, never as a value it stores: `attributeFaultToCompany` is honoured only
 * when the spine actually carries a `bounced_to_redesign` event, which is plan 7.8's rule
 * that `fault='company'` is settable by staff and only on an order with a real bounce on
 * record. A customer-initiated cancellation has no such field at all and is always
 * `fault='customer'`.
 */
export interface StaffCancelOrderRequestWire extends CancelOrderRequestWire {
  readonly attributeFaultToCompany?: boolean | undefined;
}

export interface BounceOrderRequestWire {
  readonly reason: string;
}

/**
 * Approving a re-designed order.
 *
 * There is no `absorbedDelta` field: the company's absorbed cost of quality is the
 * difference between two documents the server already holds, and a human typing it would be
 * a second answer to a question arithmetic has already settled. Plan 7.2 wants the number
 * *recorded*, not *entered*.
 */
export interface ApproveRedesignRequestWire {
  readonly noteTh?: string | undefined;
}

export interface SupersedeOrderRequestWire {
  readonly reason: string;
}

/**
 * Confirming the payment that opens the freeze.
 *
 * Empty in 5a, and deliberately a named type rather than `void`: plan 7.5(ข) says the slip
 * that closes the *gate* instalment is the transition and every other slip is a payment
 * event that leaves the order where it is, so 5b fills this in with the instalment and slip
 * ids. Until then, this is a member of staff asserting the gate is settled, and the spine
 * records who they were.
 */
export interface ConfirmPaymentRequestWire {
  readonly noteTh?: string | undefined;
}

export interface CreateChangeRequestWire {
  /** What the customer said, in their words. Never rendered onto a production sheet — 7.9(ค). */
  readonly noteTh: string;
}

export interface ResolveChangeRequestWire {
  readonly resolution: 'accepted' | 'rejected' | 'withdrawn';
  readonly noteTh?: string | undefined;
}

/* ------------------------------------------------------------------ *
 * Request schemas — one per payload kind, chosen late
 * ------------------------------------------------------------------ */

/**
 * Prose fields are bounded and non-empty.
 *
 * A `reason` is the only account of why an order was cancelled that anybody will ever have,
 * so an empty string is refused; and it goes into a JSONB payload on an append-only table,
 * so it is bounded before it gets there.
 */
const reasonSchema = z.string().trim().min(1).max(2000);
const noteSchema = z.string().trim().min(1).max(2000);
const localeSchema = z.string().regex(/^[a-z]{2}(?:-[A-Za-z0-9]{2,8})?$/, 'must be a BCP-47 language tag');

/**
 * The address a customer will be written to. Lower-cased on the way in, because
 * `orders_contact_email_lowercase` refuses anything else and two spellings of one mailbox
 * are two idempotency keys in the outbox (plan 10.5(1)).
 */
const emailSchema = z
  .string()
  .trim()
  .max(320)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'must be an email address')
  .transform((value) => value.toLowerCase());

/**
 * ⭐ E.164, refused rather than normalised.
 *
 * `orders_contact_phone_e164` and `user_phones_number_e164` demand the identical string, so a
 * contact number and a username are comparable — which is the whole reason a customer with
 * only a telephone can have an account at all.
 *
 * ⚠️ **No transform.** This contract is shared with browsers, and normalising here would mean
 * the storefront and the API each held an opinion about what a number is. `@wewin/core/phone`
 * is the single one; a client calls it before it sends, and a refusal names the problem where
 * the person can still fix it. A transform would also make the failure arrive as a 500 from a
 * CHECK the day the two spellings diverged.
 */
const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9][0-9]{7,14}$/u, 'must be a telephone number in E.164 form, e.g. +66812345678');

/**
 * ⭐ **A channel, not an address** — plan 10.2, restated after Thai customers turned out
 * frequently not to have an email address they use.
 *
 * ⚠️ This rule lives in two places and both had to move. The database's
 * `orders_submitted_has_a_contact_channel` was relaxed to email-or-phone first, and a
 * phone-only submit still failed here, with a 400 that looked like a client bug. See
 * `tests/order-contact.test.ts`, which exists to keep the two agreeing.
 *
 * ⚠️ And the refusal when there is neither is load-bearing. An order nobody can be reached
 * about is exactly what plan 10.2 is about; "no email required" must not have quietly become
 * "no channel required".
 */
export const orderContactRequestSchema: z.ZodType<OrderContactRequestWire> = z
  .strictObject({
    email: emailSchema.optional(),
    name: z.string().trim().min(1).max(200).optional(),
    phone: phoneSchema.optional(),
    locale: localeSchema.optional(),
  })
  .refine((contact) => contact.email !== undefined || contact.phone !== undefined, {
    message: 'a submitted order needs an email address or a telephone number',
    path: ['email'],
  });

export const createOrderRequestSchema: z.ZodType<CreateOrderRequestWire> = z.strictObject({
  contact: orderContactRequestSchema.optional(),
});

/**
 * At least one line, and a bounded number of them.
 *
 * Zero lines would produce a contract for nothing at a total of zero, which every downstream
 * rule (the deposit, the forfeit ceiling, the instalment that foots) would then divide by.
 * The ceiling is a request-size bound, not a business rule: each line costs a `calcPrice`
 * and a catalogue lookup, and this endpoint is reachable by an anonymous visitor.
 */
export const submitOrderRequestSchema: z.ZodType<SubmitOrderRequestWire> = z.strictObject({
  contact: orderContactRequestSchema,
  lines: z.array(priceRequestWireSchema).min(1).max(100).optional(),
});

export const cancelOrderRequestSchema: z.ZodType<CancelOrderRequestWire> = z.strictObject({
  reason: reasonSchema,
});

export const staffCancelOrderRequestSchema: z.ZodType<StaffCancelOrderRequestWire> = z.strictObject({
  reason: reasonSchema,
  attributeFaultToCompany: z.boolean().optional(),
});

export const bounceOrderRequestSchema: z.ZodType<BounceOrderRequestWire> = z.strictObject({
  reason: reasonSchema,
});

export const approveRedesignRequestSchema: z.ZodType<ApproveRedesignRequestWire> = z.strictObject({
  noteTh: noteSchema.optional(),
});

export const supersedeOrderRequestSchema: z.ZodType<SupersedeOrderRequestWire> = z.strictObject({
  reason: reasonSchema,
});

export const confirmPaymentRequestSchema: z.ZodType<ConfirmPaymentRequestWire> = z.strictObject({
  noteTh: noteSchema.optional(),
});

/** A transition whose payload kind is `none` takes an empty body — and refuses a full one. */
export const emptyTransitionRequestSchema: z.ZodType<Record<string, never>> = z.strictObject({});

export const createChangeRequestSchema: z.ZodType<CreateChangeRequestWire> = z.strictObject({
  noteTh: noteSchema,
});

export const resolveChangeRequestSchema: z.ZodType<ResolveChangeRequestWire> = z.strictObject({
  resolution: z.literal(['accepted', 'rejected', 'withdrawn']),
  noteTh: noteSchema.optional(),
});

/* ------------------------------------------------------------------ *
 * Response schemas — for clients and for the API's own tests
 * ------------------------------------------------------------------ */

export const changeRequestWireSchema: z.ZodType<ChangeRequestWire> = z.object({
  id: z.uuid(),
  noteTh: z.string().nullable(),
  openedAt: z.iso.datetime(),
  resolution: z.literal(CHANGE_REQUEST_RESOLUTIONS_WIRE).nullable(),
  resolvedAt: z.iso.datetime().nullable(),
});

export const orderSummaryWireSchema: z.ZodType<OrderSummaryWire> = z.object({
  id: z.uuid(),
  orderNo: z.string().nullable(),
  status: orderStatusWireSchema,
  isFrozen: z.boolean(),
  frozenAt: z.iso.datetime().nullable(),
  submittedAt: z.iso.datetime().nullable(),
  grandTotalThbMinor: thb.nullable(),
  updatedAt: z.iso.datetime(),
});

export const orderEventWireSchema: z.ZodType<OrderEventWire> = z.object({
  id: z.uuid(),
  seq: z.int().min(1),
  eventType: z.literal(ORDER_EVENT_TYPES_WIRE),
  fromStatus: orderStatusWireSchema.nullable(),
  toStatus: orderStatusWireSchema.nullable(),
  actorKind: z.literal(ORDER_ACTOR_KINDS_WIRE),
  actorUserId: z.uuid().nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
});
