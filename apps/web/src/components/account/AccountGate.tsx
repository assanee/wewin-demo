'use client';

import type { ReactElement, ReactNode } from 'react';

import type { Session } from '../../lib/auth/account';
import { useSession } from '../../state/SessionProvider';
import { useLocale } from '../../state/localeContext';
import { AccountForm } from './AccountForm';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ AN ACCOUNT BEFORE A QUOTATION.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ A reversal of a decision this codebase argues for repeatedly. Plan 6 and 10.2 call the
 * anonymous visitor the main funnel, and the storefront's pitch is pricing a window without
 * signing in.
 *
 * What changed is the question *whose order is this?*. A guest order belongs to a **cookie**:
 * clear it, change device, or open the emailed link on a phone, and the customer has no way
 * back to their own quotation. An account answers that durably.
 *
 * **Pricing and filling a cart stay anonymous.** This gate stands in front of one button.
 *
 * ── ⚠️ It no longer asks the API whether there is a session ──────────────────
 *
 * It used to, and that was safe only while the cart was the only place asking. `POST
 * /auth/refresh` **rotates** the cookie, so a header link that also asked would produce two
 * rotations in the same second and the second would invalidate the first — a sign-out that
 * reproduces only under a race. The question is `SessionProvider`'s now, asked once above
 * every route.
 */
export function AccountGate({
  children,
}: {
  readonly children: (session: Session) => ReactNode;
}): ReactElement {
  const { t } = useLocale();
  const { state, signOut } = useSession();

  if (state.kind === 'checking') {
    return <p className="text-small text-chalk-2">{t('account.checking')}</p>;
  }

  if (state.kind === 'signed-in') {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-caption text-chalk-2">{t('account.signedInAs')}</span>
          <button type="button" className="text-caption text-chalk-3 underline" onClick={signOut}>
            {t('account.signOut')}
          </button>
        </div>
        {children(state.session)}
      </div>
    );
  }

  return (
    <div className="border border-line bg-panel p-4">
      <h2 className="text-lead text-chalk">{t('account.needAccount')}</h2>
      <p className="mt-1 mb-4 text-small text-chalk-2">{t('account.whyAccount')}</p>
      <AccountForm />
    </div>
  );
}
