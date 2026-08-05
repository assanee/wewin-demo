import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import type { Product } from '@wewin/core';
import { countProfileColors, getCustomGroup, getSkuGroup, measureRange } from '@wewin/core/filters';
import { bahtToMinor } from '@wewin/core/money';
import type { LengthUnit } from '@wewin/core/units';
import { Badge } from '../common/Badge';
import { CatalogText } from '../common/CatalogText';
import { Schematic } from '../common/Schematic';
import { useDisplayUnit } from '../../state/displayUnitContext';
import { useLocale } from '../../state/localeContext';
import type { Formatters } from '../../i18n/format';

interface ProductCardProps {
  product: Product;
}

const defaultSwatch = (product: Product, groupCode: string, fallback: string): string => {
  const group = getSkuGroup(product, groupCode);
  const value = group?.values.find((candidate) => candidate.code === group.defaultValue);
  return value?.swatchHex ?? fallback;
};

/**
 * The default size, as a proportion for the thumbnail and a sentence for its
 * accessible name.
 *
 * Both come from the same pair of groups, and neither is a length: the micrometres
 * turn into a ratio and a string here and go no further. `Number` on a bound is safe
 * and stays safe — the largest one in the catalogue is four metres, eleven orders of
 * magnitude inside what a double holds exactly.
 *
 * `unit` reaches the label and stops there. The ratio is a quotient of micrometres and
 * so is the same drawing in every unit, and nothing on this path can write a length
 * back — a card that re-rounded a catalogue default to show it in inches would be the
 * exact failure plan 4.1 forbids.
 */
const defaultSize = (
  product: Product,
  unit: LengthUnit,
  f: Formatters,
): { ratio: number; label: string } => {
  const width = getCustomGroup(product, 'width');
  const height = getCustomGroup(product, 'height');

  // The catalogue schema requires both groups on every product, so this is the
  // render-time echo of that guarantee rather than a case anyone can reach: a square
  // with nothing claimed about its size beats inventing one.
  if (!width || !height) return { ratio: 1, label: '' };

  return {
    ratio: Number(width.defaultUm) / Number(height.defaultUm),
    label: f.dimensions(width.defaultUm, height.defaultUm, unit),
  };
};

export function ProductCard({ product }: ProductCardProps) {
  // The unit the customer picked, not the one the row was authored in: the badge and
  // the size on the card have to agree with the configurator they lead to.
  const { unit } = useDisplayUnit();
  const { t, f } = useLocale();
  const size = defaultSize(product, unit, f);
  const range = measureRange(product, 'width');
  const colorCount = countProfileColors(product);

  return (
    <article className="group relative flex h-full min-w-0 flex-col border border-line bg-panel transition-colors duration-180 ease-out hover:border-line-2 focus-within:border-line-2">
      <div className="border-b border-line bg-ink/40 p-6 text-chalk-3">
        <div className="mx-auto h-[160px] w-full max-w-[240px]">
          <Schematic
            ratio={size.ratio}
            sizeLabel={size.label}
            elevation={product.elevation}
            profileHex={defaultSwatch(product, 'profile_color', '#7C7F85')}
            glassHex={defaultSwatch(product, 'glass_color', '#C9E4F7')}
          />
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4 md:p-5">
        <div className="min-w-0">
          <h3 className="text-lead text-chalk">
            <Link
              to={`/products/${product.slug}`}
              /* Stretched link: the whole card is the hit area, but only the title is
                 in the tab order and read out as the link. */
              className="after:absolute after:inset-0 after:content-['']"
            >
              <CatalogText at={{ on: 'productName', productId: product.id }} th={product.nameTh} />
            </Link>
          </h3>
          <p className="mt-1 text-small text-chalk-2">
            <CatalogText
              at={{ on: 'productSummary', productId: product.id }}
              th={product.summaryTh}
            />
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Badge>{t('product.colorCount', { count: colorCount })}</Badge>
          {range ? (
            <Badge tone="blueprint" mono>
              {/* `f.range` writes the unit itself, and its own ≈ when a bound cannot be
                  said exactly in the unit on screen — every authored bound is off the
                  eighth-inch grid, so imperial always earns the marker. The catalogue
                  entry decides where the numbers go in the sentence. */}
              {t('product.sizeRange', { minUm: range.minUm, maxUm: range.maxUm, unit })}
            </Badge>
          ) : null}
        </div>

        <div className="mt-auto flex items-end justify-between gap-3 border-t border-line pt-3">
          <div className="min-w-0">
            {/* Never a per-piece price here — the size is not known yet (spec 7). */}
            <p className="text-caption text-chalk-3">{t('price.from')}</p>
            <p className="numeric text-lead text-chalk">
              {f.baht(bahtToMinor(product.pricePerSqm))}
              <span className="text-small text-chalk-2"> {t('price.perSqmSuffix')}</span>
            </p>
            <p className="numeric mt-1 text-caption text-chalk-3">
              {t('leadTime.produce', { days: product.leadTimeDays })}
            </p>
          </div>

          <ArrowRight
            size={18}
            aria-hidden
            className="mb-1 shrink-0 text-chalk-3 transition-[color,transform] duration-180 ease-out group-hover:translate-x-1 group-hover:text-chalk"
          />
        </div>
      </div>
    </article>
  );
}
