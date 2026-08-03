/**
 * Terse constructors for the RuleExpr AST, so rules in `products.ts` stay readable.
 *
 *   and(selected('glass_thickness', 'LAM'), gt(measure('width'), lengthCm(200)))
 *
 * reads about as well as the string form the spec sketched, but a misspelled group
 * code is a compile error rather than a runtime surprise.
 *
 * There is deliberately no constructor for a bare number. A threshold is written in
 * the unit whoever wrote the rule was thinking in — `lengthCm(200)`, `areaSqm(8)` —
 * and the conversion to canonical micrometres happens here, once, at build time.
 */

import type { Dimension, NumExpr, RuleExpr } from '../types/rule.js';
import { sqmToSqUm, toMicrons } from '../units.js';

const constant = (value: bigint, dim: Dimension): NumExpr => ({ n: 'const', value, dim });

/** A length threshold written in centimetres, the unit the catalogue is authored in. */
export const lengthCm = (cm: number): NumExpr => constant(toMicrons(cm, 'cm'), 'length');

/** An area threshold written in square metres, the unit a price list quotes. */
export const areaSqm = (sqm: number): NumExpr => constant(sqmToSqUm(sqm), 'area');

/** A dimensionless multiplier, e.g. the 3 in a 3:1 aspect ratio. */
export const scalar = (value: number): NumExpr => constant(BigInt(value), 'scalar');

export const measure = (group: string): NumExpr => ({ n: 'measure', group });
export const area = (): NumExpr => ({ n: 'area' });
export const mul = (left: NumExpr, right: NumExpr): NumExpr => ({ n: 'mul', left, right });

export const gt = (left: NumExpr, right: NumExpr): RuleExpr => ({ op: 'gt', left, right });
export const lt = (left: NumExpr, right: NumExpr): RuleExpr => ({ op: 'lt', left, right });
export const gte = (left: NumExpr, right: NumExpr): RuleExpr => ({ op: 'gte', left, right });
export const lte = (left: NumExpr, right: NumExpr): RuleExpr => ({ op: 'lte', left, right });

export const selected = (group: string, value: string): RuleExpr => ({
  op: 'selected',
  group,
  value,
});

export const and = (...all: RuleExpr[]): RuleExpr => ({ op: 'and', all });
export const or = (...any: RuleExpr[]): RuleExpr => ({ op: 'or', any });
export const not = (expr: RuleExpr): RuleExpr => ({ op: 'not', expr });
