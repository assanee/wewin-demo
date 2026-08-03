import { AlertTriangle } from 'lucide-react';
import type { QuoteLine } from '@wewin/core/quote';
import { formatBaht, formatDimensions } from '@wewin/core/format';
import { QuoteActions, QuoteQtyStepper } from './QuoteActions';

interface QuoteLineRowProps {
  line: QuoteLine;
  onQtyChange: (qty: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}

/** Desktop only (lg). The mobile equivalent is QuoteLineCard — never both at once. */
export function QuoteLineRow({ line, onQtyChange, onDuplicate, onRemove }: QuoteLineRowProps) {
  const width = line.measures['width'] ?? 0;
  const height = line.measures['height'] ?? 0;

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
        {formatDimensions(width, height, 'cm')}
      </td>

      <td className="py-3 pe-3">
        <QuoteQtyStepper qty={line.qty} nickname={line.nickname} onChange={onQtyChange} />
      </td>

      <td className="numeric py-3 pe-3 text-end text-small text-chalk-2 whitespace-nowrap">
        {formatBaht(line.priceSnapshot.unitPrice)}
      </td>

      <td className="numeric py-3 pe-3 text-end text-body text-chalk whitespace-nowrap">
        {formatBaht(line.priceSnapshot.total)}
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
