import Link from 'next/link';
import { Clock, Mail, MapPin, MessageCircle, Phone } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { company, type ContactChannel } from '../../data/company';
import type { PlainKey } from '../../i18n/keys';
import { SOURCE_LOCALE, type Locale } from '../../i18n/locales';
import {
  aboutHref,
  catalogHref,
  quoteHref,
  settingsHref,
  type AboutRoute,
  type CatalogRoute,
  type QuoteRoute,
  type SettingsRoute,
} from '../../lib/routing';
import { useLocale } from '../../state/localeContext';
import { IncompleteLocaleNotice } from './LanguagePicker';

/*
 * The union of the three route types rather than `string`, and `typedRoutes` is what
 * insists: `Link` takes `RouteImpl<T>`, built from the pages that exist, so a table of
 * footer links typed as `(locale: Locale) => string` puts every one of them back to being
 * unchecked. Written out as a union so that adding a fourth entry pointing at a page
 * nobody has written yet is a compile error in this file.
 */
type FooterRoute = CatalogRoute | AboutRoute | QuoteRoute | SettingsRoute;

const NAV_LINKS: { href: (locale: Locale) => FooterRoute; labelKey: PlainKey }[] = [
  { href: catalogHref, labelKey: 'nav.products' },
  { href: aboutHref, labelKey: 'nav.about' },
  { href: quoteHref, labelKey: 'nav.quote' },
  /*
   * The display settings live in the footer and not in the header, and that is a decision about
   * what the header is for. `AppHeader` already carries the language picker at 360px — the one
   * preference a visitor changes mid-task — and the unit picker sits with the three fields it
   * governs. This page is where those choices are *explained*, including the four that do
   * nothing yet, and an explanation belongs where somebody goes looking rather than in front of
   * somebody pricing a window.
   *
   * It is in the menu at all because a screen reachable only by typing a URL is a screen nobody
   * uses — `apps/dashboard/src/lib/nav/navigation.ts` records that exact failure for `/quotes`,
   * which shipped for a round with no entry.
   */
  { href: settingsHref, labelKey: 'settings.nav' },
];

/*
 * `_CLASS` in the name, and it is a convention with a check behind it.
 *
 * `scripts/check-tokens.mjs` half three asks "does every utility this app writes produce a
 * rule", and it can only ask that of utilities it can find — a class list held in a
 * constant is invisible to a scan of `className=` attributes. So a constant holding
 * utilities is named with `class` in it, the scanner reads those too, and
 * `tests/tokens.test.ts` fails if a component hides a class list somewhere neither can
 * see. This one was `SECTION_HEADING` in the Vite app and its three utilities were
 * unchecked the whole time.
 */
const SECTION_HEADING_CLASS = 'text-caption tracking-[0.08em] text-chalk-3 uppercase';

/**
 * The site's headline is "no need to leave your number first". That only reads as
 * confidence if *our* number is easy to find — otherwise it reads as a company you cannot
 * reach. So the contact details are laid out in full rather than parked behind a contact
 * page.
 *
 * The footer also carries the honest note about an incomplete language. It is not on
 * every route — `showsFooter` (`./footer-routes.ts`) limits it to the shop front: home,
 * `/products` and `/about`, times eight locales, twenty-four paths in total — but on the
 * routes it does appear on, it sits below the untranslated text rather than in front of it.
 */
export function AppFooter() {
  const { t, locale } = useLocale();

  // The registered name, the postal address and the published opening hours are source
  // content in Thai (see `data/company.ts`). Marking them is what stops a German page from
  // claiming they are German — it fixes the screen-reader voice and lets a `:lang(th)`
  // rule pick a face that can draw the script.
  const sourceLang = locale === SOURCE_LOCALE ? {} : { lang: SOURCE_LOCALE };

  return (
    <footer
      /* See `AppHeader` — `data-chrome` names the shell's own furniture for the print rule. */
      data-chrome
      className="mt-auto border-t border-line bg-panel"
    >
      <div className="container-page grid grid-cols-1 gap-8 py-10 md:grid-cols-2 md:py-12 lg:grid-cols-4">
        {/* Identity */}
        <div className="min-w-0">
          <p className="font-display text-lead tracking-[0.18em] text-chalk">{company.wordmark}</p>
          <p className="mt-2 text-caption text-chalk-3" {...sourceLang}>
            {company.legalNameTh}
          </p>
          <p className="mt-3 flex items-start gap-2 text-small text-chalk-2">
            <MapPin size={14} aria-hidden className="mt-1 shrink-0 text-chalk-3" />
            <span className="min-w-0" {...sourceLang}>
              {company.addressTh}
            </span>
          </p>
        </div>

        {/* Contact */}
        <section aria-labelledby="footer-contact-heading" className="min-w-0">
          <h2 id="footer-contact-heading" className={SECTION_HEADING_CLASS}>
            {t('footer.contact')}
          </h2>
          <ul className="mt-3 flex flex-col">
            {company.phones.map((phone) => (
              <li key={phone.valueTh} className="min-w-0">
                <ContactLink channel={phone} Icon={Phone} />
              </li>
            ))}
            <li className="min-w-0">
              <ContactLink channel={company.line} Icon={MessageCircle} />
            </li>
            <li className="min-w-0">
              <ContactLink channel={company.email} Icon={Mail} />
            </li>
          </ul>
        </section>

        {/* When — and where, once someone confirms the coverage area */}
        <section aria-labelledby="footer-hours-heading" className="min-w-0">
          <h2 id="footer-hours-heading" className={SECTION_HEADING_CLASS}>
            {t('footer.hours')}
          </h2>
          <p className="mt-3 flex items-start gap-2 text-small text-chalk-2">
            <Clock size={14} aria-hidden className="mt-1 shrink-0 text-chalk-3" />
            <span className="min-w-0" {...sourceLang}>
              {company.businessHoursTh}
            </span>
          </p>

          {company.serviceAreaTh ? (
            <>
              <h3 className={`mt-5 ${SECTION_HEADING_CLASS}`}>{t('footer.serviceArea')}</h3>
              <p className="mt-2 text-small text-chalk-2" {...sourceLang}>
                {company.serviceAreaTh}
              </p>
            </>
          ) : null}
        </section>

        {/* Navigation */}
        <nav aria-labelledby="footer-nav-heading" className="min-w-0">
          <h2 id="footer-nav-heading" className={SECTION_HEADING_CLASS}>
            {t('footer.menu')}
          </h2>
          <ul className="mt-3 flex flex-col">
            {NAV_LINKS.map((item) => (
              <li key={item.labelKey}>
                <Link
                  href={item.href(locale)}
                  className="inline-flex min-h-11 items-center text-small text-chalk-2 transition-colors duration-180 ease-out hover:text-chalk"
                >
                  {t(item.labelKey)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      <div className="border-t border-line">
        <div className="container-page flex flex-wrap items-center justify-between gap-2 py-4">
          {/* The year is the param and the era is `f.year`'s business: Thai writes
              พ.ศ. 2569 and English writes 2026 from the same number, both out of ICU.

              The registered name is Thai source content and stays Thai (see
              `data/company.ts`), so the line is split: the sentence is the catalogue's and
              the name is its own element carrying `lang="th"`. As one interpolated string
              it was unmarkable, and a screen reader read the company's name aloud in
              German. */}
          <p className="text-caption text-chalk-3">
            {t('footer.copyright', { year: COPYRIGHT_YEAR })}{' '}
            <span {...sourceLang}>{company.legalNameTh}</span>
          </p>
          <p className="numeric text-caption text-chalk-3">{t('price.vatExcluded')}</p>
        </div>
      </div>

      <div className="border-t border-line">
        <div className="container-page py-3">
          <IncompleteLocaleNotice />
        </div>
      </div>
    </footer>
  );
}

/**
 * Gregorian, and a constant rather than `new Date()`.
 *
 * A footer that changes on New Year's Eve without a deploy is a footer whose output
 * depends on the clock, which makes every snapshot of this page unreproducible — and on a
 * prerendered site it would additionally freeze whichever year the *build machine* was in
 * when it ran, which is worse than a constant because it looks like it is live.
 */
const COPYRIGHT_YEAR = 2026;

function ContactLink({ channel, Icon }: { channel: ContactChannel; Icon: LucideIcon }) {
  const { t } = useLocale();

  const content = (
    <>
      <Icon size={14} aria-hidden className="shrink-0 text-chalk-3" />
      <span className="sr-only">{t(channel.labelKey)}: </span>
      {/* Phone numbers, LINE ids and email addresses are read character by character,
          which is what `numeric` is for.

          Deliberately *not* through `f.integer`: a phone number is a string of digits that
          identifies a line, not a quantity. Grouping it by thousands or rewriting it in
          Burmese digits would make it undiallable. */}
      <span className="numeric min-w-0 truncate">{channel.valueTh}</span>
    </>
  );

  if (!channel.href) {
    return (
      <span className="flex min-h-11 items-center gap-2 text-small text-chalk-2">{content}</span>
    );
  }

  const external = channel.href.startsWith('http');

  return (
    <a
      href={channel.href}
      {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
      className="flex min-h-11 items-center gap-2 text-small text-chalk-2 transition-colors duration-180 ease-out hover:text-chalk"
    >
      {content}
    </a>
  );
}
