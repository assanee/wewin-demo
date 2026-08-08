'use client';

import { useCallback, useState, type ReactElement } from 'react';

import { changePassword, type ChangeProblem, type Session } from '../../lib/auth/account';
import { useLocale } from '../../state/localeContext';
import type { PlainKey } from '../../i18n/keys';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ CHANGE, NOT RESET.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A **reset** proves control of a mailbox and works for somebody locked out. It is email-only
 * by design — `phone-authority.test.ts` pins that, because a reset requestable by *number*
 * would hand the account to whoever holds an unverified claim on it.
 *
 * ⚠️ Every account registered through this storefront has a telephone number and **no
 * address**, so a reset link has nowhere to go. A change needs no channel at all: the current
 * password is the proof, and that works for everyone.
 *
 * ⚠️ The gap that remains is worth naming rather than papering over: a customer who *forgets*
 * their password still has no self-service way back. Closing it needs an SMS budget or a member
 * of staff able to vouch — the same fork `user_phones` records for verification, unresolved.
 *
 * ── The confirmation field exists here and not in the API ────────────────────
 *
 * `changePasswordSchema` takes `currentPassword` and `newPassword`. Typing the new one twice
 * is a client concern — the server has nothing to compare and no way to tell a typo from an
 * intention — and it belongs on the one screen where a typo locks somebody out of their own
 * account with no way to discover what they actually typed.
 */

const PROBLEM_KEYS: Readonly<Record<Exclude<ChangeProblem, 'refused'>, PlainKey>> = {
  'current-missing': 'account.password.problem.currentMissing',
  'too-short': 'account.password.problem.tooShort',
  'same-as-current': 'account.password.problem.sameAsCurrent',
  unreachable: 'account.problem.unreachable',
  unconfigured: 'account.problem.unconfigured',
};

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'done'; readonly otherSessionsEnded: number };

export function ChangePassword({ session }: { readonly session: Session }): ReactElement {
  const { t } = useLocale();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');

  const submit = useCallback(async () => {
    if (next !== confirm) {
      setPhase({ kind: 'failed', message: t('account.password.problem.mismatch') });
      return;
    }

    setPhase({ kind: 'saving' });

    const result = await changePassword({
      accessToken: session.accessToken,
      currentPassword: current,
      newPassword: next,
    });

    if (!result.ok) {
      /*
       * The API's own sentence when it sent one — "รหัสผ่านปัจจุบันไม่ถูกต้อง" is the message
       * that matters most here and it is already in the reader's language, because the API
       * renders through the same catalogue the pages do.
       */
      setPhase({
        kind: 'failed',
        message:
          result.problem === 'refused'
            ? (result.detail ?? t('account.problem.unreachable'))
            : t(PROBLEM_KEYS[result.problem]),
      });
      return;
    }

    /* ⚠️ Cleared on success. Three passwords left in a form is three passwords in a screenshot. */
    setCurrent('');
    setNext('');
    setConfirm('');
    setPhase({ kind: 'done', otherSessionsEnded: result.otherSessionsEnded });
  }, [confirm, current, next, session.accessToken, t]);

  const busy = phase.kind === 'saving';

  return (
    <div className="flex flex-col gap-3">
      {phase.kind === 'failed' ? (
        <p className="border border-line bg-panel-2 p-3 text-small text-danger">{phase.message}</p>
      ) : null}

      {phase.kind === 'done' ? (
        /*
         * ⭐ Says whether other devices were signed out, rather than only "saved".
         *
         * That is the *effect* of changing a password and the reason somebody does it after a
         * shared tablet or a lost phone. Being told "0 others" is equally useful: it means
         * nothing else was signed in, which is what they wanted to know.
         */
        <p className="border border-line bg-panel-2 p-3 text-small text-chalk">
          {phase.otherSessionsEnded > 0 ? t('account.password.doneOthers') : t('account.password.done')}
        </p>
      ) : null}

      <Field label={t('account.password.current')}>
        <input
          className="w-full border border-line bg-panel-2 px-3 py-2 text-body text-chalk"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          disabled={busy}
        />
      </Field>

      <Field label={t('account.password.new')}>
        <input
          className="w-full border border-line bg-panel-2 px-3 py-2 text-body text-chalk"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          disabled={busy}
        />
      </Field>

      <Field label={t('account.password.confirm')}>
        <input
          className="w-full border border-line bg-panel-2 px-3 py-2 text-body text-chalk"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          disabled={busy}
        />
      </Field>

      {/* Said before the button, not after: it is a consequence, not a receipt. */}
      <p className="text-caption text-chalk-3">{t('account.password.note')}</p>

      <button
        type="button"
        className="w-fit border border-line px-4 py-2 text-small text-chalk disabled:opacity-60"
        onClick={() => {
          void submit();
        }}
        disabled={busy || current === '' || next === ''}
      >
        {busy ? t('account.password.saving') : t('account.password.action')}
      </button>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactElement;
}): ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-caption text-chalk-2">{label}</span>
      {children}
    </label>
  );
}
