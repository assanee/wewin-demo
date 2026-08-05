import { calcPrice } from '@wewin/core/pricing';
import { optionStatesFor } from '@wewin/core/option-states';
import { validate } from '@wewin/core/validation';
import { getProductById } from '@wewin/core/fixtures';
import { toMicrons } from '@wewin/core/units';
import type { CustomGroup, Message, MessageKey, Product, SkuGroup } from '@wewin/core';

/**
 * Every message in the scheme, produced by real code rather than written by hand.
 *
 * Deliberately the same configurations `@wewin/core/tests/messages.test.ts` uses, because
 * the point of `parity.test.ts` is that this package's Thai output equals the strings
 * core's phase-6a gate pins — and comparing two different configurations would prove
 * nothing. A fixture object here would prove even less: it would test that this package
 * can render a `Message` somebody typed, not one the domain can actually emit.
 */

export const product = (id: string): Product => {
  const found = getProductById(id);
  if (!found) throw new Error(`fixture missing: ${id}`);
  return found;
};

export const cm = (value: number): bigint => toMicrons(value, 'cm');

export const AWN_OK = {
  profile_color: 'DW',
  glass_color: 'GRN',
  glass_thickness: 'T5',
  insect_screen: 'NS0',
} as const;

/** awn-4t with one option marked out of stock. */
const withUnavailable = (groupCode: string, valueCode: string): Product => {
  const base = product('awn-4t');
  return {
    ...base,
    groups: base.groups.map((group) =>
      group.kind === 'sku' && group.code === groupCode
        ? ({
            ...group,
            values: group.values.map((value) =>
              value.code === valueCode ? { ...value, available: false } : value,
            ),
          } satisfies SkuGroup)
        : group,
    ),
  };
};

/**
 * awn-4t whose width range sits strictly between two eighth-inch marks.
 *
 * 3,175 × 315 = 1,000,125 µm and 3,175 × 316 = 1,003,300 µm, so nothing typed in inches
 * can land in 1,000,200–1,003,000. The only way to reach `issue.step.noMarkInRange`.
 */
const betweenMarks = (): Product => {
  const base = product('awn-4t');
  const width = base.groups.find(
    (group): group is CustomGroup => group.kind === 'custom' && group.code === 'width',
  );
  if (!width) throw new Error('fixture missing: awn-4t.width');

  return {
    ...base,
    groups: base.groups.map((group) =>
      group === width ? { ...width, minUm: 1_000_200n, maxUm: 1_003_000n } : group,
    ),
  };
};

function mustFind(issues: readonly { ruleId: string; message: Message }[], ruleId: string): Message {
  const found = issues.find((issue) => issue.ruleId === ruleId);
  if (!found) throw new Error(`no issue ${ruleId} in [${issues.map((i) => i.ruleId).join(', ')}]`);
  return found.message;
}

function mustState(item: Product, groupCode: string, valueCode: string): Message {
  const reason = optionStatesFor(item, AWN_OK, { width: cm(320), height: cm(160) })[groupCode]?.[
    valueCode
  ]?.reason;
  if (!reason) throw new Error(`no reason on ${groupCode}.${valueCode}`);
  return reason;
}

function mustLine(price: { lines: readonly { label: Message }[] }, index: number): Message {
  const line = price.lines[index];
  if (!line) throw new Error(`no breakdown row ${String(index)}`);
  return line.label;
}

export const produced: Record<MessageKey, Message> = {
  'issue.selection.unknown': mustFind(
    validate(
      product('awn-4t'),
      { ...AWN_OK, glass_color: 'PLAID' },
      { width: cm(320), height: cm(160) },
    ),
    'selection:glass_color',
  ),
  'issue.range.outOfRange': mustFind(
    validate(product('awn-4t'), AWN_OK, { width: cm(40), height: cm(160) }),
    'range:width',
  ),
  'issue.step.willSnapUp': mustFind(
    validate(product('awn-4t'), AWN_OK, { width: cm(320), height: cm(160.3) }),
    'step:height',
  ),
  'issue.step.aboveLargestMark': mustFind(
    validate(product('awn-4t'), AWN_OK, { width: cm(320), height: 2_499_000n }, { height: 'in' }),
    'step:height',
  ),
  'issue.step.noMarkInRange': mustFind(
    validate(betweenMarks(), AWN_OK, { width: 1_000_300n, height: cm(160) }, { width: 'in' }),
    'step:width',
  ),
  'issue.rule': mustFind(
    validate(
      product('awn-4t'),
      { ...AWN_OK, glass_thickness: 'LAM' },
      { width: cm(260), height: cm(160) },
    ),
    'awn4t-lam-width',
  ),
  'option.unavailable': mustState(withUnavailable('insect_screen', 'NS1'), 'insect_screen', 'NS1'),
  'price.line.base': mustLine(
    calcPrice(product('awn-4t'), AWN_OK, { width: cm(320), height: cm(160) }, 1),
    0,
  ),
  'price.line.option': mustLine(
    calcPrice(product('awn-4t'), AWN_OK, { width: cm(320), height: cm(160) }, 1),
    1,
  ),
};
