/**
 * Rule predicate AST.
 *
 * Spec section 6 offered two shapes: an expression string evaluated through the
 * `Function` constructor, or a discriminated union. We took the union because:
 *
 *   1. `strict: true` with no `any` cannot type-check a string expression at all —
 *      a typo like `widht > 200` only surfaces as a runtime ReferenceError, and only
 *      once a customer happens to select the combination that triggers that rule.
 *   2. zod can validate the union structurally at boot (spec section 9 wants
 *      `schema.ts` to catch typos in mock data). A string is just a string to zod.
 *   3. The `Function` constructor is dynamic code generation. It needs a hand-rolled
 *      scope whitelist to stay safe, and that whitelist has to be kept in sync with
 *      every product's group codes by hand.
 *
 * The union's only real cost is verbosity in `products.ts`, which the builder
 * helpers in `src/data/ruleBuilders.ts` remove.
 */

/** A numeric term a rule can compare. Recursive so `width / height` needs no special case. */
export type NumExpr =
  | { n: 'const'; value: number }
  /** Value of a `CustomGroup` measurement, e.g. `width`. */
  | { n: 'measure'; group: string }
  /** Derived: (width * height) / 10000, in square metres. */
  | { n: 'area' }
  | { n: 'div'; left: NumExpr; right: NumExpr };

export type RuleExpr =
  | { op: 'gt'; left: NumExpr; right: NumExpr }
  | { op: 'lt'; left: NumExpr; right: NumExpr }
  | { op: 'gte'; left: NumExpr; right: NumExpr }
  | { op: 'lte'; left: NumExpr; right: NumExpr }
  /** True when `group`'s current selection equals `value`. */
  | { op: 'selected'; group: string; value: string }
  | { op: 'and'; all: RuleExpr[] }
  | { op: 'or'; any: RuleExpr[] }
  | { op: 'not'; expr: RuleExpr };
