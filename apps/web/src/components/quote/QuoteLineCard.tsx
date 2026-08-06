'use client';

import type { QuoteLine } from '@wewin/core/quote';
import { useDisplayUnit } from '../../state/displayUnitContext';
import { useLocale } from '../../state/localeContext';
import { QuoteActions, QuoteQtyStepper } from './QuoteActions';
import { QuoteLineWarning } from './QuoteLineWarning';
import { configureHref } from './configureHref';

interface QuoteLineCardProps {
  line: QuoteLine;
  onQtyChange: (qty: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}

/**
 * base and md. Spec section 8 rules out a horizontally scrolling table on mobile,
 * so the same data is restructured rather than shrunk: nickname as the card head,
 * sku_code and size as a mono sub-line, quantity and total on the bottom row.
 */
export function QuoteLineCard({ line, onQtyChange, onDuplicate, onRemove }: QuoteLineCardProps) {
  const { unit: displayUnit } = useDisplayUnit();
  const { t, f, locale } = useLocale();
  const widthUm = line.measures['width'] ?? 0n;
  const heightUm = line.measures['height'] ?? 0n;
  // Same unit choice as the desktop row, reasoned about there: the unit the size was
  // typed in, falling back to the display unit only when nobody typed one. Rotating a
  // phone must not restate a line, so the two views have to agree.
  const unit = line.enteredUnits['width'] ?? line.enteredUnits['height'] ?? displayUnit;

  return (
    <article className="flex min-w-0 flex-col gap-3 border border-line bg-panel p-4">
      <div className="min-w-0">
        <h2 className="min-w-0 truncate text-body text-chalk">{line.nickname}</h2>
        <p className="numeric mt-1 min-w-0 truncate text-caption text-chalk-3">{line.skuCode}</p>
        <p className="numeric text-caption text-blueprint">{f.dimensions(widthUm, heightUm, unit)}</p>
      </div>

      <QuoteLineWarning
        line={line}
        className="rounded-xs border border-warn/40 bg-warn/10 px-2 py-1.5 text-caption"
      />

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
        <QuoteQtyStepper qty={line.qty} nickname={line.nickname} onChange={onQtyChange} />
        <div className="text-end">
          <p className="numeric text-caption text-chalk-3">
            {t('price.perPiece', { minor: line.priceSnapshot.unitPriceMinor })}
          </p>
          <p className="numeric text-body text-chalk">{f.baht(line.priceSnapshot.totalMinor)}</p>
        </div>
      </div>

      <div className="flex justify-end">
        <QuoteActions
          editHref={configureHref(locale, line)}
          nickname={line.nickname}
          onDuplicate={onDuplicate}
          onRemove={onRemove}
        />
      </div>
    </article>
  );
}