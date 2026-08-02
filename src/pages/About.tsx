import { Clock, Mail, MapPin, MessageCircle, Phone, Truck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { categories, products } from '../data/catalog';
import { company } from '../data/company';
import {
  billableFloorSpan,
  leadTimeSpan,
  lowestPricePerSqm,
  summarizeCategories,
} from '../lib/catalogSummary';
import { formatBaht, formatInteger, formatLeadTime, formatSqm } from '../lib/format';
import { ButtonLink } from '../components/common/Button';

/**
 * Everything here is either a figure derived from products.ts or a sentence the
 * company publishes about itself. There is no origin story, no founding year, no
 * project count and no certification list — none of that is documented anywhere we
 * can cite, and an About page is precisely where invented history goes unchallenged.
 *
 * What is left is narrow but true, which suits a site whose whole pitch is that the
 * numbers are on the table before you ask.
 */
export function About() {
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
            เกี่ยวกับเรา
          </h1>

          <p className="mt-5 text-lead text-chalk-2">
            {company.legalNameTh} ผลิต{company.makesTh} สั่งทำตามขนาดหน้างานจริง
            โรงงานอยู่ที่จังหวัดพิษณุโลก และ{company.serviceAreaTh}
          </p>

          <p className="mt-4 max-w-[62ch] text-body text-chalk-2">
            เว็บนี้คือเครื่องมือคำนวณราคาของเราเอง กรอกความกว้างกับความสูงของช่องเปิด
            แล้วเห็นราคาเต็มจำนวนได้ทันทีโดยไม่ต้องติดต่อใครก่อน
          </p>
        </div>
      </section>

      {/* ---- The stance ---- */}
      <section aria-labelledby="stance-heading" className="container-page pb-14 md:pb-20">
        <h2 id="stance-heading" className="text-title text-chalk">
          ทำไมเราเปิดราคาให้เห็น
        </h2>

        <div className="mt-6 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <StanceNote titleTh="ถามราคาไม่ควรต้องแลกกับเบอร์โทร">
            งานสั่งทำส่วนใหญ่ต้องทิ้งเบอร์ไว้ก่อนถึงจะได้ตัวเลข
            แปลว่าคนที่แค่อยากรู้งบคร่าวๆ ต้องยอมรับสายที่ตามมา เราตัดขั้นตอนนั้นออก
          </StanceNote>

          <StanceNote titleTh="ราคาต้องแยกให้เห็นว่ามาจากอะไร">
            หน้าคำนวณราคาแสดงทุกบรรทัดที่ประกอบกันเป็นยอด ทั้งค่าพื้นที่ ค่าสี ค่ากระจก
            และค่าอุปกรณ์ ถ้าตัวเลขเปลี่ยน จะเห็นว่าเปลี่ยนเพราะอะไร
          </StanceNote>

          <StanceNote titleTh="ข้อจำกัดบอกก่อน ไม่ใช่บอกทีหลัง">
            พื้นที่คิดเงินขั้นต่ำ ขนาดที่ผลิตไม่ได้ และสิ่งที่ราคายังไม่รวม
            อยู่บนหน้าเว็บตั้งแต่ก่อนกรอกขนาด ไม่ใช่ไปโผล่ตอนคุยกัน
          </StanceNote>
        </div>
      </section>

      {/* ---- What we make ---- */}
      <section aria-labelledby="range-heading" className="container-page pb-14 md:pb-20">
        <h2 id="range-heading" className="text-title text-chalk">
          สิ่งที่เราผลิต
        </h2>
        <p className="mt-2 max-w-[60ch] text-body text-chalk-2">
          ตัวเลขทั้งหมดนี้อ่านจากแคตตาล็อกจริงที่ใช้คำนวณราคา ไม่ได้เขียนแยกไว้ต่างหาก
        </p>

        <dl className="mt-6 grid grid-cols-1 gap-px border border-line bg-line md:grid-cols-2 lg:grid-cols-4">
          <Fact
            termTh="แบบให้เลือก"
            value={`${formatInteger(products.length)} แบบ`}
            noteTh={`ใน ${formatInteger(stockedCategories.length)} หมวด`}
          />
          <Fact
            termTh="ราคาเริ่มต้น"
            value={catalogFrom === null ? '—' : `${formatBaht(catalogFrom)} / ตร.ม.`}
            noteTh="ยังไม่รวม VAT 7%"
          />
          <Fact
            termTh="ระยะเวลาผลิต"
            value={catalogLeadTime === null ? '—' : formatLeadTime(catalogLeadTime)}
            noteTh="แล้วแต่แบบ"
          />
          <Fact
            termTh="พื้นที่คิดเงินขั้นต่ำ"
            value={
              billableFloor
                ? `${formatSqm(billableFloor[0])}–${formatSqm(billableFloor[1])} ตร.ม.`
                : '—'
            }
            noteTh="บานเล็กกว่านี้คิดที่ขั้นต่ำ"
          />
        </dl>

        {/* A plain list rather than the home page's card grid: here the point is how
            wide the range is, not picking something out of it. */}
        <ul className="mt-6 grid grid-cols-1 gap-x-8 md:grid-cols-2">
          {stockedCategories.map((summary) => (
            <li
              key={summary.category.id}
              className="flex min-w-0 items-baseline justify-between gap-3 border-b border-line py-2"
            >
              <span className="min-w-0 truncate text-body text-chalk-2">
                {summary.category.labelTh}
              </span>
              <span className="numeric shrink-0 text-small text-chalk-3">
                {formatInteger(summary.productCount)} แบบ
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-8">
          <ButtonLink to="/products" variant="primary" size="lg">
            ดูสินค้าและคำนวณราคา
          </ButtonLink>
        </div>
      </section>

      {/* ---- Where and how to reach us ---- */}
      <section aria-labelledby="contact-heading" className="container-page pb-16 md:pb-24">
        <h2 id="contact-heading" className="text-title text-chalk">
          ที่ตั้งและการติดต่อ
        </h2>

        <div className="mt-6 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <InfoCard titleTh="โรงงานและสำนักงาน" Icon={MapPin}>
            <p className="text-body text-chalk-2">{company.addressTh}</p>
          </InfoCard>

          <InfoCard titleTh="การจัดส่งและติดตั้ง" Icon={Truck}>
            <p className="text-body text-chalk-2">{company.serviceAreaTh}</p>
            <p className="mt-2 text-small text-chalk-3">
              ค่าติดตั้งและค่าขนส่งไม่รวมอยู่ในราคาบนเว็บ เพราะขึ้นกับหน้างานและระยะทาง
              ทีมงานจะประเมินให้ในใบเสนอราคา
            </p>
          </InfoCard>

          <InfoCard titleTh="เวลาทำการ" Icon={Clock}>
            <p className="text-body text-chalk-2">{company.businessHoursTh}</p>
            <p className="mt-2 text-small text-chalk-3">
              นอกเวลาทำการ ทิ้งข้อความไว้ทาง LINE หรืออีเมลได้ ทีมงานจะตอบกลับในวันทำการถัดไป
            </p>
          </InfoCard>
        </div>

        {/* Repeated from the footer on purpose: an About page that makes you scroll
            past it to find a phone number is the behaviour the "no need to leave your
            number first" line is arguing against. */}
        <ul className="mt-6 flex flex-col gap-2 md:flex-row md:flex-wrap">
          {company.phones.map((phone) => (
            <li key={phone.valueTh} className="min-w-0">
              <ChannelChip
                valueTh={phone.valueTh}
                href={phone.href}
                labelTh={phone.labelTh}
                Icon={Phone}
              />
            </li>
          ))}
          <li className="min-w-0">
            <ChannelChip
              valueTh={company.line.valueTh}
              href={company.line.href}
              labelTh={company.line.labelTh}
              Icon={MessageCircle}
            />
          </li>
          <li className="min-w-0">
            <ChannelChip
              valueTh={company.email.valueTh}
              href={company.email.href}
              labelTh={company.email.labelTh}
              Icon={Mail}
            />
          </li>
        </ul>
      </section>
    </main>
  );
}

function StanceNote({ titleTh, children }: { titleTh: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col border border-line bg-panel p-4 md:p-5">
      <h3 className="font-display text-lead text-chalk">{titleTh}</h3>
      <p className="mt-3 min-w-0 text-small text-chalk-2">{children}</p>
    </div>
  );
}

function Fact({ termTh, value, noteTh }: { termTh: string; value: string; noteTh: string }) {
  return (
    <div className="min-w-0 bg-panel px-4 py-4 md:px-5">
      <dt className="text-caption text-chalk-3">{termTh}</dt>
      <dd className="min-w-0">
        <span className="numeric block truncate text-lead text-chalk">{value}</span>
        <span className="block text-caption text-chalk-3">{noteTh}</span>
      </dd>
    </div>
  );
}

function InfoCard({
  titleTh,
  Icon,
  children,
}: {
  titleTh: string;
  Icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col border border-line bg-panel p-4 md:p-5">
      <div className="flex items-center gap-2">
        <Icon size={15} aria-hidden className="shrink-0 text-chalk-3" />
        <h3 className="font-display text-lead text-chalk">{titleTh}</h3>
      </div>
      <div className="mt-3 min-w-0">{children}</div>
    </div>
  );
}

function ChannelChip({
  valueTh,
  href,
  labelTh,
  Icon,
}: {
  valueTh: string;
  href?: string | undefined;
  labelTh: string;
  Icon: LucideIcon;
}) {
  const inner = (
    <>
      <Icon size={15} aria-hidden className="shrink-0 text-chalk-3" />
      <span className="sr-only">{labelTh}: </span>
      <span className="numeric min-w-0 truncate text-small">{valueTh}</span>
    </>
  );

  const shared =
    'flex min-h-11 min-w-0 items-center gap-2 rounded-xs border border-line bg-panel-2 px-3 text-chalk-2';

  if (!href) return <span className={shared}>{inner}</span>;

  return (
    <a
      href={href}
      {...(href.startsWith('http') ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
      className={`${shared} transition-colors duration-180 ease-out hover:border-line-2 hover:text-chalk`}
    >
      {inner}
    </a>
  );
}
