import { divRoundHalfUp, readSatang, roundToUnit } from './money.js';

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
 * restated at each site. `grep -rn '@wewin/core/discount' apps` naming every place a discount is
 * read — two in the dashboard, one in the api — is what makes that checkable rather than stated.
 *
 * ## The rule, and why this direction rather than the other
 *
 * **A magnitude is taken and an explicit `+` is refused.** `'5%'` and `'-5%'` are the same five
 * percent off; `'+5%'` is not a discount at all and is refused by name.
 *
 * ⚠️ **That is the rule for text already on the wire, which is a laxer thing than what a person may
 * type.** `discountBp` and `discountMinor` below are what `apps/api` applies to a stored or
 * submitted `entered_value_text`, and they stay lenient on purpose: rows written before the screen
 * tightened say `'-15%'`, and a guard that only holds when the client is well-behaved is no guard.
 *
 * What a *person* may type is `normalisePercentEntry` and `normaliseAmountEntry` at the foot of this
 * file, and **both accept exactly one spelling — a plain positive number.** The owner's instruction
 * was *"ถ้าใส่ผิดให้ขึ้นแดงเลยจะได้กรอกรูปแบบเดียว ไม่งงด้วย"*: somebody who types `-291` believes they
 * are asking for something different from somebody who types `291`, so making both mean ฿291 off
 * left one of the two uncorrected. They share `screenTypedDiscount`, which is the only reason that
 * sentence will still be true of both fields a year from now.
 *
 * The two layers disagree in the safe direction: the screen refuses strictly more than the server
 * does, so nothing the screen accepts can surprise it.
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
 * ⚠️ **ONE ACCEPTED SPELLING: a plain positive number.** No sign, no `%`, no inner spaces.
 *
 * This regex used to be `^([-+]?)(\d+(?:\.\d{1,2})?)$` and five spellings of five percent all
 * worked. That was built deliberately and then removed deliberately, on the owner's instruction:
 * *"ถ้าใส่ผิดให้ขึ้นแดงเลยจะได้กรอกรูปแบบเดียว ไม่งงด้วย"* — five accepted spellings are five things
 * a salesperson might believe about what they typed, and one visible refusal beats five silent
 * interpretations. The field already draws a `%` beside itself and the caption already says ส่วนลด,
 * so a typed `%` and a typed sign are both duplicates of what is on the screen.
 *
 * Outer whitespace is still trimmed, because a paste carries it and the contract's
 * `enteredValueTextSchema` trims too; a space *inside* the number is a refusal.
 *
 * ⚠️ **This being sign-free is deliberate redundancy and a mutation test survives on it.** The
 * explicit `startsWith('-')` check below fires first, so loosening this back to `[-+]?\d+` changes
 * no observable behaviour and no test fails — the two guards each reject a sign on their own, and
 * only breaking *both* lets `-5` through. That is the right trade for a money field, but it is
 * recorded here rather than discovered: the explicit check exists to produce the `signed` reason
 * code and the *message*, and this exists so the check is not the only thing standing between a
 * minus and an accepted discount.
 */
const TYPED_PERCENT = /^\d+(?:\.\d{1,2})?$/;

/**
 * What every discount field refuses **before its own unit's grammar is consulted**.
 *
 * `signed` and `unit_typed` are separate codes rather than one `unreadable`, because the point of
 * refusing them is to teach the format: "drop the minus" and "drop the ฿" are different
 * instructions, and a single "invalid" would leave the person guessing at which.
 */
export type TypedDiscountRefusal = 'empty' | 'signed' | 'unit_typed';

/**
 * ⭐ The three refusals both discount fields share, in one function.
 *
 * The percentage box and the money box have genuinely different *grammars* — a percentage with
 * thousands separators is nonsense and its ceiling is 100, while an amount groups digits and has no
 * ceiling of its own — so they are not forced through one parser. What they must never disagree
 * about is the **shape**: a discount field takes a bare positive number, and a sign or a unit symbol
 * is a refusal that says so.
 *
 * That is this function, and it is the whole of the sharing. Two near-copies of these three checks
 * is how the money box would drift away from the percentage box the first time either was touched —
 * and drift between two readers of a typed discount is the defect this module exists because of.
 *
 * @param unit the symbol the field already draws beside itself: `%` or `฿`.
 */
export function screenTypedDiscount(typed: string, unit: string): Ruled<string, TypedDiscountRefusal> {
  const trimmed = typed.trim();
  if (trimmed === '') return { ok: false, refusal: 'empty' };

  /*
   * The sign is named before the unit because on `-฿291` it is the more dangerous of the two: a
   * minus in a discount box is the character this module was written for. `+` and `-` are one
   * refusal because the instruction is the same — the caption gives the direction, so neither
   * belongs in the box.
   */
  if (trimmed.startsWith('-') || trimmed.startsWith('+')) return { ok: false, refusal: 'signed' };
  if (trimmed.includes(unit)) return { ok: false, refusal: 'unit_typed' };

  return { ok: true, value: trimmed };
}

/** Why a typed percentage is not usable. */
export type PercentEntryRefusal = DiscountRefusal | TypedDiscountRefusal | 'unreadable' | 'no_change';

/** Why a typed money discount is not usable. It has no ceiling of its own — see the function. */
export type AmountEntryRefusal = TypedDiscountRefusal | 'unreadable' | 'no_change';

export interface PercentEntry {
  /** Basis points off. `5`, `-5`, `5%` and `-5%` all produce 500. */
  readonly bp: bigint;
  /**
   * The characters to put on the wire: what was typed, plus the `%` the field only drew.
   *
   * `apps/api/src/quotes/entry.ts` requires a literal `%` on a `percent_discount` — the guard
   * that stops `291` being read as 291 percent — and the dashboard's field renders the `%` as a
   * decoration rather than as text, so a salesperson who types `5` into a box captioned
   * ส่วนลด and showing `%` sends `5`, and the server refuses it. This is that `%`.
   *
   * ⚠️ **The `%` is the only addition, and now it is the only one possible.** No sign is invented:
   * `entered_value_text` is plan 7.9(ก)'s record of what the human said, not a place for
   * characters they did not type. With one accepted format that argument no longer needs making —
   * there is nothing left to normalise away, so `wireText` is the typed digits verbatim and a `%`.
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
  const screened = screenTypedDiscount(typed, '%');
  if (!screened.ok) return screened;

  const trimmed = screened.value;
  if (!TYPED_PERCENT.test(trimmed)) return { ok: false, refusal: 'unreadable' };

  const [whole = '0', fraction = ''] = trimmed.split('.');
  const magnitude = BigInt(whole) * PERCENT_TO_BP + BigInt(fraction.padEnd(2, '0'));
  if (magnitude === 0n) return { ok: false, refusal: 'no_change' };

  /*
   * `'unsigned'` is the only sign that can reach here, so the ceiling is the only refusal
   * `discountBp` can still produce. It is called rather than re-checked because the 100% ceiling
   * belongs to the rule — three copies of that number is what the first round removed.
   */
  const ruled = discountBp('unsigned', magnitude);
  if (!ruled.ok) return ruled;

  return { ok: true, value: { bp: ruled.value, wireText: `${trimmed}%` } };
}

/** Two decimal places of a *percent* is exactly one basis point, so `7.5%` is 750 bp. */
const PERCENT_TO_BP = 100n;

export interface AmountEntry {
  /** Satang **off** the baseline. */
  readonly minor: bigint;
  /**
   * The characters to put on the wire — here, exactly what was typed.
   *
   * ⭐ **Nothing is appended.** The percentage field has to add the `%` its box only draws, because
   * the server's `percent_discount` guard requires a literal one. A money discount needs no such
   * decoration: `apps/api`'s `magnitude()` reads `291` as ฿291 off already. So this field's
   * `entered_value_text` is what the salesperson typed, character for character — the strongest
   * form of plan 7.9(ก)'s record, and better than the percentage field can manage.
   */
  readonly wireText: string;
}

/**
 * A discount typed as money: satang off, from one accepted spelling.
 *
 * **The grammar is `readSatang`'s and not a new one.** That function's `AMOUNT` regex is already
 * exactly what is wanted here — optional thousands separators, at most two decimal places, and no
 * sign — and its header already argues the case this field needs: *"a minus is a typo here and not a
 * credit — refused with a sentence rather than sent and 422'd"*. `amounts.ts`'s `readBaht` keeps its
 * own leniency for the absolute-price boxes, where a pasted `฿8,500` is not a mistake; a discount
 * box has one format, so it screens the `฿` out by name first and then hands the digits over.
 *
 * ⚠️ **No ceiling here.** Whether ฿291 is more than the line costs is a comparison against a
 * baseline this function has not been given, and `override-entry.ts`'s `preview` already refuses a
 * discount that drives the price below zero — with `readBaht`'s own reasoning about why a negative
 * price is not a price. Restating it here would be a second answer to one question.
 */
export function normaliseAmountEntry(typed: string): Ruled<AmountEntry, AmountEntryRefusal> {
  const screened = screenTypedDiscount(typed, '฿');
  if (!screened.ok) return screened;

  const trimmed = screened.value;
  const parsed = readSatang(trimmed);
  if (!parsed.ok) return { ok: false, refusal: 'unreadable' };
  if (parsed.value === 0n) return { ok: false, refusal: 'no_change' };

  return { ok: true, value: { minor: parsed.value, wireText: trimmed } };
}
