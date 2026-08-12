'use client';

import { useCallback, useEffect, useState, type ReactElement } from 'react';

import { printableQuotation, type PrintableQuotation } from '@wewin/core/quotation';

import { currentSession } from '../../lib/auth/account';
import { acceptsPayment } from '../../lib/payment/payable';
import { fetchQuotation, quotationSource, type QuotationFailure, type Seller } from '../../lib/quotation/api';
import { localeHref } from '../../lib/routing';
import type { Locale } from '../../i18n/locales';
import { useLocale } from '../../state/localeContext';
import { ButtonLink } from '../common/Button';

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
      /**
       * ⭐ The order's live status, which this component decoded and then threw away.
       *
       * `LinkedQuotation.status` has been on the wire and read by `decodeQuotation` since the
       * page was written; the `ready` phase simply did not carry it, so the one fact that
       * decides whether there is anything left to pay never reached a render. See
       * `lib/payment/payable.ts`.
       *
       * ⚠️ Live, and therefore *not* part of `quotation` — `PrintableQuotation` is a pure
       * function of the pinned document and must stay one, exactly as `seller` is kept beside
       * it rather than folded in. A status inside the document would make a reprint of an
       * August quotation say the order is still awaiting payment forever.
       */
      readonly status: string;
      /**
       * ⚠️ The order's UUID, and **only on the `?order=` half of this page**.
       *
       * `null` for every quotation opened from an emailed `?t=` link, because there is no id
       * to have: `LinkedDocumentWire` carries `orderNo`, `status`, `contactName`,
       * `submittedAt`, `document` and `seller` — and deliberately no `id`. The route's own
       * header states the rule ("the token names the order; nothing else needs to"), and
       * `document-link.controller.ts` refuses the handler shape that would take an id beside
       * a signature. Adding one to that response to light up a button here would undo the
       * property the whole design is built on, so the button is absent on that half instead.
       */
      readonly orderId: string | null;
    };

export function QuotationIsland(): ReactElement {
  const { t, locale } = useLocale();
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
              status: result.data.status,
              /* The id this page was opened with, never one derived from the response — the
               * token half has none, and `source` is the only place either half is known. */
              orderId: source.kind === 'owned' ? source.orderId : null,
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

  return (
    <Sheet
      quotation={phase.quotation}
      orderNo={phase.orderNo}
      seller={phase.seller}
      /*
       * ⭐ The pay action's two conditions, resolved here rather than inside `Sheet`.
       *
       * `Sheet` renders a document; whether this customer may act on it is a fact about the
       * live order and about how the page was opened, and neither belongs in a component
       * whose job is to print pinned figures. So it receives an id or `null` and asks no
       * questions — `null` covers both "opened from an email, no id to link with" and
       * "finished, nothing to pay".
       */
      payOrderId={acceptsPayment(phase.status) ? phase.orderId : null}
      locale={locale}
      t={t}
    />
  );
}

type Translate = ReturnType<typeof useLocale>['t'];

function Sheet({
  quotation,
  orderNo,
  seller,
  payOrderId,
  locale,
  t,
}: {
  readonly quotation: PrintableQuotation;
  readonly orderNo: string | null;
  readonly seller: Seller | null;
  /** The order to pay, or `null` when this quotation offers no payment. See the call site. */
  readonly payOrderId: string | null;
  readonly locale: Locale;
  readonly t: Translate;
}): ReactElement {
  /*
   * ⭐ One deposit row, rendered in one of two places — see the domestic block below.
   *
   * Built once here so the foreign and domestic branches cannot drift into printing the
   * deposit with two different labels or two different formats. `@wewin/core` has already
   * decided whether there is one to print: `depositThbText` is null when the schedule has no
   * deposit *and* when the deposit is the whole total (a pay-in-full policy), where a second
   * identical figure under "ชำระมัดจำก่อน" would read as a second obligation.
   */
  const depositRow =
    quotation.depositThbText === null ? null : (
      <Row label={t('quotation.fx.deposit')} value={quotation.depositThbText} />
    );

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
        <Row
          label={`${t('quotation.vat')} ${quotation.vatRateText}${
            quotation.vatIsIncluded ? ` (${t('quotation.vatIncluded')})` : ''
          }`}
          value={quotation.vatText}
        />
        <Row label={t('quotation.total')} value={quotation.grandTotalText} strong />
      </dl>

      {/*
       * ⭐ THE RATE, AND WHY IT IS THE ONLY THING ON THIS PAGE THAT MENTIONS BAHT.
       *
       * Every figure above is already in the destination's currency — the owner's requirement
       * is that it *replaces* baht, not that it sits in a second column beside it. What a
       * reader still needs is the rate those figures were struck at and when, because that is
       * what makes the number checkable rather than merely asserted. It is the same rate the
       * document froze at submit, so a reprint years from now says the same thing.
       *
       * ⚠️ `rateText` is a rendering. Dividing the printed total by the printed rate will not
       * reproduce the figures to the last cent — the conversion used an exact ratio, which is
       * pinned in the document but is not something to put in front of a customer.
       */}
      {quotation.fxRate === null ? null : (
        <div className="mt-4 ml-auto max-w-[320px]">
          {/*
           * ⭐ The amount actually transferred, in baht.
           *
           * The figures above are the price and this is the payment — the owner's decision is
           * that a foreign destination is quoted in its own currency and settled in baht. Both
           * belong on the page: a customer who sees only the SGD total meets the baht figure
           * for the first time on the payment screen, and two amounts discovered one at a time
           * is how somebody transfers the wrong one.
           *
           * ⚠️ It is the *pinned* baht total, not the SGD total converted back — see
           * `payableThbText` in `@wewin/core/quotation`. It is therefore the same integer the
           * payment page charges, which a database trigger keeps equal to the document.
           */}
          {quotation.payableThbText === null ? null : (
            <div className="border-t border-line pt-2">
              <p className="text-caption text-chalk-2">
                {t('quotation.fx.settlementNote', { currency: quotation.fxRate.currency })}
              </p>
              <Row label={t('quotation.fx.payable')} value={quotation.payableThbText} strong />
              {depositRow}
            </div>
          )}

          <p className="mt-3 text-caption text-chalk-2">
            {t('quotation.fx.rate', {
              currency: quotation.fxRate.currency,
              rateText: quotation.fxRate.rateText,
            })}
            {quotation.fxRate.isManual
              ? ` · ${t('quotation.fx.manual')}`
              : ` · ${t('quotation.fx.observedAt', { observedAt: quotation.fxRate.observedAtText })}`}
          </p>
        </div>
      )}

      {/*
       * ⭐ THE DEPOSIT ON A DOMESTIC ORDER, WHICH THIS PAGE NEVER USED TO PRINT.
       *
       * `depositThbText` was conditioned on `fx` inside `@wewin/core`, so a Thai customer was
       * told the total and nothing else — and then met `฿4,237.20` on the payment screen,
       * which now opens on the next instalment due. The owner's rule is that the field opens
       * on what the quotation promised, and a quotation that promised nothing cannot satisfy
       * it, so the promise has to exist here first.
       *
       * ⚠️ A second block rather than one shared with the fx branch above, because the two
       * orders differ: for a foreign destination the deposit belongs directly under
       * `quotation.fx.payable` (the baht figure it is a part of) and *above* the rate line,
       * while a domestic order has neither of those and the deposit simply follows the total.
       * Rendering one block after the rate would have moved the foreign layout to say
       * payable → rate → deposit, which puts a figure below the footnote explaining a
       * different figure.
       *
       * `quotation.fx.deposit` keeps its key name though it is no longer only about fx — the
       * label itself ("ชำระมัดจำก่อน") was never about the currency, and renaming a key across
       * eight catalogues to change nothing a customer sees is churn.
       */}
      {quotation.fxRate !== null || depositRow === null ? null : (
        <div className="mt-4 ml-auto max-w-[320px] border-t border-line pt-2">{depositRow}</div>
      )}

      {/*
       * ─────────────────────────────────────────────────────────────────────────
       * ⭐ THE WAY OUT OF THIS PAGE — task: payment entry points.
       * ─────────────────────────────────────────────────────────────────────────
       *
       * `PaymentIsland` has been finished since task 10 and **nothing linked to it**: a
       * customer read `ยอดที่ต้องชำระ ฿14,400.00` two lines above this and had no way to act
       * on it. This is the way to act on it.
       *
       * ── ⚠️ Outside the fx block, and that is not a formatting choice ─────────
       *
       * The baht rows above live under `quotation.fxRate === null ? null : …` — they exist
       * only for a *foreign* destination, where the price is quoted in SGD and settled in
       * baht. A Thai order has no fx rate, renders none of that, and needs to pay just the
       * same. Nested one level up this button would have been invisible to every domestic
       * customer, which is most of them. It sits after the whole totals stack instead, so it
       * follows `quotation.total` for a domestic order and `quotation.fx.payable` for a
       * foreign one — under the last figure either way, which is the reasoning the fx block's
       * own comment sets out: both amounts belong on the page, and the action belongs under
       * the amounts rather than in a header away from them.
       *
       * ── ⚠️ THE LABEL CARRIES NO NUMBER, ON PURPOSE ──────────────────────────
       *
       * This page can see two figures and the payment screen asks for a third.
       * `quotation.fx.payable` is the pinned grand total and `quotation.fx.deposit` the
       * scheduled deposit, both frozen at submit; `PaymentIsland` opens on
       * `outstandingThbMinor` — `grand_total − order_settled_thb_minor()`, folded live — and
       * prefills its amount field with it. On a fresh order that equals the grand total and
       * not the deposit; on an order whose deposit has been paid it equals neither. A button
       * promising "ชำระมัดจำ ฿4,320.00" would therefore land on a form reading ฿14,400.00,
       * and one promising the total would be wrong the day after the first transfer. So it
       * promises the *screen* and the screen states the figure, which is the only one of the
       * three that is authoritative at the moment the customer reads it.
       *
       * ── `print:hidden`, like the print button ────────────────────────────────
       *
       * A saved PDF is the contract. A button in it is a dead rectangle.
       *
       * ── ⚠️ Where the order id does and does not go ──────────────────────────
       *
       * Into an `href` built in the browser, and nowhere else. This markup exists only after
       * `fetchQuotation` resolves, and the first render — the only one Next prerenders into
       * the eight static shells — is always `reading`, so no id is ever in the built HTML, a
       * cache key or a build log. The destination sets `robots: {index: false}` and declares
       * no hreflang alternates, so there is no crawlable or localised copy of this URL to
       * leak into either. `ButtonLink` is a plain `<a>` rather than `next/link` — see its own
       * note — which also means no prefetch carries the id into the network log of a page the
       * customer has not chosen to open yet.
       */}
      {payOrderId === null ? null : (
        <div className="mt-4 ml-auto max-w-[320px] print:hidden">
          <ButtonLink
            variant="primary"
            className="w-full"
            href={`${localeHref(locale, '/payment')}?order=${payOrderId}`}
          >
            {t('payment.action')}
          </ButtonLink>
        </div>
      )}

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
