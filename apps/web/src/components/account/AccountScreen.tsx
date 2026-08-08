'use client';

import type { ReactElement } from 'react';

import { localeHref } from '../../lib/routing';
import { useLocale } from '../../state/localeContext';
import { AccountGate } from './AccountGate';
import { MyQuotations } from './MyQuotations';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The account page: sign in here, and see what has been asked for.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ **"บัญชีของฉัน" and not "ใบเสนอราคาของฉัน"**, and the difference is about what comes
 * next rather than about wording. A shipping address and a change of password belong on this
 * page, and a menu named after one of its sections has to be renamed the day a second arrives
 * — by which time customers have learned the old name and links to it exist.
 *
 * So the page is the account and the quotations are a **section** of it. Adding the next one
 * is a heading and a component, with nothing above it to reconsider. `apps/dashboard` already
 * calls its equivalent "บัญชีของฉัน", so the two products agree.
 */
export function AccountScreen(): ReactElement {
  const { t, locale } = useLocale();

  return (
    <AccountGate>
      {(session) => (
        <div className="flex flex-col gap-4">
          <h1 className="text-title text-chalk">{t('account.title')}</h1>

          <section className="border border-line bg-panel p-4">
            <h2 className="text-lead text-chalk">{t('account.myQuotations')}</h2>
            <div className="mt-3">
              <MyQuotations session={session} />
            </div>
          </section>

          {/*
            The next sections go here — a shipping address, a change of password — each one a
            heading and a component, with nothing above them to rename.
          */}

          <a
            className="w-fit border border-line px-4 py-2 text-small text-chalk"
            href={localeHref(locale, '/products')}
          >
            {t('nav.products')}
          </a>
        </div>
      )}
    </AccountGate>
  );
}
