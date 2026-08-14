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
import type { Emphasis } from '../../lib/payment/owedFigures';
import { useLocale } from '../../state/localeContext';
import type { Translate } from '../../i18n/translate';
import { AccountForm } from '../account/AccountForm';
import { AccountGate } from '../account/AccountGate';
import { AccountPicker } from './AccountPicker';
import { describePaymentPanel } from './paymentPanel';
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

/**
 * ⭐ The two roles `describeOwedFigures` hands back, in this screen's tokens.
 *
 * `lead` keeps the styling this screen has always given its headline figure — the amount in
 * `text-lead text-lime`, its label in body text — so the *prominence* is unchanged and only
 * which figure gets it has moved. `quiet` is the supporting line, the same weight the rest
 * of this screen gives context (`notFound.body`, the slip history) and the same *role*
 * `MyQuotations` paints with its own `AMOUNT_CLASS`.
 *
 * ⚠️ Whole strings rather than a template with a hole in it: `scripts/check-tokens.mjs`
 * reads the literals out of any `const` whose name contains `class`, and a utility spliced
 * together at runtime is one it cannot see.
 */
const FIGURE_CLASS: Readonly<
  Record<Emphasis, { readonly line: string; readonly amount: string }>
> = {
  lead: { line: 'text-body text-chalk', amount: 'numeric text-lead text-lime' },
  quiet: { line: 'text-small text-chalk-2', amount: 'numeric text-small text-chalk-2' },
};

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
      /*
       * ⭐ THE FIELD OPENS ON THE NEXT INSTALMENT DUE, NOT ON THE OUTSTANDING.
       *
       * The owner's rule: *"ถ้าเป็นเคสที่ระบุว่าต้องมัดจำ จึงจะมัดจำ ถ้าไม่ได้ระบุให้ใช้ยอดเต็มเลย"*.
       * This used to be `outstandingThbMinor`, which meant a 30/70 order whose quotation
       * printed `ชำระมัดจำก่อน ฿4,320.00` opened a form reading ฿14,400.00 — the customer being
       * shown one number and asked for another, which is the whole reason this changed.
       *
       * ⚠️ The choice is the server's and is not re-made here. `order_next_due_thb_minor()`
       * answers the deposit for a 30/70 and the full amount for a pay-in-full schedule, so
       * there is no `deposit ?? total` on this side — a client picking between two figures
       * would be a second implementation of the rule, and the two would disagree the first
       * time somebody paid half a deposit.
       */
      setAmountText((current) => (current === '' ? satangField(result.data.nextDueThbMinor) : current));
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
          /*
           * ⚠️ Fix round 1. `selectedAccountId` was narrowed to `string` by the null check
           * above, before the upload branch even runs — so every path that reaches this call
           * already has one. The picker cannot be bypassed; this line is what stops that
           * fact from staying true only in the UI and not in the request.
           */
          receivedBankAccountId: selectedAccountId,
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
  /*
   * ⭐ WHAT THIS SCREEN SAYS, AND WHETHER IT ASKS FOR ANYTHING — one call, one module.
   *
   * This used to be `const settled = data.outstandingThbMinor <= 0n` and nothing else, which
   * is *false* on a cancelled order carrying an unpaid balance: the screen printed
   * "ยอดคงค้างทั้งหมด ฿10,354.18" over the upload form on an order the customer had cancelled and
   * on which the company owed them their deposit back. `orderIsLive` is the server's own
   * answer, from the same predicate the staff money card reads, and `paymentPanel.ts` holds
   * the decision so it can be tested — a `.test.tsx` is never collected here.
   *
   * ⚠️ An `acceptsPayment` boolean was passed beside it until `0046_slips_after_delivery.sql`
   * opened `delivered` to slips; the two then answered identically on every status and the
   * wire dropped one. See `paymentPanel.ts` for what that removed from this screen.
   */
  const panel = describePaymentPanel({
    orderIsLive: data.orderIsLive,
    outstandingMinor: data.outstandingThbMinor,
    nextDueMinor: data.nextDueThbMinor,
    accountCount: data.accounts.length,
  });
  const parsedAmount = readSatang(amountText);
  const amountForQr = parsedAmount.ok ? parsedAmount.value : null;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-title text-chalk">{t('payment.heading')}</h1>

      {/*
        ⭐ THE SCREEN NAMES THE NUMBER IT IS ASKING FOR — fix round 2.

        This block used to be one line: `payment.outstanding` in `text-lead text-lime`, and
        nothing at all about the next instalment. The amount field below it already opened on
        `nextDueThbMinor` (see the ⭐ note at the prefill, which is the owner's rule and is not
        in question) — so on a 30/70 order the headline said ฿14,400.00 while the field the
        customer was about to submit said ฿4,320.00, and the only place that figure was named
        was `จำนวนเงินที่โอน`, which asks what they *transferred*, not what they owe.

        `MyQuotations` had by then started leading each row with ฿4,320.00. A customer read
        ฿4,320.00, clicked, and the headline became ฿14,400.00.

        ⚠️ The order of the two figures is `describeOwedFigures`', not this file's, and the
        list asks the same module the same question — which is what stops the two screens from
        drifting apart again. On a pay-in-full order, and on a 30/70 whose deposit has been
        accepted, it answers with one figure and this renders exactly the single outstanding
        line that was here before.

        ⭐ …and on an order nobody owes anything on it answers with **none**, which is the
        round after this one. `panel.figures` is empty on a cancelled or superseded order — the
        residue is real but it is a refund question, not a bill, and a figure under
        "ยอดคงค้างทั้งหมด" is a bill whatever its value. A **delivered** order is not in that set:
        it is a contract fulfilled, its balance is genuinely owed, and since 0046 the form
        below can take it.

        ⚠️ `payment.outstandingAmount` is this app's only money template and is a bare
        `f.bahtExact` in all eight locales, so it formats the due-now the same way — to the
        satang, in the locale's own numerals. The figure never enters a translator's sentence.
      */}
      <div className="flex flex-col gap-1">
        {panel.figures.map((figure) => (
          <p key={figure.labelKey} className={FIGURE_CLASS[figure.emphasis].line}>
            {t(figure.labelKey)}{' '}
            <span className={FIGURE_CLASS[figure.emphasis].amount}>
              {t('payment.outstandingAmount', { owedMinor: figure.amountMinor })}
            </span>
          </p>
        ))}
      </div>

      {/*
        One sentence in place of a demand — `payment.closed` when this order can no longer
        receive a payment, `payment.settled` when it can and owes nothing, `payment.account.none`
        when there is nowhere for the money to go (`0027_organisation.sql` seeds no bank
        accounts, so a fresh database reaches that on every order). Which of the three, and
        whether the form exists at all, is `paymentPanel.ts`'s decision and is tested there.

        ⚠️ `SlipForm` and its submit button are not rendered *disabled* in any of the three:
        there is nothing to send, or nowhere to send it, so the control that would send it is
        unreachable rather than merely refused on press.
      */}
      {panel.noteKey !== null ? (
        <p className="border border-line bg-panel-2 p-3 text-small text-chalk">{t(panel.noteKey)}</p>
      ) : null}

      {panel.showsForm ? (
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
      ) : null}

      {/*
        ⚠️ OUTSIDE EVERY GATE, AND DELIBERATELY SO.

        A customer whose order was cancelled after they paid a deposit needs to see that the
        deposit is *recorded* — that is the one thing this screen can still tell them, and the
        refund conversation starts from it. Hiding the history along with the form would make
        a closed order look like an order nothing had ever been sent against, which is worse
        than the bug this round fixes.
      */}
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
