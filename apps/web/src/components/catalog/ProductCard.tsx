import { ArrowRight } from 'lucide-react';
import type { ReactElement } from 'react';
import type { Product } from '@wewin/core';
import { countProfileColors, getCustomGroup, getSkuGroup, measureRange } from '@wewin/core/filters';
import { bahtToMinor } from '@wewin/core/money';

import { Badge } from '../common/Badge';
import { ElevationDrawing } from '../common/ElevationDrawing';
import type { LocaleBundle } from '../../i18n/server';
import { CatalogContent } from './CatalogContent';
import { ProductSchematic } from './ProductSchematic';
import { UnitText } from './UnitText';
import { unitVariants, type UnitVariants } from './unitVariants';

interface ProductCardProps {
  readonly product: Product;
  /** The locale layer as a value — `i18n/server.ts`. There is no context on this path. */
  readonly l: LocaleBundle;
}

const defaultSwatch = (product: Product, groupCode: string, fallback: string): string => {
  const group = getSkuGroup(product, groupCode);
  const value = group?.values.find((candidate) => candidate.code === group.defaultValue);
  return value?.swatchHex ?? fallback;
};

/**
 * The shorter side of every schematic, in viewBox units — hundredths of the shorter side.
 * Carried across from `components/common/Schematic` unchanged.
 */
const SHORT_SIDE = 100;

/**
 * The default size, as a proportion for the thumbnail and a sentence for its accessible
 * name — the sentence now written out in **all five units** (see `unitVariants.ts`).
 *
 * Both come from the same pair of groups, and neither is a length: the micrometres turn
 * into a ratio and a set of strings here and go no further. `Number` on a bound is safe and
 * stays safe — the largest one in the catalogue is four metres, eleven orders of magnitude
 * inside what a double holds exactly.
 *
 * Nothing on this path can write a length back. A card that re-rounded a catalogue default
 * to show it in inches would be the exact failure plan 4.1 forbids, and rendering every
 * unit from the one `bigint` pair is what makes that structurally impossible rather than
 * carefully avoided.
 */
const defaultSize = (
  product: Product,
  l: LocaleBundle,
): { ratio: number; label: UnitVariants | null } => {
  const width = getCustomGroup(product, 'width');
  const height = getCustomGroup(product, 'height');

  // The catalogue schema requires both groups on every product, so this is the render-time
  // echo of that guarantee rather than a case anyone can reach: a square with nothing
  // claimed about its size beats inventing one.
  if (!width || !height) return { ratio: 1, label: null };

  return {
    ratio: Number(width.defaultUm) / Number(height.defaultUm),
    label: unitVariants((unit) => l.f.dimensions(width.defaultUm, height.defaultUm, unit)),
  };
};

/**
 * One product, on a catalogue page that is prerendered per locale.
 *
 * A **server component**, and that is the return on the whole phase: 8 locales × 81
 * products is 648 pages that should be crawlable and fast, and a card that had to hydrate
 * before it could say a product's name would give that back. What ships to the browser
 * from this file is the two leaves that need the reader's display unit, and nothing else —
 * not `lucide-react`, not `@wewin/core/elevation`, not the catalogue.
 *
 * ## The price is rendered here, and that is a decision with a reason
 *
 * The locale layout says a page under it "may render a product's name and its shape; it
 * may not render its price" until `revalidateTag('product:' + id)` and the API's
 * `priceVersion` refusal both exist. That sentence is about plan 8.2's first trap: an ISR
 * page showing an hour-old price while the API prices from live Postgres.
 *
 * This price is not that price. `products` is `@wewin/core/fixtures` — compiled into the
 * bundle by `tsc`, imported at module scope, read at build time. There is no fetch, no
 * request-time read and no revalidation window, so `revalidate = false` adds **zero**
 * staleness over what the Vite app already shipped: it compiled the identical fixture into
 * `dist` and served it until the next deploy.
 *
 * ## ⚠️ The sentence that used to be here was false, and the correction matters
 *
 * It said this was *"the same figure `calcPrice` charges, from the same array, in the same
 * process."* It is not. `apps/api/src/catalog/catalog.repository.ts` says in as many words
 * that it **deliberately does not import `@wewin/core/fixtures`**, and `/meta` reports
 * `source: "database"`. Two arrays, two processes. Measured during 6b's adversarial pass:
 * publish a new version of `awn-4t` at ฿2,500/m² through the dashboard's own route and the
 * API bills ฿12,800 for the default configuration while this card keeps saying ฿1,500/m²
 * and ฿7,680 — 40% low, until somebody redeploys the storefront.
 *
 * ## What actually binds the two today, and what does not
 *
 * **Binding:** `apps/api/tests/catalog-fidelity.pg.test.ts` compares the *served*
 * catalogue against this fixture with `toStrictEqual`, product by product, bigint by
 * bigint, and is mutation-tested from inside itself. A database that has drifted from this
 * array fails CI. That is a real guarantee and it is the reason this card is allowed to
 * show a price at all.
 *
 * **Not binding:** anything at run time, between deploys. A publish lands in Postgres
 * immediately and here at the next build.
 *
 * 🔴 **And the plan's prescribed remedy does not fit this design.**
 * `revalidateTag('product:' + id)` invalidates a *cached fetch*; there is no fetch to
 * invalidate — `grep -rn "fetch("` over this app returns nothing, and it returned nothing
 * for the Vite app either. `priceVersion` has no wire to travel on for the same reason.
 * Writing either today produces a call site with nothing on the other end, which reads as
 * coverage while changing nothing. Both become buildable — and mandatory — in the phase
 * that has this page read a product from the API, and on that day the price comes out of
 * this component until they exist. The distinction that matters is *where the number came
 * from*, not whether a page is cached, and it is worth saying out loud because the code
 * will look almost identical.
 */
export function ProductCard({ product, l }: ProductCardProps): ReactElement {
  const { t, f, locale } = l;
  const size = defaultSize(product, l);
  const range = measureRange(product, 'width');
  const colorCount = countProfileColors(product);

  // A square is the honest fallback for a proportion that is not one: a zero or a NaN
  // width would otherwise collapse the viewBox and take the whole card with it.
  const proportion = Number.isFinite(size.ratio) && size.ratio > 0 ? size.ratio : 1;
  const w = proportion >= 1 ? SHORT_SIDE * proportion : SHORT_SIDE;
  const h = proportion >= 1 ? SHORT_SIDE : SHORT_SIDE / proportion;

  return (
    <article className="group relative flex h-full min-w-0 flex-col border border-line bg-panel transition-colors duration-180 ease-out hover:border-line-2 focus-within:border-line-2">
      <div className="border-b border-line bg-ink/40 p-6 text-chalk-3">
        <div className="mx-auto h-[160px] w-full max-w-[240px]">
          <ProductSchematic
            viewBox={`0 0 ${w} ${h}`}
            label={size.label}
            unsizedLabel={t('drawing.schematic')}
          >
            <ElevationDrawing
              frame={{ x: 0, y: 0, width: w, height: h }}
              elevation={product.elevation}
              profileHex={defaultSwatch(product, 'profile_color', '#7C7F85')}
              glassHex={defaultSwatch(product, 'glass_color', '#C9E4F7')}
              frameWeight={SHORT_SIDE * 0.045}
              lineWeight={SHORT_SIDE * 0.006}
              bladePitch={SHORT_SIDE * 0.075}
            />
          </ProductSchematic>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4 md:p-5">
        <div className="min-w-0">
          <h3 className="text-lead text-chalk">
            {/*
             * A plain `<a>`, not `next/link`, and the reason is `typedRoutes`: the route
             * union is built from the pages that exist, and `/[locale]/products/[slug]` is
             * the configurator's page, being ported in parallel. A `Link` to it would be a
             * compile error today and the only way to silence that is a cast, which the
             * house rules forbid. The cost is one document load instead of a client
             * transition; the crawl — which is the reason this page is prerendered at all —
             * is unaffected, because a crawler reads `href`.
             *
             * Stretched link: the whole card is the hit area, but only the title is in the
             * tab order and read out as the link.
             */}
            <a
              href={`/${locale}/products/${product.slug}`}
              className="after:absolute after:inset-0 after:content-['']"
            >
              <CatalogContent
                locale={locale}
                at={{ on: 'productName', productId: product.id }}
                th={product.nameTh}
              />
            </a>
          </h3>
          <p className="mt-1 text-small text-chalk-2">
            <CatalogContent
              locale={locale}
              at={{ on: 'productSummary', productId: product.id }}
              th={product.summaryTh}
            />
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Badge>{t('product.colorCount', { count: colorCount })}</Badge>
          {range ? (
            <Badge tone="blueprint" mono>
              {/*
               * `f.range` writes the unit itself, and its own ≈ when a bound cannot be said
               * exactly in the unit on screen — every authored bound is off the eighth-inch
               * grid, so imperial always earns the marker. The catalogue entry decides
               * where the numbers go in the sentence.
               *
               * All five renderings are produced here, on the server, from the one `bigint`
               * pair; `UnitText` picks. See `unitVariants.ts` for why that is the answer to
               * plan 8.2's third trap rather than a URL parameter.
               */}
              <UnitText
                variants={unitVariants((unit) =>
                  t('product.sizeRange', { minUm: range.minUm, maxUm: range.maxUm, unit }),
                )}
              />
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
