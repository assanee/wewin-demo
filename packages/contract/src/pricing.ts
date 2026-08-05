import { z } from 'zod';
import { MAX_QTY, MIN_QTY } from '@wewin/core/constants';
import type { Currency } from '@wewin/core/money';
import type { LengthUnit } from '@wewin/core/units';
import { type PriceBreakdown, type PriceLine, sqUmToSqm } from '@wewin/core/pricing';
import type { Issue } from '@wewin/core/validation';
import type { OptionState, OptionStates } from '@wewin/core/option-states';
import {
  type MoneyWire,
  type ScaledMoneyWire,
  currencyOf,
  encodeMinor,
  encodeScaledMinor,
  moneyWireSchema,
  scaledMoneyWireSchema,
} from './money.js';
import {
  type AreaWire,
  type LengthWire,
  areaWireSchema,
  decodeSqUm,
  decodeUm,
  encodeSqUm,
  encodeUm,
  lengthUnitSchema,
  lengthWireSchema,
} from './measure.js';
import { type CatalogRef, catalogRefShape } from './catalog.js';
import {
  type MessageWire,
  encodeMessage,
  messageWireSchema,
  requireMessage,
} from './message.js';
import { toBigInt } from './exact.js';

/**
 * Pricing over HTTP.
 *
 * The request is what `Configure.tsx` already holds while the customer is typing —
 * selections, canonical measurements, the unit each was typed in, a quantity — plus
 * the handle to the document those controls were drawn from. The response is core's
 * `PriceBreakdown` with its money wrapped, the issues the configuration raises, and
 * the per-option states the swatch groups grey out with.
 */

/* ------------------------------------------------------------------ *
 * Breakdown
 * ------------------------------------------------------------------ */

export interface PriceLineWire {
  /**
   * What the row is called — a key and its values, never a sentence.
   *
   * It was `string`, and that was the boundary at which plan section 5 quietly stopped
   * being paid. Core emits `{ key, params }` and `apps/web` renders it in eight languages,
   * but only because the storefront prices locally from bundled fixtures; the moment it
   * asks the API for a price (plan 5.5 / 8.2, phase 6b) a `string` here would be a Thai
   * sentence again, chosen by the server before the reader's browser was consulted.
   */
  readonly label: MessageWire;
  readonly amountMinor: MoneyWire;
}

/**
 * A priced configuration.
 *
 * Core's `currency` field is not here, and its absence is the point: every amount
 * below already names its currency in its own unit tag, so a separate field could only
 * ever contradict them. `toPriceBreakdown` reads the currency off `totalMinor` — the
 * one figure plan 4.3(b) calls the number on the contract — and the schema refuses a
 * breakdown whose amounts do not all agree with it.
 *
 * The two areas travel **only** in their exact form, as square micrometres. Core keeps a
 * `number` alongside for a stored snapshot to survive JSON with, and putting both on the
 * wire would be two spellings of one quantity — which `exact.ts` already says is one
 * quantity that hashes two ways, and which phase 6a caught disagreeing on screen by a
 * hundredth of a square metre. `toPriceBreakdown` divides the exact value out again.
 */
export interface PriceBreakdownWire {
  readonly areaSqUm: AreaWire;
  readonly billableSqUm: AreaWire;
  readonly baseMinor: MoneyWire;
  readonly percentTotalMinor: MoneyWire;
  readonly perSqmTotalMinor: MoneyWire;
  readonly flatTotalMinor: MoneyWire;
  readonly unitPriceMinor: MoneyWire;
  readonly unitPriceScaledMinor: ScaledMoneyWire;
  readonly qty: number;
  readonly totalMinor: MoneyWire;
  readonly lines: readonly PriceLineWire[];
}

/**
 * The issue list, keyed.
 *
 * `messageTh` was carried here through phase 5 with a note saying it would change when
 * core did. Core changed; this is that change. The field is renamed as well as retyped on
 * purpose — a field whose name says Thai and whose value is a locale-free message is a lie
 * the next reader has to discover, which is the same reasoning `optionStates.ts` used when
 * it dropped its own `Th` suffixes.
 */
export interface IssueWire {
  readonly ruleId: string;
  readonly severity: 'error' | 'warning';
  readonly message: MessageWire;
  readonly affects: readonly string[];
}

export interface OptionStateWire {
  readonly blocked: boolean;
  readonly reason?: MessageWire | undefined;
  readonly warn?: MessageWire | undefined;
}

/** groupCode -> valueCode -> state */
export type OptionStatesWire = Readonly<Record<string, Readonly<Record<string, OptionStateWire>>>>;

/* ------------------------------------------------------------------ *
 * Request / response
 * ------------------------------------------------------------------ */

/**
 * Ask for a price.
 *
 * `productVersionId` and `documentHash` are inherited rather than optional. Plan 5
 * point 5: without them a customer who spends five minutes configuring while a new
 * version is published is priced against a document they never saw, and the server has
 * no way to notice. Making them part of the type is what stops an endpoint being added
 * that forgets to ask.
 */
export interface PriceRequestWire extends CatalogRef {
  readonly productId: string;
  readonly selections: Readonly<Record<string, string>>;
  /** Canonical micrometres, keyed by custom group code. */
  readonly measures: Readonly<Record<string, LengthWire>>;
  /**
   * The unit each measurement was typed in. Carried so the server judges the step
   * warning on the grid the customer was working to, never to re-snap a value
   * (plan 4.1).
   */
  readonly enteredUnits: Readonly<Record<string, LengthUnit>>;
  readonly qty: number;
}

export interface PriceRequest extends CatalogRef {
  readonly productId: string;
  readonly selections: Record<string, string>;
  readonly measures: Record<string, bigint>;
  readonly enteredUnits: Record<string, LengthUnit>;
  readonly qty: number;
}

/**
 * The answer, carrying the handle it was computed under.
 *
 * The ref goes back out because a 200 is also the moment to tell a client it is now
 * looking at a different document — after a 409 the client re-renders and the next
 * request must quote the new pair.
 */
export interface PriceResponseWire extends CatalogRef {
  readonly skuCode: string;
  readonly configHash: string;
  readonly price: PriceBreakdownWire;
  readonly issues: readonly IssueWire[];
  readonly optionStates: OptionStatesWire;
}

export interface PriceResponse extends CatalogRef {
  readonly skuCode: string;
  readonly configHash: string;
  readonly price: PriceBreakdown;
  readonly issues: Issue[];
  readonly optionStates: OptionStates;
}

/* ------------------------------------------------------------------ *
 * Schemas
 * ------------------------------------------------------------------ */

const anyMoney = moneyWireSchema();
const anyScaledMoney = scaledMoneyWireSchema();

const priceLineWireSchema: z.ZodType<PriceLineWire> = z.object({
  label: messageWireSchema,
  amountMinor: anyMoney,
});

export const priceBreakdownWireSchema: z.ZodType<PriceBreakdownWire> = z
  .object({
    areaSqUm: areaWireSchema,
    billableSqUm: areaWireSchema,
    baseMinor: anyMoney,
    percentTotalMinor: anyMoney,
    perSqmTotalMinor: anyMoney,
    flatTotalMinor: anyMoney,
    unitPriceMinor: anyMoney,
    unitPriceScaledMinor: anyScaledMoney,
    qty: z.number().int().min(MIN_QTY).max(MAX_QTY),
    totalMinor: anyMoney,
    lines: z.array(priceLineWireSchema),
  })
  .superRefine((wire, ctx) => {
    // Every figure in one breakdown has to be the same currency. Nothing downstream
    // re-checks it: `quoteTotal` sums `totalMinor` across lines with no currency in
    // sight (quote.ts:169), so a stray USD figure would be added to baht as if it
    // were satang.
    const expected = currencyOf(wire.totalMinor);
    const check = (
      amount: MoneyWire | ScaledMoneyWire,
      path: (string | number)[],
    ): void => {
      if (currencyOf(amount) !== expected) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: `breakdown is in ${expected} but this amount is in ${currencyOf(amount)}`,
        });
      }
    };

    check(wire.baseMinor, ['baseMinor']);
    check(wire.percentTotalMinor, ['percentTotalMinor']);
    check(wire.perSqmTotalMinor, ['perSqmTotalMinor']);
    check(wire.flatTotalMinor, ['flatTotalMinor']);
    check(wire.unitPriceMinor, ['unitPriceMinor']);
    check(wire.unitPriceScaledMinor, ['unitPriceScaledMinor']);
    wire.lines.forEach((line, index) => check(line.amountMinor, ['lines', index, 'amountMinor']));
  });

const issueWireSchema: z.ZodType<IssueWire> = z.object({
  ruleId: z.string().min(1),
  severity: z.literal(['error', 'warning']),
  message: messageWireSchema,
  affects: z.array(z.string()),
});

const optionStateWireSchema: z.ZodType<OptionStateWire> = z.object({
  blocked: z.boolean(),
  reason: messageWireSchema.optional(),
  warn: messageWireSchema.optional(),
});

const optionStatesWireSchema: z.ZodType<OptionStatesWire> = z.record(
  z.string(),
  z.record(z.string(), optionStateWireSchema),
);

export const priceRequestWireSchema: z.ZodType<PriceRequestWire> = z.object({
  ...catalogRefShape,
  productId: z.string().min(1),
  selections: z.record(z.string(), z.string()),
  measures: z.record(z.string(), lengthWireSchema),
  enteredUnits: z.record(z.string(), lengthUnitSchema),
  qty: z.number().int().min(MIN_QTY).max(MAX_QTY),
});

export const priceResponseWireSchema: z.ZodType<PriceResponseWire> = z.object({
  ...catalogRefShape,
  skuCode: z.string().min(1),
  configHash: z.string().regex(/^[0-9a-f]{16}$/, 'configHash must be 16 lowercase hex digits'),
  price: priceBreakdownWireSchema,
  issues: z.array(issueWireSchema),
  optionStates: optionStatesWireSchema,
});

/* ------------------------------------------------------------------ *
 * Encode
 * ------------------------------------------------------------------ */

const encodePriceLine = (line: PriceLine, currency: Currency): PriceLineWire => ({
  label: encodeMessage(line.label),
  amountMinor: encodeMinor(line.amountMinor, currency),
});

export function encodePriceBreakdown(price: PriceBreakdown): PriceBreakdownWire {
  const currency = price.currency;
  return {
    areaSqUm: encodeSqUm(price.areaSqUm),
    billableSqUm: encodeSqUm(price.billableSqUm),
    baseMinor: encodeMinor(price.baseMinor, currency),
    percentTotalMinor: encodeMinor(price.percentTotalMinor, currency),
    perSqmTotalMinor: encodeMinor(price.perSqmTotalMinor, currency),
    flatTotalMinor: encodeMinor(price.flatTotalMinor, currency),
    unitPriceMinor: encodeMinor(price.unitPriceMinor, currency),
    unitPriceScaledMinor: encodeScaledMinor(price.unitPriceScaledMinor, currency),
    qty: price.qty,
    totalMinor: encodeMinor(price.totalMinor, currency),
    lines: price.lines.map((line) => encodePriceLine(line, currency)),
  };
}

const encodeIssue = (issue: Issue): IssueWire => ({
  ruleId: issue.ruleId,
  severity: issue.severity,
  message: encodeMessage(issue.message),
  affects: [...issue.affects],
});

function encodeOptionState(state: OptionState): OptionStateWire {
  const wire: { -readonly [K in keyof OptionStateWire]: OptionStateWire[K] } = {
    blocked: state.blocked,
  };
  if (state.reason !== undefined) wire.reason = encodeMessage(state.reason);
  if (state.warn !== undefined) wire.warn = encodeMessage(state.warn);
  return wire;
}

function encodeOptionStates(states: OptionStates): OptionStatesWire {
  const wire: Record<string, Record<string, OptionStateWire>> = {};
  for (const [groupCode, values] of Object.entries(states)) {
    const group: Record<string, OptionStateWire> = {};
    for (const [valueCode, state] of Object.entries(values)) {
      group[valueCode] = encodeOptionState(state);
    }
    wire[groupCode] = group;
  }
  return wire;
}

export function encodePriceRequest(request: PriceRequest): PriceRequestWire {
  const measures: Record<string, LengthWire> = {};
  for (const [code, um] of Object.entries(request.measures)) measures[code] = encodeUm(um);

  return {
    productVersionId: request.productVersionId,
    documentHash: request.documentHash,
    productId: request.productId,
    selections: { ...request.selections },
    measures,
    enteredUnits: { ...request.enteredUnits },
    qty: request.qty,
  };
}

export const encodePriceResponse = (response: PriceResponse): PriceResponseWire => ({
  productVersionId: response.productVersionId,
  documentHash: response.documentHash,
  skuCode: response.skuCode,
  configHash: response.configHash,
  price: encodePriceBreakdown(response.price),
  issues: response.issues.map(encodeIssue),
  optionStates: encodeOptionStates(response.optionStates),
});

/* ------------------------------------------------------------------ *
 * Decode
 * ------------------------------------------------------------------ */

export function toPriceBreakdown(wire: PriceBreakdownWire): PriceBreakdown {
  const areaSqUm = decodeSqUm(wire.areaSqUm);
  const billableSqUm = decodeSqUm(wire.billableSqUm);

  return {
    // Derived here rather than carried, so the exact count and the number a person reads
    // cannot arrive disagreeing. `sqUmToSqm` is core's own single division out of canonical
    // area — this side of the wire does not get to invent a second one.
    areaSqm: sqUmToSqm(areaSqUm),
    billableSqm: sqUmToSqm(billableSqUm),
    areaSqUm,
    billableSqUm,
    currency: currencyOf(wire.totalMinor),
    baseMinor: toBigInt(wire.baseMinor),
    percentTotalMinor: toBigInt(wire.percentTotalMinor),
    perSqmTotalMinor: toBigInt(wire.perSqmTotalMinor),
    flatTotalMinor: toBigInt(wire.flatTotalMinor),
    unitPriceMinor: toBigInt(wire.unitPriceMinor),
    unitPriceScaledMinor: toBigInt(wire.unitPriceScaledMinor),
    qty: wire.qty,
    totalMinor: toBigInt(wire.totalMinor),
    lines: wire.lines.map((line) => ({
      label: requireMessage(line.label),
      amountMinor: toBigInt(line.amountMinor),
    })),
  };
}

const toIssue = (wire: IssueWire): Issue => ({
  ruleId: wire.ruleId,
  severity: wire.severity,
  message: requireMessage(wire.message),
  affects: [...wire.affects],
});

function toOptionStates(wire: OptionStatesWire): OptionStates {
  const states: OptionStates = {};
  for (const [groupCode, values] of Object.entries(wire)) {
    const group: Record<string, OptionState> = {};
    for (const [valueCode, state] of Object.entries(values)) {
      const decoded: OptionState = { blocked: state.blocked };
      if (state.reason !== undefined) decoded.reason = requireMessage(state.reason);
      if (state.warn !== undefined) decoded.warn = requireMessage(state.warn);
      group[valueCode] = decoded;
    }
    states[groupCode] = group;
  }
  return states;
}

export function toPriceRequest(wire: PriceRequestWire): PriceRequest {
  const measures: Record<string, bigint> = {};
  for (const [code, length] of Object.entries(wire.measures)) measures[code] = decodeUm(length);

  return {
    productVersionId: wire.productVersionId,
    documentHash: wire.documentHash,
    productId: wire.productId,
    selections: { ...wire.selections },
    measures,
    enteredUnits: { ...wire.enteredUnits },
    qty: wire.qty,
  };
}

export const toPriceResponse = (wire: PriceResponseWire): PriceResponse => ({
  productVersionId: wire.productVersionId,
  documentHash: wire.documentHash,
  skuCode: wire.skuCode,
  configHash: wire.configHash,
  price: toPriceBreakdown(wire.price),
  issues: wire.issues.map(toIssue),
  optionStates: toOptionStates(wire.optionStates),
});

/** Validate an untrusted payload and decode it in one step. Throws `ZodError` on shape. */
export const decodePriceRequest = (input: unknown): PriceRequest =>
  toPriceRequest(priceRequestWireSchema.parse(input));

export const decodePriceResponse = (input: unknown): PriceResponse =>
  toPriceResponse(priceResponseWireSchema.parse(input));
