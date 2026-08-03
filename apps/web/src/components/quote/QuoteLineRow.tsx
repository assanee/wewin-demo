import { AlertTriangle } from 'lucide-react';
import type { QuoteLine } from '@wewin/core/quote';
import { formatBaht, formatDimensions } from '@wewin/core/format';
import { useDisplayUnit } from '../../state/displayUnitContext';
import { QuoteActions, QuoteQtyStepper } from './QuoteActions';

interface QuoteLineRowProps {
  line: QuoteLine;
  onQtyChange: (qty: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}

/** Desktop only (lg). The mobile equivalent is QuoteLineCard — never both at once. */
export function QuoteLineRow({ line, onQtyChange, onDuplicate, onRemove }: QuoteLineRowProps) {
  const { unit: displayUnit } = useDisplayUnit();
  const widthUm = line.measures['width'] ?? 0n;
  const heightUm = line.measures['height'] ?? 0n;
  // Per line, in the unit it was typed in — not all lines in the current display unit.
  // The job on this screen is checking the quote against what was asked for, and a
  // customer who read 82 1/2" off a tape is looking for 82 1/2"; restating that as
  // ≈209.6 cm asks them to verify arithmetic instead of a window, and every imperial
  // line would wear an `≈` that means nothing was wrong. The picker still governs
  // lines with no entered unit — sizes left at their default, and lines saved before
  // the unit was recorded — so it is never dead on this screen.
  //
  // Width carries the pair: a size is spoken as one pair, so a height typed in another
  // unit is shown in width's, where `formatDimensions` marks it `≈` rather than
  // quietly rounding it.
  const unit = line.enteredUnits['width'] ?? line.enteredUnits['height'] ?? displayUnit;

  return (
    <tr className="border-b border-line last:border-b-0 align-top">
      <td className="min-w-0 py-3 pe-3">
        <p className="min-w-0 truncate text-body text-chalk">{line.nickname}</p>
        {line.warnings.length > 0 ? (
          <p className="mt-1 flex items-start gap-1.5 text-caption text-warn">
            <AlertTriangle size={13} aria-hidden className="mt-[3px] shrink-0" />
            <span className="min-w-0">{line.warnings[0]?.messageTh}</span>
          </p>
        ) : null}
      </td>

      <td className="py-3 pe-3">
        <code className="numeric text-small text-chalk-2">{line.skuCode}</code>
      </td>

      <td className="numeric py-3 pe-3 text-small text-blueprint whitespace-nowrap">
        {formatDimensions(widthUm, heightUm, unit)}
      </td>

      <td className="py-3 pe-3">
        <QuoteQtyStepper qty={line.qty} nickname={line.nickname} onChange={onQtyChange} />
      </td>

      <td className="numeric py-3 pe-3 text-end text-small text-chalk-2 whitespace-nowrap">
        {formatBaht(line.priceSnapshot.unitPriceMinor)}
      </td>

      <td className="numeric py-3 pe-3 text-end text-body text-chalk whitespace-nowrap">
        {formatBaht(line.priceSnapshot.totalMinor)}
      </td>

      <td className="py-3">
        <QuoteActions
          editHref={`/products/${line.productId}?line=${line.lineId}`}
          nickname={line.nickname}
          onDuplicate={onDuplicate}
          onRemove={onRemove}
        />
      </td>
    </tr>
  );
}
