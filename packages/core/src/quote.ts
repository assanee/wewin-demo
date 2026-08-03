import type { Product } from './types/catalog.js';
import { type PriceBreakdown, totalFromUnitPrice } from './pricing.js';
import type { Issue } from './validation.js';
import { MAX_QTY, MIN_QTY } from './constants.js';

/**
 * Quote state and its reducer. Pure — no React, no clock, no randomness.
 *
 * Ids and timestamps arrive in the action rather than being generated here, so the
 * reducer is deterministic and testable without stubbing `crypto` or `Date`.
 */

export interface QuoteLine {
  lineId: string;
  productId: string;
  /** Customer's own label, e.g. "หน้าต่างห้องนอน 1". Defaults to the product name. */
  nickname: string;
  skuCode: string;
  selections: Record<string, string>;
  measures: Record<string, number>;
  qty: number;
  /** Price locked at the moment the line was added — material prices move, quotes do not. */
  priceSnapshot: PriceBreakdown;
  configHash: string;
  addedAt: string;
  /**
   * Non-blocking issues carried along with the line. Spec section 6: warnings must
   * travel with the quote so the sales team sees them when issuing it.
   */
  warnings: Issue[];
}

export interface QuoteState {
  lines: QuoteLine[];
  /**
   * True once localStorage has been read into this state.
   *
   * Lives here rather than in a ref because the persistence effect must read it
   * from the same object it is about to write. With a ref, both mount effects run
   * in one commit: the hydrate effect sets the flag and dispatches, then the
   * persist effect runs against the *stale* empty state, sees the flag set, and
   * overwrites storage with an empty quote — which StrictMode's second mount then
   * reads back as the real thing.
   */
  hydrated: boolean;
}

export type QuoteAction =
  | { type: 'hydrate'; lines: QuoteLine[] }
  | { type: 'add'; line: QuoteLine }
  | { type: 'update'; lineId: string; line: QuoteLine }
  | { type: 'setQty'; lineId: string; qty: number }
  | { type: 'remove'; lineId: string }
  | { type: 'duplicate'; lineId: string; newLineId: string; addedAt: string }
  | { type: 'clear' };

export const emptyQuote = (): QuoteState => ({ lines: [], hydrated: false });

/**
 * Recompute the total for a new quantity from the *locked* unit price.
 *
 * Deliberately does not call calcPrice again: that would read today's prices and
 * quietly undo the snapshot. Rounding stays at the last step so a large quantity
 * cannot accumulate per-unit error.
 */
export function repriceForQty(snapshot: PriceBreakdown, qty: number): PriceBreakdown {
  return { ...snapshot, qty, totalMinor: totalFromUnitPrice(snapshot.unitPriceScaledMinor, qty) };
}

const clampQty = (qty: number): number =>
  Math.min(Math.max(Math.round(qty), MIN_QTY), MAX_QTY);

const withQty = (line: QuoteLine, qty: number): QuoteLine => ({
  ...line,
  qty,
  priceSnapshot: repriceForQty(line.priceSnapshot, qty),
});

export function quoteReducer(state: QuoteState, action: QuoteAction): QuoteState {
  switch (action.type) {
    case 'hydrate':
      return { lines: action.lines, hydrated: true };

    case 'add': {
      // Same sku_code and same measurements is the same window (spec section 3),
      // so adding it again means "one more of these", not a second row.
      const existingIndex = state.lines.findIndex(
        (line) => line.configHash === action.line.configHash && line.productId === action.line.productId,
      );

      if (existingIndex === -1) return { ...state, lines: [...state.lines, action.line] };

      const existing = state.lines[existingIndex];
      if (!existing) return { ...state, lines: [...state.lines, action.line] };

      const merged = withQty(existing, clampQty(existing.qty + action.line.qty));
      const lines = [...state.lines];
      lines[existingIndex] = merged;
      return { ...state, lines };
    }

    case 'update':
      return {
        ...state,
        lines: state.lines.map((line) => (line.lineId === action.lineId ? action.line : line)),
      };

    case 'setQty': {
      if (!Number.isFinite(action.qty)) return state;

      return {
        ...state,
        lines: state.lines.map((line) =>
          line.lineId === action.lineId ? withQty(line, clampQty(action.qty)) : line,
        ),
      };
    }

    case 'remove':
      return { ...state, lines: state.lines.filter((line) => line.lineId !== action.lineId) };

    case 'duplicate': {
      const index = state.lines.findIndex((line) => line.lineId === action.lineId);
      const source = state.lines[index];
      if (!source) return state;

      // Bypasses the add-merge on purpose. The use case is five same-shaped windows
      // at different sizes: duplicate, then edit. Merging here would delete the copy
      // before the customer could change it.
      const copy: QuoteLine = { ...source, lineId: action.newLineId, addedAt: action.addedAt };
      const lines = [...state.lines];
      lines.splice(index + 1, 0, copy);
      return { ...state, lines };
    }

    case 'clear':
      // Keeps `hydrated` — the quote is empty because it was emptied, not because
      // it has not loaded yet, and persistence must still record that.
      return { ...state, lines: [] };
  }
}

/* ------------------------------------------------------------------ *
 * Selectors
 * ------------------------------------------------------------------ */

export const quoteTotal = (lines: QuoteLine[]): bigint =>
  lines.reduce((sum, line) => sum + line.priceSnapshot.totalMinor, 0n);

/** Pieces, not rows — three windows on one line is three windows. */
export const quoteItemCount = (lines: QuoteLine[]): number =>
  lines.reduce((sum, line) => sum + line.qty, 0);

/**
 * The slowest line in the quote, because the job is delivered as one.
 * A line whose product has since left the catalog is skipped rather than throwing.
 */
export function longestLeadTime(
  lines: QuoteLine[],
  lookup: (productId: string) => Product | undefined,
): [number, number] | null {
  let longest: [number, number] | null = null;

  for (const line of lines) {
    const product = lookup(line.productId);
    if (!product) continue;

    if (!longest || product.leadTimeDays[1] > longest[1]) longest = product.leadTimeDays;
  }

  return longest;
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

/**
 * Bumped from v1 in the same change that made money a `bigint`.
 *
 * Plan 4.5 is explicit that this must move together with the representation: a v1
 * entry holds `total: 8791` meaning baht, and a v2 entry holds `totalMinor: "879100"`
 * meaning satang. Reading one as the other is a hundredfold error that renders as a
 * plausible price. Old carts are dropped rather than migrated — a lost cart can be
 * rebuilt in a minute, a wrong price cannot be noticed at all.
 */
export const QUOTE_STORAGE_KEY = 'aluform.quote.v2';

/**
 * Written into the payload itself, not only into the key.
 *
 * A payload outlives its key more often than it looks: a restored backup, a profile
 * sync, localStorage copied between builds. Both of the representation changes this
 * codebase has made — baht to satang, and centimetres to micrometres next — keep the
 * same field names and the same JSON shape while changing what the numbers mean, so a
 * mismatched payload renders as a plausible price or a plausible size rather than as a
 * crash. The version has to travel with the data.
 */
export const QUOTE_SCHEMA_VERSION = 2;

/** `JSON.stringify` throws on a bigint, so money crosses the storage boundary as digits. */
const replacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;

export const serialiseQuote = (state: QuoteState): string =>
  JSON.stringify({ schemaVersion: QUOTE_SCHEMA_VERSION, lines: state.lines }, replacer);

/** Accepts only a string of digits — `BigInt("")` is 0n and `BigInt(" 1 ")` is 1n. */
function readMinor(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return null;
  return BigInt(value);
}

const isQuoteLine = (value: unknown): value is QuoteLine => {
  if (typeof value !== 'object' || value === null) return false;
  const line = value as Partial<QuoteLine>;

  return (
    typeof line.lineId === 'string' &&
    typeof line.productId === 'string' &&
    typeof line.nickname === 'string' &&
    typeof line.skuCode === 'string' &&
    typeof line.configHash === 'string' &&
    typeof line.addedAt === 'string' &&
    typeof line.qty === 'number' &&
    Number.isFinite(line.qty) &&
    typeof line.selections === 'object' &&
    line.selections !== null &&
    typeof line.measures === 'object' &&
    line.measures !== null &&
    typeof line.priceSnapshot === 'object' &&
    line.priceSnapshot !== null &&
    typeof line.priceSnapshot.totalMinor === 'bigint' &&
    typeof line.priceSnapshot.unitPriceScaledMinor === 'bigint' &&
    Array.isArray(line.warnings)
  );
};

/** Money fields on a stored snapshot, revived from their digit strings. */
const MONEY_FIELDS = [
  'baseMinor',
  'percentTotalMinor',
  'perSqmTotalMinor',
  'flatTotalMinor',
  'unitPriceMinor',
  'unitPriceScaledMinor',
  'totalMinor',
] as const;

function reviveSnapshot(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const snapshot = { ...(value as Record<string, unknown>) };

  for (const field of MONEY_FIELDS) {
    const minor = readMinor(snapshot[field]);
    if (minor === null) return value; // leave it broken; isQuoteLine drops the line
    snapshot[field] = minor;
  }

  if (Array.isArray(snapshot.lines)) {
    snapshot.lines = snapshot.lines.map((row: unknown) => {
      if (typeof row !== 'object' || row === null) return row;
      const amountMinor = readMinor((row as { amountMinor?: unknown }).amountMinor);
      return amountMinor === null ? row : { ...row, amountMinor };
    });
  }

  return snapshot;
}

/**
 * Read the quote back out of storage.
 *
 * localStorage is shared with every past and future build of this app, so its
 * contents are untrusted input. Anything unreadable is discarded — a stale or
 * half-written entry must cost at most the lines it corrupted, never the boot.
 */
export function parseStoredQuote(raw: string | null): QuoteLine[] {
  if (!raw) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return [];

    const { lines, schemaVersion } = parsed as { lines?: unknown; schemaVersion?: unknown };
    // Whole payload, not line by line: a version mismatch means every number in it was
    // written under different rules, so salvaging part of it salvages the wrong part.
    if (schemaVersion !== QUOTE_SCHEMA_VERSION) return [];
    if (!Array.isArray(lines)) return [];

    return lines
      .map((line: unknown) =>
        typeof line === 'object' && line !== null
          ? { ...line, priceSnapshot: reviveSnapshot((line as { priceSnapshot?: unknown }).priceSnapshot) }
          : line,
      )
      .filter(isQuoteLine);
  } catch {
    return [];
  }
}
