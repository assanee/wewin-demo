import { getProductById } from '../data/catalog';
import { useQuote } from '../state/useQuote';
import { useIsDesktop } from '../state/useMediaQuery';
import { longestLeadTime, quoteItemCount, quoteTotal } from '../state/quoteReducer';
import { formatBaht, formatInteger, formatLeadTime } from '../lib/format';
import { ButtonLink } from '../components/common/Button';
import { StickyBar } from '../components/common/StickyBar';
import { QuoteLineRow } from '../components/quote/QuoteLineRow';
import { QuoteLineCard } from '../components/quote/QuoteLineCard';

const TH_HEAD = 'py-2 pe-3 text-caption font-normal tracking-[0.08em] text-chalk-3 uppercase';

export function Quote() {
  const { lines, setQty, removeLine, duplicateLine } = useQuote();
  const isDesktop = useIsDesktop();

  const total = quoteTotal(lines);
  const itemCount = quoteItemCount(lines);
  const leadTime = longestLeadTime(lines, getProductById);

  if (lines.length === 0) {
    return (
      <main className="container-page py-16 md:py-24">
        <div className="mx-auto max-w-130 border border-line bg-panel px-6 py-14 text-center">
          {/* An invitation, not an apology (spec section 2). */}
          <h1 className="text-title text-chalk">ยังไม่มีรายการในตะกร้า</h1>
          <p className="mx-auto mt-2 max-w-[42ch] text-body text-chalk-2">
            เลือกสินค้า กรอกขนาดช่องเปิดจริง แล้วเพิ่มเข้ามาที่นี่ได้เลย
          </p>
          <div className="mt-6 flex justify-center">
            <ButtonLink to="/products" variant="primary" size="lg">
              เลือกสินค้า
            </ButtonLink>
          </div>
        </div>
      </main>
    );
  }

  const summaryRows = (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-body text-chalk-2">จำนวนรายการ</span>
        <span className="numeric text-body text-chalk">
          {formatInteger(lines.length)} รายการ · {formatInteger(itemCount)} ชิ้น
        </span>
      </div>
      {leadTime ? (
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-body text-chalk-2">ระยะเวลาผลิต</span>
          <span className="numeric text-body text-chalk">{formatLeadTime(leadTime)}</span>
        </div>
      ) : null}
      <div className="flex items-baseline justify-between gap-3 border-t border-line pt-3">
        <span className="text-lead text-chalk">ยอดรวม</span>
        <span className="numeric text-display text-lime">{formatBaht(total)}</span>
      </div>
      <p className="numeric text-caption text-chalk-3">ราคายังไม่รวม VAT 7%</p>
      <p className="mt-2 border-t border-line pt-3 text-caption text-chalk-3">
        ขั้นตอนขอใบเสนอราคาจะเพิ่มในเวอร์ชันถัดไป
      </p>
    </>
  );

  const lineHandlers = (lineId: string) => ({
    onQtyChange: (qty: number) => setQty(lineId, qty),
    onDuplicate: () => duplicateLine(lineId),
    onRemove: () => removeLine(lineId),
  });

  return (
    <main className="container-page py-6 md:py-8 lg:py-10">
      <div className="mb-6 flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h1 className="text-title text-chalk lg:text-display">ตะกร้า</h1>
        <p className="numeric text-small text-chalk-2" aria-live="polite">
          {formatInteger(lines.length)} รายการ
        </p>
      </div>

      {/* Table on lg, cards below it — one structure at a time. Rendering both and
          hiding one with CSS would make a screen reader read every line twice, and
          spec section 8 rules out a horizontally scrolling table on mobile. */}
      {isDesktop ? (
        <table className="w-full border-collapse">
          <caption className="sr-only">รายการในตะกร้า</caption>
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className={`${TH_HEAD} text-start`}>ชื่อรายการ</th>
              <th scope="col" className={`${TH_HEAD} text-start`}>รหัสสินค้า</th>
              <th scope="col" className={`${TH_HEAD} text-start`}>ขนาด</th>
              <th scope="col" className={`${TH_HEAD} text-start`}>จำนวน</th>
              <th scope="col" className={`${TH_HEAD} text-end`}>ราคาต่อชิ้น</th>
              <th scope="col" className={`${TH_HEAD} text-end`}>ราคารวม</th>
              <th scope="col" className={TH_HEAD}>
                <span className="sr-only">การจัดการ</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <QuoteLineRow key={line.lineId} line={line} {...lineHandlers(line.lineId)} />
            ))}
          </tbody>
        </table>
      ) : (
        <ul className="flex flex-col gap-3">
          {lines.map((line) => (
            <li key={line.lineId} className="min-w-0">
              <QuoteLineCard line={line} {...lineHandlers(line.lineId)} />
            </li>
          ))}
        </ul>
      )}

      {isDesktop ? (
        <section
          aria-label="สรุปยอด"
          className="mt-8 ms-auto flex max-w-105 flex-col gap-2 border border-line bg-panel p-5"
        >
          {summaryRows}
        </section>
      ) : (
        <>
          <section
            aria-label="สรุปยอด"
            className="mt-6 flex flex-col gap-2 border border-line bg-panel p-4"
          >
            {summaryRows}
          </section>

          <StickyBar>
            <div className="min-w-0">
              <p className="numeric text-lead text-lime">{formatBaht(total)}</p>
              <p className="numeric text-caption text-chalk-3">
                {formatInteger(itemCount)} ชิ้น · ยังไม่รวม VAT
              </p>
            </div>
            <ButtonLink to="/products" className="shrink-0">
              เพิ่มสินค้าอีก
            </ButtonLink>
          </StickyBar>
        </>
      )}
    </main>
  );
}
