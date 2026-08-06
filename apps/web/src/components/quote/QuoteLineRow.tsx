'use client';

import type { QuoteLine } from '@wewin/core/quote';
import { useDisplayUnit } from '../../state/displayUnitContext';
import { useLocale } from '../../state/localeContext';
import { QuoteActions, QuoteQtyStepper } from './QuoteActions';
import { QuoteLineWarning } from './QuoteLineWarning';
import { configureHref } from './configureHref';

interface QuoteLineRowProps {
  line: QuoteLine;
  onQtyChange: (qty: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}

/** Desktop only (lg). The mobile equivalent is QuoteLineCard — never both at once. */
export function QuoteLineRow({ line, onQtyChange, onDuplicate, onRemove }: QuoteLineRowProps) {
  const { unit: displayUnit } = useDisplayUnit();
  const { f, locale } = useLocale();
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
        <QuoteLineWarning line={line} className="mt-1 text-caption" />
      </td>

      <td className="py-3 pe-3">
        <code className="numeric text-small text-chalk-2">{line.skuCode}</code>
      </td>

      <td className="numeric py-3 pe-3 text-small text-blueprint whitespace-nowrap">
        {f.dimensions(widthUm, heightUm, unit)}
      </td>

      <td className="py-3 pe-3">
        <QuoteQtyStepper qty={line.qty} nickname={line.nickname} onChange={onQtyChange} />
      </td>

      <td className="numeric py-3 pe-3 text-end text-small text-chalk-2 whitespace-nowrap">
        {f.baht(line.priceSnapshot.unitPriceMinor)}
      </td>

      <td className="numeric py-3 pe-3 text-end text-body text-chalk whitespace-nowrap">
        {f.baht(line.priceSnapshot.totalMinor)}
      </td>

      <td className="py-3">
        <QuoteActions
          editHref={configureHref(locale, line)}
          nickname={line.nickname}
          onDuplicate={onDuplicate}
          onRemove={onRemove}
        />
      </td>
    </tr>
  );
}