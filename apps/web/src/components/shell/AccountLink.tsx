'use client';

import Link from 'next/link';
import { UserRound } from 'lucide-react';

import { accountHref } from '../../lib/routing';
import { useSession } from '../../state/SessionProvider';
import { useLocale } from '../../state/localeContext';

/**
 * The account entry, and the label is the whole of it.
 *
 * ⚠️ **Signed out it says "sign in"; signed in it says "my quotations".** They are the same
 * destination and two different questions. A customer who submitted from a laptop and opens
 * the site on a phone is asking the first; a customer who submitted five minutes ago is asking
 * the second — and the answer to the second used to be "look in the cart", which is empty for
 * exactly those people, because the cart is cleared on success.
 *
 * ⚠️ **Nothing renders while the session is `checking`.** The refresh cookie is `__Host-`
 * prefixed and unreadable from here, so the answer arrives over the network one commit after
 * the first render. Showing "sign in" meanwhile would flash the wrong label at somebody who is
 * signed in, and on a prerendered page a value that differs between the server render and the
 * first client render is a hydration mismatch — which React resolves quietly rather than
 * loudly, so it would not even be reported.
 */
export function AccountLink() {
  const { t, locale } = useLocale();
  const { state } = useSession();

  if (state.kind === 'checking') return null;

  const label = t(state.kind === 'signed-in' ? 'account.myQuotations' : 'account.signIn');

  return (
    <Link
      href={accountHref(locale)}
      aria-label={label}
      className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xs border border-line px-3 text-body text-chalk transition-colors duration-180 ease-out hover:border-line-2"
    >
      <UserRound size={18} aria-hidden />
      {/*
        Hidden below `md` for the reason the cart's label is: at 360px the header carries a
        wordmark, a language picker and a cart, and a fourth word pushes one of them off. The
        icon is the affordance there and the label is the clarification where there is room.

        ⚠️ **No `sr-only` twin**, though the cart beside this has one — and copying its shape
        was the mistake. The cart's hidden text says something *different* ("มี 4 รายการใน
        ตะกร้า"), which is why it earns its place; a copy of the visible label reads the same
        words twice to a screen reader and adds nothing.

        `aria-label` carries the name below `md`, where the visible span is display:none and
        therefore not announced at all.
      */}
      <span className="hidden md:inline" aria-hidden>
        {label}
      </span>
    </Link>
  );
}
