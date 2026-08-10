'use client';

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import type { QuoteLine } from '@wewin/core';

import {
  contactToWire,
  fetchCatalogRefs,
  linesToSubmit,
  submitQuote,
  type ContactProblem,
} from '../../lib/quote/submit';
import { fetchContactPrefill, fieldsToApply } from '../../lib/quote/prefillContact';
import { fetchDestinations, isKnownDestination, THAILAND_ONLY, type Destination } from '../../lib/quote/destinations';
import type { Session } from '../../lib/auth/account';
import { useLocale } from '../../state/localeContext';
import { DestinationSelect } from './DestinationSelect';
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
 *
 * ── ⚠️ The fields pre-fill themselves, quietly ──────────────────────────
 *
 * A returning customer has already told this company their name, number, address and
 * destination — on a prior order, or at worst at registration. `../../lib/quote/prefillContact`
 * goes and asks, over the network, after the form is already on screen and usable. Because that
 * answer can arrive after somebody has started typing (or picking), `touchedRef` below remembers
 * which fields a finger has already reached — see `fieldsToApply` for the rule that keeps a slow
 * network response from overwriting a fast typist.
 *
 * ── ⚠️ The destination is its own picker, and its own network call ───────────
 *
 * `DestinationSelect` is a plain, prop-driven `<select>` — the fetch that populates it
 * (`../../lib/quote/destinations`) lives here, beside the fetch for the pre-fill, and is asked
 * for independently: a customer must be able to open the picker before this form has ever heard
 * back from `GET /orders`, and a slow or unreachable pre-fill must not hold the picker's
 * options hostage. On failure it degrades to Thailand alone, same as the picker's own default,
 * so this form is exactly as submittable as it was before either fetch ran. `isKnownDestination`
 * is a last check before submit: a value this app did not itself select — most likely a
 * destination pre-filled from a prior order that has since been withdrawn — is refused here
 * rather than reaching the API, where Task 9 found the refusal otherwise lands far from the
 * mistake.
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
  /* `TH` — `DestinationSelect`'s own default, and `ContactPrefill`'s "nothing to offer" value. */
  const [destinationCountry, setDestinationCountry] = useState('TH');
  /* `THAILAND_ONLY` until the real list arrives, and again forever if that fetch fails. */
  const [destinationOptions, setDestinationOptions] = useState<readonly Destination[]>(THAILAND_ONLY);

  /*
   * ⚠️ A ref, not state. Nothing here needs to trigger a render — it only needs to be
   * *current* the moment the pre-fill's network round trip finishes, which a `useState`
   * closure captured at mount would not be: this object is mutated in place by each field's
   * `onChange`, so the effect below always reads what actually happened, not what was true
   * when it started listening.
   */
  const touchedRef = useRef({ name: false, phone: false, email: false, destinationCountry: false });

  /*
   * ⭐ Pre-filled once, from whichever the customer told us most recently — see the module
   * note on `prefillContact` for the two sources and the precedence between them.
   *
   * ⚠️ Never surfaces a failure. `fetchContactPrefill` resolves to `null` for every problem
   * it can have — no API configured, unreachable, a customer with nothing on file — and a
   * `null` here does exactly nothing: the form stays exactly as usable as it was before this
   * effect ever ran.
   */
  useEffect(() => {
    let cancelled = false;

    void fetchContactPrefill(session.accessToken).then((prefill) => {
      if (cancelled || prefill === null) return;

      const toApply = fieldsToApply(touchedRef.current, prefill);
      if (toApply.name !== undefined) setName(toApply.name);
      if (toApply.phone !== undefined) setPhone(toApply.phone);
      if (toApply.email !== undefined) setEmail(toApply.email);
      if (toApply.destinationCountry !== undefined) setDestinationCountry(toApply.destinationCountry);
    });

    return () => {
      cancelled = true;
    };
  }, [session.accessToken]);

  /*
   * ⭐ The options `DestinationSelect` renders — asked for once, independently of the pre-fill
   * above. `fetchDestinations` never rejects and never resolves to an empty list: a failed read
   * degrades to Thailand alone, which is also this state's own initial value, so a slow or
   * broken settings endpoint costs this form nothing — it stays exactly as submittable as it
   * was before this effect ran.
   */
  useEffect(() => {
    let cancelled = false;

    void fetchDestinations().then((options) => {
      if (!cancelled) setDestinationOptions(options);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const send = useCallback(async () => {
    /*
     * ⭐ The unknown-code guard (Task 9's finding). `POST /orders` accepts any `/^[A-Z]{2}$/`
     * code without checking it against `tax_countries` and the refusal, if one comes, lands at
     * the API — far from the mistake. This is the storefront-side check against the list this
     * customer was actually shown just now: it catches a destination pre-filled from a prior
     * order that has since been withdrawn, before a network round trip is spent on it.
     */
    if (!isKnownDestination(destinationCountry, destinationOptions)) {
      setPhase({ kind: 'failed', message: t('submit.problem.badDestination') });
      return;
    }

    const contact = contactToWire({ name, email, phone, destinationCountry }, locale);
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
  }, [
    destinationCountry,
    destinationOptions,
    email,
    lines,
    locale,
    name,
    onSubmitted,
    phone,
    session.accessToken,
    t,
  ]);

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
            onChange={(event) => {
              touchedRef.current.name = true;
              setName(event.target.value);
            }}
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
            onChange={(event) => {
              touchedRef.current.phone = true;
              setPhone(event.target.value);
            }}
            disabled={busy}
            autoComplete="tel"
          />
        </Field>

        <Field label={t('submit.email')}>
          <input
            className="w-full border border-line bg-panel-2 px-3 py-2 text-body text-chalk"
            type="email"
            value={email}
            onChange={(event) => {
              touchedRef.current.email = true;
              setEmail(event.target.value);
            }}
            disabled={busy}
            autoComplete="email"
          />
        </Field>

        <p className="text-caption text-chalk-3">{t('submit.channelHint')}</p>

        <DestinationSelect
          options={destinationOptions}
          value={destinationCountry}
          onChange={(code) => {
            touchedRef.current.destinationCountry = true;
            setDestinationCountry(code);
          }}
          label={t('submit.destination')}
          disabled={busy}
        />

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
