import { useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Check, Minus, Pencil, Plus } from 'lucide-react';
import { getProductBySlug } from '../data/catalog';
import { useConfigurator } from '../state/useConfigurator';
import { useMediaQuery } from '../state/useMediaQuery';
import { getCustomGroup, getSkuGroup } from '../lib/filters';
import { formatBaht, formatSqm } from '../lib/format';
import type { CustomGroup, Product, SkuGroup } from '../types/catalog';
import { ButtonLink } from '../components/common/Button';
import { BottomSheet } from '../components/common/BottomSheet';
import { Schematic } from '../components/common/Schematic';
import { ElevationPreview } from '../components/configurator/ElevationPreview';
import { MeasureInput } from '../components/configurator/MeasureInput';
import { SwatchGroup } from '../components/configurator/SwatchGroup';
import { ChipGroup } from '../components/configurator/ChipGroup';
import { ToggleOption } from '../components/configurator/ToggleOption';
import { IssuePanel } from '../components/configurator/IssuePanel';
import { PriceBreakdownList } from '../components/configurator/PriceBreakdownList';
import { PriceStickyBar, PriceSummaryCard } from '../components/configurator/PriceSummary';
import { NotFound } from './NotFound';

/** Static spec sheet — identical for every product in this prototype. */
const SPEC_ROWS: [string, string][] = [
  ['วัสดุ', 'อะลูมิเนียมอัดรีด เกรด 6063-T5'],
  ['ความหนาโปรไฟล์', '1.2–1.4 mm'],
  ['มาตรฐานที่ผ่าน', 'มอก. 284-2530 · ทดสอบแรงลม 2,000 Pa'],
  ['การรับประกัน', 'โครงสร้าง 5 ปี · อุปกรณ์ 2 ปี'],
];

export function Configure() {
  const { slug } = useParams();
  const product = getProductBySlug(slug ?? '');

  if (!product) return <NotFound />;

  // Keyed on the product so switching slugs resets the configuration rather than
  // carrying one product's selections into another's group codes.
  return <ConfigureProduct key={product.id} product={product} />;
}

function ConfigureProduct({ product }: { product: Product }) {
  const config = useConfigurator(product);
  const isTablet = useMediaQuery('(min-width: 768px)');

  const [editingName, setEditingName] = useState(false);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const issueRef = useRef<HTMLDivElement>(null);

  const customGroups = product.groups.filter((g): g is CustomGroup => g.kind === 'custom');
  const skuGroups = product.groups.filter((g): g is SkuGroup => g.kind === 'sku');

  const width = config.measures['width'] ?? getCustomGroup(product, 'width')?.defaultValue ?? 0;
  const height = config.measures['height'] ?? getCustomGroup(product, 'height')?.defaultValue ?? 0;

  const swatchOf = (groupCode: string, fallback: string): string => {
    const group = getSkuGroup(product, groupCode);
    const code = config.selections[groupCode] ?? group?.defaultValue;
    return group?.values.find((value) => value.code === code)?.swatchHex ?? fallback;
  };

  const measureInvalid = (groupCode: string): boolean =>
    config.issues.some((issue) => issue.severity === 'error' && issue.affects.includes(groupCode));

  const onAdd = () => {
    if (config.hasError) {
      // Spec section 6: the button stays pressable so a touch user gets an
      // explanation rather than a dead control. Phase 4 wires the successful path.
      setBreakdownOpen(false);
      issueRef.current?.focus();
      issueRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    setBreakdownOpen(false);
  };

  const profileHex = swatchOf('profile_color', '#7C7F85');
  const glassHex = swatchOf('glass_color', '#C9E4F7');
  const unit = getCustomGroup(product, 'width')?.unit ?? 'cm';

  // Rendered in exactly one of two places depending on viewport — never both.
  const specTable = (
    <dl className="mt-3 border border-line bg-panel">
      {SPEC_ROWS.map(([term, value]) => (
        <div
          key={term}
          className="flex min-w-0 flex-col gap-0.5 border-b border-line px-3 py-2 last:border-b-0"
        >
          <dt className="text-caption text-chalk-3">{term}</dt>
          <dd className="min-w-0 text-small text-chalk-2">{value}</dd>
        </div>
      ))}
    </dl>
  );

  return (
    <main className="container-page py-6 md:py-8 lg:py-10">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,300px)_minmax(0,1fr)] lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] lg:gap-8">
        {/* ---- Left column: the drawing ---- */}
        <div className="md:sticky md:top-22 md:self-start">
          <div className="border border-line bg-panel p-3">
            <div className="h-55 w-full md:h-70 lg:h-80">
              <ElevationPreview
                widthCm={width}
                heightCm={height}
                profileHex={profileHex}
                glassHex={glassHex}
                invalid={measureInvalid('width') || measureInvalid('height')}
                unit={unit}
              />
            </div>
          </div>

          {/* Three views of the same configuration, all derived from the live
              measurements rather than from stored artwork.

              Plain schematics, not ElevationPreview: dimension lines need room for
              their gutters and 11px numerals, and at 64px tall they collide into
              noise. The dimensions belong on the main drawing, once. */}
          <ul className="mt-3 grid grid-cols-3 gap-3">
            {(
              [
                ['ด้านหน้า', width, height],
                ['ครึ่งบาน', width / 2, height],
                ['ช่องแสงบน', width, height / 3],
              ] as [string, number, number][]
            ).map(([label, w, h]) => (
              <li key={label} className="min-w-0 border border-line bg-panel p-2">
                <div className="h-16 w-full">
                  <Schematic
                    widthCm={w}
                    heightCm={h}
                    profileHex={profileHex}
                    glassHex={glassHex}
                    frameRatio={0.07}
                  />
                </div>
                <p className="mt-1 truncate text-center text-caption text-chalk-3">{label}</p>
              </li>
            ))}
          </ul>

          {/* On md and up the spec sheet rides along in the sticky column. On mobile
              it moves below the controls: spec section 8 fixes the order there as
              preview -> name -> measurements -> options -> issues, and a four-row
              reference table between the drawing and the first input is four screens
              of scrolling before the customer can do anything. */}
          {isTablet ? specTable : null}
        </div>

        {/* ---- Right column: the controls ---- */}
        <div className="flex min-w-0 flex-col gap-6">
          {/* 1. Name + rename */}
          <div className="min-w-0">
            <p className="text-caption text-chalk-3">{product.nameTh}</p>
            {editingName ? (
              <div className="mt-1 flex items-stretch gap-2">
                <input
                  autoFocus
                  value={config.nickname}
                  onChange={(event) => config.setNickname(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === 'Escape') setEditingName(false);
                  }}
                  aria-label="ชื่อรายการนี้"
                  className="min-w-0 flex-1 rounded-xs border border-line-2 bg-panel-2 px-3 py-2 text-title text-chalk outline-none"
                />
                <button
                  type="button"
                  onClick={() => setEditingName(false)}
                  aria-label="บันทึกชื่อรายการ"
                  className="flex h-11 w-11 shrink-0 items-center justify-center self-center rounded-xs border border-line text-chalk-2 hover:text-chalk"
                >
                  <Check size={16} aria-hidden />
                </button>
              </div>
            ) : (
              <div className="mt-1 flex min-w-0 items-center gap-2">
                <h1 className="min-w-0 flex-1 text-title text-chalk lg:text-display">
                  {config.nickname}
                </h1>
                <button
                  type="button"
                  onClick={() => setEditingName(true)}
                  aria-label="ตั้งชื่อรายการนี้เอง"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xs border border-line text-chalk-2 transition-colors duration-180 ease-out hover:text-chalk"
                >
                  <Pencil size={15} aria-hidden />
                </button>
              </div>
            )}
            <p className="mt-2 max-w-[60ch] text-small text-chalk-2">{product.summaryTh}</p>
          </div>

          {/* 2. Measurements */}
          <section aria-label="ขนาด" className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {customGroups.map((group) => (
                <MeasureInput
                  key={group.code}
                  group={group}
                  value={config.measures[group.code] ?? group.defaultValue}
                  onChange={(next) => config.measure(group.code, next)}
                  invalid={measureInvalid(group.code)}
                />
              ))}
            </div>
            <p className="numeric text-small text-blueprint">
              พื้นที่ {formatSqm(config.price.areaSqm)} ตร.ม. · คิดขั้นต่ำ{' '}
              {formatSqm(product.minBillableSqm)} ตร.ม.
            </p>
          </section>

          {/* 3. Sku groups, in groups[] order */}
          {skuGroups.map((group) => {
            const states = config.optionStates[group.code] ?? {};
            const selected = config.selections[group.code] ?? group.defaultValue;
            const blocked = group.values.filter((value) => states[value.code]?.blocked);
            const onSelect = (code: string) => config.select(group.code, code);

            return (
              <section key={group.code} aria-label={group.labelTh} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <h2 className="text-body text-chalk">{group.labelTh}</h2>
                  {group.includeInSkuCode ? (
                    <span className="text-caption text-chalk-3">มีผลกับรหัสสินค้า</span>
                  ) : null}
                </div>

                {group.input === 'swatch' ? (
                  <SwatchGroup group={group} selected={selected} states={states} onSelect={onSelect} />
                ) : group.input === 'toggle' ? (
                  <ToggleOption group={group} selected={selected} states={states} onSelect={onSelect} />
                ) : (
                  <ChipGroup group={group} selected={selected} states={states} onSelect={onSelect} />
                )}

                {/* Reasons are rendered, not only tooltipped: a tooltip is
                    unreachable on touch, and this is the explanation that matters. */}
                {blocked.map((value) => (
                  <p key={value.code} className="text-caption text-chalk-3">
                    <span className="text-danger">{value.labelTh}</span> — {states[value.code]?.reasonTh}
                  </p>
                ))}
              </section>
            );
          })}

          {/* 4. Issues */}
          <IssuePanel issues={config.issues} headingRef={issueRef} />

          {/* 5 + 6. Card from md up; below that the sticky bar takes over. */}
          {isTablet ? (
            <PriceSummaryCard
              product={product}
              price={config.price}
              skuCode={config.skuCode}
              qty={config.qty}
              onQtyChange={config.setQty}
              onAdd={onAdd}
              hasError={config.hasError}
            />
          ) : null}

          {isTablet ? null : specTable}

          <p className="text-caption text-chalk-3">ขั้นตอนขอใบเสนอราคาจะเพิ่มในเวอร์ชันถัดไป</p>

          <div>
            <ButtonLink to="/products" variant="ghost">
              กลับไปดูสินค้าทั้งหมด
            </ButtonLink>
          </div>
        </div>
      </div>

      {/* Reserve the bar's height so it never covers the last line of content. */}
      {!isTablet ? <div aria-hidden className="h-18" /> : null}

      {!isTablet ? (
        <PriceStickyBar
          product={product}
          price={config.price}
          skuCode={config.skuCode}
          qty={config.qty}
          onQtyChange={config.setQty}
          onAdd={onAdd}
          hasError={config.hasError}
          onOpenBreakdown={() => setBreakdownOpen(true)}
        />
      ) : null}

      <BottomSheet
        open={breakdownOpen && !isTablet}
        titleTh="รายละเอียดราคา"
        size="auto"
        onClose={() => setBreakdownOpen(false)}
      >
        <div className="flex flex-col gap-4">
          <PriceBreakdownList price={config.price} minBillableSqm={product.minBillableSqm} />
          <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
            <span className="text-small text-chalk-2">จำนวน</span>
            <div className="flex items-stretch overflow-hidden rounded-xs border border-line">
              <button
                type="button"
                onClick={() => config.setQty(Math.max(1, config.qty - 1))}
                disabled={config.qty <= 1}
                aria-label="ลดจำนวน 1 ชิ้น"
                className="flex h-11 w-11 items-center justify-center bg-panel-2 text-chalk-2 disabled:opacity-30"
              >
                <Minus size={15} aria-hidden />
              </button>
              <output className="numeric flex h-11 w-12 items-center justify-center bg-panel-2 text-body text-chalk">
                {config.qty}
              </output>
              <button
                type="button"
                onClick={() => config.setQty(Math.min(99, config.qty + 1))}
                aria-label="เพิ่มจำนวน 1 ชิ้น"
                className="flex h-11 w-11 items-center justify-center bg-panel-2 text-chalk-2"
              >
                <Plus size={15} aria-hidden />
              </button>
            </div>
          </div>

          <div className="flex items-baseline justify-between gap-3 border-t border-line pt-3">
            <span className="text-body text-chalk">ราคารวม</span>
            <span className="numeric text-title text-lime">{formatBaht(config.price.total)}</span>
          </div>
          <p className="numeric text-caption text-chalk-3">ราคายังไม่รวม VAT 7%</p>
        </div>
      </BottomSheet>
    </main>
  );
}
