import { ButtonLink } from '../components/common/Button';

/** Placeholder — the quote list lands in phase 4. */
export function Quote() {
  return (
    <main className="container-page py-10">
      <h1 className="text-title text-chalk">ตะกร้า</h1>
      <p className="mt-2 text-body text-chalk-2">ยังไม่มีรายการในตะกร้า</p>
      <div className="mt-6">
        <ButtonLink to="/products">เลือกสินค้า</ButtonLink>
      </div>
    </main>
  );
}
