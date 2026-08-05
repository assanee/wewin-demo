import type { PlainKey } from '../i18n/keys';

/**
 * Company identity and contact details.
 *
 * Source: https://www.wewin180.com/th/contact (fetched 2 ส.ค. 2569, cross-checked
 * against /th/about). Values are reproduced verbatim from that page — phone numbers
 * keep the +66 form they are published in rather than being reformatted, so anything
 * here can be diffed against the source without judgement calls.
 *
 * No founding year is recorded: it is not published anywhere we can cite. An earlier
 * draft carried "พ.ศ. 2547", which was invented, and an invented heritage claim is
 * exactly the kind of unverifiable number this project refuses to print.
 *
 * ## Why this file is still Thai after the locale round
 *
 * The values here are *source content*, not app prose, and the same rule applies that
 * plan 13 applies to the 81 products: the mechanism ships, the translation is a
 * person's job, and nothing gets machine translated on the way past. A registered
 * company name and a Thai postal address are also the two things that should stay in
 * Thai for a courier and a company registry regardless of who is reading the page.
 *
 * What *did* become keys are the channel labels — "Telephone", "Email" — because those
 * are the app naming a kind of thing rather than the company saying something about
 * itself. Everything that stays Thai is rendered `lang="th"` at the call site.
 */

export interface ContactChannel {
  /** Which kind of channel this is. App prose, so a key — see `i18n/keys.ts`. */
  labelKey: PlainKey;
  /** What the customer reads — verbatim from the source page. */
  valueTh: string;
  /** tel: / mailto: / https: — omitted when the value is not actionable. */
  href?: string;
}

export interface Company {
  /** Registered name, for the footer and the copyright line. */
  legalNameTh: string;
  /** Short form used as the wordmark in the header. */
  wordmark: string;
  phones: ContactChannel[];
  line: ContactChannel;
  email: ContactChannel;
  addressTh: string;
  businessHoursTh: string;
  serviceAreaTh: string | null;
  /** What the company makes, as its own site describes it. */
  makesTh: string;
}

export const company: Company = {
  legalNameTh: 'บริษัท วีวิน180 จำกัด',
  wordmark: 'WEWIN180',

  phones: [
    { labelKey: 'contact.phone', valueTh: '+66 91 879 6563', href: 'tel:+66918796563' },
    { labelKey: 'contact.phone', valueTh: '+66 65 751 9662', href: 'tel:+66657519662' },
    { labelKey: 'contact.phone', valueTh: '+66 81 118 5017', href: 'tel:+66811185017' },
  ],

  // The site publishes a second official account, @wewin180pl, on the same page.
  // Which one a customer should prefer is not stated, so only the unsuffixed
  // handle is surfaced rather than presenting a choice we cannot explain.
  line: {
    labelKey: 'contact.line',
    valueTh: '@wewin180',
    href: 'https://lin.ee/qxGxHezy',
  },

  email: {
    labelKey: 'contact.email',
    valueTh: 'info@wewin180.com',
    href: 'mailto:info@wewin180.com',
  },

  addressTh: '291/4 หมู่ที่ 1 ต.บ้านกร่าง อ.เมืองพิษณุโลก จ.พิษณุโลก 65000',
  businessHoursTh: 'วันจันทร์–วันเสาร์ 09:00–17:00 น. (เวลา ICT)',

  // From /th/about: "บริการจัดส่งและติดตั้งทั้งภายในและต่างประเทศ". Phrased as the
  // service that is offered rather than as a coverage boundary, because the site
  // states no boundary and inventing one would send the wrong customer away.
  serviceAreaTh: 'จัดส่งและติดตั้งทั้งภายในประเทศและต่างประเทศ',

  makesTh: 'บานเกล็ดปรับระดับได้ หน้าต่าง และประตู',
};

/**
 * The spec sheet shown on every product page (spec section 7 fixes these four rows).
 *
 * ⚠️ Three of the four are unconfirmed and therefore not displayed. An earlier draft
 * filled them in with "มอก. 284-2530 · ทดสอบแรงลม 2,000 Pa" and "โครงสร้าง 5 ปี ·
 * อุปกรณ์ 2 ปี", all of which were invented. A fabricated certification is a claim
 * about a test that never happened, and a fabricated warranty is a contract term —
 * both are worse to guess at than a price.
 *
 * Fill these in from the real product documentation; rows with a null value are
 * simply not rendered, so nothing breaks while they are missing.
 */
export const productSpecs: { termKey: PlainKey; valueKey: PlainKey | null }[] = [
  { termKey: 'spec.material', valueKey: 'spec.material.value' },
  { termKey: 'spec.profileThickness', valueKey: null },
  { termKey: 'spec.standards', valueKey: null },
  { termKey: 'spec.warranty', valueKey: null },
];
