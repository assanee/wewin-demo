import { useMemo, useState } from 'react';
import type { CustomGroup, LengthUnit, Product, SkuGroup } from '@wewin/core';
import { calcPrice, type PriceBreakdown } from '@wewin/core/pricing';
import { buildSkuCode } from '@wewin/core/sku';
import { hasBlockingError, validate, type Issue } from '@wewin/core/validation';
import { optionStatesFor, type OptionStates } from '@wewin/core/option-states';
import {
  canRedo,
  canUndo,
  initHistory,
  pushHistory,
  redo,
  undo,
  type History,
} from '@wewin/core/history';

export interface ConfiguratorState {
  selections: Record<string, string>;
  /** Canonical micrometres, keyed by group code. */
  measures: Record<string, bigint>;
  /**
   * The unit a measurement was typed in, for the fields that have been typed into.
   *
   * A sibling of `measures` rather than a value inside it: `configHash` interpolates
   * that record, and 320 cm and 3,200 mm are one window that has to reach the quote
   * as one row. A missing entry means "not typed yet", which every reader resolves
   * to the unit the catalogue was authored in — the same unit the field is showing.
   */
  enteredUnits: Record<string, LengthUnit>;
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
  measure: (groupCode: string, value: bigint) => void;
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
  const measures: Record<string, bigint> = {};

  for (const group of product.groups) {
    if (group.kind === 'sku') selections[group.code] = (group satisfies SkuGroup).defaultValue;
    else measures[group.code] = (group satisfies CustomGroup).defaultUm;
  }

  // Empty, not seeded with each group's authored unit: nothing has been typed yet,
  // and the difference matters the moment the fields can be shown in another unit —
  // a seeded entry would claim the customer chose cm when they only looked at it.
  return { selections, measures, enteredUnits: {}, qty: 1, nickname: product.nameTh };
}

/** Shallow record equality, written out rather than stringified. */
const sameRecord = <T>(a: Record<string, T>, b: Record<string, T>): boolean => {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
};

/*
 * `JSON.stringify` used to stand in for a deep equal here. It could not survive the
 * move to micrometres: measures are bigint now, and stringify throws on a bigint
 * rather than returning something wrong. This sits on the render path via
 * `isPristine`, so the whole configurator page would have died on first paint — not
 * just the reset button.
 */
const sameState = (a: ConfiguratorState, b: ConfiguratorState): boolean =>
  a.qty === b.qty &&
  a.nickname === b.nickname &&
  sameRecord(a.selections, b.selections) &&
  sameRecord(a.measures, b.measures) &&
  sameRecord(a.enteredUnits, b.enteredUnits);

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
  const { selections, measures, enteredUnits, qty } = state;

  const derived = useMemo(() => {
    const price = calcPrice(product, selections, measures, qty);
    // `enteredUnits` decides which grid each measurement is judged against and what
    // unit the messages are phrased in, so it has to reach both readers or a field
    // typed in inches gets told off in centimetres.
    const issues = validate(product, selections, measures, enteredUnits);

    return {
      price,
      issues,
      skuCode: buildSkuCode(product, selections),
      optionStates: optionStatesFor(product, selections, measures, enteredUnits),
      hasError: hasBlockingError(issues),
    };
  }, [product, selections, measures, enteredUnits, qty]);

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
    //
    // Takes no unit yet, so `enteredUnits` stays empty and every reader falls back to
    // the authored one — which is the unit the field is displaying, so nothing is
    // misreported. It gains one when the fields can be shown in something else.
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
