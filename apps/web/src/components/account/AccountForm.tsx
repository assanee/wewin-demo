'use client';

import { useCallback, useState, type ReactElement } from 'react';

import { register, signIn, type AuthProblem } from '../../lib/auth/account';
import { useSession } from '../../state/SessionProvider';
import { useLocale } from '../../state/localeContext';
import type { PlainKey } from '../../i18n/keys';

/**
 * Register or sign in — the two forms, which are nearly the same form.
 *
 * ⚠️ Its own component because it is now needed in **two** places: in front of the cart's
 * submit button, and on `/account`, which is where a customer goes to see what they sent
 * without having to open a cart they may have emptied. A footer note in this codebase already
 * records the lesson — *"a screen reachable only by typing a URL is a screen nobody uses"* —
 * and the same is true of a sign-in reachable only through a cart.
 *
 * The session goes to `SessionProvider` rather than to the caller, so a header link and a cart
 * gate both learn about it without either asking the API a second time.
 */

const PROBLEM_KEYS: Readonly<Record<Exclude<AuthProblem, 'refused'>, PlainKey>> = {
  'name-or-number-missing': 'account.problem.badPhone',
  'bad-phone': 'account.problem.badPhone',
  'password-too-short': 'account.problem.passwordTooShort',
  unreachable: 'account.problem.unreachable',
  unconfigured: 'account.problem.unconfigured',
};

export function AccountForm(): ReactElement {
  const { t } = useLocale();
  const { adopt } = useSession();

  const [mode, setMode] = useState<'register' | 'sign-in'>('register');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
       * anything this component could invent, and is already in the reader's language because
       * the API renders through the same catalogue the pages do.
       */
      setProblem(
        result.problem === 'refused'
          ? (result.detail ?? t('account.problem.unreachable'))
          : t(PROBLEM_KEYS[result.problem]),
      );
      return;
    }

    adopt(result.session);
    setPassword('');
  }, [adopt, mode, password, t, username]);

  const registering = mode === 'register';

  return (
    <div className="flex flex-col gap-3">
      {problem === null ? null : (
        <p className="border border-line bg-panel-2 p-3 text-small text-danger">{problem}</p>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-caption text-chalk-2">
          {t(registering ? 'account.phone' : 'account.username')}
        </span>
        {/*
          ⚠️ `type="text"` on sign-in and no `pattern` on either. `password.contract.ts` refuses
          `z.string().email()` on this field because a shape rule answers a question the sign-in
          path must stay silent about — and the dashboard's login field taught the same lesson
          when `type="email"` made a browser refuse numbers the API accepted.
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
  );
}
