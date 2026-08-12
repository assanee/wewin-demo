import { divRoundHalfUp, roundToUnit } from './money.js';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * A DISCOUNT BOX ONLY DISCOUNTS. One rule, one module, both sides of the wire.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ## Why this is a module and not a comment
 *
 * It was a comment. Twice, in opposite directions, each one describing the failure it was
 * meant to prevent and neither one able to prevent it:
 *
 *   `apps/api/src/quotes/entry.ts` — *"`percent_discount` and `discount_amount` both accept
 *   `'15%'` and `'-15%'` — a salesperson writes either and means the same thing"*. Magnitude.
 *
 *   `apps/dashboard/src/components/quotes/amounts.ts` — *"a discount field that silently took
 *   the magnitude would turn '−5' — a salesperson's shorthand for adding five percent — into a
 *   five percent giveaway"*. Sign as direction.
 *
 * Both were true statements about their own file, and together they were a money bug. On a
 * ฿8,791.00 line, `-5%` previewed **฿9,230.55** — a five percent surcharge — and stored
 * **฿8,351.00**, a five percent discount. ฿879.55 apart, silent, and against the company. The
 * salesperson was routed onto it by the server's own error text, which suggests `"-15%"`.
 *
 * So the rule is arithmetic that runs in one place and is imported by both, rather than prose
 * restated at each site. `grep -rn 'discountBp\|priceAfterPercentDiscount' apps` naming exactly
 * the two entry points is what makes that checkable rather than merely stated.
 *
 * ## The rule, and why this direction rather than the other
 *
 * **A magnitude is taken and an explicit `+` is refused.** `'5%'` and `'-5%'` are the same five
 * percent off; `'+5%'` is not a discount at all and is refused by name.
 *
 * The dashboard's reading — negative raises the price — lost on four counts:
 *
 *   * `packages/db/src/schema/quote.ts` uses `'-5%'` as its worked example of a **document
 *     discount**, and `packages/contract/src/quote.ts` uses `'-15%'` the same way. Those are
 *     the two files that describe what is stored.
 *   * raising a price already has two first-class routes — an absolute `line_total` or
 *     `grand_total`, and a new positive charge line. Plan 7.2's *"an edit after a factory bounce
 *     is usually more expensive"* is served by those. It never needed a discount box.
 *   * a surcharge entered as a negative discount reaches plan 7.13's `margin` dimension as a
 *     negative concession. `concession.ts` clamps it (`if (reduction <= 0n) continue`), so today
 *     it buys no headroom — but the clamp is the only thing standing between that entry and a
 *     ceiling that funds the next real discount, and a rule should not depend on a guard in a
 *     different module happening to hold.
 *   * `entered_value_text` is an audit trail. Every `'-15%'` already stored was written by a
 *     salesperson who got a discount and, on the server's reading, meant one. Flipping the
 *     server would silently reinterpret history; flipping the screen reinterprets nothing.
 *
 * ## What is deliberately *not* here
 *
 * Scanning text. The two sides read a keyboard differently and should: the server accepts Thai,
 * Hindi and Burmese numerals and validates comma placement (`@wewin/i18n`'s `asciiNumerals`),
 * while the screen is regex-first so that a half-typed box shows a Thai sentence rather than a
 * throw. What they must not disagree about is what the *sign* means and what the arithmetic
 * *produces*, and that is all this module holds.
 *
 * Prose, likewise. A refusal here is a reason code, and each edge renders it — the server as an
 * `EntryError` a route turns into a 422, the screen as the sentence under the box. One rule,
 * two voices.
 */

/**
 * The sign a person typed, kept apart from the digits.
 *
 * Three states and not a `boolean`, because an *absent* sign and an explicit `+` are different
 * events: `'5%'` is the ordinary way to write a discount and `'+5%'` is somebody asking for a
 * surcharge. A parser that collapsed them would have to guess.
 */
export type TypedSign = 'negative' | 'positive' | 'unsigned';

/** Why a typed discount is not usable. Rendered as prose by the caller, never here. */
export type DiscountRefusal = 'surcharge' | 'above_full';

/** A verdict carrying a reason code and no language. `R` widens for `normalisePercentEntry`. */
export type Ruled<T, R> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: R };

export type DiscountRule<T> = Ruled<T, DiscountRefusal>;

/** One hundred percent, in basis points. A discount at the ceiling is a free window. */
export const FULL_DISCOUNT_BP = 10_000n;

/**
 * THB presents on the whole baht — the same policy `pricing.ts` applies to every computed line.
 *
 * A percentage that produced ฿8,351.45 would be the only figure on the document carrying
 * satang. An *absolute* entry is not rounded, here or anywhere: ฿8,500.50 is what the human
 * promised and the system records promises rather than tidying them.
 */
const THB_PRESENTATION_MINOR = 100n;

/**
 * A percentage discount, in basis points, from a sign and a magnitude.
 *
 * `'-5%'` and `'5%'` both arrive as 500. `'+5%'` is refused, and that refusal is the whole
 * point of the module — see the header.
 */
export function discountBp(sign: TypedSign, magnitudeBp: bigint): DiscountRule<bigint> {
  if (sign === 'positive') return { ok: false, refusal: 'surcharge' };
  if (magnitudeBp > FULL_DISCOUNT_BP) return { ok: false, refusal: 'above_full' };

  return { ok: true, value: magnitudeBp };
}

/**
 * A discount written as money, in minor units, from a sign and a magnitude.
 *
 * `'-291'` and `'291'` both mean ฿291 off. No ceiling: whether ฿291 is more than the line costs
 * is a comparison against a baseline this function has not been given, and both callers make it
 * against their own.
 */
export function discountMinor(sign: TypedSign, magnitudeMinor: bigint): DiscountRule<bigint> {
  if (sign === 'positive') return { ok: false, refusal: 'surcharge' };

  return { ok: true, value: magnitudeMinor };
}

/**
 * The price after a percentage has come off it, on the whole baht.
 *
 * `divRoundHalfUp` and not `Math.round`, for the reason plan 7.9(ง)(4) records with a number:
 * `Math.round(-1432.5)` is −1432 because it rounds toward +Infinity, and half_up means −1433.
 *
 * ⚠️ **The rounding is part of the answer, not a presentation step the caller may skip.** A
 * preview that stopped at ฿8,351.45 while the write stored ฿8,351.00 is the same class of defect
 * as the sign, 45 satang wide — and it shipped alongside it, in a comment advertising
 * "฿8,351.45" as the figure the screen shows.
 */
export const priceAfterPercentDiscount = (computedMinor: bigint, bp: bigint): bigint =>
  roundToUnit(computedMinor - divRoundHalfUp(computedMinor * bp, FULL_DISCOUNT_BP), THB_PRESENTATION_MINOR);

/* ------------------------------------------------------------------ *
 * What a person types → the text the wire requires
 * ------------------------------------------------------------------ */

/**
 * A percentage in every shape a person types one: a bare number, a sign, a `%`, or both.
 *
 * `+` is *matched* rather than excluded, so that an explicit surcharge is refused with a reason
 * that names it. Left unmatched it failed as "not a percentage", which is a lie about what is
 * wrong with `+5`.
 */
const TYPED_PERCENT = /^([-+]?)(\d+(?:\.\d{1,2})?)$/;

export type PercentEntryRefusal = DiscountRefusal | 'empty' | 'unreadable' | 'no_change';

export interface PercentEntry {
  /** Basis points off. `5`, `-5`, `5%` and `-5%` all produce 500. */
  readonly bp: bigint;
  /**
   * The characters to put on the wire, which is **not always what was typed**.
   *
   * `apps/api/src/quotes/entry.ts` requires a literal `%` on a `percent_discount` — the guard
   * that stops `291` being read as 291 percent — and the dashboard's field renders the `%` as a
   * decoration rather than as text, so a salesperson who types `5` into a box captioned
   * ส่วนลด and showing `%` sends `5`, and the server refuses it. This is the appended `%`.
   *
   * ⚠️ **Nothing else is added.** A `-` is preserved because it was typed and a `+` never gets
   * here, but no sign is ever *invented*: the server reads `5%` and `-5%` identically, so
   * fabricating a minus would put a character into `entered_value_text` that the human did not
   * write, in the one column plan 7.9(ก) keeps as the record of what they actually said.
   */
  readonly wireText: string;
}

/**
 * The single reader of a typed percentage, for the preview **and** for the request.
 *
 * This is here rather than in the dialog for the reason the sign rule is: a second place that
 * knows how to read a percentage is the shape the original defect had. The screen calls it to
 * show a figure, and the text it hands back is what gets sent — so the number previewed and the
 * number the server normalises come from one parse of one string.
 */
export function normalisePercentEntry(typed: string): Ruled<PercentEntry, PercentEntryRefusal> {
  /* A `%` the person typed, with or without a space before it. The decoration is not text. */
  const trimmed = typed.trim().replace(/\s*%$/, '');
  if (trimmed === '') return { ok: false, refusal: 'empty' };

  const match = TYPED_PERCENT.exec(trimmed);
  if (match === null) return { ok: false, refusal: 'unreadable' };

  const [, sign = '', digits = '0'] = match;
  const [whole = '0', fraction = ''] = digits.split('.');
  const magnitude = BigInt(whole) * PERCENT_TO_BP + BigInt(fraction.padEnd(2, '0'));
  if (magnitude === 0n) return { ok: false, refusal: 'no_change' };

  const ruled = discountBp(sign === '-' ? 'negative' : sign === '+' ? 'positive' : 'unsigned', magnitude);
  if (!ruled.ok) return ruled;

  return { ok: true, value: { bp: ruled.value, wireText: `${sign}${digits}%` } };
}

/** Two decimal places of a *percent* is exactly one basis point, so `7.5%` is 750 bp. */
const PERCENT_TO_BP = 100n;
