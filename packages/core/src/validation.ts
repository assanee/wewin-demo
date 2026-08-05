import type { CustomGroup, Product, SkuGroup } from './types/catalog.js';
import type { Dimension, NumExpr, RuleExpr } from './types/rule.js';
import { AREA_MEASURE_CODES, calcAreaSqUm, measureOf } from './pricing.js';
import {
  groupLabel,
  isMessage,
  lengthParam,
  lengthRangeParam,
  type Message,
  reviveMessage,
  ruleMessage,
} from './message.js';
import { resolveSelection } from './selection.js';
import { gridUmFor, isOnGridUm, type LengthUnit, snapUpUm } from './units.js';

export type IssueSeverity = 'error' | 'warning';

/**
 * Something wrong with a configuration, said in a way eight languages can render.
 *
 * `messageTh` was a Thai sentence this file *built* — see the module comment in
 * `message.ts` for why that had to stop. `message` is a key plus values now; nothing in
 * this file formats a number or concatenates a clause, and it no longer imports
 * `format.ts` at all.
 *
 * The message is nested rather than spread onto `Issue` so that the same `Message`
 * value serves an issue, an option tooltip and a price breakdown row unchanged, and one
 * validator and one reviver cover all three.
 */
export type Issue = {
  ruleId: string;
  severity: IssueSeverity;
  message: Message;
  affects: string[]; // groupCodes the UI should highlight
};

const isSeverity = (value: unknown): value is IssueSeverity =>
  value === 'error' || value === 'warning';

/**
 * True when `value` is a sound `Issue`.
 *
 * Needed because an `Issue` is now persisted with numbers inside it: a quote line
 * carries its warnings to storage, and a warning that came back with `um: "3200000"`
 * would interpolate as a string rather than a length. Before this change a stored
 * warning was a sentence and there was nothing in it to get wrong.
 */
export function isIssue(value: unknown): value is Issue {
  if (typeof value !== 'object' || value === null) return false;
  const issue = value as Partial<Issue>;

  return (
    typeof issue.ruleId === 'string' &&
    isSeverity(issue.severity) &&
    Array.isArray(issue.affects) &&
    issue.affects.every((code) => typeof code === 'string') &&
    isMessage(issue.message)
  );
}

/** Read an `Issue` back out of JSON, restoring the micrometres its params carry. */
export function reviveIssue(value: unknown): Issue | null {
  if (typeof value !== 'object' || value === null) return null;
  const stored = value as { message?: unknown };

  const message = reviveMessage(stored.message);
  if (message === null) return null;

  const revived: unknown = { ...value, message };
  return isIssue(revived) ? revived : null;
}

const customGroups = (product: Product): CustomGroup[] =>
  product.groups.filter((group): group is CustomGroup => group.kind === 'custom');

const skuGroups = (product: Product): SkuGroup[] =>
  product.groups.filter((group): group is SkuGroup => group.kind === 'sku');

/* ------------------------------------------------------------------ *
 * Expression evaluation
 * ------------------------------------------------------------------ */

/** Scope a rule can read: the measurements, the derived area, and every sku selection. */
export interface RuleScope {
  product: Product;
  selections: Record<string, string>;
  measures: Record<string, bigint>;
  areaSqUm: bigint;
}

/**
 * What a term measures, or `null` when it multiplies quantities that have no product.
 *
 * The algebra is the whole point of `Dimension`: scalar × anything keeps the other
 * side's dimension, length × length is an area, and there is nothing sensible to do
 * with area × length in a window catalogue — so it is rejected rather than guessed.
 */
export function numDimension(expr: NumExpr): Dimension | null {
  switch (expr.n) {
    case 'const':
      return expr.dim;
    case 'measure':
      return 'length';
    case 'area':
      return 'area';
    case 'mul': {
      const left = numDimension(expr.left);
      const right = numDimension(expr.right);
      if (left === null || right === null) return null;
      if (left === 'scalar') return right;
      if (right === 'scalar') return left;
      return left === 'length' && right === 'length' ? 'area' : null;
    }
  }
}

/** Micrometres, square micrometres, or a bare count — read `numDimension` to know which. */
export function evalNum(expr: NumExpr, scope: RuleScope): bigint {
  switch (expr.n) {
    case 'const':
      return expr.value;
    case 'measure':
      return measureOf(scope.product, scope.measures, expr.group);
    case 'area':
      return scope.areaSqUm;
    case 'mul':
      return evalNum(expr.left, scope) * evalNum(expr.right, scope);
  }
}

/**
 * Both sides of a comparison, once it is established they measure the same thing.
 *
 * Throws rather than returning false on a mismatch. `schema.ts` refuses to boot on a
 * dimensionally inconsistent rule, so the catalogue can never reach this — the throw
 * is here for an expression built by hand, where "the rule quietly never fires" is
 * the failure that costs a customer a window and a silent `false` would deliver it.
 */
function comparands(left: NumExpr, right: NumExpr, scope: RuleScope): [bigint, bigint] {
  const leftDim = numDimension(left);
  if (leftDim === null || leftDim !== numDimension(right)) {
    throw new TypeError(
      `rule compares ${String(leftDim)} against ${String(numDimension(right))}`,
    );
  }

  return [evalNum(left, scope), evalNum(right, scope)];
}

/**
 * Resolve what a sku group is currently set to, falling back to its default —
 * the default is what the configurator renders before the customer touches it,
 * so rules must see the same value the screen shows.
 */
export function selectionOf(scope: RuleScope, groupCode: string): string | undefined {
  const explicit = scope.selections[groupCode];
  if (explicit !== undefined) return explicit;

  return skuGroups(scope.product).find((group) => group.code === groupCode)?.defaultValue;
}

/**
 * Evaluate a rule predicate. True means the condition is met and the issue fires.
 *
 * Two things this deliberately does *not* guard against, because `schema.ts` rejects
 * them at boot rather than letting them reach here:
 *
 *   - An empty `and: []` would be vacuously true and fire on every configuration.
 *     `ruleExprSchema` requires `.min(1)`, so the app refuses to start instead.
 *   - A `selected` on a group the product does not have would silently never match.
 *     `productSchema` cross-checks every referenced group code against the product.
 *
 * Catching those at boot beats a runtime fallback: a fallback keeps a broken rule
 * quietly inert, while a boot failure puts it in front of whoever edited the data.
 *
 * The switch is exhaustive on purpose — adding an op to RuleExpr without handling it
 * here becomes a compile error rather than a rule that never fires.
 */
export function evalExpr(expr: RuleExpr, scope: RuleScope): boolean {
  switch (expr.op) {
    case 'gt': {
      const [left, right] = comparands(expr.left, expr.right, scope);
      return left > right;
    }
    case 'lt': {
      const [left, right] = comparands(expr.left, expr.right, scope);
      return left < right;
    }
    case 'gte': {
      const [left, right] = comparands(expr.left, expr.right, scope);
      return left >= right;
    }
    case 'lte': {
      const [left, right] = comparands(expr.left, expr.right, scope);
      return left <= right;
    }
    case 'selected':
      return selectionOf(scope, expr.group) === expr.value;
    case 'and':
      return expr.all.every((child) => evalExpr(child, scope));
    case 'or':
      return expr.any.some((child) => evalExpr(child, scope));
    case 'not':
      return !evalExpr(expr.expr, scope);
  }
}

/** Group codes a rule reads, so the UI knows which controls to mark. */
export function affectedGroups(expr: RuleExpr): string[] {
  const found = new Set<string>();

  const walkNum = (node: NumExpr): void => {
    if (node.n === 'measure') found.add(node.group);
    // `area` reads no group directly, but a complaint about the area is a complaint
    // about the two measurements it is computed from — without this the dimension
    // lines and the number inputs stay unmarked while the size is unbuildable.
    if (node.n === 'area') for (const code of AREA_MEASURE_CODES) found.add(code);
    if (node.n === 'mul') {
      walkNum(node.left);
      walkNum(node.right);
    }
  };

  const walk = (node: RuleExpr): void => {
    switch (node.op) {
      case 'gt':
      case 'lt':
      case 'gte':
      case 'lte':
        walkNum(node.left);
        walkNum(node.right);
        break;
      case 'selected':
        found.add(node.group);
        break;
      case 'and':
        node.all.forEach(walk);
        break;
      case 'or':
        node.any.forEach(walk);
        break;
      case 'not':
        walk(node.expr);
        break;
    }
  };

  walk(expr);
  return [...found];
}

/* ------------------------------------------------------------------ *
 * Step snapping
 * ------------------------------------------------------------------ */

/**
 * The grid this group's measurement snaps to when typed in `unit`.
 *
 * Anchored at absolute zero, not at `group.min`. Every authored bound is a whole
 * number of centimetres and so a multiple of the 5 mm step, which makes the two
 * anchors identical on the metric grid — and fixes the imperial one for free:
 * 600,000 µm is not a multiple of 3,175, so anchoring at `min` turned a typed
 * 24 in into 24.122 in.
 */
export const gridFor = (group: CustomGroup, unit: LengthUnit): bigint =>
  gridUmFor(unit, group.stepUm);

/**
 * Round a measurement up to the next valid step.
 *
 * Spec section 6: off-step values snap *up*, never down — a window built slightly
 * large can be trimmed on site, one built small is scrap. Notably it does **not**
 * clamp to `group.maxUm`: the old `Math.min(snapped, group.max)` was a snap *down*
 * wearing a guard's clothes, and at the top of an imperial range it fired for real —
 * 4,000,000 µm is not on the eighth grid (3,175 × 1,260 = 4,000,500), so someone
 * typing 157.5 in got a window 500 µm shorter without being told. Overshooting the
 * maximum is an error `validate` reports, not something to silently absorb here.
 */
export const snapToStep = (group: CustomGroup, valueUm: bigint, unit: LengthUnit): bigint =>
  snapUpUm(valueUm, gridFor(group, unit));

const isOnStep = (group: CustomGroup, valueUm: bigint, unit: LengthUnit): boolean =>
  isOnGridUm(valueUm, gridFor(group, unit));

/* ------------------------------------------------------------------ *
 * validate
 * ------------------------------------------------------------------ */

/**
 * Collect every issue for a configuration. Pure — no React (spec section 6).
 *
 * Range and step issues are derived from CustomGroup min/max/step rather than
 * written into rules[], so a new product gets them for free.
 *
 * `enteredUnits` decides which grid each field is judged against, and therefore what
 * the messages are phrased in. A field the customer has not typed into falls back to
 * the unit the catalogue was authored in, which is what the input is showing.
 */
export function validate(
  product: Product,
  selections: Record<string, string>,
  measures: Record<string, bigint>,
  enteredUnits: Record<string, LengthUnit> = {},
): Issue[] {
  const issues: Issue[] = [];
  const scope: RuleScope = {
    product,
    selections,
    measures,
    areaSqUm: calcAreaSqUm(product, measures),
  };

  /*
   * A selection that names nothing this product offers — the hole that made a lower-case
   * option code a 12,840-baht discount.
   *
   * `resolveSelection` falls the price and the SKU back to the group default together, so
   * nothing diverges any more; what it cannot do is decide whether the customer meant the
   * default. Only the customer knows that, so it is an `error` and not a `warning`:
   * `hasBlockingError` is what the configurator's "add to quote" button and the API's
   * submit both read, and this is precisely the case where continuing would put a window
   * on a contract that nobody chose.
   *
   * Deliberately *not* reported: a key in `selections` that names no group at all. Stored
   * carts and share links from an older catalogue carry those, they contribute to nothing,
   * and refusing the whole configuration over a leftover key would strand a customer with
   * an error they cannot clear.
   */
  for (const group of skuGroups(product)) {
    if (selections[group.code] === undefined) continue;
    if (resolveSelection(group, selections).recognised) continue;

    issues.push({
      ruleId: `selection:${group.code}`,
      severity: 'error',
      message: {
        key: 'issue.selection.unknown',
        params: { group: groupLabel(product, group) },
      },
      affects: [group.code],
    });
  }

  for (const group of customGroups(product)) {
    const value = measureOf(product, measures, group.code);
    const unit = enteredUnits[group.code] ?? group.unit;

    if (value < group.minUm || value > group.maxUm) {
      issues.push({
        ruleId: `range:${group.code}`,
        severity: 'error',
        message: {
          key: 'issue.range.outOfRange',
          params: {
            group: groupLabel(product, group),
            range: lengthRangeParam(group.minUm, group.maxUm, unit),
          },
        },
        affects: [group.code],
      });
      // Out of range already tells the customer what to fix; a step warning on the
      // same field on top of it is noise.
      continue;
    }

    if (isOnStep(group, value, unit)) continue;

    const snapped = snapToStep(group, value, unit);

    // In range but with nowhere to go: the next mark on this grid is past the
    // maximum. Snapping down to fit is the one thing that must not happen, so this
    // is an error the customer resolves, not a warning the app resolves for them.
    //
    // The message names the largest mark that does fit rather than the maximum
    // itself. Both are reachable only when the grid is imperial and the maximum is
    // not on it, and in that case the maximum *renders* as the mark just above it —
    // "the next value, 157 1/2", is over the 157 1/2" maximum" is a sentence nobody
    // can act on. The value below is for the message and goes nowhere near `measures`.
    //
    // Two outcomes, two keys. The Thai version glued one of two advice clauses onto a
    // shared stem, which only works in a language where the stem happens to come
    // first; each of these is now a whole sentence in the target language.
    if (snapped > group.maxUm) {
      const grid = gridFor(group, unit);
      const largestOnGrid = group.maxUm - (group.maxUm % grid);

      issues.push({
        ruleId: `step:${group.code}`,
        severity: 'error',
        message:
          largestOnGrid >= group.minUm
            ? {
                key: 'issue.step.aboveLargestMark',
                params: {
                  group: groupLabel(product, group),
                  step: lengthParam(grid, unit),
                  largest: lengthParam(largestOnGrid, unit),
                },
              }
            : {
                key: 'issue.step.noMarkInRange',
                params: {
                  group: groupLabel(product, group),
                  step: lengthParam(grid, unit),
                  range: lengthRangeParam(group.minUm, group.maxUm, unit),
                },
              },
        affects: [group.code],
      });
      continue;
    }

    issues.push({
      ruleId: `step:${group.code}`,
      severity: 'warning',
      message: {
        key: 'issue.step.willSnapUp',
        params: {
          group: groupLabel(product, group),
          step: lengthParam(gridFor(group, unit), unit),
          snapped: lengthParam(snapped, unit),
        },
      },
      affects: [group.code],
    });
  }

  for (const rule of product.rules) {
    if (evalExpr(rule.when, scope)) {
      issues.push({
        ruleId: rule.id,
        severity: rule.severity,
        // The sentence stays the catalogue's, addressable by `ref` so a translated
        // catalogue can replace it. Core does not own this text and never will:
        // 81 products × 8 languages is a person's job (plan section 13).
        message: { key: 'issue.rule', params: { message: ruleMessage(product, rule) } },
        affects: affectedGroups(rule.when),
      });
    }
  }

  return issues;
}

/** True when nothing blocks adding the configuration to the quote. */
export const hasBlockingError = (issues: Issue[]): boolean =>
  issues.some((issue) => issue.severity === 'error');
