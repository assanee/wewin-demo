import type { PriceBreakdown } from '../../lib/pricing';
import { formatBaht, formatSqm } from '../../lib/format';

interface PriceBreakdownListProps {
  price: PriceBreakdown;
  minBillableSqm: number;
}

export function PriceBreakdownList({ price, minBillableSqm }: PriceBreakdownListProps) {
  const minimumApplied = price.billableSqm > price.areaSqm;

  return (
    <dl className="flex flex-col gap-1.5">
      {minimumApplied ? (
        <p className="numeric mb-1 text-caption text-chalk-3">
          พื้นที่จริง {formatSqm(price.areaSqm)} ตร.ม. · คิดขั้นต่ำ {formatSqm(minBillableSqm)} ตร.ม.
        </p>
      ) : null}

      {price.lines.map((line) => (
        <div key={line.label} className="flex min-w-0 items-baseline justify-between gap-3">
          <dt className="min-w-0 flex-1 truncate text-small text-chalk-2">{line.label}</dt>
          <dd className="numeric shrink-0 text-small text-chalk">{formatBaht(line.amount)}</dd>
        </div>
      ))}

      <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-line pt-2">
        <dt className="text-small text-chalk-2">ราคาต่อชิ้น</dt>
        <dd className="numeric text-small text-chalk">{formatBaht(price.unitPrice)}</dd>
      </div>
    </dl>
  );
}
