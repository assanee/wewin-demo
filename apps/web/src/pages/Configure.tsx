import { useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Check, Minus, Pencil, Plus } from 'lucide-react';
import { getProductBySlug } from '@wewin/core/fixtures';
import { productSpecs } from '../data/company';
import { defaultStateFor, useConfigurator, type ConfiguratorState } from '../state/useConfigurator';
import { useDisplayUnit } from '../state/displayUnitContext';
import { useMediaQuery } from '../state/useMediaQuery';
import { getCustomGroup, getSkuGroup } from '@wewin/core/filters';
import { configHash } from '@wewin/core/hash';
import { buildShareUrl, readSharedConfig, type SharedConfig } from '@wewin/core/share-link';
import { useQuote } from '../state/useQuote';
import { useToast } from '../components/common/useToast';
import type { QuoteLine } from '@wewin/core/quote';
import type { CustomGroup, OptionValue, Product, SkuGroup } from '@wewin/core';
import type { OptionState } from '@wewin/core/option-states';
import type { PlainKey } from '../i18n/keys';
import { useLocale } from '../state/localeContext';
import { ButtonLink } from '../components/common/Button';
import { CatalogText } from '../components/common/CatalogText';
import { BottomSheet } from '../components/common/BottomSheet';
import { Schematic } from '../components/common/Schematic';
import { UnitPicker } from '../components/common/UnitPicker';
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
  const { t } = useLocale();

  if (!product) return <NotFound />;

  const editingLineId = searchParams.get('line');
  const editingLine = editingLineId ? getLine(editingLineId) : undefined;

  // Wait for localStorage before deciding: rendering the defaults first and swapping
  // them in a moment later would throw away anything typed in between.
  if (editingLineId && !ready) {
    return (
      <main className="container-page py-16">
        <p className="text-body text-chalk-2">{t('configure.loadingLine')}</p>
      </main>
    );
  }

  // A saved line wins over link parameters: opening the edit action on a line is a
  // stronger intent than whatever query string happens to be along for the ride.
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
  // How the sizes on this page are read out, and nothing more. Every measurement the
  // page holds stays canonical micrometres; this reaches only the format calls.
  const { unit } = useDisplayUnit();
  const { t, f } = useLocale();
  const navigate = useNavigate();
  const { addLine, updateLine } = useQuote();
  const { showToast } = useToast();

  const [editingName, setEditingName] = useState(false);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const issueRef = useRef<HTMLDivElement>(null);

  const customGroups = product.groups.filter((g): g is CustomGroup => g.kind === 'custom');
  const skuGroups = product.groups.filter((g): g is SkuGroup => g.kind === 'sku');

  // Canonical micrometres all the way down to the two format calls below. `0n` and
  // not `0`: a number beside a bigint is a TypeError at the first arithmetic, not a
  // type error, and this page is the first thing a customer opens.
  const widthUm = config.measures['width'] ?? getCustomGroup(product, 'width')?.defaultUm ?? 0n;
  const heightUm = config.measures['height'] ?? getCustomGroup(product, 'height')?.defaultUm ?? 0n;

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
      // Travels with the line so reopening it offers the fields back in the unit the
      // customer measured in. Deliberately not part of `configHash`: 320 cm and
      // 3200 mm are one window and have to merge into one row.
      enteredUnits: config.enteredUnits,
      qty: config.qty,
      priceSnapshot: config.price,
      configHash: configHash(config.skuCode, config.measures),
      // Warnings ride along with the line so the sales team sees them when the
      // quote is issued (spec section 6).
      warnings: config.issues.filter((issue) => issue.severity === 'warning'),
    };

    if (editingLine) {
      updateLine(editingLine.lineId, draft);
      showToast({
        messageKey: 'toast.lineSaved',
        action: { labelKey: 'toast.viewQuote', to: '/quote' },
      });
      navigate('/quote');
      return;
    }

    addLine(draft);
    showToast({
      messageKey: 'toast.lineAdded',
      action: { labelKey: 'toast.viewQuote', to: '/quote' },
    });
  };

  const profileHex = swatchOf('profile_color', '#7C7F85');
  const glassHex = swatchOf('glass_color', '#C9E4F7');
  const minBillableSqUm = product.minBillableSqUm;

  // `location` is read in an event-free render path only through this memo, which
  // falls back to a relative URL so nothing here depends on `window` existing.
  //
  // The measurements go in canonical micrometres and the units the customer typed in
  // go beside them; the unit currently on screen is not in the link at all. A link is
  // the sizes, and the recipient reads them in whichever unit they themselves prefer.
  const shareUrl = useMemo(
    () =>
      buildShareUrl(
        typeof window === 'undefined' ? '' : window.location.origin,
        product,
        config.selections,
        config.measures,
        config.enteredUnits,
        config.qty,
      ),
    [product, config.selections, config.measures, config.enteredUnits, config.qty],
  );

  // Only rows with a confirmed value are shown. The unconfirmed ones (profile
  // thickness, standards, warranty) are held as null in company.ts rather than
  // filled with plausible figures — see the note there.
  const knownSpecs = productSpecs.filter(
    (row): row is { termKey: typeof row.termKey; valueKey: NonNullable<typeof row.valueKey> } =>
      row.valueKey !== null,
  );

  // Rendered in exactly one of two places depending on viewport — never both.
  const specTable = (
    <div className="mt-3 border border-line bg-panel">
      <dl>
        {knownSpecs.map((row) => (
          <div
            key={row.termKey}
            className="flex min-w-0 flex-col gap-0.5 border-b border-line px-3 py-2"
          >
            <dt className="text-caption text-chalk-3">{t(row.termKey)}</dt>
            <dd className="min-w-0 text-small text-chalk-2">{t(row.valueKey)}</dd>
          </div>
        ))}
      </dl>
      <p className="px-3 py-2 text-caption text-chalk-3">{t('configure.spec.note')}</p>
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
                ratio={ratioOf(widthUm, heightUm)}
                // Through the locale's formatter, not core's. The drawing layer takes
                // numerals as strings — `ratioOf` is the one place a canonical length
                // is widened, and no `bigint` may cross into the SVG — so the
                // formatting has to happen on this side of that boundary, and the
                // dimension numerals on a drawing are read the way the reader reads
                // numbers like everything else on the page.
                widthLabel={f.length(widthUm, unit)}
                heightLabel={f.length(heightUm, unit)}
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
                ['configure.view.front', widthUm, heightUm],
                // Integer division truncates by at most a micrometre, which is a
                // millionth of a millimetre on a 64px sketch — it can reach neither
                // a pixel nor a rendered numeral.
                ['configure.view.halfPanel', widthUm / 2n, heightUm],
                ['configure.view.transom', widthUm, heightUm / 3n],
              ] as [PlainKey, bigint, bigint][]
            ).map(([labelKey, w, h]) => (
              <li key={labelKey} className="min-w-0 border border-line bg-panel p-2">
                <div className="h-16 w-full">
                  <Schematic
                    ratio={ratioOf(w, h)}
                    sizeLabel={f.dimensions(w, h, unit)}
                    elevation={product.elevation}
                    profileHex={profileHex}
                    glassHex={glassHex}
                    frameRatio={0.07}
                  />
                </div>
                <p className="mt-1 truncate text-center text-caption text-chalk-3">
                  {t(labelKey)}
                </p>
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
            <p className="text-caption text-chalk-3">
              <CatalogText at={{ on: 'productName', productId: product.id }} th={product.nameTh} />
            </p>
            {editingName ? (
              <div className="mt-1 flex items-stretch gap-2">
                <input
                  autoFocus
                  value={config.nickname}
                  onChange={(event) => config.setNickname(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === 'Escape') setEditingName(false);
                  }}
                  aria-label={t('configure.name.editLabel')}
                  className="min-w-0 flex-1 rounded-xs border border-line-2 bg-panel-2 px-3 py-2 text-title text-chalk outline-none"
                />
                <button
                  type="button"
                  onClick={() => setEditingName(false)}
                  aria-label={t('configure.name.save')}
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
                  aria-label={t('configure.name.rename')}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xs border border-line text-chalk-2 transition-colors duration-180 ease-out hover:text-chalk"
                >
                  <Pencil size={15} aria-hidden />
                </button>
              </div>
            )}
            <p className="mt-2 max-w-[60ch] text-small text-chalk-2">
              <CatalogText
                at={{ on: 'productSummary', productId: product.id }}
                th={product.summaryTh}
              />
            </p>

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
          <section aria-label={t('configure.size.heading')} className="flex flex-col gap-4">
            {/* The picker sits with the fields it retitles rather than off in the
                header: the customer reaches for it while looking at a tape measure,
                and this is the one place on the site where the answer is typed. */}
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <h2 className="text-body text-chalk">{t('configure.size.heading')}</h2>
              <UnitPicker />
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {customGroups.map((group) => (
                <MeasureInput
                  key={group.code}
                  product={product}
                  group={group}
                  value={config.measures[group.code] ?? group.defaultUm}
                  // The unit comes back from the field rather than being read off the
                  // picker here: what has to be recorded is the unit the customer was
                  // typing in when they committed, and the picker may have moved on.
                  onChange={(next, enteredUnit) => config.measure(group.code, next, enteredUnit)}
                  invalid={measureInvalid(group.code)}
                />
              ))}
            </div>
            <p className="numeric text-small text-blueprint">
              {t('configure.area.line', { areaSqUm: config.price.areaSqUm, minBillableSqUm })}
            </p>
          </section>

          {/* 3. Sku groups, in groups[] order */}
          {skuGroups.map((group) => {
            const states = config.optionStates[group.code] ?? {};
            const selected = config.selections[group.code] ?? group.defaultValue;
            const blocked = group.values.filter((value) => states[value.code]?.blocked);
            const onSelect = (code: string) => config.select(group.code, code);

            return (
              <section key={group.code} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <h2 className="text-body text-chalk">
                    <CatalogText
                      at={{ on: 'groupLabel', productId: product.id, groupCode: group.code }}
                      th={group.labelTh}
                    />
                  </h2>
                  {group.includeInSkuCode ? (
                    <span className="text-caption text-chalk-3">
                      {t('configure.group.affectsSku')}
                    </span>
                  ) : null}
                </div>

                {group.input === 'swatch' ? (
                  <SwatchGroup product={product} group={group} selected={selected} states={states} onSelect={onSelect} />
                ) : group.input === 'toggle' ? (
                  <ToggleOption product={product} group={group} selected={selected} states={states} onSelect={onSelect} />
                ) : (
                  <ChipGroup product={product} group={group} selected={selected} states={states} onSelect={onSelect} />
                )}

                {/* Reasons are rendered, not only tooltipped: a tooltip is
                    unreachable on touch, and this is the explanation that matters.

                    The reason is the same `Message` the tooltip and the issue panel
                    get, so the three cannot drift into three translations of one rule. */}
                {blocked.map((value) => (
                  <BlockedReason
                    key={value.code}
                    product={product}
                    group={group}
                    value={value}
                    state={states[value.code]}
                  />
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

          <p className="text-caption text-chalk-3">{t('configure.futureQuote')}</p>

          <div>
            <ButtonLink to="/products" variant="ghost">
              {t('nav.backToProducts')}
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
        title={t('configure.breakdown.title')}
        size="auto"
        onClose={() => setBreakdownOpen(false)}
      >
        <div className="flex flex-col gap-4">
          <PriceBreakdownList price={config.price} minBillableSqUm={minBillableSqUm} />
          <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
            <span className="text-small text-chalk-2">{t('configure.qty')}</span>
            <div className="flex items-stretch overflow-hidden rounded-xs border border-line">
              <button
                type="button"
                onClick={() => config.setQty(Math.max(1, config.qty - 1))}
                disabled={config.qty <= 1}
                aria-label={t('configure.qty.decrease')}
                className="flex h-11 w-11 items-center justify-center bg-panel-2 text-chalk-2 disabled:opacity-30"
              >
                <Minus size={15} aria-hidden />
              </button>
              <output className="numeric flex h-11 w-12 items-center justify-center bg-panel-2 text-body text-chalk">
                {f.integer(config.qty)}
              </output>
              <button
                type="button"
                onClick={() => config.setQty(Math.min(99, config.qty + 1))}
                aria-label={t('configure.qty.increase')}
                className="flex h-11 w-11 items-center justify-center bg-panel-2 text-chalk-2"
              >
                <Plus size={15} aria-hidden />
              </button>
            </div>
          </div>

          <div className="flex items-baseline justify-between gap-3 border-t border-line pt-3">
            <span className="text-body text-chalk">{t('price.total')}</span>
            <span className="numeric text-title text-lime">{f.baht(config.price.totalMinor)}</span>
          </div>
          <p className="numeric text-caption text-chalk-3">{t('price.vatExcluded')}</p>
        </div>
      </BottomSheet>
    </main>
  );
}

/**
 * A struck-through option and why it cannot be chosen.
 *
 * Its own component because it needs the locale to render a `Message`, and because the
 * option's own name is catalogue content that has to be able to mark itself Thai.
 */
function BlockedReason({
  product,
  group,
  value,
  state,
}: {
  product: Product;
  group: SkuGroup;
  value: OptionValue;
  state: OptionState | undefined;
}) {
  const { message } = useLocale();
  const reason = state?.reason;
  const rendered = reason ? message(reason) : null;

  return (
    <p className="text-caption text-chalk-3">
      <CatalogText
        at={{
          on: 'optionLabel',
          productId: product.id,
          groupCode: group.code,
          valueCode: value.code,
        }}
        th={value.labelTh}
        className="text-danger"
      />
      {rendered ? (
        <>
          {' — '}
          <span {...(rendered.fallback ? { lang: 'th' } : {})}>{rendered.text}</span>
        </>
      ) : null}
    </p>
  );
}

/**
 * The proportion the drawing layer works in.
 *
 * The one place a canonical length is widened to a float, and deliberately at the
 * SVG boundary: `Math.max(3_200_000n, 1)` throws, so no bigint may cross into that
 * layer. A height nobody has entered stays `0n` upstream, and zero divides into an
 * Infinity that each consumer would otherwise have to recognise on its own.
 */
const ratioOf = (widthUm: bigint, heightUm: bigint): number =>
  heightUm > 0n ? Number(widthUm) / Number(heightUm) : 1;

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
      // Carried, not re-derived: the line records what the customer measured in, and
      // rebuilding it from the catalogue would put an inch reading back in cm and
      // move it to the metric grid the first time the field is touched.
      enteredUnits: editingLine.enteredUnits,
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
    // Verbatim micrometres. Opening a link is not typing a value, so nothing here is
    // snapped to a grid: a 3,200,000 µm window that arrives from a link has to still
    // be 3,200,000 µm on the screen it arrives at.
    measures: { ...defaults.measures, ...shared.measures },
    // A link only carries a unit for a group it also carries a measurement for, so
    // merging over the defaults keeps the rest on the catalogue's own idiom.
    enteredUnits: { ...defaults.enteredUnits, ...shared.enteredUnits },
    qty: shared.qty,
  };
}
