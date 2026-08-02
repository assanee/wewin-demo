import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ToastCtx, type ToastContextValue, type ToastPayload } from './useToast';

const VISIBLE_MS = 4000;

/**
 * A single transient confirmation.
 *
 * Announced through an aria-live region rather than by moving focus: the customer is
 * usually mid-configuration when this fires, and pulling focus to a message that
 * removes itself four seconds later would lose their place in the form.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<(ToastPayload & { key: number }) | null>(null);

  const showToast = useCallback((payload: ToastPayload) => {
    setToast({ ...payload, key: Date.now() });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const value = useMemo<ToastContextValue>(() => ({ showToast }), [showToast]);

  return (
    <ToastCtx.Provider value={value}>
      {children}

      {/* The live region exists even while empty so assistive tech is already
          watching it when a message arrives. */}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-4"
        // Sits above the sticky bar when there is one, reusing the height StickyBar
        // publishes. Covering the bar would hide the primary action behind a message
        // about that action. The variable already includes the safe-area inset.
        style={{ paddingBottom: 'calc(16px + var(--sticky-bar-height, env(safe-area-inset-bottom)))' }}
      >
        {toast ? (
          <div
            key={toast.key}
            className="pointer-events-auto flex w-full max-w-105 items-center gap-3 rounded-xs border border-sel-line bg-panel px-4 py-3"
          >
            <Check size={16} aria-hidden className="shrink-0 text-sel-line" />
            <p className="min-w-0 flex-1 text-small text-chalk">{toast.messageTh}</p>

            {toast.action ? (
              <Link
                to={toast.action.to}
                onClick={() => setToast(null)}
                className="shrink-0 text-small text-chalk underline underline-offset-4"
              >
                {toast.action.labelTh}
              </Link>
            ) : null}

            <button
              type="button"
              onClick={() => setToast(null)}
              aria-label="ปิดข้อความ"
              className="-me-1 flex h-11 w-11 shrink-0 items-center justify-center text-chalk-3 transition-colors duration-180 ease-out hover:text-chalk"
            >
              <X size={15} aria-hidden />
            </button>
          </div>
        ) : null}
      </div>
    </ToastCtx.Provider>
  );
}
