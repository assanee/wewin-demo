import { useMemo, useState } from 'react';
import type { CustomGroup, Product, SkuGroup } from '../types/catalog';
import { calcPrice, type PriceBreakdown } from '../lib/pricing';
import { buildSkuCode } from '../lib/skuCode';
import { hasBlockingError, validate, type Issue } from '../lib/validation';
import { optionStatesFor, type OptionStates } from '../lib/optionStates';
import {
  canRedo,
  canUndo,
  initHistory,
  pushHistory,
  redo,
  undo,
  type History,
} from '../lib/history';

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
  /* --- History ---------------------------------------------------------- */
  undo: () => void;
  redo: () => void;
  /** Back to the product's defaults. Undoable like any other edit. */
  reset: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** False once anything differs from the defaults, so reset can disable itself. */
  isPristine: boolean;
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

const sameState = (a: ConfiguratorState, b: ConfiguratorState): boolean =>
  a.qty === b.qty &&
  a.nickname === b.nickname &&
  JSON.stringify(a.selections) === JSON.stringify(b.selections) &&
  JSON.stringify(a.measures) === JSON.stringify(b.measures);

/**
 * Holds the configuration and derives everything downstream of it.
 *
 * All four derived values come from the same (selections, measures) pair, so the
 * price, the sku code, the issue list and the struck-through options can never
 * disagree about what is currently configured.
 *
 * State lives inside a History so every change is undoable. Continuous edits pass a
 * merge key — holding the + stepper is one undo step, not twenty — while picking an
 * option is discrete and gets its own.
 */
export function useConfigurator(product: Product, initial?: Partial<ConfiguratorState>): Configurator {
  const defaults = useMemo(() => defaultStateFor(product), [product]);
  const [history, setHistory] = useState<History<ConfiguratorState>>(() =>
    initHistory({ ...defaults, ...initial }),
  );

  const state = history.present;
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

  const edit = (next: (current: ConfiguratorState) => ConfiguratorState, mergeKey?: string) =>
    setHistory((current) => pushHistory(current, next(current.present), mergeKey));

  return {
    ...state,
    ...derived,

    // Picking an option is a discrete act, so no merge key: it always earns its
    // own undo step even if it follows a run of stepper presses.
    select: (groupCode, valueCode) =>
      edit((current) => ({
        ...current,
        selections: { ...current.selections, [groupCode]: valueCode },
      })),

    // Keyed per field: dragging width then height gives two steps, not one.
    measure: (groupCode, value) =>
      edit(
        (current) => ({ ...current, measures: { ...current.measures, [groupCode]: value } }),
        `measure:${groupCode}`,
      ),

    setQty: (next) => edit((current) => ({ ...current, qty: next }), 'qty'),
    setNickname: (next) => edit((current) => ({ ...current, nickname: next }), 'nickname'),

    undo: () => setHistory(undo),
    redo: () => setHistory(redo),
    reset: () => setHistory((current) => pushHistory(current, defaults)),

    canUndo: canUndo(history),
    canRedo: canRedo(history),
    isPristine: sameState(state, defaults),
  };
}
