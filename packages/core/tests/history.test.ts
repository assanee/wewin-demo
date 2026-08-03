import { describe, expect, test } from 'vitest';
import {
  canRedo,
  canUndo,
  initHistory,
  pushHistory,
  redo,
  undo,
  HISTORY_LIMIT,
} from '../src/history.js';

/**
 * Undo/redo over the configurator state. Pure, so the awkward parts — coalescing a
 * held stepper into one step, dropping the redo branch on a new edit — are checked
 * by assertion rather than by clicking.
 */

describe('pushHistory', () => {
  test('moves the old value into the past', () => {
    const h = pushHistory(initHistory('a'), 'b');

    expect(h.present).toBe('b');
    expect(h.past).toEqual(['a']);
    expect(h.future).toEqual([]);
  });

  test('ignores a push that does not change anything', () => {
    // Re-selecting the colour that is already selected is not an undo step.
    expect(pushHistory(initHistory('a'), 'a').past).toEqual([]);

    // The same holds for a measure now that measures are bigint micrometres:
    // `Object.is` compares bigints by value, so blurring an untouched field —
    // which reparses to the identical micrometre count — costs no undo step.
    expect(pushHistory(initHistory(3_200_000n), 3_200_000n).past).toEqual([]);
  });

  test('discards the redo branch once a new edit is made', () => {
    let h = pushHistory(initHistory('a'), 'b');
    h = undo(h);
    h = pushHistory(h, 'c');

    expect(h.present).toBe('c');
    expect(h.future).toEqual([]);
  });

  test('caps the past so a long session cannot grow without bound', () => {
    let h = initHistory(0);
    for (let i = 1; i <= HISTORY_LIMIT + 20; i += 1) h = pushHistory(h, i);

    expect(h.past).toHaveLength(HISTORY_LIMIT);
    // The oldest entries are the ones dropped, not the newest.
    expect(h.past[h.past.length - 1]).toBe(HISTORY_LIMIT + 19);
  });
});

describe('pushHistory — coalescing', () => {
  test('folds consecutive edits to the same field into one step', () => {
    // Holding the + stepper must not cost twenty presses of undo to reverse.
    // One press is one 0.5 cm step, which is 5,000 µm.
    let h = initHistory(3_200_000n);
    h = pushHistory(h, 3_205_000n, 'width');
    h = pushHistory(h, 3_210_000n, 'width');
    h = pushHistory(h, 3_215_000n, 'width');

    expect(h.present).toBe(3_215_000n);
    expect(h.past).toEqual([3_200_000n]);
    expect(undo(h).present).toBe(3_200_000n);
  });

  test('starts a new step when the edit moves to another field', () => {
    let h = initHistory('start');
    h = pushHistory(h, 'w1', 'width');
    h = pushHistory(h, 'h1', 'height');

    expect(h.past).toEqual(['start', 'w1']);
  });

  test('starts a new step when a push carries no merge key', () => {
    // Picking a colour is a discrete act even if it follows a stepper drag.
    let h = initHistory('start');
    h = pushHistory(h, 'w1', 'width');
    h = pushHistory(h, 'colour');

    expect(h.past).toEqual(['start', 'w1']);
  });

  test('an undo breaks the coalescing run, so the next edit is its own step', () => {
    let h = initHistory('a');
    h = pushHistory(h, 'b', 'width');
    h = undo(h);
    h = pushHistory(h, 'c', 'width');

    expect(h.past).toEqual(['a']);
    expect(h.present).toBe('c');
  });
});

describe('undo and redo', () => {
  test('undo steps back and redo steps forward again', () => {
    let h = pushHistory(pushHistory(initHistory('a'), 'b'), 'c');

    h = undo(h);
    expect(h.present).toBe('b');

    h = undo(h);
    expect(h.present).toBe('a');

    h = redo(h);
    expect(h.present).toBe('b');
  });

  test('are no-ops at the ends rather than throwing', () => {
    const fresh = initHistory('a');

    expect(undo(fresh)).toEqual(fresh);
    expect(redo(fresh)).toEqual(fresh);
  });

  test('report what is available so the buttons can disable themselves', () => {
    const fresh = initHistory('a');
    expect(canUndo(fresh)).toBe(false);
    expect(canRedo(fresh)).toBe(false);

    const edited = pushHistory(fresh, 'b');
    expect(canUndo(edited)).toBe(true);
    expect(canRedo(edited)).toBe(false);

    const undone = undo(edited);
    expect(canUndo(undone)).toBe(false);
    expect(canRedo(undone)).toBe(true);
  });

  test('never mutates the history it is given', () => {
    const h = pushHistory(initHistory('a'), 'b');
    const snapshot = structuredClone(h);

    undo(h);
    redo(h);
    pushHistory(h, 'c');

    expect(h).toEqual(snapshot);
  });
});
