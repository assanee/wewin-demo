import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useLocale } from '../../state/localeContext';

interface BottomSheetProps {
  open: boolean;
  /** Already translated by the caller — the set of sheet titles is open. */
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Pinned to the bottom of the sheet, above the safe area. */
  footer?: ReactNode;
  /**
   * Full-height for browsing tasks like the filter panel; auto-height for short
   * read-only content, where a full screen of empty panel below four rows of text
   * reads as a loading failure.
   */
  size?: 'full' | 'auto';
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Bottom sheet for mobile. Callers decide when it applies — the filter panel uses
 * it below lg, the price breakdown below md — so it carries no breakpoint itself.
 *
 * Handles the three things a modal has to get right and that a plain div does not:
 * Escape closes it, focus is trapped inside while it is open, and focus returns to
 * whatever opened it on close. All DOM access is inside effects so nothing touches
 * `window` during render (spec section 12 keeps the SSR migration path open).
 */
export function BottomSheet({ open, title, onClose, children, footer, size = 'full' }: BottomSheetProps) {
  const { t } = useLocale();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;

    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Move focus into the sheet, otherwise the next Tab lands back on the page behind.
    const firstFocusable = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    firstFocusable?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;

      const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label={t('sheet.closeNamed', { title })}
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-black/70"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`absolute inset-x-0 bottom-0 flex flex-col border-t border-line bg-panel ${
          size === 'full'
            ? 'top-0'
            : // Auto-height sheets are the ones that can appear on a large screen
              // (the share panel does). Stretching a QR code across 1440px reads as
              // a broken layout, so from md up it becomes a centred dialog instead.
              'max-h-[85%] md:inset-x-auto md:bottom-8 md:left-1/2 md:w-full md:max-w-130 md:-translate-x-1/2 md:rounded-xs md:border'
        }`}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 id={titleId} className="text-lead">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('sheet.close')}
            className="flex h-11 w-11 items-center justify-center rounded-xs border border-line text-chalk-2 transition-colors duration-180 ease-out hover:text-chalk"
          >
            <X size={18} aria-hidden />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">{children}</div>

        {footer ? (
          <div
            className="shrink-0 border-t border-line px-4 pt-3"
            style={{ paddingBottom: 'calc(12px + env(safe-area-inset-bottom))' }}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
