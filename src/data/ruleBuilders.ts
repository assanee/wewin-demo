/**
 * Terse constructors for the RuleExpr AST, so rules in `products.ts` stay readable.
 *
 *   and(selected('glass_thickness', 'LAM'), gt(measure('width'), 200))
 *
 * reads about as well as the string form the spec sketched, but a misspelled group
 * code is a compile error rather than a runtime surprise.
 */

import type { NumExpr, RuleExpr } from '../types/rule';

export const num = (value: number): NumExpr => ({ n: 'const', value });
export const measure = (group: string): NumExpr => ({ n: 'measure', group });
export const area = (): NumExpr => ({ n: 'area' });
export const div = (left: NumExpr, right: NumExpr): NumExpr => ({ n: 'div', left, right });

/** Coerce bare numbers on the right-hand side of a comparison. */
const term = (value: NumExpr | number): NumExpr => (typeof value === 'number' ? num(value) : value);

export const gt = (left: NumExpr, right: NumExpr | number): RuleExpr => ({
  op: 'gt',
  left,
  right: term(right),
});

export const lt = (left: NumExpr, right: NumExpr | number): RuleExpr => ({
  op: 'lt',
  left,
  right: term(right),
});

export const gte = (left: NumExpr, right: NumExpr | number): RuleExpr => ({
  op: 'gte',
  left,
  right: term(right),
});

export const lte = (left: NumExpr, right: NumExpr | number): RuleExpr => ({
  op: 'lte',
  left,
  right: term(right),
});

export const selected = (group: string, value: string): RuleExpr => ({
  op: 'selected',
  group,
  value,
});

export const and = (...all: RuleExpr[]): RuleExpr => ({ op: 'and', all });
export const or = (...any: RuleExpr[]): RuleExpr => ({ op: 'or', any });
export const not = (expr: RuleExpr): RuleExpr => ({ op: 'not', expr });
