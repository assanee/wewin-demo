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

/**
 * What a numeric term measures.
 *
 * A rule constant is a bare integer, and once lengths are micrometres a bare integer
 * is ambiguous in the worst possible way: `gt(measure('width'), 200)` reads as "wider
 * than 200 cm" and evaluates as "wider than 0.2 mm", which is true for every window
 * in the catalogue. The dimension is what makes that a rejected expression rather
 * than a rule that fires always.
 */
export type Dimension = 'length' | 'area' | 'scalar';

/** A numeric term a rule can compare. Recursive so `3 × height` needs no special case. */
export type NumExpr =
  /** Micrometres for `length`, square micrometres for `area`, a plain count for `scalar`. */
  | { n: 'const'; value: bigint; dim: Dimension }
  /** Value of a `CustomGroup` measurement in micrometres, e.g. `width`. */
  | { n: 'measure'; group: string }
  /** Derived: width × height, in square micrometres. */
  | { n: 'area' }
  /**
   * Product of two terms.
   *
   * This is where `div` used to be, and the swap is not cosmetic. Integer division
   * truncates: `4805000n / 1600000n` is `3n`, so `(w/h) > 3` went quiet for every
   * aspect ratio in [3, 4) — an error-severity rule silently passing unbuildable
   * windows. Written as the cross-multiplication `w > 3·h` the same comparison is
   * exact, and it was verified equivalent to the float form over all 259,461 grid
   * points before the swap was made.
   */
  | { n: 'mul'; left: NumExpr; right: NumExpr };

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
