import { quoteWireSchema } from '@wewin/contract/quote';
import type { LengthWire, MoneyWire } from '@wewin/contract';
import type { QuoteWire } from '@wewin/contract/quote';

import { flatMinorOf, umOf } from '@/components/products/wire';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BOUNDARY. Where a quote stops being JSON and starts being figures.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ### The shapes are the contract's, not this folder's
 *
 * `@wewin/contract/quote` is the one definition of what a quote looks like on the wire, and
 * it is the same module apps/api validates its own responses against. Everything here is
 * either an import from it or a decode through its schema — there is no hand-rolled narrowing
 * in this file and there must not be one, because a second reading of the same payload is how
 * a dashboard renders a field the API stopped sending.
 *
 * ### Nothing money-shaped leaves this app. At all.
 *
 * There is no encoder in this file, and that absence is the strongest statement this folder
 * makes about plan 7.9. A human-set price travels as **the characters the human typed**
 * (`enteredValueText`) plus the box they typed it into (`enteredAs`), and the server does
 * every piece of arithmetic against a baseline it computed itself. The contract's own header
 * says why that reading of "the api never accepts a number from a client" is the one that
 * survives a feature whose whole purpose is a person setting a number:
 *
 *     a client that wanted to forge a concession would have to forge the *baseline*,
 *     and there is no field on any request that carries one.
 *
 * `override-entry.ts` still does the arithmetic — but only to show a person what their typing
 * will become, and its header is explicit that the preview is not the record.
 *
 * ### Reading is routed through `products/wire.ts`, on purpose
 *
 * That file's header claims to be the *single* file in this app that calls `toBigInt`/`unitOf`,
 * and says the claim is what makes the arrangement checkable:
 * `grep -rn 'toBigInt\|unitOf' src/` names one file. Opening `Exact` a second time here would
 * quietly make that header false. So the two functions this folder needs are routed through
 * it and renamed for this domain — `flatMinorOf` is `MoneyWire<'THB'> → satang`, and the name
 * comes from the surcharge it was written for rather than from the arithmetic, which is the
 * same.
 */

export type {
  OverrideAnchorWire,
  OverrideEntryModeWire,
  OverrideReasonWire,
  /**
   * ⭐ The indicative destination-currency figure. `null` for every domestic quotation.
   *
   * Re-exported like every other shape here rather than imported from the contract at the one
   * component that renders it: this file's header is that the shapes are the contract's and that
   * there is no second reading of the same payload anywhere in the folder. `fx-preview.ts` and
   * `totals-card.tsx` both need the type, and two import paths for one interface is how a folder
   * ends up with two of them.
   */
  QuoteFxPreviewWire,
  QuoteLineKindWire,
  QuoteLineWire,
  QuoteMoneyWire,
  QuoteOverrideWire,
  QuoteSalesViewWire,
  QuoteWire,
  StaleBaselineKindWire,
  StaleBaselineWire,
} from '@wewin/contract/quote';

export {
  ENTRY_MODES_BY_ANCHOR,
  OVERRIDE_ANCHORS_WIRE,
  OVERRIDE_ENTRY_MODES_WIRE,
  OVERRIDE_REASONS_WIRE,
} from '@wewin/contract/quote';

/**
 * Satang, out of a THB amount. The one way a money figure becomes arithmetic in this folder.
 *
 * Named for the domain rather than reused under `flatMinorOf`, because
 * `flatMinorOf(line.effectiveTotalThbMinor)` reads like a surcharge and this is a line total.
 */
export const thbMinorOf = (wire: MoneyWire<'THB'>): bigint => flatMinorOf(wire);

/** Canonical micrometres, out of a measure. Same routing, same reason. */
export const measureUmOf = (wire: LengthWire): bigint => umOf(wire);

/**
 * The quote, checked rather than assumed.
 *
 * `apiJson` takes a decoder as a required argument precisely so this is not a cast: the
 * response crossed a network from a service versioned separately from this bundle, and a
 * renamed field has to become a message at the boundary rather than `undefined` three
 * components deep.
 */
export const decodeQuote = (body: unknown): QuoteWire => quoteWireSchema.parse(body);
