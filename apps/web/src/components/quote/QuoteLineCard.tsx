import { AlertTriangle } from 'lucide-react';
import type { QuoteLine } from '@wewin/core/quote';
import { formatBaht, formatDimensions } from '@wewin/core/format';
import { useDisplayUnit } from '../../state/displayUnitContext';
import { QuoteActions, QuoteQtyStepper } from './QuoteActions';

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
        <p className="numeric text-caption text-blueprint">{formatDimensions(widthUm, heightUm, unit)}</p>
      </div>

      {line.warnings.length > 0 ? (
        <p className="flex items-start gap-1.5 rounded-xs border border-warn/40 bg-warn/10 px-2 py-1.5 text-caption text-warn">
          <AlertTriangle size={13} aria-hidden className="mt-[3px] shrink-0" />
          <span className="min-w-0">{line.warnings[0]?.messageTh}</span>
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
        <QuoteQtyStepper qty={line.qty} nickname={line.nickname} onChange={onQtyChange} />
        <div className="text-end">
          <p className="numeric text-caption text-chalk-3">
            {formatBaht(line.priceSnapshot.unitPriceMinor)} / ชิ้น
          </p>
          <p className="numeric text-body text-chalk">{formatBaht(line.priceSnapshot.totalMinor)}</p>
        </div>
      </div>

      <div className="flex justify-end">
        <QuoteActions
          editHref={`/products/${line.productId}?line=${line.lineId}`}
          nickname={line.nickname}
          onDuplicate={onDuplicate}
          onRemove={onRemove}
        />
      </div>
    </article>
  );
}
