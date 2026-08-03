import { createContext, useContext } from 'react';
import type { LengthUnit } from '@wewin/core/units';

/**
 * The context and its hook, apart from the provider component.
 *
 * Same split as `QuoteContext.tsx`/`useQuote.ts` and `Toast.tsx`/`useToast.ts`, and for
 * the same reason: React Fast Refresh only remounts cleanly when a module exports
 * components *or* plain values, never both. A file that exports the provider and the
 * hook together silently costs a full reload on every edit during development.
 */

export interface DisplayUnitContextValue {
  unit: LengthUnit;
  setUnit: (next: LengthUnit) => void;
}

export const DisplayUnitCtx = createContext<DisplayUnitContextValue | null>(null);

export function useDisplayUnit(): DisplayUnitContextValue {
  const value = useContext(DisplayUnitCtx);
  if (!value) throw new Error('useDisplayUnit must be used inside <DisplayUnitProvider>');
  return value;
}
