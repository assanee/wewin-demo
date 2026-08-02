import { ButtonLink } from '../components/common/Button';

export function NotFound() {
  return (
    <main className="container-page py-20">
      <p className="numeric text-caption tracking-[0.22em] text-chalk-3 uppercase">404</p>
      <h1 className="mt-3 text-title text-chalk">ไม่พบหน้าที่ต้องการ</h1>
      <p className="mt-2 text-body text-chalk-2">ลิงก์อาจเปลี่ยนไปแล้ว ลองเริ่มจากรายการสินค้า</p>
      <div className="mt-6">
        <ButtonLink to="/products">ดูสินค้าทั้งหมด</ButtonLink>
      </div>
    </main>
  );
}
