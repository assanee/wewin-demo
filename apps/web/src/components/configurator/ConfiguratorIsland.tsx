'use client';

import { useMemo, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { getProductBySlug } from '@wewin/core/fixtures';
import { getCustomGroup, getSkuGroup } from '@wewin/core/filters';
import { configHash } from '@wewin/core/hash';
import { buildShareUrl, readSharedConfig, type SharedConfig } from '@wewin/core/share-link';
import type { QuoteLine } from '@wewin/core/quote';
import type { CustomGroup, OptionValue, Product, SkuGroup } from '@wewin/core';
import type { OptionState } from '@wewin/core/option-states';

import { productSpecs } from '../../data/company';
import type { PlainKey } from '../../i18n/keys';
import type { Locale } from '../../i18n/locales';
import { localeHref } from '../../lib/routing';
import { defaultStateFor, useConfigurator, type ConfiguratorState } from '../../state/useConfigurator';
import { useDisplayUnit } from '../../state/displayUnitContext';
import { useLocale } from '../../state/localeContext';
import { useMediaQuery } from '../../state/useMediaQuery';
import { useQuote } from '../../state/useQuote';
import { useOrigin, useUrlSearch } from '../../state/useUrlSearch';
import { ButtonLink } from '../common/Button';
import { BottomSheet } from '../common/BottomSheet';
import { CatalogText } from '../common/CatalogText';
import { Schematic } from '../common/Schematic';
import { useToast } from '../common/useToast';
import { UnitPicker } from '../common/UnitPicker';
import { ChipGroup } from './ChipGroup';
import { ConfiguratorToolbar } from './ConfiguratorToolbar';
import { ElevationPreview } from './ElevationPreview';
import { IssuePanel } from './IssuePanel';
import { MeasureInput } from './MeasureInput';
import { PriceBreakdownList } from './PriceBreakdownList';
import { PriceStickyBar, PriceSummaryCard } from './PriceSummary';
import { SwatchGroup } from './SwatchGroup';
import { ToggleOption } from './ToggleOption';

/**
 * # The configurator, moved whole.
 *
 * Plan 8.1, in as many words: *"debounce · a live SVG · undo/redo history ·
 * localStorage — splitting this into server components buys nothing and costs
 * correctness. The RSC win is the catalogue, not this."* So this file carries the only
 * `'use client'` directive in the port, and everything from the first interactive
 * control inward is below it: `useConfigurator`'s History, `MeasureInput`'s debounce and
 * dirty flag, `ElevationPreview`'s `ResizeObserver`, the quote's `localStorage` mirror,
 * the share sheet and the QR encoder.
 *
 * ## `'use client'` does not mean "not rendered on the server"
 *
 * It is worth stating because the opposite belief is what would make somebody split
 * this. A client component is still **prerendered to HTML at build time**; the directive
 * decides where it is *hydrated*, not where it is *rendered*. So the 648 pages this move
 * exists for still ship a complete document — the product name, the specs, the controls,
 * the sizes and the price are all in the HTML a crawler reads — and the island is one
 * island rather than five because the plan says so and because nothing here would work
 * split.
 *
 * What that buys has a matching obligation, and it is the risk named in the brief: every
 * value this subtree renders must be **the same on the server and on the first client
 * render**. A date, a random id, a stored preference or a query string read during render
 * is a mismatch, and React answers a mismatch by re-rendering quietly rather than by
 * telling anybody. Four such values exist here and all four are handled the same way —
 * they start at the value the server has, and the browser's answer arrives in an effect:
 *
 * | value | server / first client render | arrives |
 * |---|---|---|
 * | the display unit (`aluform.displayUnit.v1`) | `cm`, the unit the catalogue is authored in | `DisplayUnitProvider`'s mount effect |
 * | the quote (`aluform.quote.v1`) | empty, `ready === false` | `QuoteProvider`'s mount effect |
 * | the query string (`?line`, `?width…&v=3`) | empty | `useUrlSearch`'s mount effect |
 * | the origin, for the share link | `''` → a relative URL | `useOrigin`'s mount effect |
 *
 * And one that is *not* deferred, because it does not have to be: **the language**. It is
 * the `[locale]` path segment, narrowed by the server component that renders this and
 * handed down as a prop, so both halves read it off the same URL. That is plan 8.7(2)
 * paid — in the Vite app the locale came out of `localStorage` after mount, which here
 * would have been a mismatch on every string on the page at once.
 *
 * `useMediaQuery` needs no entry in that table and it is the one piece of luck in this
 * port: it was written on `useSyncExternalStore` with an explicit server snapshot of
 * `false`, on the grounds that it "stays safe if the app ever moves to SSR". It did, and
 * it is.
 *
 * ## The providers are one floor up now
 *
 * `LocaleProvider` / `DisplayUnitProvider` / `QuoteProvider` / `ToastProvider` were
 * mounted here through the port, because writing into the shared locale layout would have
 * collided with the two agents porting the other two routes. They live in
 * `components/shell/AppShell.tsx` now — one mount, above every route, which is what the
 * cart requires: two `QuoteProvider`s in one tree are two carts writing one storage key.
 * This component is the island and nothing else.
 */
export function ConfiguratorIsland({
  locale,
  slug,
}: {
  /** Narrowed from the `[locale]` segment by the server component. Never guessed. */
  readonly locale: Locale;
  /** The `[slug]` segment. Verified to name a product by the server component. */
  readonly slug: string;
}) {
  return <ConfigureRoute locale={locale} slug={slug} />;
}

/**
 * `apps/web/src/pages/Configure.tsx`'s outer half: which product, which starting state.
 *
 * The two differences from the Vite version are both consequences of the query string
 * arriving one commit late (see `useUrlSearch`):
 *
 *   1. The `key` includes the query string. In the Vite app the params were readable on
 *      the first render, so keying on the product and the line id was enough. Here a
 *      share link's `?width=…` arrives *after* `useConfigurator` has already taken its
 *      initial state, and without the query in the key the link would be read and then
 *      ignored. A URL with no query — which is every crawled URL and most typed ones —
 *      produces the same key before and after mount and therefore never remounts.
 *   2. `getProductBySlug` is called here rather than the product being passed in. Only
 *      strings cross the server/client boundary: a `Product` holds `bigint` micrometres
 *      and `bigint` satang, and pushing one through the RSC payload would mean either
 *      serialising money by hand or trusting a serialiser with it. The fixtures are
 *      compiled into both bundles, so a slug is enough — and a slug is a value whose
 *      round trip cannot lose a unit.
 */
function ConfigureRoute({ locale, slug }: { locale: Locale; slug: string }) {
  const search = useUrlSearch();
  const product = getProductBySlug(slug);
  const { getLine, ready } = useQuote();
  const { t } = useLocale();

  // Unreachable in practice: the server component calls `notFound()` for a slug that
  // names no product, so this subtree is never rendered for one. `null` rather than a
  // second 404 UI, because two answers to "does this page exist" is how they drift.
  if (!product) return null;

  const editingLineId = search.get('line');
  const editingLine = editingLineId ? getLine(editingLineId) : undefined;

  // Wait for localStorage before deciding: rendering the defaults first and swapping
  // them in a moment later would throw away anything typed in between.
  if (editingLineId && !ready) {
    return <p className="text-body text-chalk-2">{t('configure.loadingLine')}</p>;
  }

  // A saved line wins over link parameters: opening the edit action on a line is a
  // stronger intent than whatever query string happens to be along for the ride.
  const shared = editingLine ? null : readSharedConfig(product, search);

  return (
    <ConfigureProduct
      key={`${product.id}:${editingLineId ?? 'new'}:${search.toString()}`}
      locale={locale}
      product={product}
      editingLine={editingLine}
      shared={shared}
    />
  );
}

function ConfigureProduct({
  locale,
  product,
  editingLine,
  shared,
}: {
  locale: Locale;
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
  const { addLine, updateLine } = useQuote();
  const { showToast } = useToast();
  const origin = useOrigin();

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

  const quoteHref = localeHref(locale, '/quote');

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
      // The Vite page called `navigate('/quote')` here, and this one does not — the
      // toast carries the link instead, so the destination is one tap away rather than
      // automatic. Two reasons, and the second is the one that decided it:
      //
      //   1. `/[locale]/quote` was not on disk when this was written. It is now, so
      //      `useRouter().push` would type-check today.
      //   2. `useRouter` is the App Router's context. Importing it here would make this
      //      island unrenderable outside a mounted Next router — including by
      //      `renderToStaticMarkup`, which is what `tests/configurator-render.test.ts`
      //      uses to prove that the whole configurator prerenders with no browser
      //      globals in reach. Trading that proof for one automatic navigation is a bad
      //      trade while the port is still being reviewed.
      //
      // Restoring it is a `router.push(quoteHref)` in a two-line wrapper that the test
      // can stub, and it belongs with the other `next/link` upgrades.
      showToast({
        messageKey: 'toast.lineSaved',
        action: { labelKey: 'toast.viewQuote', href: quoteHref },
      });
      return;
    }

    addLine(draft);
    showToast({
      messageKey: 'toast.lineAdded',
      action: { labelKey: 'toast.viewQuote', href: quoteHref },
    });
  };

  const profileHex = swatchOf('profile_color', '#7C7F85');
  const glassHex = swatchOf('glass_color', '#C9E4F7');
  const minBillableSqUm = product.minBillableSqUm;

  // The origin is `''` until the mount effect in `useOrigin` runs, so the server and the
  // first client render both produce a relative URL and agree. The sizes go in canonical
  // micrometres with the units the customer typed in beside them; the unit currently on
  // screen is not in the link at all. A link is the sizes, and the recipient reads them
  // in whichever unit — and whichever language — they themselves prefer.
  const shareUrl = useMemo(
    () =>
      buildShareUrl(
        origin,
        product,
        config.selections,
        config.measures,
        config.enteredUnits,
        config.qty,
      ),
    [origin, product, config.selections, config.measures, config.enteredUnits, config.qty],
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
    <>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,300px)_minmax(0,1fr)] lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] lg:gap-8">
        {/* ---- Left column: the drawing ---- */}
        <div className="md:sticky md:top-22 md:self-start">
          <div className="border border-line bg-panel p-3">
            <div className="h-55 w-full md:h-70 lg:h-80">
              {/* The drawing lays out in pixel space against its own measured box, and
                  used to render `null` until `ResizeObserver` had answered — which meant
                  it rendered nothing on the server, i.e. the signature element of the
                  storefront was missing from all 648 prerendered pages. It draws against
                  a constant fallback box now and rescales when the measurement lands; see
                  `ElevationPreview`. */}
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
          {/* CSS decides, not `useMediaQuery` — the same rule the catalogue's filter
              sidebar now follows, and for the same measured reason: the server snapshot
              of a media query is `false`, so a JS-gated branch renders the *mobile* half
              of this page into all 648 prerendered documents and swaps it after
              hydration. Two copies of a four-row `<dl>` in the DOM, one of them
              `display: none` and therefore out of the accessibility tree, is the price of
              the desktop half being in the HTML at all. */}
          <div className="hidden md:block">{specTable}</div>
        </div>

        {/* ---- Right column: the controls ---- */}
        <div className="flex min-w-0 flex-col gap-6">
          {/* 1. Name */}
          <div className="min-w-0">
            <p className="text-caption text-chalk-3">
              <CatalogText at={{ on: 'productName', productId: product.id }} th={product.nameTh} />
            </p>
            {/*
              ⚠️ **The rename was removed, and the name was not.**
              ─────────────────────────────────────────────────────────────────
              A pencil here let a customer call a line "หน้าต่างห้องนอน 1" — and that name
              **never left the browser**. `PriceRequestWire` carries no description field, and
              `customerDescriptionTh` on the pinned document comes from `quote_lines`, which
              sales edits. So the quotation the customer received said nothing they had typed.

              An affordance that promises to name a thing and does not is worse than no
              affordance: the customer did the work, believed it landed, and had no way to
              discover it had not. Removing it closes the promise rather than the gap.

              ⚠️ **The gap itself is still open**, upstream: `submit_for_payment` should freeze
              a description alongside the prices and the locale. On the day it does, this is
              where the pencil comes back.

              `nickname` stays because it is still a *label* — the cart rows, the line cards
              and every `aria-label` about "this window" read it, and it is the product name
              until somebody has a reason to change it. It is derived now, not typed.
            */}
            <h1 className="mt-1 min-w-0 text-title text-chalk lg:text-display">{config.nickname}</h1>
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
          {/* The SKU code, the per-piece price, the quantity, the line total, the VAT
              note and the lead time all live in here — and none of them were in the
              prerendered HTML while this was JS-gated, because the server always took the
              mobile branch. */}
          <div className="hidden md:block">
            <PriceSummaryCard
              product={product}
              price={config.price}
              skuCode={config.skuCode}
              qty={config.qty}
              onQtyChange={config.setQty}
              onAdd={onAdd}
              hasError={config.hasError}
            />
          </div>

          <div className="md:hidden">{specTable}</div>

          <p className="text-caption text-chalk-3">{t('configure.futureQuote')}</p>

          <div>
            {/* A document load, not a client transition — `ButtonLink` is a plain `<a>`
                across all three ported screens today, and the note on it says why. Now
                that `/[locale]/products` exists this can become
                `<Link href={catalogHref(locale)}>`; it is one edit in `Button.tsx` and
                it belongs in the commit that makes it for all three at once. */}
            <ButtonLink href={localeHref(locale, '/products')} variant="ghost">
              {t('nav.backToProducts')}
            </ButtonLink>
          </div>
        </div>
      </div>

      {/* `StickyBar` reserves its own height on `<body>` by measuring itself; hidden at
          `md` it measures 0, which is the right reservation for a bar nobody can see. */}
      <div className="md:hidden">
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
      </div>

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
    </>
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
