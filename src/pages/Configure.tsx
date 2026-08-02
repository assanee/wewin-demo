import { useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Check, Minus, Pencil, Plus } from 'lucide-react';
import { getProductBySlug } from '../data/catalog';
import { productSpecs } from '../data/company';
import { defaultStateFor, useConfigurator, type ConfiguratorState } from '../state/useConfigurator';
import { useMediaQuery } from '../state/useMediaQuery';
import { getCustomGroup, getSkuGroup } from '../lib/filters';
import { formatBaht, formatSqm } from '../lib/format';
import { configHash } from '../lib/hash';
import { buildShareUrl, readSharedConfig, type SharedConfig } from '../lib/shareLink';
import { useQuote } from '../state/useQuote';
import { useToast } from '../components/common/useToast';
import type { QuoteLine } from '../state/quoteReducer';
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
import { ConfiguratorToolbar } from '../components/configurator/ConfiguratorToolbar';
import { NotFound } from './NotFound';

export function Configure() {
  const { slug } = useParams();
  const [searchParams] = useSearchParams();
  const product = getProductBySlug(slug ?? '');
  const { getLine, ready } = useQuote();

  if (!product) return <NotFound />;

  const editingLineId = searchParams.get('line');
  const editingLine = editingLineId ? getLine(editingLineId) : undefined;

  // Wait for localStorage before deciding: rendering the defaults first and swapping
  // them in a moment later would throw away anything typed in between.
  if (editingLineId && !ready) {
    return (
      <main className="container-page py-16">
        <p className="text-body text-chalk-2">กำลังโหลดรายการ…</p>
      </main>
    );
  }

  // A saved line wins over link parameters: opening "แก้ไขการตั้งค่า" on a line is
  // a stronger intent than whatever query string happens to be along for the ride.
  const shared = editingLine ? null : readSharedConfig(product, searchParams);

  // Keyed on the product and the line so switching either resets the configuration
  // rather than carrying one product's selections into another's group codes.
  return (
    <ConfigureProduct
      key={`${product.id}:${editingLineId ?? 'new'}`}
      product={product}
      editingLine={editingLine}
      shared={shared}
    />
  );
}

function ConfigureProduct({
  product,
  editingLine,
  shared,
}: {
  product: Product;
  editingLine: QuoteLine | undefined;
  shared: SharedConfig | null;
}) {
  const config = useConfigurator(product, initialStateFrom(product, editingLine, shared));
  const isTablet = useMediaQuery('(min-width: 768px)');
  const navigate = useNavigate();
  const { addLine, updateLine } = useQuote();
  const { showToast } = useToast();

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
    setBreakdownOpen(false);

    if (config.hasError) {
      // Spec section 6: the button stays pressable so a touch user gets an
      // explanation rather than a dead control.
      issueRef.current?.focus();
      issueRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }

    const draft = {
      productId: product.id,
      nickname: config.nickname.trim() || product.nameTh,
      skuCode: config.skuCode,
      selections: config.selections,
      measures: config.measures,
      qty: config.qty,
      priceSnapshot: config.price,
      configHash: configHash(config.skuCode, config.measures),
      // Warnings ride along with the line so the sales team sees them when the
      // quote is issued (spec section 6).
      warnings: config.issues.filter((issue) => issue.severity === 'warning'),
    };

    if (editingLine) {
      updateLine(editingLine.lineId, draft);
      showToast({ messageTh: 'บันทึกการแก้ไขแล้ว', action: { labelTh: 'ดูตะกร้า', to: '/quote' } });
      navigate('/quote');
      return;
    }

    addLine(draft);
    showToast({ messageTh: 'เพิ่มลงรายการแล้ว', action: { labelTh: 'ดูตะกร้า', to: '/quote' } });
  };

  const profileHex = swatchOf('profile_color', '#7C7F85');
  const glassHex = swatchOf('glass_color', '#C9E4F7');
  const unit = getCustomGroup(product, 'width')?.unit ?? 'cm';

  // `location` is read in an event-free render path only through this memo, which
  // falls back to a relative URL so nothing here depends on `window` existing.
  const shareUrl = useMemo(
    () =>
      buildShareUrl(
        typeof window === 'undefined' ? '' : window.location.origin,
        product,
        config.selections,
        config.measures,
        config.qty,
      ),
    [product, config.selections, config.measures, config.qty],
  );

  // Only rows with a confirmed value are shown. The unconfirmed ones (profile
  // thickness, standards, warranty) are held as null in company.ts rather than
  // filled with plausible figures — see the note there.
  const knownSpecs = productSpecs.filter((row) => row.valueTh !== null);

  // Rendered in exactly one of two places depending on viewport — never both.
  const specTable = (
    <div className="mt-3 border border-line bg-panel">
      <dl>
        {knownSpecs.map((row) => (
          <div
            key={row.termTh}
            className="flex min-w-0 flex-col gap-0.5 border-b border-line px-3 py-2"
          >
            <dt className="text-caption text-chalk-3">{row.termTh}</dt>
            <dd className="min-w-0 text-small text-chalk-2">{row.valueTh}</dd>
          </div>
        ))}
      </dl>
      <p className="px-3 py-2 text-caption text-chalk-3">
        สเปกละเอียด มาตรฐาน และเงื่อนไขรับประกัน สอบถามทีมงานได้ที่ช่องทางติดต่อด้านล่าง
      </p>
    </div>
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
                elevation={product.elevation}
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
                    elevation={product.elevation}
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

            <div className="mt-4">
              <ConfiguratorToolbar
                onUndo={config.undo}
                onRedo={config.redo}
                onReset={config.reset}
                canUndo={config.canUndo}
                canRedo={config.canRedo}
                isPristine={config.isPristine}
                shareUrl={shareUrl}
              />
            </div>
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

/**
 * Where the configurator starts: a saved quote line if one is being edited, else a
 * shared link's parameters, else the product's own defaults.
 */
function initialStateFrom(
  product: Product,
  editingLine: QuoteLine | undefined,
  shared: SharedConfig | null,
): Partial<ConfiguratorState> | undefined {
  if (editingLine) {
    return {
      selections: editingLine.selections,
      measures: editingLine.measures,
      qty: editingLine.qty,
      nickname: editingLine.nickname,
    };
  }

  if (!shared) return undefined;

  // Merged over the defaults, not used raw: a link may name only a width, and the
  // remaining groups still need the values the product ships with.
  const defaults = defaultStateFor(product);
  return {
    selections: { ...defaults.selections, ...shared.selections },
    measures: { ...defaults.measures, ...shared.measures },
    qty: shared.qty,
  };
}
