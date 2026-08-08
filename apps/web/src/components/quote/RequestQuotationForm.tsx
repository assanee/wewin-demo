'use client';

import { useCallback, useState, type ReactElement } from 'react';

import type { QuoteLine } from '@wewin/core';

import {
  contactToWire,
  fetchCatalogRefs,
  linesToSubmit,
  submitQuote,
  type ContactProblem,
} from '../../lib/quote/submit';
import type { Session } from '../../lib/auth/account';
import { useLocale } from '../../state/localeContext';
import { SubmittedNotice } from './SubmittedNotice';
import type { PlainKey } from '../../i18n/keys';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE BUTTON THAT WAS "COMING IN THE NEXT VERSION".
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The cart said `configure.futureQuote` — "ขั้นตอนขอใบเสนอราคาจะเพิ่มในเวอร์ชันถัดไป" — and it
 * was telling the truth: a customer could price a window, fill a cart, and then had to
 * telephone. Everything downstream existed. This was the missing first step.
 *
 * ── ⚠️ Two calls, and the catalogue in between ───────────────────────────────
 *
 * The cart is `localStorage` and the catalogue is compiled into the bundle, so a line knows
 * its `productId` and nothing about `productVersionId` or `documentHash`. Those come from the
 * live catalogue, at the moment of submitting, and are paired with the cart by
 * `linesToSubmit` — which **refuses** rather than substituting, for the reason its own tests
 * give: a substituted version quotes somebody for a window they did not configure.
 *
 * ── What happens after ──────────────────────────────────────────────────────
 *
 * The order is submitted, the API pins the document, and the outbox emails the quotation link
 * — the one built two phases ago. This screen then offers the same link directly, because a
 * customer who has just pressed a button should not have to go and look in their inbox, and a
 * customer who gave only a telephone number will not find one there at all.
 */

/**
 * ⚠️ `PlainKey` and not `UiKey`.
 *
 * `t` has two overloads — a key that carries values may not be called without them — and only
 * the parameterless half is callable from a variable. Typing this as `UiKey` compiles the map
 * and fails at the call site, which is the type system pointing at exactly the mistake it
 * exists to prevent: a sentence rendered with `undefined` inside it.
 */
const PROBLEM_KEYS: Readonly<Record<ContactProblem, PlainKey>> = {
  'name-missing': 'submit.problem.nameMissing',
  'no-channel': 'submit.problem.noChannel',
  'bad-phone': 'submit.problem.badPhone',
  'bad-email': 'submit.problem.badEmail',
};

type Phase =
  | { readonly kind: 'form' }
  | { readonly kind: 'sending' }
  /** The API's own sentence when it has one — already in the reader's language. */
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'done'; readonly orderId: string; readonly orderNo: string | null };

export function RequestQuotationForm({
  lines,
  session,
  onSubmitted,
}: {
  readonly lines: readonly QuoteLine[];
  /** Handed down by `AccountGate` rather than fetched — see its note on double rotation. */
  readonly session: Session;
  /**
   * Called once a quotation exists — the list on the same page catches up, and the cart is
   * emptied, because it has become an order.
   */
  readonly onSubmitted?: ((order: { orderId: string; orderNo: string | null }) => void) | undefined;
}): ReactElement {
  const { t, locale } = useLocale();
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');

  const send = useCallback(async () => {
    const contact = contactToWire({ name, email, phone }, locale);
    if (!contact.ok) {
      setPhase({ kind: 'failed', message: t(PROBLEM_KEYS[contact.problem]) });
      return;
    }

    setPhase({ kind: 'sending' });

    /*
     * ⚠️ Asked now, not at page load. This is "what may be ordered *right now*", and a
     * catalogue fetched when the tab opened is a catalogue that may have changed by the time
     * somebody finishes typing their name.
     */
    const refs = await fetchCatalogRefs();
    if (refs === null) {
      setPhase({ kind: 'failed', message: t('submit.problem.unreachable') });
      return;
    }

    const prepared = linesToSubmit(lines, refs);
    if (!prepared.ok) {
      setPhase({ kind: 'failed', message: t('submit.problem.unavailable') });
      return;
    }

    const result = await submitQuote({
      lines: prepared.lines,
      contact: contact.contact,
      accessToken: session.accessToken,
    });
    if (!result.ok) {
      /*
       * The API's sentence when it sent one. It is rendered through the same message catalogue
       * the pages use, so it is already in this reader's language and is more specific than
       * anything this component could invent — "a line is priced against a document that has
       * changed" beats "something went wrong".
       */
      setPhase({
        kind: 'failed',
        message:
          result.detail ??
          t(result.reason === 'unconfigured' ? 'submit.problem.unconfigured' : 'submit.problem.unreachable'),
      });
      return;
    }

    /*
     * ⚠️ `done` before `onSubmitted`, and the order matters.
     *
     * `onSubmitted` empties the cart, and this component takes `lines` as a prop — so the
     * render that follows has none. Setting `done` first means the success screen is what is
     * showing when that happens, rather than the form briefly re-rendering against an empty
     * cart with its button disabled.
     */
    setPhase({ kind: 'done', orderId: result.orderId, orderNo: result.orderNo });
    onSubmitted?.({ orderId: result.orderId, orderNo: result.orderNo });
  }, [email, lines, locale, name, onSubmitted, phone, session.accessToken, t]);

  if (phase.kind === 'done') {
    return <SubmittedNotice orderId={phase.orderId} orderNo={phase.orderNo} />;
  }

  const busy = phase.kind === 'sending';

  return (
    <div className="border border-line bg-panel p-4">
      <h2 className="text-lead text-chalk">{t('submit.heading')}</h2>
      <p className="mt-1 text-small text-chalk-2">{t('submit.intro')}</p>

      {phase.kind === 'failed' ? (
        <p className="mt-3 border border-line bg-panel-2 p-3 text-small text-danger">{phase.message}</p>
      ) : null}

      <div className="mt-4 flex flex-col gap-3">
        <Field label={t('submit.name')}>
          <input
            className="w-full border border-line bg-panel-2 px-3 py-2 text-body text-chalk"
            value={name}
            placeholder={t('submit.namePlaceholder')}
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
            autoComplete="name"
          />
        </Field>

        <Field label={t('submit.phone')}>
          {/*
            ⚠️ `tel`, and no `pattern`. `@wewin/core/phone` decides what a number is — one
            implementation, shared with the API's identity table — and a regex here would be a
            second opinion that refuses numbers the server accepts.
          */}
          <input
            className="w-full border border-line bg-panel-2 px-3 py-2 text-body text-chalk"
            type="tel"
            inputMode="tel"
            value={phone}
            placeholder="081-234-5678"
            onChange={(event) => setPhone(event.target.value)}
            disabled={busy}
            autoComplete="tel"
          />
        </Field>

        <Field label={t('submit.email')}>
          <input
            className="w-full border border-line bg-panel-2 px-3 py-2 text-body text-chalk"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={busy}
            autoComplete="email"
          />
        </Field>

        <p className="text-caption text-chalk-3">{t('submit.channelHint')}</p>

        <button
          type="button"
          className="border border-lime bg-lime px-4 py-2 text-body text-ink disabled:opacity-60"
          onClick={() => {
            void send();
          }}
          disabled={busy || lines.length === 0}
        >
          {busy ? t('submit.sending') : t('submit.action')}
        </button>
      </div>
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
