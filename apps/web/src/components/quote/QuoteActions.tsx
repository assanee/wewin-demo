'use client';

import Link from 'next/link';
import { Copy, Pencil, Trash2 } from 'lucide-react';
import { MAX_QTY } from '@wewin/core/constants';
import { useLocale } from '../../state/localeContext';
import type { configureHref } from './configureHref';

interface QuoteActionsProps {
  /**
   * Locale-prefixed href for the configurator, already carrying `?line=`.
   *
   * Built by the caller rather than here, because it needs the locale and this
   * component would otherwise have two reasons to read the context. Typed as
   * `configureHref`'s return rather than as `string`, so `typedRoutes` still has a
   * literal to check and nothing has to be cast at the `Link` below.
   */
  editHref: ReturnType<typeof configureHref>;
  onDuplicate: () => void;
  onRemove: () => void;
  /** Included in every label so a screen reader hears which line it is acting on. */
  nickname: string;
}

const ACTION_CLASS =
  'flex h-11 w-11 items-center justify-center rounded-xs border border-line text-chalk-2 transition-colors duration-180 ease-out hover:border-line-2 hover:text-chalk';

/**
 * Edit, duplicate, remove — for one line.
 *
 * The edit control is a real `next/link`, which matters more here than it looks: it is
 * the one navigation on this screen that leaves with state behind it. A document load
 * would tear down the cart provider and rebuild it from storage on the other side, so
 * every "edit" would pay a fresh `parseStoredQuote` and a fresh mount effect. It is also
 * the only link in the app that goes from a page holding the cart to a page that reads
 * it, which is exactly where a prefetch is worth having.
 *
 * `href` stays a checked route rather than a cast — see `configureHref`.
 */
export function QuoteActions({ editHref, onDuplicate, onRemove, nickname }: QuoteActionsProps) {
  const { t } = useLocale();

  return (
    <div className="flex items-center gap-2">
      <Link href={editHref} aria-label={t('quote.action.edit', { nickname })} className={ACTION_CLASS}>
        <Pencil size={15} aria-hidden />
      </Link>
      <button
        type="button"
        onClick={onDuplicate}
        aria-label={t('quote.action.duplicate', { nickname })}
        className={ACTION_CLASS}
      >
        <Copy size={15} aria-hidden />
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('quote.action.remove', { nickname })}
        className={`${ACTION_CLASS} hover:border-danger hover:text-danger`}
      >
        <Trash2 size={15} aria-hidden />
      </button>
    </div>
  );
}

interface QtyStepperProps {
  qty: number;
  nickname: string;
  onChange: (qty: number) => void;
}

export function QuoteQtyStepper({ qty, nickname, onChange }: QtyStepperProps) {
  const { t, f } = useLocale();

  return (
    <div className="inline-flex items-stretch overflow-hidden rounded-xs border border-line">
      <button
        type="button"
        onClick={() => onChange(qty - 1)}
        disabled={qty <= 1}
        aria-label={t('quote.qty.decrease', { nickname })}
        className="flex h-11 w-11 items-center justify-center bg-panel-2 text-chalk-2 transition-colors duration-180 ease-out hover:text-chalk disabled:opacity-30"
      >
        −
      </button>
      <output
        aria-label={t('quote.qty.label', { nickname })}
        className="numeric flex h-11 w-11 items-center justify-center bg-panel-2 text-body text-chalk"
      >
        {f.integer(qty)}
      </output>
      <button
        type="button"
        onClick={() => onChange(qty + 1)}
        // Was the literal 99, one of two copies of a cap that already has a name.
        disabled={qty >= MAX_QTY}
        aria-label={t('quote.qty.increase', { nickname })}
        className="flex h-11 w-11 items-center justify-center bg-panel-2 text-chalk-2 transition-colors duration-180 ease-out hover:text-chalk disabled:opacity-30"
      >
        +
      </button>
    </div>
  );
}