'use client';

import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react';

import { currentSession, register, signIn, signOut, type AuthProblem, type Session } from '../../lib/auth/account';
import { useLocale } from '../../state/localeContext';
import type { PlainKey } from '../../i18n/keys';

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
 * ── The first render is always `checking` ────────────────────────────────────
 *
 * The refresh cookie is `__Host-` prefixed and belongs to the API's origin, so this bundle
 * cannot read it — "am I signed in?" has to be asked over the network. Rendering "sign in"
 * first and correcting a moment later would flash the form at somebody who is already signed
 * in, and worse, would be a hydration mismatch on a prerendered page: the server and the first
 * client render must agree, and neither of them knows.
 */

const PROBLEM_KEYS: Readonly<Record<Exclude<AuthProblem, 'refused'>, PlainKey>> = {
  'name-or-number-missing': 'account.problem.badPhone',
  'bad-phone': 'account.problem.badPhone',
  'password-too-short': 'account.problem.passwordTooShort',
  unreachable: 'account.problem.unreachable',
  unconfigured: 'account.problem.unconfigured',
};

type Phase =
  | { readonly kind: 'checking' }
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'signed-in'; readonly session: Session };

/**
 * Renders `children` only for a caller with a session, and the forms otherwise.
 *
 * ⚠️ The session is handed to `children` rather than fetched again by them. Two components
 * each spending the refresh cookie would rotate it twice for one page, and the second
 * rotation invalidates the first — an intermittent sign-out that reproduces only when both
 * happen to land in the same second.
 */
export function AccountGate({
  children,
}: {
  readonly children: (session: Session) => ReactNode;
}): ReactElement {
  const { t } = useLocale();
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [mode, setMode] = useState<'register' | 'sign-in'>('register');

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void currentSession().then((session) => {
      if (cancelled) return;
      setPhase(session === null ? { kind: 'anonymous' } : { kind: 'signed-in', session });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const submit = useCallback(async () => {
    setBusy(true);
    setProblem(null);

    const result =
      mode === 'register'
        ? await register({ phone: username, password })
        : await signIn({ username, password });

    setBusy(false);

    if (!result.ok) {
      /*
       * The API's own sentence when it sent one — "เบอร์นี้มีบัญชีอยู่แล้ว …" is more use than
       * anything this component could invent, and it is already in the reader's language
       * because the API renders through the same catalogue the pages do.
       */
      setProblem(
        result.problem === 'refused'
          ? (result.detail ?? t('account.problem.unreachable'))
          : t(PROBLEM_KEYS[result.problem]),
      );
      return;
    }

    setPhase({ kind: 'signed-in', session: result.session });
    setPassword('');
  }, [mode, password, t, username]);

  if (phase.kind === 'checking') {
    return <p className="text-small text-chalk-2">{t('account.checking')}</p>;
  }

  if (phase.kind === 'signed-in') {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-caption text-chalk-2">{t('account.signedInAs')}</span>
          <button
            type="button"
            className="text-caption text-chalk-3 underline"
            onClick={() => {
              void signOut().then(() => {
                setPhase({ kind: 'anonymous' });
              });
            }}
          >
            {t('account.signOut')}
          </button>
        </div>
        {children(phase.session)}
      </div>
    );
  }

  const registering = mode === 'register';

  return (
    <div className="border border-line bg-panel p-4">
      <h2 className="text-lead text-chalk">{t('account.needAccount')}</h2>
      <p className="mt-1 text-small text-chalk-2">{t('account.whyAccount')}</p>

      {problem === null ? null : (
        <p className="mt-3 border border-line bg-panel-2 p-3 text-small text-danger">{problem}</p>
      )}

      <div className="mt-4 flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-caption text-chalk-2">
            {t(registering ? 'account.phone' : 'account.username')}
          </span>
          {/*
            ⚠️ `type="text"` on the sign-in form even though a number is expected, and no
            `pattern` on either. `password.contract.ts` refuses `z.string().email()` on this
            field because a shape rule answers a question the sign-in path must stay silent
            about — and the dashboard's login field learned the same lesson the hard way when
            `type="email"` made a browser refuse numbers the API accepted.
          */}
          <input
            className="w-full border border-line bg-panel-2 px-3 py-2 text-body text-chalk"
            type={registering ? 'tel' : 'text'}
            inputMode={registering ? 'tel' : 'text'}
            autoComplete="username"
            placeholder="081-234-5678"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            disabled={busy}
          />
          {registering ? null : (
            <span className="text-caption text-chalk-3">{t('account.usernameHint')}</span>
          )}
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-caption text-chalk-2">{t('account.password')}</span>
          <input
            className="w-full border border-line bg-panel-2 px-3 py-2 text-body text-chalk"
            type="password"
            autoComplete={registering ? 'new-password' : 'current-password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
          />
          {registering ? (
            <span className="text-caption text-chalk-3">{t('account.passwordHint')}</span>
          ) : null}
        </label>

        <button
          type="button"
          className="border border-lime bg-lime px-4 py-2 text-body text-ink disabled:opacity-60"
          onClick={() => {
            void submit();
          }}
          disabled={busy}
        >
          {t(registering ? 'account.register' : 'account.signIn')}
        </button>

        <button
          type="button"
          className="text-caption text-chalk-3 underline"
          onClick={() => {
            setMode(registering ? 'sign-in' : 'register');
            setProblem(null);
          }}
        >
          {t(registering ? 'account.haveAccount' : 'account.noAccount')}{' '}
          {t(registering ? 'account.signIn' : 'account.register')}
        </button>
      </div>
    </div>
  );
}
