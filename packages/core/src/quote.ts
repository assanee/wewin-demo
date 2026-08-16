import type { Product } from './types/catalog.js';
import { isMessage, reviveMessage } from './message.js';
import { type PriceBreakdown, totalFromUnitPrice } from './pricing.js';
import { type Issue, isIssue, reviveIssue } from './validation.js';
import { MAX_QTY, MIN_QTY } from './constants.js';
import { isLengthUnit, type LengthUnit } from './units.js';

/**
 * Quote state and its reducer. Pure — no React, no clock, no randomness.
 *
 * Ids and timestamps arrive in the action rather than being generated here, so the
 * reducer is deterministic and testable without stubbing `crypto` or `Date`.
 */

export interface QuoteLine {
  lineId: string;
  productId: string;
  /**
   * ⭐ The product's slug, because the configurator route is keyed by slug and this line
   * has to be able to get back there.
   *
   * ⛔ Optional, and only because lines already sitting in a customer's `localStorage` were
   * written before this field existed. A missing one falls back to `productId`, which is
   * correct for every seeded product — `data/products.ts` builds them with `id: row.slug` —
   * and is the best guess available for anything else.
   *
   * ⚠️ That coincidence is exactly what broke. `configureHref` relied on it and said so in
   * its own comment: *"if ids ever stop being slugs, this is the call site that breaks, and
   * it breaks as a 404"*. Products created in the dashboard set id and slug independently,
   * so a customer who added one to their cart could not reopen it.
   *
   * ⚠️ The fallback no longer 404s: the storefront route resolves a product **id** as well
   * as a slug, precisely so links of that shape — old cart lines, bookmarks — keep working.
   * This field is still what makes the URL canonical rather than merely resolvable.
   */
  productSlug?: string;
  /** Customer's own label, e.g. "หน้าต่างห้องนอน 1". Defaults to the product name. */
  nickname: string;
  skuCode: string;
  selections: Record<string, string>;
  /** Canonical micrometres, keyed by custom group code. */
  measures: Record<string, bigint>;
  /**
   * The unit each measurement was typed in, keyed the same way.
   *
   * A sibling of `measures` rather than a field inside it, because a value in
   * `measures` is interpolated straight into the config hash and an object there
   * would stringify to `[object Object]` — two different windows, one hash.
   *
   * It is deliberately *not* part of the hash: 320 cm, 3200 mm and 3.2 m are one
   * window and must merge into one line. This exists so that reopening a line
   * offers the customer the field back in the unit they measured in, and so the
   * step warning is phrased on the grid they were working to.
   */
  enteredUnits: Record<string, LengthUnit>;
  qty: number;
  /** Price locked at the moment the line was added — material prices move, quotes do not. */
  priceSnapshot: PriceBreakdown;
  /**
   * ⭐ The product's lead time, locked with the price and for the same reason.
   *
   * ⛔ It used to be read out of the compiled catalogue at render time, which silently
   * skipped any product the bundle does not contain — every product created in the
   * dashboard. A cart holding only those showed **no lead time at all**, and a mixed cart
   * showed the longest of the *seeded* ones, which understates the wait. A quote that
   * promises 14–21 days for an item that takes 20–30 is a promise the workshop cannot keep.
   *
   * ⚠️ Optional for lines already in a customer's `localStorage`; `longestLeadTime` falls
   * back to the lookup for those, which is exactly the old behaviour and no worse.
   */
  leadTimeDays?: [number, number];
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

      // Built from `existing`, so the row keeps its own nickname, its locked price and
      // its `enteredUnits`. That last one is a decision, not a side effect: the hash
      // that brought the two rows together deliberately ignores units — 320 cm and
      // 3200 mm are one window — so the merge has a genuine choice to make, and the
      // row the customer already named and measured is the one that keeps speaking.
      // Taking the incoming units would rewrite a line the customer never edited,
      // which is the same class of surprise as re-snapping on a unit switch.
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
    /*
     * ⛔ The line's own snapshot first, and the catalogue only as a fallback. The lookup is
     * fixture-backed, so a product created in the dashboard is not in it — reading through
     * the lookup alone silently dropped those lines and understated the wait.
     */
    const leadTimeDays = line.leadTimeDays ?? lookup(line.productId)?.leadTimeDays;
    if (!leadTimeDays) continue;

    if (!longest || leadTimeDays[1] > longest[1]) longest = leadTimeDays;
  }

  return longest;
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

/**
 * Bumped from v2 in the same change that made lengths micrometres.
 *
 * Plan 4.5 is explicit that this must move together with the representation, and it
 * has now had to twice: a v1 entry held `total: 8791` meaning baht, a v2 entry held
 * `totalMinor: "879100"` meaning satang, and a v3 entry holds `measures.width:
 * "3200000"` where v2 held `320`. Every one of those reads as a plausible number
 * under the wrong rules rather than as a crash.
 *
 * v2 is dropped, not migrated. Not because the unit is ambiguous — it is not, every
 * v2 group hardcoded `unit: 'cm'` — but because `unitPriceScaledMinor` changed scale
 * by a factor of 10^6 in the same commit, and a migration is a thing somebody has to
 * keep correct forever. A lost cart can be rebuilt in a minute.
 *
 * v3 → v4 is the structured-message change. It is easy to read as cosmetic and it is
 * not: a v3 entry held `lines[0].label: "ราคาฐานตามพื้นที่"` and `warnings[0].messageTh`,
 * both plain strings with nothing in them to misread. A v4 entry holds a square
 * micrometre count inside the label and micrometres inside a warning's params, and both
 * cross `JSON.stringify` as digit strings. A v3 payload read under v4 rules loses every
 * label and every warning; read leniently it would keep them as strings that a renderer
 * would interpolate verbatim. Same rule as before: the version travels with the data.
 */
export const QUOTE_STORAGE_KEY = 'aluform.quote.v4';

/**
 * Written into the payload itself, not only into the key.
 *
 * A payload outlives its key more often than it looks: a restored backup, a profile
 * sync, localStorage copied between builds. Both of the representation changes this
 * codebase has made — baht to satang, and centimetres to micrometres — keep the same
 * field names and the same JSON shape while changing what the numbers mean, so a
 * mismatched payload renders as a plausible price or a plausible size rather than as a
 * crash. The version has to travel with the data.
 */
export const QUOTE_SCHEMA_VERSION = 4;

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

/**
 * An object whose every value passes `isMember`.
 *
 * Arrays are excluded rather than merely unexpected: an empty one satisfies "every
 * value is a bigint" vacuously, so `measures: []` would otherwise be accepted and
 * price as the group defaults — a real window at a size nobody chose.
 */
const isRecordOf = (value: unknown, isMember: (member: unknown) => boolean): boolean =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every(isMember);

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
    // Every measurement, not just the container. A `measures` that survived as
    // `{width: "320"}` would price as the group default and read as a real window;
    // `reviveMeasures` leaves exactly that shape behind when it cannot convert.
    isRecordOf(line.measures, (measure) => typeof measure === 'bigint') &&
    isRecordOf(line.enteredUnits, isLengthUnit) &&
    typeof line.priceSnapshot === 'object' &&
    line.priceSnapshot !== null &&
    typeof line.priceSnapshot.totalMinor === 'bigint' &&
    typeof line.priceSnapshot.unitPriceScaledMinor === 'bigint' &&
    // The exact areas, checked the way the money is. They are what every area on the
    // screen is now rendered from, and one that came back as `"5120000000000"` would
    // reach `formatSqmExact` as a string and multiply by 100n into concatenation.
    typeof line.priceSnapshot.areaSqUm === 'bigint' &&
    typeof line.priceSnapshot.billableSqUm === 'bigint' &&
    // Reaches inside the breakdown, the way the `measures` check does. A row's label
    // stopped being a string in v4 and now carries a square micrometre count; one that
    // came back as `"5128000000000"` would render as digits in a sentence.
    Array.isArray(line.priceSnapshot.lines) &&
    line.priceSnapshot.lines.every(
      (row: unknown) =>
        typeof row === 'object' &&
        row !== null &&
        typeof (row as { amountMinor?: unknown }).amountMinor === 'bigint' &&
        isMessage((row as { label?: unknown }).label),
    ) &&
    // Was `Array.isArray(line.warnings)` and nothing more, which was enough while a
    // warning was a sentence. A warning carries micrometres now.
    Array.isArray(line.warnings) &&
    line.warnings.every(isIssue)
  );
};

/**
 * Exact-integer fields on a stored snapshot, revived from their digit strings.
 *
 * Money and area in one list, because `readMinor` does not care what is being counted —
 * it accepts canonical digits and returns a `bigint`. Keeping two lists would mean two
 * places to forget a field, and forgetting one is not a crash: it is a string reaching a
 * formatter that will happily concatenate it.
 */
const EXACT_FIELDS = [
  'baseMinor',
  'percentTotalMinor',
  'perSqmTotalMinor',
  'flatTotalMinor',
  'unitPriceMinor',
  'unitPriceScaledMinor',
  'totalMinor',
  'areaSqUm',
  'billableSqUm',
] as const;

function reviveSnapshot(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const snapshot = { ...(value as Record<string, unknown>) };

  for (const field of EXACT_FIELDS) {
    const minor = readMinor(snapshot[field]);
    if (minor === null) return value; // leave it broken; isQuoteLine drops the line
    snapshot[field] = minor;
  }

  if (Array.isArray(snapshot.lines)) {
    snapshot.lines = snapshot.lines.map((row: unknown) => {
      if (typeof row !== 'object' || row === null) return row;

      // Two fields, revived independently, and neither one judged here — a field that
      // will not convert is left exactly as storage held it and `isQuoteLine` refuses
      // the line. Coupling them would make the money check stand in for the label
      // check by accident, which is a guard with no evidence behind it: the label is
      // a `Message` now and its params hold integers, so a row can arrive with sound
      // money and a label that is still a v3 sentence.
      const revived: Record<string, unknown> = { ...row };

      const amountMinor = readMinor((row as { amountMinor?: unknown }).amountMinor);
      if (amountMinor !== null) revived.amountMinor = amountMinor;

      const label = reviveMessage((row as { label?: unknown }).label);
      if (label !== null) revived.label = label;

      return revived;
    });
  }

  return snapshot;
}

/**
 * Warnings, revived the way the breakdown rows are.
 *
 * A single unrevivable warning leaves the array as it was found rather than dropping
 * that one entry: warnings travel with a quote so the sales team sees them when issuing
 * it (spec section 6), and a line that quietly arrives with one fewer caveat than it was
 * saved with is worse than a line that fails to load.
 */
function reviveWarnings(value: unknown): unknown {
  if (!Array.isArray(value)) return value;

  const revived: Issue[] = [];
  for (const entry of value) {
    const issue = reviveIssue(entry);
    if (issue === null) return value;
    revived.push(issue);
  }

  return revived;
}

/**
 * Measurements, revived from their digit strings the way money is.
 *
 * A single unconvertible entry leaves the whole map as it was found rather than
 * reviving the rest: a half-revived `measures` is a window with one real dimension
 * and one that falls back to a default, which is the shape that prices plausibly
 * and wrongly. `isQuoteLine` then drops the line.
 */
function reviveMeasures(value: unknown): unknown {
  // An array is not a measures map, and an empty one would otherwise revive into an
  // empty object and pass every check that follows — a line that prices from the
  // group defaults and shows a size nobody entered.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;

  const revived: Record<string, bigint> = {};
  for (const [code, raw] of Object.entries(value)) {
    const um = readMinor(raw);
    if (um === null) return value;
    revived[code] = um;
  }

  return revived;
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
      .map((line: unknown) => {
        if (typeof line !== 'object' || line === null) return line;
        const stored = line as {
          priceSnapshot?: unknown;
          measures?: unknown;
          warnings?: unknown;
        };

        return {
          ...line,
          priceSnapshot: reviveSnapshot(stored.priceSnapshot),
          measures: reviveMeasures(stored.measures),
          warnings: reviveWarnings(stored.warnings),
        };
      })
      .filter(isQuoteLine);
  } catch {
    return [];
  }
}
