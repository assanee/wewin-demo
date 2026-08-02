import { Link } from 'react-router-dom';
import { Clock, Mail, MapPin, MessageCircle, Phone } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { company, type ContactChannel } from '../../data/company';

const NAV_LINKS = [
  { to: '/products', labelTh: 'สินค้า' },
  { to: '/about', labelTh: 'เกี่ยวกับเรา' },
  { to: '/quote', labelTh: 'ตะกร้า' },
];

const SECTION_HEADING = 'text-caption tracking-[0.08em] text-chalk-3 uppercase';

/**
 * The site's headline is "no need to leave your number first". That only reads as
 * confidence if *our* number is easy to find — otherwise it reads as a company you
 * cannot reach. So the contact details are laid out in full rather than parked
 * behind a contact page.
 */
export function AppFooter() {
  return (
    <footer className="mt-auto border-t border-line bg-panel">
      <div className="container-page grid grid-cols-1 gap-8 py-10 md:grid-cols-2 md:py-12 lg:grid-cols-4">
        {/* Identity */}
        <div className="min-w-0">
          <p className="font-display text-lead tracking-[0.18em] text-chalk">{company.wordmark}</p>
          <p className="mt-2 text-caption text-chalk-3">{company.legalNameTh}</p>
          <p className="mt-3 flex items-start gap-2 text-small text-chalk-2">
            <MapPin size={14} aria-hidden className="mt-1 shrink-0 text-chalk-3" />
            <span className="min-w-0">{company.addressTh}</span>
          </p>
        </div>

        {/* Contact */}
        <section aria-labelledby="footer-contact-heading" className="min-w-0">
          <h2 id="footer-contact-heading" className={SECTION_HEADING}>
            ติดต่อเรา
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
            เวลาทำการ
          </h2>
          <p className="mt-3 flex items-start gap-2 text-small text-chalk-2">
            <Clock size={14} aria-hidden className="mt-1 shrink-0 text-chalk-3" />
            <span className="min-w-0">{company.businessHoursTh}</span>
          </p>

          {company.serviceAreaTh ? (
            <>
              <h3 className={`mt-5 ${SECTION_HEADING}`}>พื้นที่ให้บริการ</h3>
              <p className="mt-2 text-small text-chalk-2">{company.serviceAreaTh}</p>
            </>
          ) : null}
        </section>

        {/* Navigation */}
        <nav aria-labelledby="footer-nav-heading" className="min-w-0">
          <h2 id="footer-nav-heading" className={SECTION_HEADING}>
            เมนู
          </h2>
          <ul className="mt-3 flex flex-col">
            {NAV_LINKS.map((item) => (
              <li key={item.to}>
                <Link
                  to={item.to}
                  className="inline-flex min-h-11 items-center text-small text-chalk-2 transition-colors duration-180 ease-out hover:text-chalk"
                >
                  {item.labelTh}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      <div className="border-t border-line">
        <div className="container-page flex flex-wrap items-center justify-between gap-2 py-4">
          <p className="text-caption text-chalk-3">© พ.ศ. 2569 {company.legalNameTh}</p>
          <p className="numeric text-caption text-chalk-3">ราคายังไม่รวม VAT 7%</p>
        </div>
      </div>
    </footer>
  );
}

function ContactLink({ channel, Icon }: { channel: ContactChannel; Icon: LucideIcon }) {
  const content = (
    <>
      <Icon size={14} aria-hidden className="shrink-0 text-chalk-3" />
      <span className="sr-only">{channel.labelTh}: </span>
      {/* Phone numbers, LINE ids and email addresses are read character by
          character, which is what `numeric` is for. */}
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
