import { Link } from 'react-router-dom';
import { Clock, Mail, MapPin, MessageCircle, Phone } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { company, type ContactChannel } from '../../data/company';
import type { PlainKey } from '../../i18n/keys';
import { SOURCE_LOCALE } from '../../i18n/locales';
import { useLocale } from '../../state/localeContext';
import { IncompleteLocaleNotice } from './LanguagePicker';

const NAV_LINKS: { to: string; labelKey: PlainKey }[] = [
  { to: '/products', labelKey: 'nav.products' },
  { to: '/about', labelKey: 'nav.about' },
  { to: '/quote', labelKey: 'nav.quote' },
];

const SECTION_HEADING = 'text-caption tracking-[0.08em] text-chalk-3 uppercase';

/**
 * The site's headline is "no need to leave your number first". That only reads as
 * confidence if *our* number is easy to find — otherwise it reads as a company you
 * cannot reach. So the contact details are laid out in full rather than parked
 * behind a contact page.
 *
 * The footer also carries the honest note about an incomplete language: it is the one
 * strip that appears on every route, and it sits below the untranslated text rather
 * than in front of it.
 */
export function AppFooter() {
  const { t, locale } = useLocale();

  // The registered name, the postal address and the published opening hours are source
  // content in Thai (see `data/company.ts`). Marking them is what stops a German page
  // from claiming they are German — it fixes the screen-reader voice and lets a
  // `:lang(th)` rule pick a face that can draw the script.
  const sourceLang = locale === SOURCE_LOCALE ? {} : { lang: SOURCE_LOCALE };

  return (
    <footer className="mt-auto border-t border-line bg-panel">
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
          <h2 id="footer-contact-heading" className={SECTION_HEADING}>
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
          <h2 id="footer-hours-heading" className={SECTION_HEADING}>
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
              <h3 className={`mt-5 ${SECTION_HEADING}`}>{t('footer.serviceArea')}</h3>
              <p className="mt-2 text-small text-chalk-2" {...sourceLang}>
                {company.serviceAreaTh}
              </p>
            </>
          ) : null}
        </section>

        {/* Navigation */}
        <nav aria-labelledby="footer-nav-heading" className="min-w-0">
          <h2 id="footer-nav-heading" className={SECTION_HEADING}>
            {t('footer.menu')}
          </h2>
          <ul className="mt-3 flex flex-col">
            {NAV_LINKS.map((item) => (
              <li key={item.to}>
                <Link
                  to={item.to}
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
              พ.ศ. 2569 and English writes 2026 from the same number, both out of ICU. It
              was a literal before, and then briefly `p.year + 543` inside the Thai entry —
              which put 2569 on every page that falls back to Thai, i.e. six of eight.

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
 * depends on the clock, which makes every snapshot of this page unreproducible. The
 * value was already fixed before this round — it was written into the Thai string as
 * พ.ศ. 2569 — and this only moves it out where the catalogue can convert it.
 */
const COPYRIGHT_YEAR = 2026;

function ContactLink({ channel, Icon }: { channel: ContactChannel; Icon: LucideIcon }) {
  const { t } = useLocale();

  const content = (
    <>
      <Icon size={14} aria-hidden className="shrink-0 text-chalk-3" />
      <span className="sr-only">{t(channel.labelKey)}: </span>
      {/* Phone numbers, LINE ids and email addresses are read character by
          character, which is what `numeric` is for.

          Deliberately *not* through `f.integer`: a phone number is a string of digits
          that identifies a line, not a quantity. Grouping it by thousands or rewriting
          it in Burmese digits would make it undiallable. */}
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
