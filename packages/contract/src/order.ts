import { z } from 'zod';
import {
  type MoneyWire,
  encodeMinor,
  moneyWireSchema,
} from './money.js';
import { priceBreakdownWireSchema, priceRequestWireSchema, type PriceBreakdownWire, type PriceRequestWire } from './pricing.js';
import { catalogRefShape, type CatalogRef } from './catalog.js';
import { lengthWireSchema, type LengthWire } from './measure.js';
import type { OrganisationProfileWire } from './organisation.js';
import { DESTINATION_TAX_BASES, FX_CURRENCIES_WIRE } from './tax.js';

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

/**
 * ⚠️ Restated from `@wewin/db`'s `ORDER_EVENT_TYPES`, in the same order, and pinned by
 * `apps/api/tests/orders/contract-drift.pg.test.ts` — a browser cannot import a Drizzle
 * schema, so the duplication is unavoidable and the drift test is what makes it safe.
 *
 * ⭐ `balance_reminded` (0050) is the fourth member with **no status pair**: staff asked the
 * customer for the outstanding balance and the order did not move. A client rendering a
 * timeline must not assume `toStatus` is present — `apps/dashboard`'s spine reads
 * `eventLabelTh` for exactly these rows.
 */
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
  'balance_reminded',
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

/**
 * Any currency, not pinned to one — the presentment currency varies per destination, and the
 * document says which in `fx.currency`.
 *
 * ⚠️ Declared here beside `thb` rather than beside the rest of the fx block further down:
 * `z.object({...})` evaluates its shape eagerly, so a `const` a schema above it references is
 * a `ReferenceError` at import time. Module-load order, not declaration tidiness.
 */
const fxMoney = moneyWireSchema();

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
   * The line total — **what the customer is charged for this line**.
   *
   * Equal to `computedNetMinor` unless a human overrode it, in which case this is the human's
   * figure and that one is the machine's. Plan 4.3(ข): the number on the contract is the line
   * total, and there is one of it.
   *
   * ⚠️ Not always VAT-exclusive, despite the name. Whether this figure already contains the
   * tax depends on the destination's basis this document pinned — see `taxBasis` below and
   * `QuoteDestinationWire.basis` (`quote.ts`) for the identity: under `exclusive` line totals
   * sum to the net; under `inclusive` they already contain the tax and sum to the grand total
   * instead.
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
  /**
   * `netMinor` in the document's presentment currency — see `OrderDocumentFxWire`.
   *
   * Pinned rather than derived at print time, because `@wewin/core/quotation` does no
   * arithmetic. The column is converted as a running total (`convertSeriesFromBaht`), so these
   * figures sum **exactly** to the converted subtotal rather than to within a few cents of it.
   */
  readonly fxMinor?: MoneyWire | undefined;
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
  /**
   * The same charge in the document's presentment currency — see `OrderDocumentFxWire`.
   *
   * Absent whenever `fx` is absent, and present on every line and charge whenever it is
   * present. Optional for the reason `destinationCountry` is: already-issued documents have
   * no such field and must keep parsing.
   */
  readonly fxMinor?: MoneyWire | undefined;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE EXCHANGE RATE, PINNED — AND WHY THIS MUCH OF IT.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The owner's decision is that the rate is fixed **at the moment staff submits the
 * quotation** (*"ตรึงเรทตอนที่พนักงานส่งยืนยันใบเสนอราคา"*), and this is where that pin lands.
 *
 * ── ⚠️ Why every one of these fields, and why none can be added later ────────────
 *
 * `order_documents_freeze` raises unconditionally on UPDATE (`0007_order_guards.sql:564-588`),
 * so **there is no backfill, ever**. A field not written today is a field no already-issued
 * quotation can ever have. The test is therefore not "what does the page need now" but "what
 * would somebody re-deriving this figure in 2031 have to ask a mutable table for" — and the
 * answer has to be: nothing.
 *
 *   - `currency` — what the figures on this page *are*. Without it the digits are unitless.
 *   - `source` — `mid_market` means the spread below was applied to a provider figure;
 *     `manual` means a human typed the rate and the spread was deliberately **not** applied
 *     (THE RULE, `@wewin/core/fx`). Two figures that differ by 2% are indistinguishable
 *     without it, and "why is this rate not the mid-market one" is the question a customer
 *     actually asks.
 *   - `spreadBp` — what was **applied**, which is `0` for a manual override, not what the row
 *     said. `tax_countries.fx_spread_bp` is mutable and is not a record of anything.
 *   - `rateNumerator` / `rateDenominator` — the **exact** ratio, as digit strings. This is the
 *     divisor that produced every figure below. A decimal rounded to N places is a different
 *     number: ฿100,000 to SGD is 3,698.63 exactly and 3,698.64 through a rate rounded to four
 *     places, which is a cent of unexplainable difference on a document somebody is auditing.
 *     Two fields and not one string, because a ratio is what the arithmetic used and parsing a
 *     `'a/b'` string back is a decoder nobody would test.
 *   - `rateText` — ⚠️ **a rendering, never the divisor.** It exists so the page can print a
 *     rate a person can read. Reproducing the figures from it will not work; that is what the
 *     ratio above is for.
 *   - `observedAt` — when the market was observed, so a reader can tell a rate pinned from
 *     that morning's sync from one pinned off a five-day-old cached observation. `null` for
 *     `manual`: a rate somebody typed has no market observation instant, and inventing one
 *     (the submit time) would dress a policy figure up as a measurement.
 *   - `provider` — the two figures the cross-rate was derived from, verbatim. The free plan is
 *     USD-base, so THB→SGD exists only as `rates.THB ÷ rates.SGD`; keeping both means the
 *     derivation can be re-checked without `fx_rates`, which is append-only but still a table
 *     this document would then depend on. `null` for `manual`, which needs no provider at all.
 *   - The three totals — because `@wewin/core/quotation` is *"a pure function of the pinned
 *     document"* with *"no arithmetic of its own"*, and a renderer that recomputed a total
 *     would be a second opinion about a contract term. The same rule puts `fxMinor` on every
 *     line and charge rather than deriving the column at print time.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────────────
 *
 * The baht figures do not move. `netThbMinor` / `vatThbMinor` / `grandTotalThbMinor` remain
 * exactly what they were and remain what `orders_totals_match_document()` checks, what the
 * ledger posts, and what the VAT return reports. This block is a **presentment** layer over
 * them, which is the shape `packages/db/src/schema/payment.ts:419-426` reserves the word for:
 * *"a presentment amount is additional columns beside this one, never a reinterpretation of
 * it."* The customer's page prints these; the company's books keep those.
 */
export interface OrderDocumentFxProviderWire {
  /** The base the observation was published against — `'USD'` on the free plan. */
  readonly base: string;
  /** `rates['THB']` exactly as stored. */
  readonly thbPerBase: number;
  /** `rates[currency]` exactly as stored. */
  readonly unitPerBase: number;
}

export interface OrderDocumentFxWire {
  readonly currency: (typeof FX_CURRENCIES_WIRE)[number];
  readonly source: 'mid_market' | 'manual';
  /** Basis points actually applied. `0` on a manual override — see THE RULE in core's `fx.ts`. */
  readonly spreadBp: number;
  /** Baht per one whole unit of `currency`, exact. Digits only; both are positive integers. */
  readonly rateNumerator: string;
  readonly rateDenominator: string;
  /** ⚠️ For a human to read. `rateNumerator / rateDenominator` is what was divided by. */
  readonly rateText: string;
  /** ISO 8601. `null` when `source` is `'manual'`. */
  readonly observedAt: string | null;
  readonly provider: OrderDocumentFxProviderWire | null;
  readonly netMinor: MoneyWire;
  readonly vatMinor: MoneyWire;
  readonly grandTotalMinor: MoneyWire;
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
  /**
   * Where the goods are going, frozen at submit, and absent on every document issued before
   * this field existed.
   *
   * Optional is what keeps the 21 already-issued quotations readable: `documentSchemaVersion`
   * is a bare `z.literal` with no v1/v2 union reader, and a parse failure is a 503 for staff
   * and customer alike (`apps/api/src/orders/order.repository.ts:747-755`).
   */
  readonly destinationCountry?: string | undefined;
  /**
   * Which arithmetic ran, recorded because the printed page needs it and cannot ask.
   *
   * The renderer picks a layout from this. It cannot read `tax_countries` instead: that table
   * is mutable, and a quotation must print what was quoted, not what is policy today.
   */
  readonly taxBasis?: (typeof DESTINATION_TAX_BASES)[number] | undefined;
  /**
   * ⭐ The presentment currency and the rate it was pinned at, or absent for a baht quotation.
   *
   * Absent means baht, which is what every domestic quotation and every already-issued
   * document is. Present means **this document prints in `fx.currency` and not in baht** — the
   * baht figures beside it are the company's record, not the customer's page.
   *
   * Optional for the same reason `destinationCountry` above is, and it is the same trap:
   * `documentSchemaVersion` is a bare `z.literal(2)` with no v1/v2 union reader, and a parse
   * failure is `AppError.databaseUnavailable` — a 503 for staff and customer alike
   * (`apps/api/src/orders/order.repository.ts:747-755`). A required field here would take every
   * already-issued quotation off the air at once.
   */
  readonly fx?: OrderDocumentFxWire | undefined;
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
  fxMinor: fxMoney.optional(),
});

const orderDocumentChargeWireSchema: z.ZodType<OrderDocumentChargeWire> = z.object({
  lineNo: z.int().min(1),
  customerDescriptionTh: z.string().min(1),
  netMinor: thb,
  isVatApplicable: z.boolean(),
  override: orderDocumentOverrideWireSchema.nullable(),
  fxMinor: fxMoney.optional(),
});

/** Digits only, and never `0`: the ratio is positive, and a zero denominator is a division. */
const positiveDigits = z
  .string()
  .regex(/^\d{1,40}$/u, 'must be digits')
  .refine((value) => /[1-9]/u.test(value), { message: 'must be greater than zero' });

const orderDocumentFxWireSchema: z.ZodType<OrderDocumentFxWire> = z.object({
  currency: z.enum(FX_CURRENCIES_WIRE),
  source: z.enum(['mid_market', 'manual']),
  spreadBp: z.int().min(0).max(2_000),
  rateNumerator: positiveDigits,
  rateDenominator: positiveDigits,
  rateText: z.string().min(1),
  observedAt: z.iso.datetime({ offset: true }).nullable(),
  provider: z
    .object({
      base: z.string().regex(/^[A-Z]{3}$/u),
      thbPerBase: z.number().positive(),
      unitPerBase: z.number().positive(),
    })
    .nullable(),
  netMinor: fxMoney,
  vatMinor: fxMoney,
  grandTotalMinor: fxMoney,
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
  destinationCountry: z.string().regex(/^[A-Z]{2}$/u).optional(),
  taxBasis: z.enum(DESTINATION_TAX_BASES).optional(),
  fx: orderDocumentFxWireSchema.optional(),
  lines: z.array(orderDocumentLineWireSchema),
  charges: z.array(orderDocumentChargeWireSchema),
  documentOverride: orderDocumentOverrideWireSchema.nullable(),
  netThbMinor: thb,
  vatThbMinor: thb,
  grandTotalThbMinor: thb,
  leadTimeDays: z.int().min(0),
});

/**
 * `GET /orders/:orderId/document` — the pinned document, and beside it, never inside it,
 * who is offering it.
 *
 * ⚠️ **`seller` is a sibling of `document`, not a field on it.** `document` is
 * `OrderDocumentWire` exactly as `orderDocumentWireSchema` reads it back from
 * `order_documents` — `documentSchemaVersion` is a bare literal there and
 * `order.repository.ts` `safeParse`s every stored row against it with no v1/v2 union
 * reader, so a field added inside `document` is a version bump that stops every
 * already-issued quotation from parsing. `seller` carries no such pin: it is
 * `OrganisationProfileWire`, read live from `organisation_profile` on every request, because
 * a price is an offer and is frozen, but a letterhead is not — a company that moves office
 * wants last year's quotation reprinted at the new address, not the old one repeated
 * forever.
 */
export interface OrderDocumentResponseWire {
  readonly document: OrderDocumentWire;
  readonly seller: OrganisationProfileWire;
}

/* ------------------------------------------------------------------ *
 * The order
 * ------------------------------------------------------------------ */

export interface OrderContactWire {
  readonly email: string | null;
  readonly name: string | null;
  readonly phone: string | null;
  readonly locale: string;
  /**
   * Where this order is going, or `null` on a cart that predates the field and every order
   * before a destination was ever chosen.
   *
   * ⭐ Carried beside `locale` deliberately — the two make the identical round trip through
   * `GET /orders/:id` (`encode.ts`'s `contact` object, off `ScopedOrder.destinationCountry`),
   * and the storefront's pre-fill (`prefillContact.ts`) follows `locale` to find every place
   * this field had to be added too.
   */
  readonly destinationCountry: string | null;
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
  /**
   * What is still owed on this order — `order_outstanding_thb_minor()`, the function in
   * `packages/db/drizzle/0011_payment_guards.sql`, read as a column on the same select that
   * fetched the row.
   *
   * It is here so that nobody has to arrive at it twice. `grandTotal` minus a sum of slips is
   * a *different number* the moment a slip carries `unallocated_thb_minor` or the order has
   * more than one instalment, and `schedule.ts` refuses to ship an outstanding field beside
   * the instalments for exactly that reason — a total beside the parts invites a client to
   * fold the parts and disagree. This is the opposite move and not a reversal of it: what
   * travels is the database's own answer, so there is nothing here for a second
   * implementation to be wrong about.
   *
   * ⚠️ Null before submit, on the same fact as `grandTotalThbMinor` above and never on its
   * own. The fold answers ฿0.00 for a cart — true, and unreadable on a queue, where "ค้างชำระ
   * ฿0.00" is how a screen says *settled*, and a cart that was never priced has settled
   * nothing. One order carries one answer to "is there a contract here yet", and all three
   * money fields give it together (`encodeOrderSummary`).
   *
   * ⚠️ **And null on a `cancelled` or `superseded` order, where `grandTotalThbMinor` is not.**
   * The fold is total and answers the whole unpaid remainder there too — the right answer to
   * the question the function asks, and a bill nobody owes. Money still held on a cancelled
   * order is a refund (`POST /payments/refunds`); money on a superseded one was carried to the
   * order that replaced it and is already counted there. So the wire states neither "owing"
   * nor "settled" for those two, because neither is true, and a client renders the same
   * nothing it renders for a cart. The membership is `NON_LIVE_ORDER_STATUSES` in
   * `apps/api/src/orders/live-order.ts`, which is the same list `GET /overview`'s money card
   * filters on — one definition, so the row and the total cannot disagree.
   */
  readonly outstandingThbMinor: MoneyWire<'THB'> | null;
  /**
   * What to pay *now* — `order_next_due_thb_minor()`
   * (`packages/db/drizzle/0042_next_instalment_due.sql`): the remainder of the first
   * instalment no accepted slip has settled yet.
   *
   * Beside `outstandingThbMinor` rather than instead of it, because the owner's ruling is
   * about this one and not that one: *"ถ้าเป็นเคสที่ระบุว่าต้องมัดจำ จึงจะมัดจำ ถ้าไม่ได้ระบุให้ใช้ยอด
   * เต็มเลย"*. The two are equal on a pay-in-full order and differ by the balance on every
   * 30/70, so a screen with one field has to pick — and picking the outstanding where the
   * quotation promised a deposit asks the customer for the whole contract. Neither is
   * derivable from the other, which is why both are sent.
   *
   * ฿0.00 when nothing is due, which is settled-in-full and not "no schedule": the fold is
   * total by construction (0042 says so at length) and never makes a caller handle a third
   * case. Null before submit — and null on a `cancelled` or `superseded` order — on the same
   * terms as the field above, and always together with it: a client that has one of these two
   * has both, and a client that has neither must ask for no money at all.
   */
  readonly nextDueThbMinor: MoneyWire<'THB'> | null;
  /**
   * ⭐ HOW MUCH OF THIS ORDER'S BALANCE THE COMPANY HAS **FORGIVEN** —
   * `order_written_off_thb_minor()` (`packages/db/drizzle/0048_write_off_approval.sql`), the sum
   * of every approved ตัดยอดค้างทิ้ง on this order.
   *
   * ── Why it is on the wire at all, and not merely inside the fold ─────────────
   *
   * Because since 0048 `outstandingThbMinor` is `grand_total − settled − written_off`, and a
   * balance that fell for the third reason is **not the same news** as one that fell for the
   * second. ฿0.00 outstanding with ฿0.00 here means the customer paid; ฿0.00 outstanding with
   * ฿20,000 here means the company gave up ฿20,000. Without this field a screen has one number
   * for two facts and no way to tell them apart — so the customer's payment page would print
   * *"ออเดอร์นี้ชำระครบแล้ว"* at somebody who did not pay, and the owner asking *"how much did we
   * write off this year?"* would have nothing to add up.
   *
   * ⛔ It is not the reader's job to subtract it. `outstandingThbMinor` is **already net of
   * this**: the two are read from two Postgres folds on one select, and
   * `outstanding + written_off` is `grand_total − settled` rather than a bigger debt. A screen
   * that took this off the outstanding again would double-count the forgiveness.
   *
   * ⚠️ ฿0.00 on the overwhelming majority of orders, and ฿0.00 is a real answer — *nothing has
   * been forgiven* — not an absence. Nulled only on the same fact as the two fields above: a cart
   * has no contract, and a cancelled or superseded order states no money figures at all
   * (`encodeOrderSummary` asks that question once for all four).
   *
   * ⚠️ It is **not** money that arrived. `order_settled_thb_minor()` deliberately still means
   * *cash the company received*, and 0048 does not touch it; a client that added this to a
   * "received" figure would be reporting revenue the company chose not to collect.
   */
  readonly writtenOffThbMinor: MoneyWire<'THB'> | null;
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
  /**
   * ⚠️ Which transaction wrote this row — **staff only**, `null` for the customer.
   *
   * `order_events.write_txid` is `pg_current_xact_id()::text`, and it is the only column on the
   * table that answers "were these two rows one act?". `created_at` cannot: it defaults to
   * `now()`, which in Postgres is the *transaction's* start time, so rows written together
   * carry an identical instant — and rows written seconds apart in separate transactions can
   * still render as the same minute. `seq` orders the spine; this says which writes were atomic.
   *
   * Withheld from the customer for the same class of reason as `actorUserId`, one step further
   * out. A txid is neither personal data nor a secret, but it is monotonic across the *whole
   * database*: two of them subtracted give the number of write transactions the company
   * committed in between, so a customer holding events from two of their own orders could read
   * the company's transaction volume off them. Staff already hold `orders.read` over the whole
   * table and can see the traffic directly, so the same figure tells them nothing new.
   */
  readonly writeTxid: string | null;
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

/**
 * ⭐ แจ้งเตือนยอดค้างชำระ — what came of pressing the button.
 *
 * `POST /orders/:orderId/balance-reminders` answers with this. It is deliberately *not* an
 * `OrderWire`: nothing about the order changed — no status, no money, no available transition —
 * and returning the order would invite a screen to diff it and find nothing, which reads as a
 * button that did nothing.
 *
 * ── ⚠️ WHY `queued` AND `suppressedReason` ARE ON IT ─────────────────────────────
 *
 * Because *"I pressed it, did it go?"* is the whole question, and the spine row alone cannot
 * answer it. `order_events_fan_out_notifications()` runs in this transaction and writes either a
 * `pending` row or a **`suppressed`** one — the latter when the customer has no email address
 * (`no_contact_channel`) or the account was erased (`recipient_erased`). Both are correct
 * outcomes and they look identical from the order screen, so the API states which happened
 * rather than leaving a member of staff to believe a message is on its way to somebody who has
 * only ever given a telephone number.
 *
 * ⚠️ `queued` is **not** `sent`. The worker polls, renders and talks to an SMTP server minutes
 * later, and `notification_attempts` is where "it went" is recorded. A field called `sent` here
 * would be a lie in the ordinary case, which is why the dashboard's toast says คิว and not ส่งแล้ว.
 */
export interface BalanceReminderWire {
  /** The `order_events` row this ask wrote — citable, and the row the timeline renders. */
  readonly eventId: string;
  /** Its position on the spine, so a client can find it without re-reading the whole history. */
  readonly seq: number;
  readonly remindedAt: string;
  /**
   * ⛔ `order_outstanding_thb_minor()` at the moment of the ask, computed in Postgres inside the
   * transaction that wrote the event, and stored verbatim in its payload. Never arithmetic done
   * by a caller, and never re-derivable later — the balance moves.
   */
  readonly outstandingThbMinor: MoneyWire<'THB'>;
  /** How many outbox rows the fan-out wrote for this event with somewhere to send them. */
  readonly queued: number;
  /**
   * Why nothing was queued, when nothing was — `notifications.suppressed_reason`, verbatim
   * (`no_contact_channel`, `recipient_erased`). `null` when a message is on its way.
   */
  readonly suppressedReason: string | null;
}

/**
 * What cancelling this order *right now* would cost — priced, not estimated.
 *
 * ── Why this is a response and not something a client computes ────────────────────
 *
 * The forfeit is `least(held, scheduled_deposit) × forfeit_bp`, clamped to money held, and two
 * of those three inputs are not on any wire: `held` is a fold of ledger postings, and
 * `forfeit_bp` comes from the policy the order **pinned at submit** — not from today's table.
 * A client cannot arrive at this number, and a client that approximated it would be telling
 * somebody what their cancellation costs and being wrong.
 *
 * So the server prices it, by calling the same `PaymentLifecycleService.priceCancellation` the
 * cancellation itself calls. The figure shown before confirming and the figure the ledger keeps
 * afterwards are one call made twice, which is the only arrangement under which they cannot
 * drift. Plan 7.13 is the reason that sentence is written down.
 *
 * ── `fault` is not a parameter, because for the caller it is not a choice ─────────
 *
 * This prices the cancellation **as the caller could actually perform it**: with no
 * company-fault claim, which for a customer or a guest is the only cancellation that exists
 * (`faultFor` returns `'customer'` for every non-staff actor, and `CancelOrderRequestWire` has
 * no field through which a claim could be made). Staff who intend to claim company fault are
 * asking a different question — and its answer is always ฿0 forfeited, by CHECK.
 */
export interface CancellationPreviewWire {
  /**
   * The status this was priced from — the order's status when the preview was taken.
   *
   * Echoed back so a client can notice it is stale. The forfeit rate is keyed on this, so a
   * preview taken in `production_confirmed` does not describe a cancellation made from
   * `in_production`.
   */
  readonly fromStatus: OrderStatusWire;
  /** Money the company is holding for this order. The ceiling on both figures below. */
  readonly heldThbMinor: MoneyWire<'THB'>;
  /** What would be kept. ฿0 is a real and common answer — see the shipped default policy. */
  readonly forfeitThbMinor: MoneyWire<'THB'>;
  /** What would come back: `held − forfeit`. */
  readonly refundThbMinor: MoneyWire<'THB'>;
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
  /** Where the order is going. Optional: a submit that names none carries over the cart's own. */
  readonly destinationCountry?: string | undefined;
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
    destinationCountry: z.string().regex(/^[A-Z]{2}$/u).optional(),
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

/**
 * ⭐ The reminder's answer, as a schema — for the API's own tests and for any client that wants
 * to refuse a shape rather than read past it.
 *
 * `suppressedReason` is `z.string().nullable()` and not a literal union on purpose: the reasons
 * come from `order_events_fan_out_notifications()`, a plpgsql function that a migration may add
 * to without this package being rebuilt, and a client that threw on an unrecognised reason would
 * turn a *more informative* server into a broken screen.
 */
export const balanceReminderWireSchema: z.ZodType<BalanceReminderWire> = z.object({
  eventId: z.uuid(),
  seq: z.int().min(1),
  remindedAt: z.iso.datetime(),
  outstandingThbMinor: thb,
  queued: z.int().min(0),
  suppressedReason: z.string().nullable(),
});

export const cancellationPreviewWireSchema: z.ZodType<CancellationPreviewWire> = z.object({
  fromStatus: orderStatusWireSchema,
  heldThbMinor: thb,
  forfeitThbMinor: thb,
  refundThbMinor: thb,
});

export const orderSummaryWireSchema: z.ZodType<OrderSummaryWire> = z.object({
  id: z.uuid(),
  orderNo: z.string().nullable(),
  status: orderStatusWireSchema,
  isFrozen: z.boolean(),
  frozenAt: z.iso.datetime().nullable(),
  submittedAt: z.iso.datetime().nullable(),
  grandTotalThbMinor: thb.nullable(),
  /* Nullable on the same fact as the total above, never independently — see `OrderSummaryWire`. */
  outstandingThbMinor: thb.nullable(),
  nextDueThbMinor: thb.nullable(),
  writtenOffThbMinor: thb.nullable(),
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
  /* Digits, not a uuid and not a number: see the note on `OrderEventWire.writeTxid`. */
  writeTxid: z.string().regex(/^\d+$/).nullable(),
  createdAt: z.iso.datetime(),
});
