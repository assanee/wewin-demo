import { expect, it } from 'vitest';
import type { AuthoredUnit, InputStyle, OptionKind, PriceDelta, Rule } from '@wewin/core';
import {
  authoredUnit,
  optionGroupKind,
  optionInput,
  priceDeltaType,
  ruleSeverity,
} from '../src/schema/enums.js';

/**
 * Every Postgres enum against the TypeScript union it stands for.
 *
 * These assertions are type-level and cost nothing at runtime — the point is the
 * compile error. A member added to `InputStyle` in core and not to `option_input` here
 * would otherwise surface as a `22P02 invalid input value for enum` from a customer's
 * request, months later, on the one product that uses it.
 *
 * `Exact` is mutual assignability rather than `extends`, because a one-way check passes
 * happily when the database knows fewer values than the domain does — which is exactly
 * the direction that breaks.
 */

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const kinds: Exact<(typeof optionGroupKind.enumValues)[number], OptionKind> = true;
const inputs: Exact<(typeof optionInput.enumValues)[number], InputStyle> = true;
const units: Exact<(typeof authoredUnit.enumValues)[number], AuthoredUnit> = true;
const deltas: Exact<(typeof priceDeltaType.enumValues)[number], PriceDelta['type']> = true;
const severities: Exact<(typeof ruleSeverity.enumValues)[number], Rule['severity']> = true;

it('declares the same members the domain does', () => {
  expect([kinds, inputs, units, deltas, severities].every(Boolean)).toBe(true);
});
