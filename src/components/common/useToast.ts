import { createContext, useContext } from 'react';

export interface ToastPayload {
  messageTh: string;
  /** Optional follow-up, e.g. "ดูตะกร้า". */
  action?: { labelTh: string; to: string };
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
