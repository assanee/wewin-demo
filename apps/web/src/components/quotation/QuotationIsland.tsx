'use client';

import { useCallback, useEffect, useState, type ReactElement } from 'react';

import { printableQuotation, type PrintableQuotation } from '@wewin/core/quotation';

import { currentSession } from '../../lib/auth/account';
import { fetchQuotation, quotationSource, type QuotationFailure, type Seller } from '../../lib/quotation/api';
import { useLocale } from '../../state/localeContext';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE QUOTATION, AS THE CUSTOMER OPENS IT FROM THEIR EMAIL.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── Why this is an island and not a page ─────────────────────────────────────
 *
 * The same argument `ReviewFormIsland` makes, and it is the reason both exist. What makes
 * this URL personal is `?t=<token>`, and the token must not reach the server render: this
 * app prerenders eight shells per route and `revalidate` is `false`, so a token in
 * `generateMetadata` or in a cache key is one customer's quotation served to the next person
 * who asks. Read in the browser, it never touches a cache key or a build log.
 *
 * ⚠️ The first render is therefore always `reading`, in all eight locales, and the token
 * arrives one commit later. That is deliberate: a value that differs between the server
 * render and the first client render is a hydration mismatch, and React answers a mismatch by
 * re-rendering quietly rather than by saying so.
 *
 * ── ⭐ Rendered by the same function the dashboard prints ────────────────────
 *
 * `printableQuotation` lives in `@wewin/core` for exactly this reason. Plan 10.6: *"เอกสารที่
 * พิมพ์ซ้ำแล้วได้คนละภาษาคือเอกสารที่ใช้อ้างอิงไม่ได้"* — a document that reprints differently
 * is one nobody can cite. Two renderers would be two documents, and the day they drifted the
 * customer and the salesperson would be reading different prices off the same order.
 *
 * ⚠️ **The document renders in its pinned locale, not the reader's.** The chrome around it —
 * headings, buttons, the notice — follows the reader. That split looks odd on screen and it
 * is the point: the prose is a user interface, the figures and the option labels are a
 * contract, and only one of the two is allowed to follow a language picker.
 */

type Phase =
  | { readonly kind: 'reading' }
  | { readonly kind: 'failed'; readonly reason: QuotationFailure }
  | {
      readonly kind: 'ready';
      readonly quotation: PrintableQuotation;
      readonly orderNo: string | null;
      /**
       * ⚠️ Beside `quotation`, not folded into it — the same split
       * `quotation-sheet.tsx` makes for the order it carries alongside the sheet.
       * `PrintableQuotation` is a pure function of the **pinned document** and must stay
       * one; the seller is read live and would make two prints of one quotation differ
       * the day the company moved address, which is exactly what plan 10.6 forbids.
       * `null` when the API answered with none — see `sellerFrom`.
       */
      readonly seller: Seller | null;
    };

export function QuotationIsland(): ReactElement {
  const { t } = useLocale();
  const [phase, setPhase] = useState<Phase>({ kind: 'reading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    /*
     * The whole read, in one effect. No `useSearchParams` — it makes the route dynamic, which
     * `state/useUrlSearch.ts` explains at length — and no `popstate` listener, because a
     * quotation that changes underneath somebody reading it is not a thing to support.
     */
    const source = quotationSource(window.location.search);

    /*
     * ⚠️ A session is fetched **only** for the owned path, and never for a token.
     *
     * A quotation link is opened by somebody who may have no account at all — spending a
     * refresh cookie for them would be a request that can only fail, and on a shared device
     * it would rotate a session belonging to whoever used the browser last.
     */
    const withSession =
      source.kind === 'owned'
        ? currentSession().then((session) => session?.accessToken)
        : Promise.resolve(undefined);

    void withSession
      .then((accessToken) => fetchQuotation(source, accessToken))
      .then((result) => {
      if (cancelled) return;

      setPhase(
        result.ok
          ? {
              kind: 'ready',
              quotation: printableQuotation(result.data.document),
              orderNo: result.data.orderNo,
              seller: result.data.seller,
            }
          : { kind: 'failed', reason: result.reason },
      );
    });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setPhase({ kind: 'reading' });
    setAttempt((previous) => previous + 1);
  }, []);

  if (phase.kind === 'reading') {
    return <p className="text-body text-chalk-2">{t('quotation.loading')}</p>;
  }

  if (phase.kind === 'failed') {
    /*
     * ⚠️ Two messages for five reasons, and the grouping is the API's decision showing
     * through. `refused` is one answer to expired, mistyped, unknown and never-submitted — the
     * server refuses to distinguish them so that one valid link cannot be used to probe for
     * others — so this page cannot say "your link has expired" however much it would help.
     * What it can do is offer the action that works in every one of those cases.
     */
    const transient = phase.reason === 'unreachable';

    return (
      <div className="border border-line bg-panel p-4">
        <h1 className="text-display text-chalk">
          {t(transient ? 'quotation.unreachable.title' : 'quotation.unavailable.title')}
        </h1>
        <p className="mt-2 text-body text-chalk-2">
          {t(transient ? 'quotation.unreachable.body' : 'quotation.unavailable.body')}
        </p>
        {transient ? (
          <button
            type="button"
            onClick={retry}
            className="mt-4 border border-line px-4 py-2 text-small text-chalk"
          >
            {t('quotation.retry')}
          </button>
        ) : null}
      </div>
    );
  }

  return <Sheet quotation={phase.quotation} orderNo={phase.orderNo} seller={phase.seller} t={t} />;
}

type Translate = ReturnType<typeof useLocale>['t'];

function Sheet({
  quotation,
  orderNo,
  seller,
  t,
}: {
  readonly quotation: PrintableQuotation;
  readonly orderNo: string | null;
  readonly seller: Seller | null;
  readonly t: Translate;
}): ReactElement {
  return (
    <article>
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-display text-chalk">
          {t('quotation.heading')} {orderNo ?? quotation.orderNoText}
        </h1>
        {/*
         * ⚠️ `print:hidden`, and the print stylesheet does the rest. A customer's "save as
         * PDF" is the browser's, not ours — a server-rendered PDF is a second renderer and
         * therefore a second document, which is the thing plan 10.6 forbids.
         */}
        <button
          type="button"
          onClick={() => {
            window.print();
          }}
          className="border border-line px-4 py-2 text-small text-chalk print:hidden"
        >
          {t('quotation.print')}
        </button>
      </header>

      {quotation.localeDegraded ? (
        <p className="mt-3 border border-line bg-panel-2 p-3 text-small text-chalk-2">
          {t('quotation.degraded')}
        </p>
      ) : null}

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-2 text-small md:grid-cols-4">
        <Field label={t('quotation.revision')} value={quotation.revisionText} />
        <Field label={t('quotation.submittedAt')} value={quotation.submittedAtText} />
        <Field label={t('quotation.leadTime')} value={quotation.leadTimeText} />
        {quotation.contactName === null ? null : (
          <Field label={t('quotation.contact')} value={quotation.contactName} />
        )}
      </dl>

      {/*
       * ⭐ Who is offering this — task 11b. `seller` is read live, never pinned: the
       * legal name and address are the company's own content, rendered as stored rather
       * than through a translation key (`i18n/keys.ts`'s own rule for content), while
       * "Telephone" and "Tax ID" are UI chrome and follow the reader's locale like every
       * other label on this page.
       */}
      {seller === null ? null : (
        <div className="mt-5 border-b border-line pb-4 text-small">
          <p className="text-body text-chalk">{seller.legalNameTh}</p>
          <p className="mt-1 text-chalk-2">{seller.addressTh}</p>
          <p className="mt-1 text-chalk-2">
            {t('quotation.seller.phone')} {seller.phone}
            {seller.taxId === null ? null : ` · ${t('quotation.seller.taxId')} ${seller.taxId}`}
          </p>
        </div>
      )}

      <div className="mt-6 overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-body">
          <thead>
            <tr className="border-b border-line text-left text-caption text-chalk-2">
              <th className="py-2 pr-3 font-normal">{t('quotation.lineNo')}</th>
              <th className="py-2 pr-3 font-normal">{t('quotation.item')}</th>
              <th className="py-2 pr-3 text-right font-normal">{t('quotation.qty')}</th>
              <th className="py-2 text-right font-normal">{t('quotation.amount')}</th>
            </tr>
          </thead>
          <tbody>
            {quotation.lines.map((line) => (
              <tr key={line.lineNo} className="border-b border-line align-top">
                <td className="py-3 pr-3 tabular-nums text-chalk-2">{line.lineNo}</td>
                <td className="py-3 pr-3">
                  <div className="text-chalk">{line.nameTh}</div>
                  {line.customerDescriptionTh === null ? null : (
                    <div className="text-caption text-chalk-2">{line.customerDescriptionTh}</div>
                  )}
                  {/*
                   * ⚠️ `detail` is the *pinned* text — `สีกระจก: ใส`, never `CLR`. It comes off
                   * the document rather than the live catalogue, so renaming an option next
                   * year does not change what this customer was quoted.
                   */}
                  <ul className="mt-1 text-caption text-chalk-2">
                    {line.detail.map((detail) => (
                      <li key={detail}>{detail}</li>
                    ))}
                  </ul>
                </td>
                <td className="py-3 pr-3 text-right tabular-nums text-chalk">{line.qtyText}</td>
                <td className="py-3 text-right tabular-nums text-chalk">{line.netText}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {quotation.charges.length === 0 ? null : (
        <dl className="mt-4 text-body">
          <dt className="text-caption text-chalk-2">{t('quotation.charges')}</dt>
          {quotation.charges.map((charge) => (
            <div key={charge.labelTh} className="flex justify-between border-b border-line py-2">
              <dd className="text-chalk-2">{charge.labelTh}</dd>
              <dd className="tabular-nums text-chalk">{charge.amountText}</dd>
            </div>
          ))}
        </dl>
      )}

      <dl className="mt-6 ml-auto max-w-[320px] text-body">
        <Row label={t('quotation.net')} value={quotation.netText} />
        <Row label={`${t('quotation.vat')} ${quotation.vatRateText}`} value={quotation.vatText} />
        <Row label={t('quotation.total')} value={quotation.grandTotalText} strong />
      </dl>

      {/*
       * The hash, small and present. It is what makes "the quotation you sent me in August"
       * a thing two people can check they are holding the same copy of.
       */}
      <p className="mt-6 text-caption text-chalk-2">
        {t('quotation.pinnedNotice')} · <span className="font-mono">{quotation.documentHash}</span>
      </p>
    </article>
  );
}

function Field({ label, value }: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <div>
      <dt className="text-caption text-chalk-2">{label}</dt>
      <dd className="text-chalk">{value}</dd>
    </div>
  );
}

function Row({
  label,
  value,
  strong = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly strong?: boolean;
}): ReactElement {
  return (
    <div className={`flex justify-between py-1 ${strong ? 'border-t border-line pt-2' : ''}`}>
      <dt className="text-chalk-2">{label}</dt>
      <dd className={`tabular-nums ${strong ? 'text-display text-chalk' : 'text-chalk'}`}>{value}</dd>
    </div>
  );
}
