import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { categories } from '../data/catalog';
import { ButtonLink } from '../components/common/Button';

/**
 * v1 stub (spec section 7). Enough of the tokens and type to show the direction —
 * no hero photography, no portfolio, no FAQ, no full footer. Those are next round.
 */
export function Home() {
  return (
    <main className="container-page py-12 md:py-16 lg:py-24">
      <section className="max-w-[720px]">
        <p className="numeric text-caption tracking-[0.22em] text-chalk-3 uppercase">
          ALUFORM · ตั้งแต่ พ.ศ. 2547
        </p>

        <h1 className="mt-4 text-display text-chalk lg:text-hero">
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

        <p className="numeric mt-4 text-caption text-chalk-3">ราคายังไม่รวม VAT 7%</p>
      </section>

      <section className="mt-14 md:mt-20" aria-labelledby="categories-heading">
        <h2 id="categories-heading" className="text-title text-chalk">
          เลือกตามประเภทงาน
        </h2>

        <ul className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          {categories.map((category, index) => (
            <li key={category.id} className="min-w-0">
              <Link
                to={`/products?category=${category.id}`}
                className="group flex h-full min-w-0 flex-col gap-2 border border-line bg-panel p-4 transition-colors duration-180 ease-out hover:border-line-2 md:p-5"
              >
                <span className="numeric text-caption text-chalk-3">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="font-display text-lead text-chalk">{category.labelTh}</span>
                <span className="min-w-0 text-small text-chalk-2">{category.summaryTh}</span>
                <ArrowRight
                  size={16}
                  aria-hidden
                  className="mt-auto pt-2 text-chalk-3 transition-[color,transform] duration-180 ease-out group-hover:translate-x-1 group-hover:text-chalk"
                />
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
