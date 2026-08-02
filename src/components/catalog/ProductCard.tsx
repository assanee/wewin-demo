import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import type { Product } from '../../types/catalog';
import { countProfileColors, getCustomGroup, getSkuGroup, measureRange } from '../../lib/filters';
import { formatBaht, formatCm, formatLeadTime } from '../../lib/format';
import { Badge } from '../common/Badge';
import { Schematic } from '../common/Schematic';

interface ProductCardProps {
  product: Product;
}

const defaultSwatch = (product: Product, groupCode: string, fallback: string): string => {
  const group = getSkuGroup(product, groupCode);
  const value = group?.values.find((candidate) => candidate.code === group.defaultValue);
  return value?.swatchHex ?? fallback;
};

export function ProductCard({ product }: ProductCardProps) {
  const width = getCustomGroup(product, 'width');
  const height = getCustomGroup(product, 'height');
  const range = measureRange(product, 'width');
  const colorCount = countProfileColors(product);

  return (
    <article className="group relative flex h-full min-w-0 flex-col border border-line bg-panel transition-colors duration-180 ease-out hover:border-line-2 focus-within:border-line-2">
      <div className="border-b border-line bg-ink/40 p-6 text-chalk-3">
        <div className="mx-auto h-[160px] w-full max-w-[240px]">
          <Schematic
            widthCm={width?.defaultValue ?? 100}
            heightCm={height?.defaultValue ?? 100}
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
              {product.nameTh}
            </Link>
          </h3>
          <p className="mt-1 text-small text-chalk-2">{product.summaryTh}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Badge>{colorCount} สีโปรไฟล์</Badge>
          {range ? (
            <Badge tone="blueprint" mono>
              ปรับขนาดได้ {formatCm(range.min)}–{formatCm(range.max)} {range.unit}
            </Badge>
          ) : null}
        </div>

        <div className="mt-auto flex items-end justify-between gap-3 border-t border-line pt-3">
          <div className="min-w-0">
            {/* Never a per-piece price here — the size is not known yet (spec 7). */}
            <p className="text-caption text-chalk-3">เริ่มต้น</p>
            <p className="numeric text-lead text-chalk">
              {formatBaht(product.pricePerSqm)}
              <span className="text-small text-chalk-2"> / ตร.ม.</span>
            </p>
            <p className="numeric mt-1 text-caption text-chalk-3">
              ผลิต {formatLeadTime(product.leadTimeDays)}
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
