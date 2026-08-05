import { getProductById } from '@wewin/core/fixtures';
import { useQuote } from '../state/useQuote';
import { useIsDesktop } from '../state/useMediaQuery';
import { longestLeadTime, quoteItemCount, quoteTotal } from '@wewin/core/quote';
import { useLocale } from '../state/localeContext';
import { ButtonLink } from '../components/common/Button';
import { StickyBar } from '../components/common/StickyBar';
import { QuoteLineRow } from '../components/quote/QuoteLineRow';
import { QuoteLineCard } from '../components/quote/QuoteLineCard';

const TH_HEAD = 'py-2 pe-3 text-caption font-normal tracking-[0.08em] text-chalk-3 uppercase';

export function Quote() {
  const { lines, setQty, removeLine, duplicateLine } = useQuote();
  const isDesktop = useIsDesktop();
  const { t, f } = useLocale();

  const total = quoteTotal(lines);
  const itemCount = quoteItemCount(lines);
  const leadTime = longestLeadTime(lines, getProductById);

  if (lines.length === 0) {
    return (
      <main className="container-page py-16 md:py-24">
        <div className="mx-auto max-w-130 border border-line bg-panel px-6 py-14 text-center">
          {/* An invitation, not an apology (spec section 2). */}
          <h1 className="text-title text-chalk">{t('quote.empty.title')}</h1>
          <p className="mx-auto mt-2 max-w-[42ch] text-body text-chalk-2">
            {t('quote.empty.body')}
          </p>
          <div className="mt-6 flex justify-center">
            <ButtonLink to="/products" variant="primary" size="lg">
              {t('quote.empty.cta')}
            </ButtonLink>
          </div>
        </div>
      </main>
    );
  }

  const summaryRows = (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-body text-chalk-2">{t('quote.summary.lineCount')}</span>
        <span className="numeric text-body text-chalk">
          {t('quote.summary.lineCountValue', { lines: lines.length, pieces: itemCount })}
        </span>
      </div>
      {leadTime ? (
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-body text-chalk-2">{t('quote.summary.leadTime')}</span>
          <span className="numeric text-body text-chalk">{t('leadTime.range', { days: leadTime })}</span>
        </div>
      ) : null}
      <div className="flex items-baseline justify-between gap-3 border-t border-line pt-3">
        <span className="text-lead text-chalk">{t('price.grandTotal')}</span>
        <span className="numeric text-display text-lime">{f.baht(total)}</span>
      </div>
      <p className="numeric text-caption text-chalk-3">{t('price.vatExcluded')}</p>
      <p className="mt-2 border-t border-line pt-3 text-caption text-chalk-3">
        {t('configure.futureQuote')}
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
        <h1 className="text-title text-chalk lg:text-display">{t('quote.heading')}</h1>
        <p className="numeric text-small text-chalk-2" aria-live="polite">
          {t('count.items', { count: lines.length })}
        </p>
      </div>

      {/* Table on lg, cards below it — one structure at a time. Rendering both and
          hiding one with CSS would make a screen reader read every line twice, and
          spec section 8 rules out a horizontally scrolling table on mobile. */}
      {isDesktop ? (
        <table className="w-full border-collapse">
          <caption className="sr-only">{t('quote.tableCaption')}</caption>
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className={`${TH_HEAD} text-start`}>{t('quote.col.name')}</th>
              <th scope="col" className={`${TH_HEAD} text-start`}>{t('quote.col.sku')}</th>
              <th scope="col" className={`${TH_HEAD} text-start`}>{t('quote.col.size')}</th>
              <th scope="col" className={`${TH_HEAD} text-start`}>{t('quote.col.qty')}</th>
              <th scope="col" className={`${TH_HEAD} text-end`}>{t('quote.col.unitPrice')}</th>
              <th scope="col" className={`${TH_HEAD} text-end`}>{t('quote.col.total')}</th>
              <th scope="col" className={TH_HEAD}>
                <span className="sr-only">{t('quote.col.actions')}</span>
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
          aria-label={t('quote.summary.label')}
          className="mt-8 ms-auto flex max-w-105 flex-col gap-2 border border-line bg-panel p-5"
        >
          {summaryRows}
        </section>
      ) : (
        <>
          <section
            aria-label={t('quote.summary.label')}
            className="mt-6 flex flex-col gap-2 border border-line bg-panel p-4"
          >
            {summaryRows}
          </section>

          <StickyBar>
            <div className="min-w-0">
              <p className="numeric text-lead text-lime">{f.baht(total)}</p>
              <p className="numeric text-caption text-chalk-3">
                {t('count.pieces', { count: itemCount })} · {t('price.vatExcludedShort')}
              </p>
            </div>
            <ButtonLink to="/products" className="shrink-0">
              {t('nav.addMore')}
            </ButtonLink>
          </StickyBar>
        </>
      )}
    </main>
  );
}
