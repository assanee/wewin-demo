import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { isLengthUnit, type LengthUnit } from '@wewin/core/units';
import { DisplayUnitCtx, type DisplayUnitContextValue } from './displayUnitContext';

const STORAGE_KEY = 'aluform.displayUnit.v1';

/** The unit the catalogue is authored in, so the default renders every size exactly. */
const DEFAULT_UNIT: LengthUnit = 'cm';

/**
 * The unit sizes are *shown* in — presentation, and nothing else.
 *
 * This value only ever reaches `formatLength`/`formatMeasure` on the way to the screen.
 * A 320 cm window measures 3,200,000 µm whether the page reads `320 cm` or `≈126"`;
 * were switching units allowed to write back, that same window would come out of a
 * detour through inches at 3,200,400 µm. Snapping belongs to the one path where a
 * person typed something — see `parseMeasure`.
 *
 * Deliberately outside the configurator History. Undo takes back an edit, and reading a
 * drawing in feet is not one — burying a real change under three unit switches is how
 * undo stops being worth pressing.
 */
export function DisplayUnitProvider({ children }: { children: ReactNode }): ReactElement {
  const [state, setState] = useState<{ unit: LengthUnit; hydrated: boolean }>({
    unit: DEFAULT_UNIT,
    hydrated: false,
  });

  // Read on mount rather than in the initialiser: localStorage during render would close
  // off the SSR path spec section 12 keeps open, which is why QuoteProvider hydrates from
  // an effect too. The consequence is deliberate — the first paint is always `cm` and a
  // saved preference lands one commit later, so the picker animates none of its states
  // and the correction reads as the starting position rather than a change of mind.
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      // Private mode. No preference is the default preference, not a broken page.
    }

    // A value we do not recognise is a preference from a build with a different unit
    // set, or one somebody hand-edited. Falling back beats throwing over a key the
    // customer cannot see, let alone repair.
    const restored = isLengthUnit(stored) ? stored : DEFAULT_UNIT;

    // Guarded through the flag in state, the way QuoteProvider guards its write-back:
    // if a choice has already been made, a preference arriving afterwards must not
    // roll it back.
    setState((previous) => (previous.hydrated ? previous : { unit: restored, hydrated: true }));
  }, []);

  const setUnit = useCallback((next: LengthUnit) => {
    setState({ unit: next, hydrated: true });

    // Persisted here rather than from an effect on `unit`: that effect would also run on
    // mount, holding the default, and would overwrite the stored preference before the
    // read above ever saw it. A person clicking is the only thing that may move this key.
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Quota or private mode. The choice still holds for the rest of the session.
    }
  }, []);

  const value = useMemo<DisplayUnitContextValue>(
    () => ({ unit: state.unit, setUnit }),
    [state.unit, setUnit],
  );

  return <DisplayUnitCtx.Provider value={value}>{children}</DisplayUnitCtx.Provider>;
}
