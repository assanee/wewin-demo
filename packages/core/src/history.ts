/**
 * Undo/redo over an immutable value. Pure — no React, no clock.
 *
 * Coalescing is keyed rather than timed. A time window would make the behaviour
 * depend on how fast someone clicks and would be untestable without faking the
 * clock; a merge key says plainly "this edit continues the previous one", so
 * holding the + stepper collapses into a single undo step while switching to
 * another field starts a new one.
 */

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /** The merge key of the edit that produced `present`, if it had one. */
  lastKey?: string;
}

/** Enough for a long session; the cap only exists so memory cannot grow forever. */
export const HISTORY_LIMIT = 50;

export const initHistory = <T>(present: T): History<T> => ({
  past: [],
  present,
  future: [],
});

export function pushHistory<T>(history: History<T>, next: T, mergeKey?: string): History<T> {
  // Re-selecting what is already selected is not an edit.
  if (Object.is(history.present, next)) return history;

  // Continuing the same field: replace the present instead of stacking a step.
  if (mergeKey !== undefined && history.lastKey === mergeKey) {
    return { ...history, present: next, future: [] };
  }

  const past = [...history.past, history.present].slice(-HISTORY_LIMIT);

  // A new edit invalidates anything that was undone — the redo branch is gone.
  return mergeKey === undefined
    ? { past, present: next, future: [] }
    : { past, present: next, future: [], lastKey: mergeKey };
}

export function undo<T>(history: History<T>): History<T> {
  const previous = history.past[history.past.length - 1];
  if (previous === undefined) return history;

  // `lastKey` is cleared so the next edit starts its own step rather than merging
  // into the run that was just stepped out of.
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redo<T>(history: History<T>): History<T> {
  const [next, ...rest] = history.future;
  if (next === undefined) return history;

  return {
    past: [...history.past, history.present],
    present: next,
    future: rest,
  };
}

export const canUndo = <T>(history: History<T>): boolean => history.past.length > 0;
export const canRedo = <T>(history: History<T>): boolean => history.future.length > 0;
