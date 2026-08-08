'use client';

import type { ReactElement } from 'react';

import { localeHref } from '../../lib/routing';
import { useLocale } from '../../state/localeContext';
import { AccountGate } from './AccountGate';
import { MyQuotations } from './MyQuotations';

/**
 * The account page: sign in here, and see what has been asked for.
 *
 * ⚠️ This is a thin arrangement of two components that already existed, and that is the point
 * of the change rather than a shortcoming of it. `AccountGate` and `MyQuotations` were built
 * inside the cart, where a customer who had already submitted could not reach them — the cart
 * is emptied on success, so the only door was behind a page that had nothing on it.
 */
export function AccountScreen(): ReactElement {
  const { t, locale } = useLocale();

  return (
    <AccountGate>
      {(session) => (
        <section className="border border-line bg-panel p-4">
          <h1 className="text-title text-chalk">{t('account.myQuotations')}</h1>
          <div className="mt-4">
            <MyQuotations session={session} />
          </div>
          <a
            className="mt-6 inline-block border border-line px-4 py-2 text-small text-chalk"
            href={localeHref(locale, '/products')}
          >
            {t('nav.products')}
          </a>
        </section>
      )}
    </AccountGate>
  );
}
