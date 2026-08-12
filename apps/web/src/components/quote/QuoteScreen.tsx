'use client';

import { useState } from 'react';

import { getProductById } from '@wewin/core/fixtures';
import { longestLeadTime, quoteItemCount, quoteTotal } from '@wewin/core/quote';

import { localeHref } from '../../lib/routing';
import { useQuote } from '../../state/useQuote';
import { useLocale } from '../../state/localeContext';
import { useIsDesktop } from '../../state/useMediaQuery';
import { ButtonLink } from '../common/Button';
import { StickyBar } from '../common/StickyBar';
import { QuoteLineRow } from './QuoteLineRow';
import { QuoteLineCard } from './QuoteLineCard';
import { AccountGate } from '../account/AccountGate';
import { MyQuotations } from '../account/MyQuotations';
import { RequestQuotationForm } from './RequestQuotationForm';
import { SubmittedNotice } from './SubmittedNotice';

const TH_HEAD_CLASS = 'py-2 pe-3 text-caption font-normal tracking-[0.08em] text-chalk-3 uppercase';

/**
 * # The cart, and why the whole screen is one client island
 *
 * The quote is `localStorage`. Not "backed by", not "cached in" — it *is* the browser's
 * storage, read through `parseStoredQuote` and written back by `QuoteProvider`. There is
 * no version of this screen a server can render, because the server has never seen the
 * data. That makes the boundary decision trivial where the catalogue's was interesting:
 * everything from `<main>` inward is client, and the server component next door does the
 * one thing a server can do here — set `<html lang>`, the title and the hreflang set.
 *
 * That is not a loss. Plan 8.1 draws the line in the same place for the configurator, and
 * the sentence it uses applies word for word: **the RSC win is the catalogue, not this.**
 *
 * ## What the prerendered HTML of `/th/quote` actually contains
 *
 * Nothing about anybody's cart. `QuoteProvider` starts from `emptyQuote()` — `lines: []`,
 * `hydrated: false` — on the server and on the first client render alike, so the cached
 * markup carries no line, no size and, most importantly, **no price**. The locale layout
 * is explicit that until `revalidateTag('product:'+id)` and the API's `priceVersion`
 * refusal both exist, a page under it "may render a product's name and its shape; it may
 * not render its price." This screen renders eight prices per line and is still inside
 * that rule, because every one of them appears after hydration, from a `priceSnapshot`
 * this customer's own browser locked at the moment they added the line. A cached page
 * that cannot contain a price cannot serve a stale one.
 *
 * The same fact answers plan 8.2(3) for this route without needing a decision: currency
 * and display unit are per-user preferences that are in no cache key, and the reason
 * that is safe here is that no cache ever holds a rendered one.
 *
 * ## `ready` gates the empty state, and that is a fix the port forced
 *
 * The Vite screen branched on `lines.length === 0` and never consulted `ready`, so a
 * returning customer saw "your cart is empty" for one commit before their lines appeared.
 * A one-frame flash in an SPA; here it would be **the sentence in the cached HTML**, the
 * one a crawler indexes and the one every returning customer is served first. So the
 * screen now says nothing until storage has answered. `ready` is `state.hydrated`, the
 * flag phase 0 put in reducer state for a different reason and documented at length in
 * `@wewin/core/quote` — this is its third job, and none of the three survive turning it
 * into a ref.
 *
 * ## The providers are in the shell
 *
 * They were mounted here through the port, when there was no client shell above the
 * routes. `components/shell/AppShell.tsx` holds all four now, and they moved **as a set**
 * — two `QuoteProvider`s in one tree would be two independent carts writing the same
 * storage key over each other, which is why this screen no longer mounts one even though
 * it is the screen that reads it.
 */
export function QuoteScreen() {
  /*
   * ⚠️ Bumped when a quotation is created, so the list below it catches up.
   *
   * Without this the customer pressed the button, was told "WW-1008", and read
   * "ยังไม่มีใบเสนอราคา" directly underneath — the data was right and only the list was stale.
   */
  const [quotationsKey, setQuotationsKey] = useState(0);
  /*
   * ⚠️ Kept in memory only. On the next visit the cart genuinely is empty and the quotation
   * lives in the account — persisting this would show a stale "your quotation is ready" to
   * somebody who came back a week later to start a new one.
   */
  const [justSubmitted, setJustSubmitted] = useState<{
    readonly orderId: string;
    readonly orderNo: string | null;
  } | null>(null);

  const { clear, lines, setQty, removeLine, duplicateLine, ready } = useQuote();
  const isDesktop = useIsDesktop();
  const { t, f, locale } = useLocale();

  const total = quoteTotal(lines);
  const itemCount = quoteItemCount(lines);
  const leadTime = longestLeadTime(lines, getProductById);
  const productsHref = localeHref(locale, '/products');

  // Storage has not answered yet. Deliberately not the empty state — see the header.
  // `configure.loadingLine` is reused rather than a ninth catalogue key invented: it
  // already reads "loading the item(s)" in Thai and is translated wherever anything is.
  if (!ready) {
    return (
      <main className="container-page py-16">
        <p className="text-body text-chalk-2">{t('configure.loadingLine')}</p>
      </main>
    );
  }

  /*
   * ⚠️ Two different empty carts, and they must not render the same screen.
   *
   * Clearing on success is right — the lines became an order, and leaving them kept "ตะกร้า 1"
   * in the header and the button live for a second identical submit. But falling straight into
   * "your cart is empty" would take the success screen away in the same commit, so the
   * customer would be told their quotation number and then shown an invitation to start
   * shopping, with the number gone.
   *
   * `justSubmitted` keeps the outcome on screen. It is deliberately *not* persisted: on the
   * next visit the cart genuinely is empty, and the quotation lives in the account.
   */
  if (lines.length === 0 && justSubmitted !== null) {
    return (
      <main className="container-page py-16 md:py-24">
        <div className="mx-auto max-w-130">
          <AccountGate>
            {(session) => (
              <>
                <SubmittedNotice orderId={justSubmitted.orderId} orderNo={justSubmitted.orderNo} />
                <section className="mt-4 border border-line bg-panel p-4">
                  <h2 className="text-lead text-chalk">{t('account.myQuotations')}</h2>
                  <div className="mt-3">
                    <MyQuotations session={session} reloadKey={quotationsKey} />
                  </div>
                </section>
              </>
            )}
          </AccountGate>
        </div>
      </main>
    );
  }

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
            <ButtonLink href={productsHref} variant="primary" size="lg">
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
      {/*
        ⭐ The old `configure.futureQuote` used to be here, and it was telling the truth: everything
        downstream of a submit existed and there was no way to reach it. The form below is the
        step that was missing, so the apology is gone.

        ⚠️ It was removed *here only*. The product page kept rendering the same key for another
        round — see `ConfiguratorIsland`, where it is now `configure.quoteNext`. Deleting one
        copy of a sentence is not the same as retiring it.
      */}
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
              <th scope="col" className={`${TH_HEAD_CLASS} text-start`}>{t('quote.col.name')}</th>
              <th scope="col" className={`${TH_HEAD_CLASS} text-start`}>{t('quote.col.sku')}</th>
              <th scope="col" className={`${TH_HEAD_CLASS} text-start`}>{t('quote.col.size')}</th>
              <th scope="col" className={`${TH_HEAD_CLASS} text-start`}>{t('quote.col.qty')}</th>
              <th scope="col" className={`${TH_HEAD_CLASS} text-end`}>{t('quote.col.unitPrice')}</th>
              <th scope="col" className={`${TH_HEAD_CLASS} text-end`}>{t('quote.col.total')}</th>
              <th scope="col" className={TH_HEAD_CLASS}>
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
        <div className="mt-8 ms-auto flex max-w-105 flex-col gap-4">
          <section
            aria-label={t('quote.summary.label')}
            className="flex flex-col gap-2 border border-line bg-panel p-5"
          >
            {summaryRows}
          </section>
          <AccountGate>
            {(session) => (
              <>
                <RequestQuotationForm
                  lines={lines}
                  session={session}
                  onSubmitted={(order) => {
                    setJustSubmitted(order);
                    setQuotationsKey((key) => key + 1);
                    /*
                     * ⭐ The cart is now an order. Leaving it behind kept "ตะกร้า 1" in the
                     * header and left the button live — a second press submitted a second
                     * identical order, and `orders_block_delete()` refuses to remove one.
                     */
                    clear();
                  }}
                />
                {/*
                  ⭐ The reason for having asked. A customer who signs in and sees nothing has
                  been made to do work for a benefit they cannot observe.
                */}
                <section className="border border-line bg-panel p-4">
                  <h2 className="text-lead text-chalk">{t('account.myQuotations')}</h2>
                  <div className="mt-3">
                    <MyQuotations session={session} reloadKey={quotationsKey} />
                  </div>
                </section>
              </>
            )}
          </AccountGate>
        </div>
      ) : (
        <>
          <section
            aria-label={t('quote.summary.label')}
            className="mt-6 flex flex-col gap-2 border border-line bg-panel p-4"
          >
            {summaryRows}
          </section>

          {/*
            ⚠️ Above the sticky bar, not inside it. The bar is a summary a thumb reaches; a form
            with three fields inside it would cover the cart it is about.
          */}
          <div className="mt-4">
            <AccountGate>
            {(session) => (
              <>
                <RequestQuotationForm
                  lines={lines}
                  session={session}
                  onSubmitted={(order) => {
                    setJustSubmitted(order);
                    setQuotationsKey((key) => key + 1);
                    /*
                     * ⭐ The cart is now an order. Leaving it behind kept "ตะกร้า 1" in the
                     * header and left the button live — a second press submitted a second
                     * identical order, and `orders_block_delete()` refuses to remove one.
                     */
                    clear();
                  }}
                />
                {/*
                  ⭐ The reason for having asked. A customer who signs in and sees nothing has
                  been made to do work for a benefit they cannot observe.
                */}
                <section className="border border-line bg-panel p-4">
                  <h2 className="text-lead text-chalk">{t('account.myQuotations')}</h2>
                  <div className="mt-3">
                    <MyQuotations session={session} reloadKey={quotationsKey} />
                  </div>
                </section>
              </>
            )}
          </AccountGate>
          </div>

          <StickyBar>
            <div className="min-w-0">
              <p className="numeric text-lead text-lime">{f.baht(total)}</p>
              <p className="numeric text-caption text-chalk-3">
                {t('count.pieces', { count: itemCount })}
              </p>
            </div>
            <ButtonLink href={productsHref} className="shrink-0">
              {t('nav.addMore')}
            </ButtonLink>
          </StickyBar>
        </>
      )}
    </main>
  );
}
