'use client';

import type { ReactElement } from 'react';

import { localeHref } from '../../lib/routing';
import { useLocale } from '../../state/localeContext';

/**
 * What a customer sees the moment a quotation exists.
 *
 * ⚠️ Its own component because it is rendered from **two** places, and the reason is a bug
 * that clearing the cart introduced: `QuoteScreen` returns the empty-cart invitation as soon
 * as `lines` is empty, so emptying it on success would have taken this screen away in the same
 * commit — the customer told their quotation number and then shown "start shopping", with the
 * number gone.
 */
export function SubmittedNotice({
  orderId,
  orderNo,
}: {
  readonly orderId: string;
  readonly orderNo: string | null;
}): ReactElement {
  const { t, locale } = useLocale();

  return (
    <div className="border border-line bg-panel p-4">
      <p className="text-lead text-chalk">
        {t('submit.done')} {orderNo ?? ''}
      </p>
      <p className="mt-2 text-small text-chalk-2">{t('quotation.pinnedNotice')}</p>
      {/*
        ⚠️ `?order=` — the owned path. The token in the email is for every *other* device;
        this browser is signed in and owns the order.
      */}
      <a
        className="mt-4 inline-block border border-line px-4 py-2 text-small text-chalk"
        href={`${localeHref(locale, '/orders')}?order=${orderId}`}
      >
        {t('submit.viewQuotation')}
      </a>
    </div>
  );
}
