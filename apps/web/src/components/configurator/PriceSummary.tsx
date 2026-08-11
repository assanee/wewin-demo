import { useEffect, useState } from 'react';
import { Check, Copy, Minus, Plus } from 'lucide-react';
import type { PriceBreakdown } from '@wewin/core/pricing';
import type { Product } from '@wewin/core';
import { MAX_QTY } from '@wewin/core/constants';
import { useLocale } from '../../state/localeContext';
import { Button } from '../common/Button';
import { Accordion } from '../common/Accordion';
import { StickyBar } from '../common/StickyBar';
import { PriceBreakdownList } from './PriceBreakdownList';

interface SharedProps {
  product: Product;
  price: PriceBreakdown;
  skuCode: string;
  qty: number;
  onQtyChange: (next: number) => void;
  onAdd: () => void;
  hasError: boolean;
}

function CopyableSku({ skuCode }: { skuCode: string }) {
  const [copied, setCopied] = useState(false);
  const { t } = useLocale();

  // Reset the confirmation without leaving a timer behind if the code changes first.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="numeric min-w-0 flex-1 truncate rounded-xs border border-line bg-panel-2 px-2 py-1 text-small text-chalk">
        {skuCode}
      </code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(skuCode).then(() => setCopied(true));
        }}
        aria-label={t('summary.copySku', { skuCode })}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xs border border-line text-chalk-2 transition-colors duration-180 ease-out hover:text-chalk"
      >
        {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
      </button>
      <span aria-live="polite" className="sr-only">
        {copied ? t('summary.skuCopied') : ''}
      </span>
    </div>
  );
}

function QtyStepper({ qty, onQtyChange }: { qty: number; onQtyChange: (next: number) => void }) {
  const { t, f } = useLocale();

  return (
    <div className="flex items-center gap-2">
      <span className="text-small text-chalk-2">{t('configure.qty')}</span>
      <div className="flex items-stretch overflow-hidden rounded-xs border border-line">
        <button
          type="button"
          onClick={() => onQtyChange(Math.max(1, qty - 1))}
          disabled={qty <= 1}
          aria-label={t('configure.qty.decrease')}
          className="flex h-11 w-11 items-center justify-center bg-panel-2 text-chalk-2 transition-colors duration-180 ease-out hover:text-chalk disabled:opacity-30"
        >
          <Minus size={15} aria-hidden />
        </button>
        <output className="numeric flex h-11 w-12 items-center justify-center bg-panel-2 text-body text-chalk">
          {f.integer(qty)}
        </output>
        <button
          type="button"
          onClick={() => onQtyChange(Math.min(MAX_QTY, qty + 1))}
          disabled={qty >= MAX_QTY}
          aria-label={t('configure.qty.increase')}
          className="flex h-11 w-11 items-center justify-center bg-panel-2 text-chalk-2 transition-colors duration-180 ease-out hover:text-chalk disabled:opacity-30"
        >
          <Plus size={15} aria-hidden />
        </button>
      </div>
    </div>
  );
}

/**
 * Desktop and tablet: an inline card at the end of the right-hand column.
 *
 * The add button is never `disabled`, even with errors outstanding (spec section 6).
 * A disabled button gives a touch user nothing to press and therefore no explanation;
 * pressing this one surfaces the error summary instead.
 */
export function PriceSummaryCard({
  product,
  price,
  skuCode,
  qty,
  onQtyChange,
  onAdd,
  hasError,
}: SharedProps) {
  const { t, f } = useLocale();

  return (
    <section
      aria-label={t('summary.label')}
      className="flex flex-col gap-4 border border-line bg-panel p-4 md:p-5"
    >
      <div className="flex flex-col gap-2">
        <p className="text-caption text-chalk-3">{t('summary.skuCode')}</p>
        <CopyableSku skuCode={skuCode} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <div className="min-w-0">
          <p className="text-caption text-chalk-3">{t('price.unit')}</p>
          <p className="numeric text-lead text-chalk">{f.baht(price.unitPriceMinor)}</p>
        </div>
        <QtyStepper qty={qty} onQtyChange={onQtyChange} />
      </div>

      <div className="border-t border-line pt-4">
        <p className="text-caption text-chalk-3">{t('price.total')}</p>
        {/* The one lime number on the screen — the other lime element is the button. */}
        <p className="numeric text-display text-lime transition-colors duration-180 ease-out">
          {f.baht(price.totalMinor)}
        </p>
        <p className="numeric mt-1 text-caption text-chalk-3">
          {t('summary.area', { areaSqUm: price.areaSqUm })}
        </p>
        <p className="numeric mt-1 text-caption text-chalk-2">
          {t('leadTime.produce', { days: product.leadTimeDays })}
        </p>
      </div>

      <Button variant="primary" size="lg" className="w-full" onClick={onAdd}>
        {t('summary.add')}
      </Button>
      {hasError ? <p className="text-caption text-chalk-3">{t('summary.hasErrors')}</p> : null}

      <Accordion title={t('summary.showBreakdown')}>
        {/* The floor stays in µm² all the way to the formatter. It used to be divided out
            to m² here and again in `Configure.tsx`, which is two divisions of one quantity
            in two places — and the formatter it fed rounded differently from the one the
            base row's label used. One exact value, one formatter. */}
        <PriceBreakdownList price={price} minBillableSqUm={product.minBillableSqUm} />
      </Accordion>
    </section>
  );
}

interface StickyBarProps extends SharedProps {
  onOpenBreakdown: () => void;
}

/**
 * Mobile: a 72px bar pinned above the safe area.
 *
 * Spec section 8 asks for a 20px price here, but section 2 fixes the type scale at
 * 12/13/15/18/24/34/52 and forbids values outside it. We took the scale as the
 * stricter rule and used 18px — the two rules cannot both hold.
 */
export function PriceStickyBar({ price, qty, onAdd, onOpenBreakdown }: StickyBarProps) {
  const { t, f } = useLocale();

  return (
    <StickyBar>
      <button
        type="button"
        onClick={onOpenBreakdown}
        aria-label={t('summary.showBreakdown')}
        className="flex min-h-11 min-w-0 flex-col items-start justify-center text-start"
      >
        <span className="numeric text-lead text-lime">{f.baht(price.totalMinor)}</span>
        <span className="numeric text-caption text-chalk-3">
          {t('summary.stickyMeta', { areaSqUm: price.areaSqUm, qty })}
        </span>
      </button>

      <Button variant="primary" onClick={onAdd} className="shrink-0">
        {t('summary.add')}
      </Button>
    </StickyBar>
  );
}

export { QtyStepper, CopyableSku };
