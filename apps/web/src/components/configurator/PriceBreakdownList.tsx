import type { PriceBreakdown } from '@wewin/core/pricing';
import { messageIdentity } from '../../i18n/messages';
import { useLocale } from '../../state/localeContext';

interface PriceBreakdownListProps {
  price: PriceBreakdown;
  /** Exact µm², like everything else on this screen. Divided out by the formatter, once. */
  minBillableSqUm: bigint;
}

/**
 * The other component plan section 5 names.
 *
 * `PriceLine.label` was `` `${group.labelTh} · ${value.labelTh}` `` — two catalogue
 * strings welded together by a separator `pricing.ts` chose. All three parts were
 * somebody else's: the labels belong to the catalogue and the `·` belongs to the
 * locale's typography. The row now carries a `Message`, and both decisions are taken
 * here.
 *
 * The `key` had to change with it. It was `line.label`, which worked only while the
 * label was a Thai string that happened to be unique — a rendered sentence would make
 * every key in the list change on a language switch, forcing React to discard and
 * rebuild all of it, and two rows whose translations collided would trip the duplicate
 * key warning in one language and not another. `messageIdentity` is built from the key
 * and the refs and never from the words.
 */
export function PriceBreakdownList({ price, minBillableSqUm }: PriceBreakdownListProps) {
  const { t, f, message } = useLocale();
  // Compared in exact µm², not in the `double` square metres beside them. The comparison
  // and the two numbers the sentence prints are then the same quantity, so the notice
  // cannot appear above a pair of areas that read as equal.
  const minimumApplied = price.billableSqUm > price.areaSqUm;

  return (
    <dl className="flex flex-col gap-1.5">
      {minimumApplied ? (
        <p className="numeric mb-1 text-caption text-chalk-3">
          {t('breakdown.minimumApplied', { areaSqUm: price.areaSqUm, minBillableSqUm })}
        </p>
      ) : null}

      {price.lines.map((line) => {
        const label = message(line.label);

        return (
          <div
            key={messageIdentity(line.label)}
            className="flex min-w-0 items-baseline justify-between gap-3"
          >
            <dt
              className="min-w-0 flex-1 truncate text-small text-chalk-2"
              {...(label.fallback ? { lang: 'th' } : {})}
            >
              {label.text}
            </dt>
            <dd className="numeric shrink-0 text-small text-chalk">{f.baht(line.amountMinor)}</dd>
          </div>
        );
      })}

      <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-line pt-2">
        <dt className="text-small text-chalk-2">{t('price.unit')}</dt>
        <dd className="numeric text-small text-chalk">{f.baht(price.unitPriceMinor)}</dd>
      </div>
    </dl>
  );
}
