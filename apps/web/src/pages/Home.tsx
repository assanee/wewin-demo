import { Link } from 'react-router-dom';
import { ArrowRight, Ruler, Calculator, Send, Wrench } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { categories, products } from '@wewin/core/fixtures';
import { company } from '../data/company';
import {
  billableFloorSpan,
  leadTimeSpan,
  lowestPricePerSqm,
  summarizeCategories,
} from '@wewin/core/catalog-summary';
import { formatBaht, formatInteger, formatLeadTime, formatSqm } from '@wewin/core/format';
import { ButtonLink } from '../components/common/Button';

/**
 * v1 home page (spec section 7): still no hero photography, portfolio or FAQ.
 *
 * Every figure on this page is derived from products.ts rather than written into
 * copy. The whole proposition is "see the price before you talk to us", so a home
 * page still advertising last quarter's starting price would undercut the one thing
 * the site is selling.
 */
export function Home() {
  const summaries = summarizeCategories(products, categories);
  const catalogFrom = lowestPricePerSqm(products);
  const catalogLeadTime = leadTimeSpan(products);
  const billableFloor = billableFloorSpan(products);

  return (
    <main>
      {/* ---- Hero ---- */}
      <section aria-labelledby="hero-heading" className="container-page py-12 md:py-16 lg:py-24">
        <div className="max-w-180">
          {/* No founding year: it is not published anywhere we can cite, and an
              invented heritage claim is the same species of unverifiable number as
              the customer counts this page deliberately does without. */}
          <p className="numeric text-caption tracking-[0.22em] text-chalk-3 uppercase">
            {company.wordmark}
          </p>

          <h1 id="hero-heading" className="mt-4 text-display text-chalk lg:text-hero">
            สั่งทำตามขนาดจริง
            <br />
            <span className="text-chalk-2">เห็นราคาก่อนคุยกับเรา</span>
          </h1>

          <p className="mt-5 max-w-[54ch] text-lead text-chalk-2">
            หน้าต่าง ระแนง และประตูอะลูมิเนียม กรอกความกว้างกับความสูงของช่องเปิดจริง
            แล้วดูราคาเต็มจำนวนทันที ไม่ต้องล็อกอิน ไม่ต้องทิ้งเบอร์ก่อน
          </p>

          <div className="mt-8">
            <ButtonLink to="/products" variant="primary" size="lg">
              ดูสินค้าและคำนวณราคา
              <ArrowRight size={18} aria-hidden />
            </ButtonLink>
          </div>
        </div>

        {/* Three facts, all computed from the catalog. Nothing here is a claim we
            cannot check: no customer counts, no project tallies, no awards. */}
        <dl className="mt-10 grid grid-cols-1 gap-px border border-line bg-line md:grid-cols-3">
          <FactCell termTh="แบบให้เลือก" value={`${formatInteger(products.length)} แบบ`} />
          <FactCell
            termTh="ราคาเริ่มต้น"
            value={catalogFrom === null ? '—' : formatBaht(catalogFrom)}
            suffixTh={catalogFrom === null ? undefined : '/ ตร.ม.'}
          />
          <FactCell
            termTh="ระยะเวลาผลิต"
            value={catalogLeadTime === null ? '—' : formatLeadTime(catalogLeadTime)}
          />
        </dl>

        <p className="numeric mt-4 text-caption text-chalk-3">ราคายังไม่รวม VAT 7%</p>
      </section>

      {/* ---- How it works ---- */}
      <section aria-labelledby="how-heading" className="container-page pb-14 md:pb-20">
        <h2 id="how-heading" className="text-title text-chalk">
          ขั้นตอนทำงาน
        </h2>
        <p className="mt-2 max-w-[60ch] text-body text-chalk-2">
          การดูราคาเองก่อนติดต่อยังไม่ใช่เรื่องปกติในงานสั่งทำ นี่คือสิ่งที่จะเกิดขึ้นหลังจากนี้
        </p>

        {/* An ordered list because the order is the point — reading step 4 before
            step 1 is what makes people hesitate to type a measurement at all. */}
        <ol className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Step
            index={1}
            icon={Ruler}
            titleTh="วัดช่องเปิดแล้วกรอกขนาด"
            bodyTh="เลือกแบบที่ต้องการ แล้วกรอกความกว้าง × ความสูงของช่องเปิดจริง"
          />
          <Step
            index={2}
            icon={Calculator}
            titleTh="เห็นราคาทันที"
            bodyTh="ราคาเต็มขึ้นบนหน้าจอทันที พร้อมรายการที่ประกอบกันเป็นราคานั้นทุกบรรทัด"
          />
          <Step
            index={3}
            icon={Send}
            titleTh="ส่งขอใบเสนอราคา"
            bodyTh="รวมรายการที่สนใจแล้วส่งมาขอใบเสนอราคา ยังไม่ผูกมัดในขั้นนี้"
          />
          <Step
            index={4}
            icon={Wrench}
            titleTh="วัดหน้างานก่อนผลิต"
            bodyTh={`ทีมงานเข้าวัดหน้างานจริงเพื่อยืนยันขนาดและราคาก่อนเริ่มผลิต${
              catalogLeadTime ? ` ใช้เวลาผลิต ${formatLeadTime(catalogLeadTime)} แล้วแต่แบบ` : ''
            }`}
          />
        </ol>

        {/* The single most important sentence on the page. It is stated plainly and
            up front rather than buried in terms, because a customer who feels the
            price moved on them after measuring will not come back. */}
        <p className="mt-4 border border-line bg-panel px-4 py-3 text-body text-chalk">
          ราคาบนเว็บคือ<span className="text-warn">ราคาประเมินจากตัวเลขที่คุณกรอก</span>{' '}
          ราคาสุดท้ายยืนยันหลังทีมงานเข้าวัดหน้างานจริง
        </p>
      </section>

      {/* ---- Categories ---- */}
      <section aria-labelledby="categories-heading" className="container-page pb-14 md:pb-20">
        <h2 id="categories-heading" className="text-title text-chalk">
          เลือกตามประเภทงาน
        </h2>

        <ul className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          {summaries.map((summary, index) => (
            <li key={summary.category.id} className="min-w-0">
              <Link
                to={`/products?category=${summary.category.id}`}
                className="group flex h-full min-w-0 flex-col gap-2 border border-line bg-panel p-4 transition-colors duration-180 ease-out hover:border-line-2 md:p-5"
              >
                <span className="numeric text-caption text-chalk-3">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="font-display text-lead text-chalk">{summary.category.labelTh}</span>
                <span className="min-w-0 text-small text-chalk-2">{summary.category.summaryTh}</span>

                {/* Same price row as ProductCard, deliberately — a different
                    treatment for the same fact reads as a different site. */}
                <div className="mt-auto flex items-end justify-between gap-3 border-t border-line pt-3">
                  <div className="min-w-0">
                    {summary.fromPricePerSqm === null ? (
                      <p className="text-small text-chalk-3">ยังไม่มีสินค้าในหมวดนี้</p>
                    ) : (
                      <>
                        <p className="text-caption text-chalk-3">เริ่ม</p>
                        <p className="numeric text-lead text-chalk">
                          {formatBaht(summary.fromPricePerSqm)}
                          <span className="text-small text-chalk-2"> / ตร.ม.</span>
                        </p>
                        <p className="numeric mt-1 text-caption text-chalk-3">
                          {formatInteger(summary.productCount)} แบบ
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
          ราคาคิดยังไง
        </h2>
        <p className="mt-2 max-w-[60ch] text-body text-chalk-2">
          ทั้งสามข้อนี้อยู่ตรงนี้เพราะเราอยากให้รู้ก่อนกรอกขนาด ไม่ใช่รู้ตอนเห็นตัวเลขสุดท้าย
        </p>

        {/* Left flat rather than folded into an Accordion. Each block is three lines,
            so nothing is long enough to need hiding — and putting the price caveats
            behind a tap would contradict the reason for showing prices at all. */}
        <div className="mt-6 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <PriceNote titleTh="สูตรคิดราคา">
            <p className="text-body text-chalk-2">
              ราคา = ราคาต่อตารางเมตร × พื้นที่ที่คิดเงิน + ค่าออปชัน
            </p>
            <p className="mt-2 text-small text-chalk-3">
              ค่าออปชันคือสีโปรไฟล์ สีและความหนากระจก และอุปกรณ์ที่เลือกเพิ่ม
              ทุกบรรทัดแสดงแยกให้เห็นในหน้าคำนวณราคา
            </p>
          </PriceNote>

          <PriceNote titleTh="พื้นที่คิดเงินขั้นต่ำ">
            <p className="text-body text-chalk-2">
              บานที่เล็กกว่าขั้นต่ำจะถูกคิดที่พื้นที่ขั้นต่ำ
            </p>
            <p className="mt-2 text-small text-chalk-3">
              ขั้นต่ำอยู่ระหว่าง{' '}
              <span className="numeric text-chalk-2">
                {billableFloor
                  ? `${formatSqm(billableFloor[0])}–${formatSqm(billableFloor[1])} ตร.ม.`
                  : '—'}
              </span>{' '}
              แล้วแต่แบบ หน้าคำนวณราคาจะบอกทุกครั้งว่าแบบที่เลือกใช้ขั้นต่ำเท่าไร
            </p>
          </PriceNote>

          <PriceNote titleTh="ราคานี้ยังไม่รวม">
            <ul className="flex flex-col gap-1 text-body text-chalk-2">
              <li>VAT 7%</li>
              <li>ค่าติดตั้ง</li>
              <li>ค่าขนส่ง</li>
              <li>ค่ารื้อของเดิม</li>
            </ul>
            <p className="mt-2 text-small text-chalk-3">
              ทั้งสี่รายการขึ้นกับหน้างาน จึงประเมินจากขนาดอย่างเดียวไม่ได้
              และจะอยู่ในใบเสนอราคาหลังเข้าวัด
            </p>
          </PriceNote>
        </div>
      </section>
    </main>
  );
}

function FactCell({
  termTh,
  value,
  suffixTh,
}: {
  termTh: string;
  value: string;
  // Explicitly `| undefined`: exactOptionalPropertyTypes is on, so a caller passing
  // a computed `string | undefined` would otherwise not type-check.
  suffixTh?: string | undefined;
}) {
  return (
    <div className="min-w-0 bg-panel px-4 py-4 md:px-5">
      <dt className="text-caption text-chalk-3">{termTh}</dt>
      <dd className="numeric mt-1 min-w-0 truncate text-lead text-chalk">
        {value}
        {suffixTh ? <span className="text-small text-chalk-2"> {suffixTh}</span> : null}
      </dd>
    </div>
  );
}

function Step({
  index,
  icon: Icon,
  titleTh,
  bodyTh,
}: {
  index: number;
  icon: LucideIcon;
  titleTh: string;
  bodyTh: string;
}) {
  return (
    <li className="flex min-w-0 flex-col gap-2 border border-line bg-panel p-4 md:p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="numeric text-caption text-chalk-3">
          {String(index).padStart(2, '0')}
        </span>
        <Icon size={16} aria-hidden className="shrink-0 text-chalk-3" />
      </div>
      <h3 className="font-display text-body text-chalk">{titleTh}</h3>
      <p className="min-w-0 text-small text-chalk-2">{bodyTh}</p>
    </li>
  );
}

function PriceNote({ titleTh, children }: { titleTh: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col border border-line bg-panel p-4 md:p-5">
      <h3 className="font-display text-lead text-chalk">{titleTh}</h3>
      <div className="mt-3 min-w-0">{children}</div>
    </div>
  );
}
