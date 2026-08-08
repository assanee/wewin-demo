'use client';

import type { ReactElement } from 'react';

import { localeHref } from '../../lib/routing';
import { useLocale } from '../../state/localeContext';
import { AccountGate } from './AccountGate';
import { ChangePassword } from './ChangePassword';
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

          <Section title={t('account.myQuotations')}>
            <MyQuotations session={session} />
          </Section>

          <Section title={t('account.password.section')}>
            <ChangePassword session={session} />
          </Section>

          {/*
            The next section goes here — a shipping address — as a `<Section>` and a component,
            with nothing above it to rename. That is what the page being named after the
            *account* rather than after one of its parts buys.
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

/**
 * One section, so the next one is a component and a title rather than a copied `<section>`.
 *
 * ⚠️ A heading level, too: `h1` is the page and every section is an `h2`. Getting that wrong is
 * invisible on screen and turns a screen reader's outline into a flat list.
 */
function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactElement;
}): ReactElement {
  return (
    <section className="border border-line bg-panel p-4">
      <h2 className="text-lead text-chalk">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}
