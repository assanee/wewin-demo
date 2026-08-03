import { z } from 'zod';
import { MAX_QTY, MIN_QTY } from '@wewin/core/constants';
import type { Currency } from '@wewin/core/money';
import type { LengthUnit } from '@wewin/core/units';
import type { PriceBreakdown, PriceLine } from '@wewin/core/pricing';
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
  type LengthWire,
  decodeUm,
  encodeUm,
  lengthUnitSchema,
  lengthWireSchema,
} from './measure.js';
import { type CatalogRef, catalogRefShape } from './catalog.js';
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
  readonly label: string;
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
 * `areaSqm` and `billableSqm` stay plain JSON numbers, as they are plain numbers in
 * core: they are the area divided out for a person to read and nothing may multiply
 * them back up (pricing.ts:47-57).
 */
export interface PriceBreakdownWire {
  readonly areaSqm: number;
  readonly billableSqm: number;
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
 * The issue list, unchanged.
 *
 * Plan 5 requires `Issue` to stop being a sentence and become `{ key, params }`, and
 * that change belongs to core — `validation.ts:263` builds the string, and moving it
 * touches `optionStates`, the quote reducer, two components and their tests. Carrying
 * `messageTh` here now means this DTO changes when core does, which is the honest
 * position: inventing the keyed form in the contract first would leave the API
 * translating between two shapes of the same idea.
 */
export interface IssueWire {
  readonly ruleId: string;
  readonly severity: 'error' | 'warning';
  readonly messageTh: string;
  readonly affects: readonly string[];
}

export interface OptionStateWire {
  readonly blocked: boolean;
  readonly reasonTh?: string | undefined;
  readonly warnTh?: string | undefined;
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
  label: z.string(),
  amountMinor: anyMoney,
});

export const priceBreakdownWireSchema: z.ZodType<PriceBreakdownWire> = z
  .object({
    areaSqm: z.number().finite().nonnegative(),
    billableSqm: z.number().finite().nonnegative(),
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
  messageTh: z.string(),
  affects: z.array(z.string()),
});

const optionStateWireSchema: z.ZodType<OptionStateWire> = z.object({
  blocked: z.boolean(),
  reasonTh: z.string().optional(),
  warnTh: z.string().optional(),
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
  label: line.label,
  amountMinor: encodeMinor(line.amountMinor, currency),
});

export function encodePriceBreakdown(price: PriceBreakdown): PriceBreakdownWire {
  const currency = price.currency;
  return {
    areaSqm: price.areaSqm,
    billableSqm: price.billableSqm,
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
  messageTh: issue.messageTh,
  affects: [...issue.affects],
});

function encodeOptionState(state: OptionState): OptionStateWire {
  const wire: { -readonly [K in keyof OptionStateWire]: OptionStateWire[K] } = {
    blocked: state.blocked,
  };
  if (state.reasonTh !== undefined) wire.reasonTh = state.reasonTh;
  if (state.warnTh !== undefined) wire.warnTh = state.warnTh;
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
  return {
    areaSqm: wire.areaSqm,
    billableSqm: wire.billableSqm,
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
      label: line.label,
      amountMinor: toBigInt(line.amountMinor),
    })),
  };
}

const toIssue = (wire: IssueWire): Issue => ({
  ruleId: wire.ruleId,
  severity: wire.severity,
  messageTh: wire.messageTh,
  affects: [...wire.affects],
});

function toOptionStates(wire: OptionStatesWire): OptionStates {
  const states: OptionStates = {};
  for (const [groupCode, values] of Object.entries(wire)) {
    const group: Record<string, OptionState> = {};
    for (const [valueCode, state] of Object.entries(values)) {
      const decoded: OptionState = { blocked: state.blocked };
      if (state.reasonTh !== undefined) decoded.reasonTh = state.reasonTh;
      if (state.warnTh !== undefined) decoded.warnTh = state.warnTh;
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
