import { z } from 'zod';
import { type MoneyWire, moneyWireSchema } from './money.js';
import { lengthWireSchema, type LengthWire } from './measure.js';
import { priceRequestWireSchema, type PriceRequestWire } from './pricing.js';
import { DESTINATION_TAX_BASES, type DestinationTaxBasis } from './tax.js';

/**
 * The sales-editable quote on the wire — phase 5c.
 *
 * ── The one sentence this module exists to make true ─────────────────────────────
 *
 * **No request here carries a computed money figure, and no request carries a normalised
 * one either.** A human-set price arrives as the characters the human typed
 * (`enteredValueText`) plus the box they typed it into (`enteredAs`), and the server does
 * every piece of arithmetic itself against a baseline it computed itself.
 *
 * That is stronger than it first looks, and it is the point. Plan 7.9(ก) puts `computed` in
 * the machine layer — "api คำนวณเองเสมอ ไม่รับตัวเลขจาก client". Once sales may set any
 * number, the naïve reading of that rule ("do not accept money") becomes impossible: the
 * whole feature is a person setting a number. The reading that survives is the one below:
 *
 *   * the *baseline* is never sent. Not on an override, not on a line, not at submit.
 *   * the *promise* is sent as text, exactly as it was typed, and normalised server-side.
 *   * `-15%` is resolved against the server's baseline at the moment of the write, and the
 *     absolute figure it produced is what gets stored — never the percentage. Plan 7.9(ก):
 *     a delta silently reprices to ฿9,209 the day the catalogue moves to ฿9,500, having
 *     promised ฿8,500.
 *
 * A client that wanted to forge a concession would have to forge the *baseline*, and there
 * is no field in this file that carries one.
 *
 * ── One anchor per meaning (plan 7.9(ข)) ─────────────────────────────────────────
 *
 * There are three anchors and no fourth, and the UI's per-unit box is not one of them: a
 * price typed per unit arrives as `enteredAs: 'unit_price'` and is normalised onto the line
 * total by the server. Plan 7.9(ข)'s worked example is why — qty 2 with unit ฿9,000 *and*
 * total ฿18,432 set at once leaves the quote ฿432 short of footing, and a 30% deposit is
 * then wrong from whichever end it is computed.
 *
 * ── The precondition, and why it is not a money comparison (plan 7.9(จ)) ──────────
 *
 * Every write carries `expect`, and `expect` carries no amounts at all: a quote revision
 * token and — for a write that touches a configured line — the catalogue handle that line
 * was drawn from. Two different 409s come out of it, because a client can only recover from
 * one of them: `CATALOG_STALE` means re-render and re-confirm the price, `QUOTE_STALE`
 * means somebody else edited this quote and the screen is out of date.
 *
 * ── The statuses and the vocabularies are restated, not imported ─────────────────
 *
 * `@wewin/db` is server-only by construction, so the unions a browser reads cannot be the
 * unions Postgres holds. `apps/api/tests/quotes/contract-drift.test.ts` compares every list
 * below, member for member, with the schema's own — which is what turns "restated" into
 * something other than "duplicated".
 */

/* ------------------------------------------------------------------ *
 * Closed sets
 * ------------------------------------------------------------------ */

export const QUOTE_LINE_KINDS_WIRE = ['catalog', 'freeform'] as const;
export type QuoteLineKindWire = (typeof QUOTE_LINE_KINDS_WIRE)[number];

export const OVERRIDE_ANCHORS_WIRE = ['line_total', 'grand_total', 'lead_time_days'] as const;
export type OverrideAnchorWire = (typeof OVERRIDE_ANCHORS_WIRE)[number];

export const OVERRIDE_ENTRY_MODES_WIRE = [
  'line_total',
  'unit_price',
  'grand_total',
  'percent_discount',
  'discount_amount',
  'lead_time_days',
] as const;
export type OverrideEntryModeWire = (typeof OVERRIDE_ENTRY_MODES_WIRE)[number];

export const OVERRIDE_REASONS_WIRE = [
  'price_match',
  'volume',
  'relationship',
  'goodwill',
  'correction',
  'rounding',
  'other',
] as const;
export type OverrideReasonWire = (typeof OVERRIDE_REASONS_WIRE)[number];

/**
 * Which entry modes each anchor accepts.
 *
 * A restatement of `quote_overrides_entry_mode_fits_anchor`, and a deliberate one: without
 * it the API's refusal of `entered_as: 'unit_price'` on a grand total would be SQLSTATE
 * 23514 translated into prose, which tells a client nothing it can act on. The drift test
 * reads the CHECK's own definition out of Postgres and compares.
 */
export const ENTRY_MODES_BY_ANCHOR = {
  line_total: ['line_total', 'unit_price', 'percent_discount', 'discount_amount'],
  grand_total: ['grand_total', 'percent_discount', 'discount_amount'],
  lead_time_days: ['lead_time_days'],
} as const satisfies Record<OverrideAnchorWire, readonly OverrideEntryModeWire[]>;

const thb = moneyWireSchema('THB');

/* ------------------------------------------------------------------ *
 * The precondition — plan 7.9(จ)
 * ------------------------------------------------------------------ */

/**
 * What the client believes it is editing. **No money, by construction.**
 *
 * `quoteRevision` is a token over the live content of the quote, not a counter. A counter
 * needs a column and a writer, and every writer of it is a second answer to "did this quote
 * change?"; a token derived from the content has exactly one answer, cannot run backwards,
 * and is wrong only when the thing it describes really is different. The server produces it
 * and the client echoes it back; nothing else may construct one.
 */
export interface QuotePreconditionWire {
  readonly quoteRevision: string;
}

/** 16 lowercase hex digits, like `configHash`. Opaque to a client — it is echoed, never parsed. */
export const QUOTE_REVISION_PATTERN = /^[0-9a-f]{16}$/;

export const quotePreconditionSchema: z.ZodType<QuotePreconditionWire> = z.strictObject({
  quoteRevision: z.string().regex(QUOTE_REVISION_PATTERN, 'must be a quote revision token'),
});

/* ------------------------------------------------------------------ *
 * What a human typed
 * ------------------------------------------------------------------ */

/**
 * Verbatim, bounded, and never a number.
 *
 * `'8500'`, `'8,500.50'`, `'-15%'`, `'฿8500'` — whatever the keyboard produced. It is
 * stored exactly as sent (plan 7.9(ก): sales told the customer *"เอา ฿8,500"* or *"ลด 5%"*,
 * and which of the two they said is what the conversation was), and it is parsed by exactly
 * one function on the server.
 *
 * 32 characters, because it is a price and not a sentence; the sentence is `noteTh`.
 */
export const enteredValueTextSchema = z.string().trim().min(1).max(32);

const noteSchema = z.string().trim().min(1).max(2000);
const descriptionSchema = z.string().trim().min(1).max(500);

/* ------------------------------------------------------------------ *
 * Requests — lines
 * ------------------------------------------------------------------ */

/**
 * Add a configured line.
 *
 * The line is a `PriceRequestWire`, reused rather than redefined for the reason
 * `OrderLineRequestWire` gives: an order line and a price request are the same facts plus
 * the catalogue handle they were drawn from, and two definitions of that would diverge as
 * an order priced from a shape the configurator never sends.
 *
 * `customerDescriptionTh` is the one field on a line that is free text, and ⚠️ it never
 * reaches a production sheet — plan 7.9(ค). See `worksOrderLines` on the server.
 */
export interface AddCatalogLineRequestWire {
  readonly expect: QuotePreconditionWire;
  readonly line: PriceRequestWire;
  readonly customerDescriptionTh?: string | undefined;
  readonly isVatApplicable?: boolean | undefined;
}

/**
 * Add a free-form line — delivery, installation, a site survey, a goodwill credit.
 *
 * The one place a human-typed amount is the *baseline* rather than an override against one,
 * which is why it is a different request and not a flag on the one above. `amountText` may
 * be negative: plan 7.13 lists "a negative charge" among the things the `margin` dimension
 * has to catch, because a −฿1,000 line is a discount wearing a different hat.
 */
export interface AddFreeformLineRequestWire {
  readonly expect: QuotePreconditionWire;
  readonly customerDescriptionTh: string;
  readonly amountText: string;
  readonly isVatApplicable?: boolean | undefined;
}

/**
 * Change what a line *is* — quantity, options, measurements.
 *
 * Separate from the request below, and the split is plan 7.9(ค)'s ⚠️ made structural: this
 * route writes the fields a works order renders from, that one writes the field it must
 * never render from. They are different permissions to reason about even though today they
 * are the same permission.
 *
 * Refused outright while a live `line_total` override exists — the database refuses it too
 * (`quote_lines_guard_write`), because ฿17,000 for two is not ฿17,000 for three and plan
 * 7.9(ง)(2) is the finding that `quoteReducer.ts:68` drops that promise silently.
 */
export interface ReviseLineRequestWire {
  readonly expect: QuotePreconditionWire;
  readonly line: PriceRequestWire;
}

/** What the customer reads. Editable as often as anybody likes, and structurally inert. */
export interface PresentLineRequestWire {
  readonly expect: QuotePreconditionWire;
  /** `null` clears it. Absent leaves it alone — the two are different requests. */
  readonly customerDescriptionTh?: string | null | undefined;
  readonly isVatApplicable?: boolean | undefined;
}

export interface RemoveLineRequestWire {
  readonly expect: QuotePreconditionWire;
  readonly reasonTh?: string | undefined;
}

/* ------------------------------------------------------------------ *
 * Requests — overrides
 * ------------------------------------------------------------------ */

/**
 * Set a figure a human decided.
 *
 * A discriminated union on the anchor, so the entry mode that does not fit is a parse error
 * with a path in it rather than a CHECK violation translated into a shrug. `quoteLineId` is
 * present exactly on the line anchor, which is `quote_overrides_scope_shape` said on the
 * wire.
 *
 * Replacing a live override is this same request again: the server supersedes the old row
 * and writes the new one in one transaction, in the order the partial unique index forces
 * (stamp, then insert — see `0016_quote_guards.sql`).
 */
export type SetOverrideRequestWire =
  | {
      readonly expect: QuotePreconditionWire;
      readonly anchor: 'line_total';
      readonly quoteLineId: string;
      readonly enteredAs: 'line_total' | 'unit_price' | 'percent_discount' | 'discount_amount';
      readonly enteredValueText: string;
      readonly reasonCode: OverrideReasonWire;
      readonly noteTh?: string | undefined;
    }
  | {
      readonly expect: QuotePreconditionWire;
      readonly anchor: 'grand_total';
      readonly enteredAs: 'grand_total' | 'percent_discount' | 'discount_amount';
      readonly enteredValueText: string;
      readonly reasonCode: OverrideReasonWire;
      readonly noteTh?: string | undefined;
    }
  | {
      readonly expect: QuotePreconditionWire;
      readonly anchor: 'lead_time_days';
      readonly enteredAs: 'lead_time_days';
      readonly enteredValueText: string;
      readonly reasonCode: OverrideReasonWire;
      readonly noteTh?: string | undefined;
    };

/**
 * Withdraw one, leaving no successor.
 *
 * Deliberately not a DELETE: the row is not deleted, it is stamped, and a verb that says
 * "delete" about an append-only table is a verb somebody will eventually implement. It is
 * also how sales *confirms* a price after the catalogue moved — plan 7.9(จ) — because an
 * override equal to today's computed figure is refused by `quote_overrides_value_differs`,
 * and rightly: agreeing with the machine is not a promise, it is the absence of one.
 */
export interface RevokeOverrideRequestWire {
  readonly expect: QuotePreconditionWire;
  readonly noteTh?: string | undefined;
}

/* ------------------------------------------------------------------ *
 * Responses
 * ------------------------------------------------------------------ */

export interface QuoteLineWire {
  readonly id: string;
  readonly seq: number;
  readonly kind: QuoteLineKindWire;
  /** Null on a free-form line. The handle the works order and the re-verification both use. */
  readonly productVersionId: string | null;
  /**
   * The frozen catalogue document this line is pinned against — the other half of a `CatalogRef`.
   *
   * Without it a client holding a quote cannot construct a well-formed `ReviseLineRequestWire`,
   * because that request carries a `PriceRequestWire` and a `PriceRequestWire` carries
   * `{productVersionId, documentHash}`. 5c shipped with qty and options read-only on the editor
   * for exactly this reason, and a hash taken from anywhere else would be a guess at the pinned
   * document, which is the staleness the handle exists to catch.
   *
   * Null when the pinned version is no longer the published one — which is the case
   * `staleBaselines` reports, and where there is no current handle to give.
   */
  readonly documentHash: string | null;
  /**
   * The catalogue product this line's version belongs to — the last field a `PriceRequestWire`
   * needs and the one that kept qty read-only after `documentHash` arrived.
   *
   * It is *not* the same fact as `productVersionId`, and a client cannot derive one from the
   * other: the mapping lives in the catalogue. `reviseLine` resolves the id from the line's own
   * version and refuses a request naming a different one, so this field is not trusted — it is
   * the value the server will insist on, published so a client can send it rather than guess.
   *
   * Null exactly when `documentHash` is null, and for the same reason: the pinned version is no
   * longer the published one, so there is no current handle and no revision to construct.
   */
  readonly productId: string | null;
  readonly skuCode: string | null;
  readonly selections: Readonly<Record<string, string>> | null;
  readonly measures: Readonly<Record<string, LengthWire>> | null;
  readonly qty: number;
  /** 📣 FOR THE CUSTOMER. Never rendered onto a production sheet — plan 7.9(ค). */
  readonly customerDescriptionTh: string | null;
  readonly isVatApplicable: boolean;
  /**
   * ⓵ What `calcPrice` said. Null on a free-form line, which has nothing to compute.
   *
   * ⚠️ **Also null for a customer**, and that is an audience rule rather than a data one. This
   * beside `effectiveTotalThbMinor` is the per-line concession, one subtraction away, on a
   * response that otherwise carefully strips every concession-shaped fact into `sales`. What
   * the company was willing to come down to is not the customer's record — the mirror image of
   * plan 7.9(ค)'s rule that sales prose must never reach the factory.
   */
  readonly computedTotalThbMinor: MoneyWire<'THB'> | null;
  /** The typed charge on a free-form line, and null on a configured one — and null for a customer. */
  readonly chargeTotalThbMinor: MoneyWire<'THB'> | null;
  /**
   * ⓶ What this line costs after its own override, if it has one — what the customer is
   * charged for this line.
   *
   * ⚠️ Not always VAT-exclusive. Whether this figure already contains the tax depends on the
   * destination's basis, carried beside it on `QuoteWire.destination.basis`: under `exclusive`
   * it is the tax base and effective line totals sum to `money.netThbMinor`; under `inclusive`
   * it already contains the tax and they sum to `money.grandTotalThbMinor` instead. See
   * `QuoteDestinationWire.basis` for the full identity — a reader who assumes exclusive on an
   * inclusive quote gets a total that looks like it does not foot by exactly the VAT.
   */
  readonly effectiveTotalThbMinor: MoneyWire<'THB'>;
}

/**
 * One promise, with the figure it was made against.
 *
 * Only ever served to staff: `reasonCode`, `noteTh` and `computed…` together are the record
 * of a negotiation, and the customer's copy of what they owe is the pinned document.
 */
export interface QuoteOverrideWire {
  readonly id: string;
  readonly anchor: OverrideAnchorWire;
  readonly quoteLineId: string | null;
  readonly computedThbMinor: MoneyWire<'THB'> | null;
  readonly overrideThbMinor: MoneyWire<'THB'> | null;
  readonly computedDays: number | null;
  readonly overrideDays: number | null;
  readonly enteredAs: OverrideEntryModeWire;
  readonly enteredValueText: string;
  readonly reasonCode: OverrideReasonWire;
  readonly noteTh: string | null;
  readonly setByUserId: string;
  /** Who, in words. A truncated uuid is not an answer to "who agreed this price?". */
  readonly setByUserName: string | null;
  readonly createdAt: string;
}

export interface QuoteMoneyWire {
  /** VAT-exclusive, and the sum of the taxable and exempt subtotals below. */
  readonly netThbMinor: MoneyWire<'THB'>;
  readonly taxableNetThbMinor: MoneyWire<'THB'>;
  readonly exemptNetThbMinor: MoneyWire<'THB'>;
  readonly vatThbMinor: MoneyWire<'THB'>;
  /** Always VAT-inclusive — plan 4.4, and the single base everything else derives from. */
  readonly grandTotalThbMinor: MoneyWire<'THB'>;
  readonly vat: { readonly rateBp: number; readonly treatment: string };
}

/**
 * Two things a catalogue publish does to a quote, and they need different sentences.
 *
 *   `promise_baseline_moved`   the line carries a live override. ฿17,000 against ฿18,432 is a
 *                              7.8% concession; the same ฿17,000 against ฿20,000 is 15%.
 *                              Nobody agreed to the second one — plan 7.9(จ) — so a person
 *                              has to look at this line and either re-promise or let the new
 *                              price stand.
 *   `line_needs_repricing`     the line carries no promise; it is simply pinned to a version
 *                              that is no longer published, so the figure on it is not a
 *                              price anybody may be quoted. The recovery is mechanical
 *                              (re-send the line against the current catalogue handle) and
 *                              needs no decision, which is why it is a different word.
 *   `document_baseline_moved`  ⭐ the `grand_total` promise. Its stored baseline is a figure
 *                              about every line at once, and for a whole round nothing checked
 *                              it: `verifyBaselines` iterated lines only, so a ฿7,495.84
 *                              document promise with two more lines added under it billed
 *                              ฿7,495.84 against a ฿66,562.56 document, and the verification
 *                              endpoint answered 200. It carries no `quoteLineId`, because it
 *                              hangs off no line and its recovery is the whole-document one.
 *
 * One list rather than two, because the caller's question is "may this quote go out?" and the
 * answer is no in both cases. One *word* rather than none, because the two recoveries are a
 * negotiation and a re-render, and a screen that showed them identically would send a
 * salesperson to renegotiate a price nobody ever changed.
 */
export const STALE_BASELINE_KINDS_WIRE = [
  'promise_baseline_moved',
  'line_needs_repricing',
  'document_baseline_moved',
] as const;
export type StaleBaselineKindWire = (typeof STALE_BASELINE_KINDS_WIRE)[number];

export interface StaleBaselineWire {
  readonly kind: StaleBaselineKindWire;
  /** Null on `document_baseline_moved`, which is about the document rather than a line. */
  readonly quoteLineId: string | null;
  readonly seq: number | null;
  /** Null on `line_needs_repricing`: there is no promise, which is what that word means. */
  readonly overrideId: string | null;
  /** The version this line is pinned to, which is no longer the published one. Null on a document row. */
  readonly pinnedProductVersionId: string | null;
  /** Null when the product is not published at all any more — a different conversation again. */
  readonly publishedProductVersionId: string | null;
  readonly promisedThbMinor: MoneyWire<'THB'> | null;
  /** The figure stored on the line: what the promise was made against. */
  readonly baselineThbMinor: MoneyWire<'THB'>;
  /**
   * What the same configuration costs under what is published now.
   *
   * Null when there is nothing to compute it from — the product is unpublished, or the
   * configuration names an option code the new version does not have, which is itself the
   * answer: this line cannot be carried forward and has to be rebuilt.
   */
  readonly currentComputedThbMinor: MoneyWire<'THB'> | null;
}

/**
 * What only staff see.
 *
 * Nested rather than spread through `QuoteWire` as optional fields, so "did I remember to
 * strip this?" is one question with one answer instead of one per field. Same reasoning as
 * `encodeEvent`'s audience split in the orders module.
 */
export interface QuoteSalesViewWire {
  readonly overrides: readonly QuoteOverrideWire[];
  /**
   * How much less the customer pays than the untouched document, VAT-inclusive.
   *
   * A **sum of named reductions** measured at the document level, which is plan 7.13's
   * instruction: ten lines discounted 10% each pass individually and nothing is ever reviewed.
   * Reductions add and increases do not subtract — netting line A up ฿10,000 against line B
   * down ฿10,000 leaves a real ฿10,700 promise on B that a netted figure would hide.
   *
   * ⚠️ **This is a figure to render; whether it is *allowed* is the authority endpoints'
   * answer.** It is, however, the *same number* — `measureMargin`'s, read from the rows. It was
   * briefly a second measurement produced by subtracting the effective total from an untouched
   * baseline, kept honest by a test asserting the two agreed; they did not, in three separate
   * ways and in both directions, so the subtraction is gone. See `apps/api/src/quotes/overrides.ts`.
   */
  readonly marginConcessionThbMinor: MoneyWire<'THB'>;
  /** The baseline the concession is measured from: no overrides, no negative charges. */
  readonly baselineGrandTotalThbMinor: MoneyWire<'THB'>;
  readonly staleBaselines: readonly StaleBaselineWire[];
  /**
   * ⭐ Roughly what this will cost in the destination's currency — **not yet pinned**.
   *
   * `null` for every domestic quotation, which is most of them: no destination, no
   * `fx_currency`, or a country code that names no row.
   *
   * ── Why it is in `sales` and not beside `destination` ────────────────────────────
   *
   * `destination` is outside `sales` precisely because an unrecognised country is *"a fact
   * about their own order that only they can correct"*. This is the opposite kind of fact: an
   * indicative figure at a rate that has not been struck yet, which the customer must never see
   * as a price. What a customer is entitled to is the frozen document — where the destination
   * currency *replaces* baht and the rate is pinned, printed and permanent
   * (`OrderDocumentFxWire`). Showing them a preview would put two different foreign figures in
   * front of the same person and make the second one look like a change of terms.
   *
   * ── ⚠️ The polarity is the reverse of the document's, and that is the whole point ──
   *
   * On the pinned quotation the destination currency is the figure and baht is the settlement
   * note. Here **baht is the figure** and this is the annotation. Nothing is decided from it,
   * nothing is stored from it, and `grandTotalMinor` is a *rendering* — the submit recomputes
   * everything from the rate it resolves at that moment, which is the only figure that is ever
   * binding. Between a salesperson reading this and pressing send, the daily sync can land and
   * move it; that is not a defect, it is what "not yet pinned" means.
   */
  readonly fxPreview: QuoteFxPreviewWire | null;
}

/**
 * The indicative conversion, and — when there is not one — why.
 *
 * `available: false` never fails the request. `GET /orders/:id/quote` and every quote write
 * answer with the whole quote, so a rate problem that threw would make the editor itself
 * unopenable, including for the salesperson trying to fix the order that caused it. The
 * refusal belongs at the submit, which freezes something; a read freezes nothing.
 */
export interface QuoteFxPreviewWire {
  readonly available: boolean;
  /** The destination currency. Present even when `available` is false, so a screen can name it. */
  readonly currency: string;
  /**
   * The grand total converted at the indicative rate, in that currency's **minor units** — so
   * `'65383'` is SGD 653.83 and VND carries no decimal at all. Null when `available` is false.
   *
   * A digit string rather than a number, for `money.ts`'s reason: a decimal that survives a
   * float round-trip is luck. It is not a `MoneyWire<'THB'>` because it is not baht and not
   * `Exact<'THB.satang'>`; the unit is the destination currency's minor unit and the currency
   * beside it is what names which.
   */
  readonly grandTotalMinor: string | null;
  /** Baht per one whole unit, rendered for reading. ⚠️ Never the divisor — see `thbPerUnitText`. */
  readonly rateText: string | null;
  /** `'mid_market' | 'manual'`. A manual override is neither stale nor observed. */
  readonly source: string | null;
  /** ISO 8601 of the provider's observation. Null for a manual override, and when unavailable. */
  readonly observedAt: string | null;
  /**
   * ⭐ True when the rate is past the refusal threshold — i.e. **the submit will refuse this
   * quotation**. Shown rather than hidden: a salesperson needs to know both what it will
   * roughly cost and that it is not going to go out, and a screen that showed only one of those
   * would either withhold a useful figure or let somebody promise a price that cannot be issued.
   */
  readonly stale: boolean;
  /** Whole hours since `observedAt`, for a sentence. Null for a manual override or no rate. */
  readonly ageHours: number | null;
  /** Machine-readable why-not when `available` is false: `'no_snapshot'`, `'same_currency'`, … */
  readonly reason: string | null;
}

/**
 * ⭐ Where this quote is going, and whether the money above is actually that country's.
 *
 * `money.vat` names a rate but cannot say *whose*. `POST /orders` accepts any two-letter code
 * without validating it — deliberately, so an anonymous cart is never refused for a country the
 * company is about to add — so an order can name a code `tax_countries` has no row for. The
 * quote screen and every quote write degrade that to the default rule rather than refusing,
 * because they freeze nothing and a read that refuses leaves a cart nobody can open or correct.
 *
 * `recognised: false` is what stops the degrade being silent. It means: **the figures above are
 * the default rule, not this country's**, the submit will refuse until the code is corrected,
 * and the correction is a real destination on the submit's own `contact`. Without this field a
 * client could not tell a genuine Thai quote from a Singapore typo priced as one, which is the
 * exact failure `TaxCountryService.resolveDestination` refuses at the pin to avoid.
 *
 * Outside `sales` and therefore visible to a customer, unlike everything concession-shaped: it
 * is a fact about their own order that they chose and may have to fix, not the company's
 * position in a negotiation.
 */
export interface QuoteDestinationWire {
  /** Verbatim, including a code that names no row. Null when the order names no destination. */
  readonly country: string | null;
  /** False when `country` names no row: `money.vat` is the default rule, not this country's. */
  readonly recognised: boolean;
  /**
   * ⭐ Which arithmetic produced `money` — and a client genuinely cannot work it out.
   *
   * Under `exclusive` the line figures are the tax base and the effective line totals sum to
   * `money.netThbMinor`. Under `inclusive` they already **contain** the tax, so they sum to
   * `money.grandTotalThbMinor` instead and the net is what is left after dividing it back out.
   * The two sums differ by exactly `vatThbMinor`, and nothing else on this payload distinguishes
   * them — `net`, `grand` and `vat` are consistent with each other under either reading.
   *
   * It is here because a screen that adds the lines up and compares has to know which identity
   * it is checking. The dashboard's does, and without this field it read every inclusive quote
   * as a document that does not foot: a destructive *"this quote contradicts itself — do not
   * send it"* banner on correct money, off by the VAT, on every order for an inclusive country.
   *
   * The same value the document pins as `taxBasis`, from the same resolution — see
   * `TaxCountryService.resolveDestination`. `TaxRule` still carries only a rate and a treatment;
   * the basis travels beside it, never inside it.
   */
  readonly basis: DestinationTaxBasis;
}

export interface QuoteWire {
  readonly orderId: string;
  readonly quoteRevision: string;
  readonly currency: 'THB';
  readonly destination: QuoteDestinationWire;
  readonly lines: readonly QuoteLineWire[];
  readonly money: QuoteMoneyWire;
  readonly computedLeadTimeDays: number;
  readonly effectiveLeadTimeDays: number;
  /** Null for a customer. Every concession-shaped fact lives in here and nowhere else. */
  readonly sales: QuoteSalesViewWire | null;
}

/* ------------------------------------------------------------------ *
 * Request schemas
 * ------------------------------------------------------------------ */

export const addCatalogLineRequestSchema: z.ZodType<AddCatalogLineRequestWire> = z.strictObject({
  expect: quotePreconditionSchema,
  line: priceRequestWireSchema,
  customerDescriptionTh: descriptionSchema.optional(),
  isVatApplicable: z.boolean().optional(),
});

export const addFreeformLineRequestSchema: z.ZodType<AddFreeformLineRequestWire> = z.strictObject({
  expect: quotePreconditionSchema,
  /*
   * Required here and optional on a configured line, because it is the only thing a
   * free-form line *is*. A delivery charge with no description is ฿2,000 nobody can explain
   * to the customer who asks what it is for.
   */
  customerDescriptionTh: descriptionSchema,
  amountText: enteredValueTextSchema,
  isVatApplicable: z.boolean().optional(),
});

export const reviseLineRequestSchema: z.ZodType<ReviseLineRequestWire> = z.strictObject({
  expect: quotePreconditionSchema,
  line: priceRequestWireSchema,
});

export const presentLineRequestSchema: z.ZodType<PresentLineRequestWire> = z.strictObject({
  expect: quotePreconditionSchema,
  customerDescriptionTh: descriptionSchema.nullable().optional(),
  isVatApplicable: z.boolean().optional(),
});

export const removeLineRequestSchema: z.ZodType<RemoveLineRequestWire> = z.strictObject({
  expect: quotePreconditionSchema,
  reasonTh: noteSchema.optional(),
});

const overrideCommon = {
  expect: quotePreconditionSchema,
  enteredValueText: enteredValueTextSchema,
  reasonCode: z.literal(OVERRIDE_REASONS_WIRE),
  noteTh: noteSchema.optional(),
};

export const setOverrideRequestSchema: z.ZodType<SetOverrideRequestWire> = z.discriminatedUnion(
  'anchor',
  [
    z.strictObject({
      ...overrideCommon,
      anchor: z.literal('line_total'),
      quoteLineId: z.uuid(),
      enteredAs: z.literal(ENTRY_MODES_BY_ANCHOR.line_total),
    }),
    z.strictObject({
      ...overrideCommon,
      anchor: z.literal('grand_total'),
      enteredAs: z.literal(ENTRY_MODES_BY_ANCHOR.grand_total),
    }),
    z.strictObject({
      ...overrideCommon,
      anchor: z.literal('lead_time_days'),
      enteredAs: z.literal(ENTRY_MODES_BY_ANCHOR.lead_time_days),
    }),
  ],
);

export const revokeOverrideRequestSchema: z.ZodType<RevokeOverrideRequestWire> = z.strictObject({
  expect: quotePreconditionSchema,
  noteTh: noteSchema.optional(),
});

/* ------------------------------------------------------------------ *
 * Response schemas — for clients and for the API's own tests
 * ------------------------------------------------------------------ */

export const quoteLineWireSchema: z.ZodType<QuoteLineWire> = z.object({
  id: z.uuid(),
  seq: z.int().min(1),
  kind: z.literal(QUOTE_LINE_KINDS_WIRE),
  productVersionId: z.uuid().nullable(),
  documentHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  /**
   * ⚠️ A **catalogue product id**, and this was `z.uuid()` until a real order reached the
   * dashboard.
   *
   * ⛔ Called "a catalogue slug" here until products could have an id and a slug that differ.
   * It is `products.id` — for the eighty-one seeded products those are the same string, which
   * is why the wrong word survived, but a product created in the dashboard has an id like
   * `uoio` and a slug like `sdfghjkl`, and a reader who trusted this sentence would build a
   * storefront URL out of it and get the wrong page.
   *
   * `product_versions.product_id` is a `text` column holding `awn-1`, `lvr-adj`, `sld-2p`. The
   * interface beside this has always said `string | null`; the rule said uuid, and the two
   * disagreed from the day they were written.
   *
   * Nothing noticed for months because no order created through the storefront had ever
   * reached this decoder — every fixture went in another way. The first customer to press
   * "ขอใบเสนอราคา" produced a payload the API sends and the dashboard refuses, and sales saw
   * "เนื้อหาไม่ตรงกับที่แดชบอร์ดรู้จัก" on a live quotation.
   *
   * That is what a schema can be wrong about and a type cannot: `z.uuid()` was a claim about
   * production data, and `tsc` has no way to check one.
   *
   * ⚠️ `.min(1)` and not a bare string. `null` is how a **charge** line says it has no product;
   * an empty slug is a catalogue line pointing at nothing, and it would reach a production
   * sheet as a blank.
   */
  productId: z.string().min(1).nullable(),
  skuCode: z.string().min(1).nullable(),
  selections: z.record(z.string(), z.string()).nullable(),
  measures: z.record(z.string(), lengthWireSchema).nullable(),
  qty: z.int().min(1),
  customerDescriptionTh: z.string().nullable(),
  isVatApplicable: z.boolean(),
  computedTotalThbMinor: thb.nullable(),
  chargeTotalThbMinor: thb.nullable(),
  effectiveTotalThbMinor: thb,
});

export const quoteOverrideWireSchema: z.ZodType<QuoteOverrideWire> = z.object({
  id: z.uuid(),
  anchor: z.literal(OVERRIDE_ANCHORS_WIRE),
  quoteLineId: z.uuid().nullable(),
  computedThbMinor: thb.nullable(),
  overrideThbMinor: thb.nullable(),
  computedDays: z.int().nullable(),
  overrideDays: z.int().nullable(),
  enteredAs: z.literal(OVERRIDE_ENTRY_MODES_WIRE),
  enteredValueText: z.string().min(1),
  reasonCode: z.literal(OVERRIDE_REASONS_WIRE),
  noteTh: z.string().nullable(),
  setByUserId: z.uuid(),
  setByUserName: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const staleBaselineWireSchema: z.ZodType<StaleBaselineWire> = z.object({
  kind: z.literal(STALE_BASELINE_KINDS_WIRE),
  quoteLineId: z.uuid().nullable(),
  seq: z.int().min(1).nullable(),
  overrideId: z.uuid().nullable(),
  pinnedProductVersionId: z.uuid().nullable(),
  publishedProductVersionId: z.uuid().nullable(),
  promisedThbMinor: thb.nullable(),
  baselineThbMinor: thb,
  currentComputedThbMinor: thb.nullable(),
});

export const quoteMoneyWireSchema: z.ZodType<QuoteMoneyWire> = z.object({
  netThbMinor: thb,
  taxableNetThbMinor: thb,
  exemptNetThbMinor: thb,
  vatThbMinor: thb,
  grandTotalThbMinor: thb,
  vat: z.object({ rateBp: z.int().min(0).max(10_000), treatment: z.string().min(1) }),
});

export const quoteDestinationWireSchema: z.ZodType<QuoteDestinationWire> = z.object({
  /* No `/^[A-Z]{2}$/` here, on purpose: this field's whole job is to carry a code the server
   * could not resolve, and a schema that refused a malformed one would refuse the very payload
   * that reports it. `orders.destination_country`'s own CHECK is where shape is decided. */
  country: z.string().nullable(),
  recognised: z.boolean(),
  basis: z.literal(DESTINATION_TAX_BASES),
});

/**
 * ⚠️ `grandTotalMinor` is a digit string with an optional sign and is **not** `thb` / `Exact`.
 * Those carry `unit: 'THB.satang'`, and this is not baht — the unit is the destination
 * currency's minor unit, named by `currency` beside it. Reusing the baht shape would put a
 * `'THB.satang'` tag on an SGD figure, which is exactly the mislabelling `Exact` exists to make
 * impossible.
 */
export const quoteFxPreviewWireSchema: z.ZodType<QuoteFxPreviewWire> = z.object({
  available: z.boolean(),
  currency: z.string().regex(/^[A-Z]{3}$/u),
  grandTotalMinor: z.string().regex(/^-?\d+$/u).nullable(),
  rateText: z.string().min(1).nullable(),
  source: z.string().min(1).nullable(),
  observedAt: z.iso.datetime().nullable(),
  stale: z.boolean(),
  ageHours: z.number().nonnegative().nullable(),
  reason: z.string().min(1).nullable(),
});

export const quoteWireSchema: z.ZodType<QuoteWire> = z.object({
  orderId: z.uuid(),
  quoteRevision: z.string().regex(QUOTE_REVISION_PATTERN),
  currency: z.literal('THB'),
  destination: quoteDestinationWireSchema,
  lines: z.array(quoteLineWireSchema),
  money: quoteMoneyWireSchema,
  computedLeadTimeDays: z.int().min(0),
  effectiveLeadTimeDays: z.int().min(0),
  sales: z
    .object({
      overrides: z.array(quoteOverrideWireSchema),
      marginConcessionThbMinor: thb,
      baselineGrandTotalThbMinor: thb,
      staleBaselines: z.array(staleBaselineWireSchema),
      fxPreview: quoteFxPreviewWireSchema.nullable(),
    })
    .nullable(),
});
