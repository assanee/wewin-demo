import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Clock, Mail, MapPin, MessageCircle, Phone, Truck } from 'lucide-react';
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
import { company, type ContactChannel } from '@/data/company';
import type { PlainKey } from '@/i18n/keys';
import { SOURCE_LOCALE } from '@/i18n/locales';
import { localeBundle, type LocaleBundle } from '@/i18n/server';
import {
  type LocaleRouteParams,
  catalogHref,
  languageAlternates,
  localeFromSegment,
  localeStaticParams,
} from '@/lib/routing';

/**
 * The about page — `pages/About.tsx`, ported.
 *
 * Everything here is either a figure derived from `products.ts` or a sentence the company
 * publishes about itself. There is no origin story, no founding year, no project count and
 * no certification list — none of that is documented anywhere we can cite, and an About
 * page is precisely where invented history goes unchallenged.
 *
 * What is left is narrow but true, which suits a site whose whole pitch is that the numbers
 * are on the table before you ask.
 *
 * Server-rendered end to end: no state, no effect, no browser global, nothing hydrates.
 * The Thai company facts still carry `lang="th"` at the element — and that attribute is
 * worth more here than it was in the Vite app, because the document around them now
 * genuinely declares the reader's language in the *response* rather than after hydration
 * (plan 8.7(1)). A German page reading a Thai postal address in a German voice was the
 * failure; both halves of the fix are now in the first byte.
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
    title: t('about.heading'),
    description: t('about.intro'),
    alternates: {
      canonical: `/${locale}/about`,
      languages: languageAlternates('/about'),
    },
  };
}

export default async function AboutPage({
  params,
}: {
  readonly params: Promise<LocaleRouteParams>;
}) {
  const locale = localeFromSegment((await params).locale);
  if (locale === null) notFound();

  const l = localeBundle(locale);
  const { t, f } = l;

  // The registered name, the address and the published hours are source content in Thai —
  // see `data/company.ts`. Marked, not translated.
  const sourceLang = locale === SOURCE_LOCALE ? {} : { lang: SOURCE_LOCALE };
  const summaries = summarizeCategories(products, categories);
  const catalogFrom = lowestPricePerSqm(products);
  const catalogLeadTime = leadTimeSpan(products);
  const billableFloor = billableFloorSpan(products);

  const stockedCategories = summaries.filter((summary) => summary.productCount > 0);

  return (
    <main>
      {/* ---- Intro ---- */}
      <section aria-labelledby="about-heading" className="container-page py-12 md:py-16 lg:py-20">
        <div className="max-w-180">
          <p className="numeric text-caption tracking-[0.22em] text-chalk-3 uppercase">
            {company.wordmark}
          </p>

          <h1 id="about-heading" className="mt-4 text-display text-chalk">
            {t('about.heading')}
          </h1>

          {/* The intro is catalogue prose and nothing else. The two Thai company clauses it
              used to splice in — what we make, where we deliver — are below, each as its own
              element carrying `lang="th"`.

              That is not tidiness. `…makes บานเกล็ดปรับระดับได้…, and we จัดส่งและติดตั้ง…` is a Thai
              *verb phrase* conjugated into an English grammatical frame: it cannot be
              marked, because it is mid-string; it cannot be declined, which German needs;
              and it cannot take a postposition, which Hindi needs. Core's own `message.ts`
              declares the pre-composed clause abolished, and this page was still building
              one. */}
          <p className="mt-5 text-lead text-chalk-2">{t('about.intro')}</p>

          <dl className="mt-5 flex flex-col gap-3">
            <div>
              <dt className="text-caption text-chalk-3">{t('about.fact.makes')}</dt>
              <dd className="text-body text-chalk-2" {...sourceLang}>
                {company.makesTh}
              </dd>
            </div>
            {company.serviceAreaTh === null ? null : (
              <div>
                <dt className="text-caption text-chalk-3">{t('about.fact.serviceArea')}</dt>
                <dd className="text-body text-chalk-2" {...sourceLang}>
                  {company.serviceAreaTh}
                </dd>
              </div>
            )}
            <div>
              <dt className="text-caption text-chalk-3">{t('about.fact.legalName')}</dt>
              <dd className="text-body text-chalk-2" {...sourceLang}>
                {company.legalNameTh}
              </dd>
            </div>
          </dl>

          <p className="mt-4 max-w-[62ch] text-body text-chalk-2">{t('about.tool')}</p>
        </div>
      </section>

      {/* ---- The stance ---- */}
      <section aria-labelledby="stance-heading" className="container-page pb-14 md:pb-20">
        <h2 id="stance-heading" className="text-title text-chalk">
          {t('about.stance.heading')}
        </h2>

        <div className="mt-6 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <StanceNote
            l={l}
            titleKey="about.stance.noPhone.title"
            bodyKey="about.stance.noPhone.body"
          />
          <StanceNote
            l={l}
            titleKey="about.stance.itemised.title"
            bodyKey="about.stance.itemised.body"
          />
          <StanceNote
            l={l}
            titleKey="about.stance.limits.title"
            bodyKey="about.stance.limits.body"
          />
        </div>
      </section>

      {/* ---- What we make ---- */}
      <section aria-labelledby="range-heading" className="container-page pb-14 md:pb-20">
        <h2 id="range-heading" className="text-title text-chalk">
          {t('about.range.heading')}
        </h2>
        <p className="mt-2 max-w-[60ch] text-body text-chalk-2">{t('about.range.body')}</p>

        <dl className="mt-6 grid grid-cols-1 gap-px border border-line bg-line md:grid-cols-2 lg:grid-cols-4">
          <Fact
            l={l}
            termKey="home.fact.designs"
            value={t('count.designs', { count: products.length })}
            note={t('about.fact.designs.note', { categories: stockedCategories.length })}
          />
          <Fact
            l={l}
            termKey="home.fact.startingPrice"
            value={
              catalogFrom === null
                ? t('value.unknown')
                : `${f.baht(bahtToMinor(catalogFrom))} ${t('price.perSqmSuffix')}`
            }
            note={t('about.fact.startingPrice.note')}
          />
          <Fact
            l={l}
            termKey="home.fact.leadTime"
            value={
              catalogLeadTime === null
                ? t('value.unknown')
                : t('leadTime.range', { days: catalogLeadTime })
            }
            note={t('about.fact.leadTime.note')}
          />
          <Fact
            l={l}
            termKey="about.fact.floor"
            value={t('home.pricing.floor.range', { span: billableFloor })}
            note={t('about.fact.floor.note')}
          />
        </dl>

        {/* A plain list rather than the home page's card grid: here the point is how wide
            the range is, not picking something out of it. */}
        <ul className="mt-6 grid grid-cols-1 gap-x-8 md:grid-cols-2">
          {stockedCategories.map((summary) => (
            <li
              key={summary.category.id}
              className="flex min-w-0 items-baseline justify-between gap-3 border-b border-line py-2"
            >
              <CatalogContent
                locale={locale}
                at={{ on: 'categoryLabel', categoryId: summary.category.id }}
                th={summary.category.labelTh}
                className="min-w-0 truncate text-body text-chalk-2"
              />
              <span className="numeric shrink-0 text-small text-chalk-3">
                {t('count.designs', { count: summary.productCount })}
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-8">
          <ButtonLink href={catalogHref(locale)} variant="primary" size="lg">
            {t('home.hero.cta')}
          </ButtonLink>
        </div>
      </section>

      {/* ---- Where and how to reach us ---- */}
      <section aria-labelledby="contact-heading" className="container-page pb-16 md:pb-24">
        <h2 id="contact-heading" className="text-title text-chalk">
          {t('about.contact.heading')}
        </h2>

        <div className="mt-6 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <InfoCard l={l} titleKey="about.card.factory" Icon={MapPin}>
            <p className="text-body text-chalk-2" {...sourceLang}>
              {company.addressTh}
            </p>
          </InfoCard>

          <InfoCard l={l} titleKey="about.card.delivery" Icon={Truck}>
            <p className="text-body text-chalk-2" {...sourceLang}>
              {company.serviceAreaTh}
            </p>
            <p className="mt-2 text-small text-chalk-3">{t('about.card.delivery.note')}</p>
          </InfoCard>

          <InfoCard l={l} titleKey="about.card.hours" Icon={Clock}>
            <p className="text-body text-chalk-2" {...sourceLang}>
              {company.businessHoursTh}
            </p>
            <p className="mt-2 text-small text-chalk-3">{t('about.card.hours.note')}</p>
          </InfoCard>
        </div>

        {/* Repeated from the footer on purpose: an About page that makes you scroll past it
            to find a phone number is the behaviour the "no need to leave your number first"
            line is arguing against. */}
        <ul className="mt-6 flex flex-col gap-2 md:flex-row md:flex-wrap">
          {company.phones.map((phone) => (
            <li key={phone.valueTh} className="min-w-0">
              <ChannelChip l={l} channel={phone} Icon={Phone} />
            </li>
          ))}
          <li className="min-w-0">
            <ChannelChip l={l} channel={company.line} Icon={MessageCircle} />
          </li>
          <li className="min-w-0">
            <ChannelChip l={l} channel={company.email} Icon={Mail} />
          </li>
        </ul>
      </section>
    </main>
  );
}

function StanceNote({
  l,
  titleKey,
  bodyKey,
}: {
  l: LocaleBundle;
  titleKey: PlainKey;
  bodyKey: PlainKey;
}) {
  return (
    <div className="flex min-w-0 flex-col border border-line bg-panel p-4 md:p-5">
      <h3 className="font-display text-lead text-chalk">{l.t(titleKey)}</h3>
      <p className="mt-3 min-w-0 text-small text-chalk-2">{l.t(bodyKey)}</p>
    </div>
  );
}

function Fact({
  l,
  termKey,
  value,
  note,
}: {
  l: LocaleBundle;
  termKey: PlainKey;
  value: string;
  note: string;
}) {
  return (
    <div className="min-w-0 bg-panel px-4 py-4 md:px-5">
      <dt className="text-caption text-chalk-3">{l.t(termKey)}</dt>
      <dd className="min-w-0">
        <span className="numeric block truncate text-lead text-chalk">{value}</span>
        <span className="block text-caption text-chalk-3">{note}</span>
      </dd>
    </div>
  );
}

function InfoCard({
  l,
  titleKey,
  Icon,
  children,
}: {
  l: LocaleBundle;
  titleKey: PlainKey;
  Icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col border border-line bg-panel p-4 md:p-5">
      <div className="flex items-center gap-2">
        <Icon size={15} aria-hidden className="shrink-0 text-chalk-3" />
        <h3 className="font-display text-lead text-chalk">{l.t(titleKey)}</h3>
      </div>
      <div className="mt-3 min-w-0">{children}</div>
    </div>
  );
}

function ChannelChip({
  l,
  channel,
  Icon,
}: {
  l: LocaleBundle;
  channel: ContactChannel;
  Icon: LucideIcon;
}) {
  const inner = (
    <>
      <Icon size={15} aria-hidden className="shrink-0 text-chalk-3" />
      <span className="sr-only">{l.t(channel.labelKey)}: </span>
      {/* Never through `f.integer`: a phone number identifies a line, it is not a quantity,
          and grouping or transliterating it makes it undiallable. */}
      <span className="numeric min-w-0 truncate text-small">{channel.valueTh}</span>
    </>
  );

  const shared =
    'flex min-h-11 min-w-0 items-center gap-2 rounded-xs border border-line bg-panel-2 px-3 text-chalk-2';

  if (!channel.href) return <span className={shared}>{inner}</span>;

  return (
    <a
      href={channel.href}
      {...(channel.href.startsWith('http')
        ? { target: '_blank', rel: 'noreferrer noopener' }
        : {})}
      className={`${shared} transition-colors duration-180 ease-out hover:border-line-2 hover:text-chalk`}
    >
      {inner}
    </a>
  );
}
