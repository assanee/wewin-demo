import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, Ruler, Calculator, Send, Wrench } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { categories, products } from '@wewin/core/fixtures';
import {
  billableFloorSpan,
  leadTimeSpan,
  lowestPricePerSqm,
  summarizeCategories,
} from '@wewin/core/catalog-summary';
import { bahtToMinor } from '@wewin/core/money';

import { ButtonLink } from '@/components/common/Button';
import { CatalogContent } from '@/components/catalog/CatalogContent';
import { company } from '@/data/company';
import type { PlainKey } from '@/i18n/keys';
import { localeBundle, type LocaleBundle } from '@/i18n/server';
import {
  type LocaleRouteParams,
  catalogCategoryHref,
  catalogHref,
  languageAlternates,
  localeFromSegment,
  localeStaticParams,
} from '@/lib/routing';

/**
 * The home page — `pages/Home.tsx`, ported.
 *
 * Every figure on it is derived from `products.ts` rather than written into copy. The whole
 * proposition is "see the price before you talk to us", so a home page still advertising
 * last quarter's starting price would undercut the one thing the site is selling. That was
 * true in the Vite app and it survives the move unchanged: the same four aggregates, from
 * the same `@wewin/core/catalog-summary`, over the same fixture.
 *
 * ## What changed, and it is all framework
 *
 *   - `useLocale()` became `localeBundle(locale)` — the same six fields, taken from the
 *     `[locale]` segment instead of out of React context, because a server component has
 *     no provider above it. `i18n/server.ts` is where that trade is argued.
 *   - `react-router-dom`'s `Link to=` became `next/link`'s `href=`, through the typed
 *     helpers in `lib/routes.ts`.
 *   - `CatalogText` became `CatalogContent`, which is the same component with the locale as
 *     a prop. It says so at the top of its own file, including what has to happen to it.
 *   - `<title>` and `<meta description>` are now served rather than assigned after
 *     hydration. That is plan 8.7(1), and on this page it is the difference between a
 *     crawler reading `meta.title` in the language of the URL and reading the one Thai
 *     sentence `index.html` carried for all eight.
 *
 * **No `'use client'` anywhere on this page and nothing hydrates.** There is no state, no
 * effect and no browser global on the path, which is what makes it prerenderable in eight
 * languages and is also the property spec section 12 kept true for five phases so that this
 * move would be cheap.
 */

export const generateStaticParams = localeStaticParams;

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<LocaleRouteParams>;
}): Promise<Metadata> {
  const locale = localeFromSegment((await params).locale);
  if (locale === null) notFound();

  const { t } = localeBundle(locale);

  return {
    // `title.absolute`, not `title`: the layout sets a `%s · WEWIN180` template, and the
    // home page is the one route whose own title already *is* the brand. Left to the
    // template it would read `WEWIN180 · WEWIN180` on every tab and in every share card.
    title: { absolute: t('meta.title') },
    description: t('meta.description'),
    alternates: {
      canonical: `/${locale}`,
      languages: languageAlternates('/'),
    },
  };
}

export default async function HomePage({
  params,
}: {
  readonly params: Promise<LocaleRouteParams>;
}) {
  const locale = localeFromSegment((await params).locale);
  if (locale === null) notFound();

  const l = localeBundle(locale);
  const { t, f } = l;

  const summaries = summarizeCategories(products, categories);
  const catalogFrom = lowestPricePerSqm(products);
  const catalogLeadTime = leadTimeSpan(products);
  const billableFloor = billableFloorSpan(products);

  return (
    <main>
      {/* ---- Hero ---- */}
      <section aria-labelledby="hero-heading" className="container-page py-12 md:py-16 lg:py-24">
        <div className="max-w-180">
          {/* No founding year: it is not published anywhere we can cite, and an invented
              heritage claim is the same species of unverifiable number as the customer
              counts this page deliberately does without. */}
          <p className="numeric text-caption tracking-[0.22em] text-chalk-3 uppercase">
            {company.wordmark}
          </p>

          <h1 id="hero-heading" className="mt-4 text-display text-chalk lg:text-hero">
            {t('home.hero.line1')}
            <br />
            <span className="text-chalk-2">{t('home.hero.line2')}</span>
          </h1>

          <p className="mt-5 max-w-[54ch] text-lead text-chalk-2">{t('home.hero.body')}</p>

          <div className="mt-8">
            {/* The one primary action on this screen. `--lime` is capped at two per screen
                and the other is the starting price below — spec section 2. */}
            <ButtonLink href={catalogHref(locale)} variant="primary" size="lg">
              {t('home.hero.cta')}
              <ArrowRight size={18} aria-hidden />
            </ButtonLink>
          </div>
        </div>

        {/* Three facts, all computed from the catalog. Nothing here is a claim we cannot
            check: no customer counts, no project tallies, no awards. */}
        <dl className="mt-10 grid grid-cols-1 gap-px border border-line bg-line md:grid-cols-3">
          <FactCell
            l={l}
            termKey="home.fact.designs"
            value={t('count.designs', { count: products.length })}
          />
          <FactCell
            l={l}
            termKey="home.fact.startingPrice"
            value={catalogFrom === null ? t('value.unknown') : f.baht(bahtToMinor(catalogFrom))}
            suffix={catalogFrom === null ? undefined : t('price.perSqmSuffix')}
          />
          <FactCell
            l={l}
            termKey="home.fact.leadTime"
            value={
              catalogLeadTime === null
                ? t('value.unknown')
                : t('leadTime.range', { days: catalogLeadTime })
            }
          />
        </dl>

        <p className="numeric mt-4 text-caption text-chalk-3">{t('price.vatExcluded')}</p>
      </section>

      {/* ---- How it works ---- */}
      <section aria-labelledby="how-heading" className="container-page pb-14 md:pb-20">
        <h2 id="how-heading" className="text-title text-chalk">
          {t('home.how.heading')}
        </h2>
        <p className="mt-2 max-w-[60ch] text-body text-chalk-2">{t('home.how.body')}</p>

        {/* An ordered list because the order is the point — reading step 4 before step 1 is
            what makes people hesitate to type a measurement at all. */}
        <ol className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Step
            l={l}
            index={1}
            icon={Ruler}
            titleKey="home.step.measure.title"
            body={t('home.step.measure.body')}
          />
          <Step
            l={l}
            index={2}
            icon={Calculator}
            titleKey="home.step.price.title"
            body={t('home.step.price.body')}
          />
          <Step
            l={l}
            index={3}
            icon={Send}
            titleKey="home.step.request.title"
            body={t('home.step.request.body')}
          />
          <Step
            l={l}
            index={4}
            icon={Wrench}
            titleKey="home.step.survey.title"
            // The lead time is a *value* the entry decides where to put, not a
            // pre-formatted clause glued onto a stem. Thai tolerated the join; a language
            // that fronts the qualifier does not.
            body={t('home.step.survey.body', { days: catalogLeadTime })}
          />
        </ol>

        {/* The single most important sentence on the page. It is stated plainly and up
            front rather than buried in terms, because a customer who feels the price moved
            on them after measuring will not come back. */}
        <p className="mt-4 border border-line bg-panel px-4 py-3 text-body text-chalk">
          <Emphasised sentence={t('home.estimate.note')} fragment={t('home.estimate.emphasis')} />
        </p>
      </section>

      {/* ---- Categories ---- */}
      <section aria-labelledby="categories-heading" className="container-page pb-14 md:pb-20">
        <h2 id="categories-heading" className="text-title text-chalk">
          {t('home.categories.heading')}
        </h2>

        <ul className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          {summaries.map((summary, index) => (
            <li key={summary.category.id} className="min-w-0">
              <Link
                href={catalogCategoryHref(locale, summary.category.id)}
                className="group flex h-full min-w-0 flex-col gap-2 border border-line bg-panel p-4 transition-colors duration-180 ease-out hover:border-line-2 md:p-5"
              >
                <span className="numeric text-caption text-chalk-3">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <CatalogContent
                  locale={locale}
                  at={{ on: 'categoryLabel', categoryId: summary.category.id }}
                  th={summary.category.labelTh}
                  className="font-display text-lead text-chalk"
                />
                <CatalogContent
                  locale={locale}
                  at={{ on: 'categorySummary', categoryId: summary.category.id }}
                  th={summary.category.summaryTh}
                  className="min-w-0 text-small text-chalk-2"
                />

                {/* Same price row as ProductCard, deliberately — a different treatment for
                    the same fact reads as a different site. */}
                <div className="mt-auto flex items-end justify-between gap-3 border-t border-line pt-3">
                  <div className="min-w-0">
                    {summary.fromPricePerSqm === null ? (
                      <p className="text-small text-chalk-3">{t('home.category.empty')}</p>
                    ) : (
                      <>
                        <p className="text-caption text-chalk-3">{t('price.fromShort')}</p>
                        <p className="numeric text-lead text-chalk">
                          {f.baht(bahtToMinor(summary.fromPricePerSqm))}
                          <span className="text-small text-chalk-2">
                            {' '}
                            {t('price.perSqmSuffix')}
                          </span>
                        </p>
                        <p className="numeric mt-1 text-caption text-chalk-3">
                          {t('count.designs', { count: summary.productCount })}
                        </p>
                      </>
                    )}
                  </div>

                  <ArrowRight
                    size={16}
                    aria-hidden
                    className="mb-1 shrink-0 text-chalk-3 transition-[color,transform] duration-180 ease-out group-hover:translate-x-1 group-hover:text-chalk"
                  />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* ---- How the price is calculated ---- */}
      <section aria-labelledby="pricing-heading" className="container-page pb-16 md:pb-24">
        <h2 id="pricing-heading" className="text-title text-chalk">
          {t('home.pricing.heading')}
        </h2>
        <p className="mt-2 max-w-[60ch] text-body text-chalk-2">{t('home.pricing.body')}</p>

        {/* Left flat rather than folded into an Accordion. Each block is three lines, so
            nothing is long enough to need hiding — and putting the price caveats behind a
            tap would contradict the reason for showing prices at all. */}
        <div className="mt-6 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <PriceNote l={l} titleKey="home.pricing.formula.title">
            <p className="text-body text-chalk-2">{t('home.pricing.formula.body')}</p>
            <p className="mt-2 text-small text-chalk-3">{t('home.pricing.formula.note')}</p>
          </PriceNote>

          <PriceNote l={l} titleKey="home.pricing.floor.title">
            <p className="text-body text-chalk-2">{t('home.pricing.floor.body')}</p>
            <p className="mt-2 text-small text-chalk-3">
              <span className="numeric text-chalk-2">
                {t('home.pricing.floor.range', { span: billableFloor })}
              </span>{' '}
              {t('home.pricing.floor.note')}
            </p>
          </PriceNote>

          <PriceNote l={l} titleKey="home.pricing.excluded.title">
            <ul className="flex flex-col gap-1 text-body text-chalk-2">
              <li>{t('home.pricing.excluded.vat')}</li>
              <li>{t('home.pricing.excluded.install')}</li>
              <li>{t('home.pricing.excluded.delivery')}</li>
              <li>{t('home.pricing.excluded.removal')}</li>
            </ul>
            <p className="mt-2 text-small text-chalk-3">{t('home.pricing.excluded.note')}</p>
          </PriceNote>
        </div>
      </section>
    </main>
  );
}

function FactCell({
  l,
  termKey,
  value,
  suffix,
}: {
  l: LocaleBundle;
  termKey: PlainKey;
  value: string;
  // Explicitly `| undefined`: exactOptionalPropertyTypes is on, so a caller passing a
  // computed `string | undefined` would otherwise not type-check.
  suffix?: string | undefined;
}) {
  return (
    <div className="min-w-0 bg-panel px-4 py-4 md:px-5">
      <dt className="text-caption text-chalk-3">{l.t(termKey)}</dt>
      <dd className="numeric mt-1 min-w-0 truncate text-lead text-chalk">
        {value}
        {suffix ? <span className="text-small text-chalk-2"> {suffix}</span> : null}
      </dd>
    </div>
  );
}

/**
 * One sentence with one fragment of it picked out.
 *
 * The old markup split the sentence around a `<span className="text-warn">` at a position
 * only Thai word order justifies. Splitting it into three keys would have forced every
 * locale to keep the emphasis in the middle; keeping it as one key and locating the
 * fragment lets each locale put it wherever its own grammar does — the English entry ends
 * up emphasising a different span of the sentence entirely.
 *
 * A fragment that is not found renders the sentence plainly, so a translation that
 * paraphrases loses the highlight rather than the sentence.
 */
function Emphasised({ sentence, fragment }: { sentence: string; fragment: string }) {
  const at = fragment === '' ? -1 : sentence.indexOf(fragment);
  if (at === -1) return <>{sentence}</>;

  return (
    <>
      {sentence.slice(0, at)}
      <span className="text-warn">{fragment}</span>
      {sentence.slice(at + fragment.length)}
    </>
  );
}

function Step({
  l,
  index,
  icon: Icon,
  titleKey,
  body,
}: {
  l: LocaleBundle;
  index: number;
  icon: LucideIcon;
  titleKey: PlainKey;
  body: string;
}) {
  return (
    <li className="flex min-w-0 flex-col gap-2 border border-line bg-panel p-4 md:p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="numeric text-caption text-chalk-3">{String(index).padStart(2, '0')}</span>
        <Icon size={16} aria-hidden className="shrink-0 text-chalk-3" />
      </div>
      <h3 className="font-display text-body text-chalk">{l.t(titleKey)}</h3>
      <p className="min-w-0 text-small text-chalk-2">{body}</p>
    </li>
  );
}

function PriceNote({
  l,
  titleKey,
  children,
}: {
  l: LocaleBundle;
  titleKey: PlainKey;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col border border-line bg-panel p-4 md:p-5">
      <h3 className="font-display text-lead text-chalk">{l.t(titleKey)}</h3>
      <div className="mt-3 min-w-0">{children}</div>
    </div>
  );
}
