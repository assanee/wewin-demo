import type { CustomGroup, Product, SkuGroup } from '../types/catalog';
import type { NumExpr, RuleExpr } from '../types/rule';
import { AREA_MEASURE_CODES, calcAreaSqm, measureOf } from './pricing';

export type Issue = {
  ruleId: string;
  severity: 'error' | 'warning';
  messageTh: string;
  affects: string[]; // groupCodes the UI should highlight
};

/** Tolerance for step arithmetic — 0.5 steps on a float measurement drift in the 1e-15 range. */
const EPSILON = 1e-9;

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
  measures: Record<string, number>;
  areaSqm: number;
}

export function evalNum(expr: NumExpr, scope: RuleScope): number {
  switch (expr.n) {
    case 'const':
      return expr.value;
    case 'measure':
      return measureOf(scope.product, scope.measures, expr.group);
    case 'area':
      return scope.areaSqm;
    case 'div': {
      const denominator = evalNum(expr.right, scope);
      // A zero denominator means the customer cleared the field. Report no ratio
      // violation for it; the range rule on that field is the actionable message.
      if (denominator === 0) return 0;
      return evalNum(expr.left, scope) / denominator;
    }
  }
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
    case 'gt':
      return evalNum(expr.left, scope) > evalNum(expr.right, scope);
    case 'lt':
      return evalNum(expr.left, scope) < evalNum(expr.right, scope);
    case 'gte':
      return evalNum(expr.left, scope) >= evalNum(expr.right, scope);
    case 'lte':
      return evalNum(expr.left, scope) <= evalNum(expr.right, scope);
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
    if (node.n === 'div') {
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
 * Round a measurement up to the next valid step and clamp it into range.
 * Spec section 6: off-step values snap *up* on blur, never down — a window
 * built slightly large can be trimmed on site, one built small cannot.
 */
export function snapToStep(group: CustomGroup, value: number): number {
  if (!Number.isFinite(value)) return group.defaultValue;

  const clamped = Math.min(Math.max(value, group.min), group.max);
  const steps = Math.ceil((clamped - group.min) / group.step - EPSILON);
  const snapped = group.min + steps * group.step;

  // Guard the case where snapping up would leave the range.
  const bounded = Math.min(snapped, group.max);

  // Re-round to the step's decimal precision so 0.5 steps do not accumulate float dust.
  const decimals = (String(group.step).split('.')[1] ?? '').length;
  return Number(bounded.toFixed(decimals));
}

const isOnStep = (group: CustomGroup, value: number): boolean => {
  const steps = (value - group.min) / group.step;
  return Math.abs(steps - Math.round(steps)) < EPSILON;
};

/* ------------------------------------------------------------------ *
 * validate
 * ------------------------------------------------------------------ */

/**
 * Collect every issue for a configuration. Pure — no React (spec section 6).
 *
 * Range and step issues are derived from CustomGroup min/max/step rather than
 * written into rules[], so a new product gets them for free.
 */
export function validate(
  product: Product,
  selections: Record<string, string>,
  measures: Record<string, number>,
): Issue[] {
  const issues: Issue[] = [];
  const scope: RuleScope = {
    product,
    selections,
    measures,
    areaSqm: calcAreaSqm(product, measures),
  };

  for (const group of customGroups(product)) {
    const value = measureOf(product, measures, group.code);

    if (value < group.min || value > group.max) {
      issues.push({
        ruleId: `range:${group.code}`,
        severity: 'error',
        messageTh: `${group.labelTh}ต้องอยู่ระหว่าง ${group.min}–${group.max} ${group.unit}`,
        affects: [group.code],
      });
      // Out of range already tells the customer what to fix; a step warning on the
      // same field on top of it is noise.
      continue;
    }

    if (!isOnStep(group, value)) {
      issues.push({
        ruleId: `step:${group.code}`,
        severity: 'warning',
        messageTh: `${group.labelTh}ปรับได้ทีละ ${group.step} ${group.unit} ระบบจะปัดเป็น ${snapToStep(group, value)} ${group.unit}`,
        affects: [group.code],
      });
    }
  }

  for (const rule of product.rules) {
    if (evalExpr(rule.when, scope)) {
      issues.push({
        ruleId: rule.id,
        severity: rule.severity,
        messageTh: rule.messageTh,
        affects: affectedGroups(rule.when),
      });
    }
  }

  return issues;
}

/** True when nothing blocks adding the configuration to the quote. */
export const hasBlockingError = (issues: Issue[]): boolean =>
  issues.some((issue) => issue.severity === 'error');
