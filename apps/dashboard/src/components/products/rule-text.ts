import type { AuthoredUnit } from '@wewin/core';
import { formatLength } from '@wewin/core/format';
import type { NumExprWire, ProductWire, RuleExprWire } from '@wewin/contract';

import { sqm } from './quantities';
import { constOf } from './wire';

/**
 * A rule condition, in Thai, read out of the AST rather than out of a stored sentence.
 *
 * Plan section 5 makes a point of this in the other direction: `Issue` had to stop being a
 * built string because `validation.ts` was *composing* prose from a group's label and
 * bounds, which cannot be translated. The same argument applies to a screen that has to
 * show what a rule tests. Storing a human description beside `when` would give the
 * dashboard two things that can disagree, and the one somebody reads would be the one that
 * is wrong. So the sentence is derived, every time, from the expression the pricer will
 * actually evaluate.
 *
 * ### What this deliberately is not
 *
 * It is not an editor. There is no parser here turning Thai back into a `RuleExprWire`, and
 * the screens that use this render it read-only beside the rule's own `messageTh` — which
 * *is* editable, because that string is what a customer sees and this one is a description
 * of machinery. Authoring a condition needs an expression builder, which is a screen of its
 * own and is not in this phase.
 *
 * ### Units
 *
 * A constant carries its dimension on the wire (`um`, `um2`, `count`) and not its display
 * unit, so one has to be chosen. The choice is taken from whichever side of the comparison
 * is a measurement — a rule about a group authored in millimetres reads in millimetres —
 * and falls back to centimetres, which is what 46 of the 48 authored bounds use. A length
 * shown in the wrong metric unit is still exact (`formatLength` is bigint throughout); it
 * just reads as an unfamiliar figure, which is why the unit is always printed beside it.
 */

export interface RuleTextContext {
  /** The compiled draft or published document the rule belongs to. */
  readonly product: ProductWire;
}

const OPERATORS: Record<'gt' | 'lt' | 'gte' | 'lte', string> = {
  gt: 'มากกว่า',
  lt: 'น้อยกว่า',
  gte: 'ไม่น้อยกว่า',
  lte: 'ไม่เกิน',
};

/** A group's own label, or its code when the rule names a group the document has dropped. */
function groupLabel({ product }: RuleTextContext, code: string): string {
  const group = product.groups.find((candidate) => candidate.code === code);
  return group?.labelTh ?? `«${code}»`;
}

function valueLabel({ product }: RuleTextContext, groupCode: string, valueCode: string): string {
  const group = product.groups.find((candidate) => candidate.code === groupCode);
  if (group === undefined || group.kind !== 'sku') return valueCode;
  return group.values.find((value) => value.code === valueCode)?.labelTh ?? valueCode;
}

/**
 * The unit to render a bare length in, taken from the measurement it is compared against.
 *
 * Walks both sides because `mul(measure('width'), measure('height'))` compared against an
 * area has no length constant in it at all, and `gt(area(), const(um2))` has no measure —
 * either way the fallback is what gets used and it is the catalogue's own idiom.
 */
function unitHint(context: RuleTextContext, ...expressions: readonly NumExprWire[]): AuthoredUnit {
  for (const expression of expressions) {
    const found = firstMeasureUnit(context, expression);
    if (found !== null) return found;
  }
  return 'cm';
}

function firstMeasureUnit(context: RuleTextContext, expression: NumExprWire): AuthoredUnit | null {
  switch (expression.n) {
    case 'measure': {
      const group = context.product.groups.find((candidate) => candidate.code === expression.group);
      return group !== undefined && group.kind === 'custom' ? group.unit : null;
    }
    case 'mul':
      return (
        firstMeasureUnit(context, expression.left) ?? firstMeasureUnit(context, expression.right)
      );
    case 'const':
    case 'area':
      return null;
  }
}

function numText(expression: NumExprWire, context: RuleTextContext, unit: AuthoredUnit): string {
  switch (expression.n) {
    case 'const': {
      const { dimension, value } = constOf(expression.value);
      switch (dimension) {
        case 'um':
          return `${formatLength(value, unit)} ${unit}`;
        case 'um2':
          return `${sqm(value)} ตร.ม.`;
        case 'count':
          return value.toString();
      }
    }
    case 'measure':
      return groupLabel(context, expression.group);
    case 'area':
      return 'พื้นที่';
    case 'mul':
      return `${numText(expression.left, context, unit)} × ${numText(expression.right, context, unit)}`;
  }
}

/**
 * `nested` decides the brackets: a top-level "และ" reads better without them, and a nested
 * one without them is ambiguous. One rule, applied by depth rather than by taste.
 */
function render(expression: RuleExprWire, context: RuleTextContext, nested: boolean): string {
  const bracket = (text: string): string => (nested ? `(${text})` : text);

  switch (expression.op) {
    case 'gt':
    case 'lt':
    case 'gte':
    case 'lte': {
      const unit = unitHint(context, expression.left, expression.right);
      return `${numText(expression.left, context, unit)} ${OPERATORS[expression.op]} ${numText(expression.right, context, unit)}`;
    }
    case 'selected':
      return `เลือก${groupLabel(context, expression.group)}เป็น “${valueLabel(context, expression.group, expression.value)}”`;
    case 'and':
      return bracket(expression.all.map((part) => render(part, context, true)).join(' และ '));
    case 'or':
      return bracket(expression.any.map((part) => render(part, context, true)).join(' หรือ '));
    case 'not':
      return `ไม่ใช่กรณี ${render(expression.expr, context, true)}`;
  }
}

/** The condition as one sentence. Always non-empty: every arm produces text. */
export const ruleText = (expression: RuleExprWire, context: RuleTextContext): string =>
  render(expression, context, false);
