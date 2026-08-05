import { createContext, useContext } from 'react';
import type { PlainKey } from '../../i18n/keys';

/**
 * A toast as a key, not a sentence.
 *
 * Deliberately different from `Accordion`'s `title`, and for a reason worth stating:
 * the toast outlives the call that raised it. It sits on screen for four seconds, and
 * if the language changes while it is up, a stored sentence would be stranded in the
 * old one. A stored key re-renders. The set of toasts is also closed and small, so the
 * union costs nothing.
 */
export interface ToastPayload {
  messageKey: PlainKey;
  /** Optional follow-up, e.g. `toast.viewQuote`. */
  action?: { labelKey: PlainKey; to: string };
}

export interface ToastContextValue {
  showToast: (payload: ToastPayload) => void;
}

/** Split from Toast.tsx so that file exports only a component — see useQuote.ts. */
export const ToastCtx = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const value = useContext(ToastCtx);
  if (!value) throw new Error('useToast must be used inside <ToastProvider>');
  return value;
}
