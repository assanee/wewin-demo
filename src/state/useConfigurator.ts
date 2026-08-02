import { useMemo, useState } from 'react';
import type { CustomGroup, Product, SkuGroup } from '../types/catalog';
import { calcPrice, type PriceBreakdown } from '../lib/pricing';
import { buildSkuCode } from '../lib/skuCode';
import { hasBlockingError, validate, type Issue } from '../lib/validation';
import { optionStatesFor, type OptionStates } from '../lib/optionStates';

export interface ConfiguratorState {
  selections: Record<string, string>;
  measures: Record<string, number>;
  qty: number;
  nickname: string;
}

export interface Configurator extends ConfiguratorState {
  skuCode: string;
  price: PriceBreakdown;
  issues: Issue[];
  optionStates: OptionStates;
  hasError: boolean;
  select: (groupCode: string, valueCode: string) => void;
  measure: (groupCode: string, value: number) => void;
  setQty: (qty: number) => void;
  setNickname: (nickname: string) => void;
}

/** Everything a product's groups say the configurator should start at. */
export function defaultStateFor(product: Product): ConfiguratorState {
  const selections: Record<string, string> = {};
  const measures: Record<string, number> = {};

  for (const group of product.groups) {
    if (group.kind === 'sku') selections[group.code] = (group satisfies SkuGroup).defaultValue;
    else measures[group.code] = (group satisfies CustomGroup).defaultValue;
  }

  return { selections, measures, qty: 1, nickname: product.nameTh };
}

/**
 * Holds the configuration and derives everything downstream of it.
 *
 * All four derived values come from the same (selections, measures) pair, so the
 * price, the sku code, the issue list and the struck-through options can never
 * disagree about what is currently configured.
 */
export function useConfigurator(product: Product, initial?: Partial<ConfiguratorState>): Configurator {
  const [state, setState] = useState<ConfiguratorState>(() => ({
    ...defaultStateFor(product),
    ...initial,
  }));

  const { selections, measures, qty } = state;

  const derived = useMemo(() => {
    const price = calcPrice(product, selections, measures, qty);
    const issues = validate(product, selections, measures);

    return {
      price,
      issues,
      skuCode: buildSkuCode(product, selections),
      optionStates: optionStatesFor(product, selections, measures),
      hasError: hasBlockingError(issues),
    };
  }, [product, selections, measures, qty]);

  return {
    ...state,
    ...derived,
    select: (groupCode, valueCode) =>
      setState((current) => ({
        ...current,
        selections: { ...current.selections, [groupCode]: valueCode },
      })),
    measure: (groupCode, value) =>
      setState((current) => ({
        ...current,
        measures: { ...current.measures, [groupCode]: value },
      })),
    setQty: (next) => setState((current) => ({ ...current, qty: next })),
    setNickname: (next) => setState((current) => ({ ...current, nickname: next })),
  };
}
