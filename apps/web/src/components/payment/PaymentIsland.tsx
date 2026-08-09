'use client';

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import { readSatang, satangField } from '@wewin/core/money';

import type { Session } from '../../lib/auth/account';
import {
  createSlip,
  describeUploadProblem,
  fetchPaymentInstructions,
  fetchSlips,
  MAX_SLIP_BYTES,
  toInstant,
  uploadSlipImage,
  type PaymentInstructions,
  type PaymentProblem,
  type PaymentSlip,
} from '../../lib/payment/api';
import { useLocale } from '../../state/localeContext';
import type { Translate } from '../../i18n/translate';
import { AccountForm } from '../account/AccountForm';
import { AccountGate } from '../account/AccountGate';
import { AccountPicker } from './AccountPicker';
import { SlipForm, type Phase } from './SlipForm';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE SCREEN THIS PLAN EXISTS FOR — a customer can now pay.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The slip API has been complete and tested since task 10; nothing in `apps/web` called it,
 * so every order sat in `awaiting_payment` with no way forward. This island is the way
 * forward: pick an account, attach a slip, and see what has already been sent.
 *
 * ── The order id lives in the query string, never in the path ───────────────────
 *
 * The same choice `lib/quotation/api.ts`'s `?order=` half makes, for the same reason a token
 * link makes it for the other half: read in the browser rather than through `params` or
 * `searchParams`, so the route stays the eight static shells `generateStaticParams` builds
 * and no customer's order id ever sits in a server render, a cache key or a build log.
 *
 * ── Why a session is required here and was not, until now ───────────────────────
 *
 * Plan 6 calls the anonymous visitor the main funnel and pricing stays anonymous end to end
 * — but a slip has to land on a *specific* order, re-openable after the tab that submitted it
 * is long closed, and a guest cookie answers "which order" only for as long as the cookie
 * survives. `AccountGate` is the same gate the cart's submit button already stands behind.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function orderIdFromSearch(search: string): string | null {
  const id = new URLSearchParams(search).get('order') ?? '';
  return UUID.test(id) ? id : null;
}

/** `datetime-local`'s own format, in the visitor's local time, to the minute. */
function defaultLocalDateTime(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** `'refused'` renders the API's own sentence; every other problem gets a fixed one. */
function problemMessage(
  result: { readonly problem: PaymentProblem; readonly detail?: string | undefined },
  t: Translate,
): string {
  if (result.problem === 'refused') return result.detail ?? t('payment.problem.unreachable');
  if (result.problem === 'unauthorized') return t('payment.problem.signInAgain');
  return t('payment.problem.unreachable');
}

export function PaymentIsland(): ReactElement {
  const { t } = useLocale();
  /* `undefined` until the one effect below has read the URL — see `QuotationIsland`'s own
   * note on why this is not `useSearchParams`: it would make the route dynamic. */
  const [orderId, setOrderId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    setOrderId(orderIdFromSearch(window.location.search));
  }, []);

  if (orderId === undefined) {
    return <p className="text-body text-chalk-2">{t('payment.loading')}</p>;
  }

  if (orderId === null) {
    return (
      <div className="border border-line bg-panel p-4">
        <h1 className="text-title text-chalk">{t('notFound.title')}</h1>
        <p className="mt-1 text-small text-chalk-2">{t('notFound.body')}</p>
      </div>
    );
  }

  /*
   * ⚠️ `AccountGate`'s signed-out branch opens at `<h2>`. This page's own `<h1>` lives only
   * inside `PaymentForOrder` — the signed-in branch — exactly as `AccountScreen.tsx:32` puts
   * its `<h1>` inside `children(session)` and not beside `<AccountGate>`. The consequence is
   * the same one that page accepts: a visitor who is not signed in sees no `<h1>` at all,
   * only the gate's `<h2>`. That is the existing pattern, not a new gap.
   */
  return <AccountGate>{(session) => <PaymentForOrder orderId={orderId} session={session} />}</AccountGate>;
}

type InstructionsPhase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ready'; readonly instructions: PaymentInstructions };

function PaymentForOrder({
  orderId,
  session,
}: {
  readonly orderId: string;
  readonly session: Session;
}): ReactElement {
  const { t } = useLocale();

  const [instructions, setInstructions] = useState<InstructionsPhase>({ kind: 'loading' });
  const [slips, setSlips] = useState<readonly PaymentSlip[]>([]);

  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [amountText, setAmountText] = useState('');
  const [transferredAtLocal, setTransferredAtLocal] = useState(defaultLocalDateTime);
  const [bankReference, setBankReference] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [imageHandle, setImageHandle] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [needsReauth, setNeedsReauth] = useState(false);

  /* First load: the instructions and the history, once each, for the token this render holds. */
  useEffect(() => {
    let cancelled = false;

    void fetchPaymentInstructions(orderId, session.accessToken).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setInstructions({ kind: 'failed', message: problemMessage(result, t) });
        return;
      }
      setInstructions({ kind: 'ready', instructions: result.data });
      setSelectedAccountId((current) => current ?? (result.data.accounts[0]?.id ?? null));
      setAmountText((current) => (current === '' ? satangField(result.data.outstandingThbMinor) : current));
    });

    void fetchSlips(orderId, session.accessToken).then((result) => {
      if (!cancelled && result.ok) setSlips(result.data);
    });

    return () => {
      cancelled = true;
    };
    // `t` is stable enough for this purpose (it changes only with the locale, and a locale
    // change re-reading the same order is harmless); the effect's own identity should track
    // the request that actually changes, which is the order and the token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, session.accessToken]);

  /*
   * ⚠️ Trap 5, closed. `session.accessToken` only ever changes when `adopt()` runs — either
   * the very first sign-in (irrelevant here, this component only exists once one already
   * happened) or a customer signing back in through the embedded form below after a 401.
   * The moment it changes while `needsReauth` is set, the token that failed is gone and the
   * one in hand is new: the banner clears and the button re-arms, with every field —
   * including a already-uploaded `imageHandle` — exactly as it was left.
   */
  const previousToken = useRef(session.accessToken);
  useEffect(() => {
    if (session.accessToken === previousToken.current) return;
    previousToken.current = session.accessToken;
    if (needsReauth) {
      setNeedsReauth(false);
      setPhase({ kind: 'idle' });
    }
  }, [session.accessToken, needsReauth]);

  const handleFileChange = useCallback((next: File | null) => {
    setFile(next);
    /*
     * ⚠️ Any new file selection invalidates a previously obtained handle — it named the
     * *old* bytes. Without this a customer who re-picks a photo after a failed create would
     * have `submit` skip re-uploading and attach the wrong image to the new attempt.
     */
    setImageHandle(null);
  }, []);

  /* Guards a near-simultaneous double click at the JS level, ahead of React's own re-render —
   * trap 4's "disable the button on first click", made to hold even against two clicks that
   * land before the first `setState` has painted. */
  const submitting = useRef(false);

  const submit = useCallback(async () => {
    if (submitting.current) return;
    submitting.current = true;

    try {
      const parsedAmount = readSatang(amountText);
      if (!parsedAmount.ok) {
        setPhase({ kind: 'failed', message: t('payment.problem.badAmount') });
        return;
      }

      if (selectedAccountId === null) {
        setPhase({ kind: 'failed', message: t('payment.problem.badAmount') });
        return;
      }

      const transferredAt = toInstant(transferredAtLocal);
      if (transferredAt === null) {
        setPhase({ kind: 'failed', message: t('payment.problem.badTime') });
        return;
      }

      let handle = imageHandle;

      if (handle === null) {
        if (file === null) {
          setPhase({ kind: 'failed', message: t('payment.problem.noImage') });
          return;
        }

        /*
         * ⚠️ Trap 1, closed here and not by the API. `readBoundedBody` on the far side
         * destroys the socket *while* rejecting an over-limit body, so a file this big would
         * surface as a thrown `fetch` — the 'unreachable' branch — telling the customer the
         * server is down about a photo that was merely too big.
         */
        if (describeUploadProblem(file.size) === 'too-big') {
          setPhase({
            kind: 'failed',
            message: t('payment.problem.imageTooBig', { limitMib: MAX_SLIP_BYTES / (1024 * 1024) }),
          });
          return;
        }

        setPhase({ kind: 'uploading' });
        const uploaded = await uploadSlipImage(orderId, file, session.accessToken);

        if (!uploaded.ok) {
          if (uploaded.problem === 'unauthorized') {
            setNeedsReauth(true);
            setPhase({ kind: 'failed', message: t('payment.problem.signInAgain') });
            return;
          }
          // ⚠️ Trap 2: this is the call `order_not_accepting_slips` and `too_many_slips` can
          // fail on, and its own sentence is what has to reach the screen — not a generic one.
          setPhase({ kind: 'failed', message: problemMessage(uploaded, t) });
          return;
        }

        handle = uploaded.data;
        setImageHandle(handle);
      }

      setPhase({ kind: 'creating' });
      const created = await createSlip(
        orderId,
        {
          imageHandle: handle,
          amountThbMinor: parsedAmount.value,
          transferredAt,
          bankReference: bankReference.trim() === '' ? undefined : bankReference.trim(),
        },
        session.accessToken,
      );

      if (!created.ok) {
        if (created.problem === 'unauthorized') {
          /*
           * ⚠️ The one create-time failure safe to retry with the *same* handle. A 401 is
           * raised by the RBAC guard before the handler runs — nothing was written — so the
           * handle is still good and is deliberately kept, not cleared.
           */
          setNeedsReauth(true);
          setPhase({ kind: 'failed', message: t('payment.problem.signInAgain') });
          return;
        }

        /*
         * ⚠️ Trap 4. Every other create failure clears the handle *and* the file: nothing
         * here re-sends this exact request, and presenting the same handle again is the one
         * action that turns one transfer into two slip rows. A further attempt must go
         * through a fresh upload, which means a fresh file.
         */
        setImageHandle(null);
        setFile(null);
        setPhase({ kind: 'failed', message: problemMessage(created, t) });
        return;
      }

      setSlips((current) => [...current, created.data]);
      setFile(null);
      setImageHandle(null);
      setBankReference('');
      setPhase({ kind: 'done' });
    } finally {
      submitting.current = false;
    }
  }, [amountText, bankReference, file, imageHandle, orderId, selectedAccountId, session.accessToken, t, transferredAtLocal]);

  if (instructions.kind === 'loading') {
    return <p className="text-body text-chalk-2">{t('payment.loading')}</p>;
  }

  if (instructions.kind === 'failed') {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-title text-chalk">{t('payment.heading')}</h1>
        <p className="border border-line bg-panel-2 p-3 text-small text-danger">{instructions.message}</p>
      </div>
    );
  }

  const data = instructions.instructions;
  const settled = data.outstandingThbMinor <= 0n;
  const parsedAmount = readSatang(amountText);
  const amountForQr = parsedAmount.ok ? parsedAmount.value : null;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-title text-chalk">{t('payment.heading')}</h1>

      <p className="text-body text-chalk">
        {t('payment.outstanding')}{' '}
        <span className="numeric text-lead text-lime">
          {t('payment.outstandingAmount', { owedMinor: data.outstandingThbMinor })}
        </span>
      </p>

      {settled ? (
        <p className="border border-line bg-panel-2 p-3 text-small text-chalk">{t('payment.settled')}</p>
      ) : (
        <>
          <AccountPicker
            accounts={data.accounts}
            selectedId={selectedAccountId}
            onSelect={setSelectedAccountId}
            amountThbMinor={amountForQr}
          />

          {needsReauth ? (
            <div className="border border-line bg-panel-2 p-3">
              <p className="text-small text-danger">{t('payment.problem.signInAgain')}</p>
              <div className="mt-3">
                <AccountForm initialMode="sign-in" />
              </div>
            </div>
          ) : (
            <SlipForm
              file={file}
              onFileChange={handleFileChange}
              amountText={amountText}
              onAmountChange={setAmountText}
              transferredAtLocal={transferredAtLocal}
              onTransferredAtChange={setTransferredAtLocal}
              bankReference={bankReference}
              onBankReferenceChange={setBankReference}
              phase={phase}
              onSubmit={() => {
                void submit();
              }}
            />
          )}
        </>
      )}

      <SlipHistory slips={slips} t={t} />
    </div>
  );
}

function SlipHistory({
  slips,
  t,
}: {
  readonly slips: readonly PaymentSlip[];
  readonly t: Translate;
}): ReactElement {
  return (
    <section className="border border-line bg-panel p-4">
      <h2 className="text-lead text-chalk">{t('payment.history.heading')}</h2>

      {slips.length === 0 ? (
        <p className="mt-2 text-small text-chalk-2">{t('payment.history.empty')}</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {slips.map((slip) => (
            <li key={slip.id} className="border-b border-line py-2 text-small text-chalk">
              {slip.status === 'rejected'
                ? t('payment.history.rejected', {
                    slipMinor: slip.amountThbMinor,
                    reason: slip.rejectedReasonTh ?? '',
                  })
                : t(slip.status === 'accepted' ? 'payment.history.accepted' : 'payment.history.submitted', {
                    slipMinor: slip.amountThbMinor,
                    sentAt: new Date(slip.createdAt),
                  })}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
