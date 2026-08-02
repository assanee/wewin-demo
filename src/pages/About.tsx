import { ButtonLink } from '../components/common/Button';

/**
 * Stub. The header nav in spec section 8 lists this link, but section 7 does not
 * specify the page — a nav link that lands on a 404 is worse than a short page.
 */
export function About() {
  return (
    <main className="container-page py-12 md:py-16">
      <h1 className="text-title text-chalk lg:text-display">เกี่ยวกับเรา</h1>
      <p className="mt-4 max-w-[60ch] text-body text-chalk-2">
        ALUFORM ผลิตงานอะลูมิเนียมสั่งทำตามขนาดหน้างานจริง
        เราเปิดราคาต่อตารางเมตรให้เห็นตั้งแต่ต้น เพราะการต้องโทรถามก่อนถึงจะรู้ราคา
        ทำให้ทุกฝ่ายเสียเวลา
      </p>
      <p className="mt-6 text-body text-chalk-3">เนื้อหาส่วนนี้จะเพิ่มในเวอร์ชันถัดไป</p>
      <div className="mt-8">
        <ButtonLink to="/products">ดูสินค้าและคำนวณราคา</ButtonLink>
      </div>
    </main>
  );
}
