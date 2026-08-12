'use client';

import { useCallback, useRef, useState, type ReactElement } from 'react';

import { Button } from '../common/Button';
import { useLocale } from '../../state/localeContext';
import {
  cancelOrder,
  fetchCancellationPreview,
  openChangeRequest,
  withdrawChangeRequest,
  type CancellationPreview,
  type OrderActionProblem,
  type OrderActions as Offers,
} from '../../lib/orders/actions';
import type { PlainKey } from '../../i18n/keys';

/**
 * The two things a customer may do to their own order, on the page where they read it.
 *
 * ── Why both, and in this order ─────────────────────────────────────────────────
 *
 * Objecting comes first because it is the cheaper answer to the same feeling. It blocks the
 * order from entering `production_confirmed` until a person replies, costs nothing, and can be
 * withdrawn. Cancelling is terminal and may keep money. A screen offering only the second would
 * be telling somebody with a fixable complaint that their choices are to live with it or to
 * forfeit a deposit — so the order of these two blocks is the argument, not the layout.
 *
 * ── ⭐ Which buttons exist is the server's decision ─────────────────────────────
 *
 * `offers.cancellation` is derived from `availableTransitions`, which the API builds from
 * `order_status_transitions` filtered by the caller's actor kind. This component has no list of
 * cancellable statuses and must never grow one: the moment it did, it would be a second opinion
 * about authorisation, and the first disagreement would be a 403 behind a button we drew.
 *
 * ── ⚠️ The cancel path states the cost before it will confirm ───────────────────
 *
 * `'confirming'` is not reachable without a priced preview. Pressing the cancel button fetches
 * `GET /orders/:id/cancellation-preview` first and only then renders the confirm control, so
 * there is no ordering of clicks that reaches the POST without the figure having been on screen.
 * That is the whole point of the two-step: a cancel button that silently forfeits money is the
 * worst thing this page could ship.
 *
 * The figure is the server's, priced from the policy this order pinned at submit against the
 * money it actually holds, by the same method the cancellation itself calls. It is ฿0.00 for
 * every order under the shipped default policy, and the copy says *that* rather than "money may
 * be kept" — a hedge in front of a number nobody has computed is how a customer ends up
 * surprised either way.
 */
export function OrderActions({
  offers,
  accessToken,
  onChanged,
}: {
  readonly offers: Offers;
  /**
   * ⚠️ Passed down, never re-fetched.
   *
   * `currentSession()` spends the `__Host-` refresh cookie and **rotates it** — asking twice in
   * one second is a sign-out. `QuotationIsland` asks exactly once for the whole page; this
   * component receives the answer.
   */
  readonly accessToken: string;
  /** Reload the order so the page reflects what just happened. */
  readonly onChanged: () => void;
}): ReactElement | null {
  const { t, f } = useLocale();

  const nothingToDo = offers.cancellation.kind === 'none' && offers.openChangeRequest === null;
  /*
   * A signed-in customer on a delivered order has neither button and no objection open. Rendering
   * an empty bordered section under their quotation would be a heading with nothing beneath it.
   */
  if (nothingToDo) return null;

  return (
    <section className="mt-8 border border-line bg-panel p-4 print:hidden">
      <h2 className="text-lead text-chalk">{t('orderActions.heading')}</h2>

      <Objection offers={offers} accessToken={accessToken} onChanged={onChanged} t={t} f={f} />

      {offers.cancellation.kind === 'none' ? null : (
        <Cancellation
          orderId={offers.orderId}
          postFreeze={offers.cancellation.kind === 'post-freeze'}
          accessToken={accessToken}
          onChanged={onChanged}
          t={t}
        />
      )}
    </section>
  );
}

type Bundle = ReturnType<typeof useLocale>;
type Translate = Bundle['t'];
type Formatters = Bundle['f'];

/**
 * The API's own sentence when it has one, and a local key when it does not.
 *
 * Every refusal from this application carries `error.message` already rendered in the reader's
 * language, so `'refused'` prefers `detail`: the server can say "this order has already been
 * cancelled" and a generic string cannot. The other four problems never reach the wire, so
 * there is nothing to prefer.
 */
const PROBLEM_KEY: Record<OrderActionProblem, PlainKey> = {
  unconfigured: 'orderActions.problem.unconfigured',
  unreachable: 'orderActions.problem.unreachable',
  unauthorized: 'orderActions.problem.unauthorized',
  refused: 'orderActions.problem.refused',
  malformed: 'orderActions.problem.malformed',
};

const messageOf = (
  t: Translate,
  problem: OrderActionProblem,
  detail: string | undefined,
): string => (problem === 'refused' && detail !== undefined ? detail : t(PROBLEM_KEY[problem]));

const FIELD = 'w-full border border-line bg-panel-2 p-3 text-body text-chalk';
const ERROR_BOX = 'mt-3 border border-line bg-panel-2 p-3 text-small text-danger';
const NOTE_BOX = 'mt-3 border border-line bg-panel-2 p-3 text-small text-chalk';

/* ------------------------------------------------------------------ *
 * Objecting
 * ------------------------------------------------------------------ */

type ObjectionPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'done'; readonly messageKey: PlainKey };

function Objection({
  offers,
  accessToken,
  onChanged,
  t,
  f,
}: {
  readonly offers: Offers;
  readonly accessToken: string;
  readonly onChanged: () => void;
  readonly t: Translate;
  readonly f: Formatters;
}): ReactElement {
  const [note, setNote] = useState('');
  const [phase, setPhase] = useState<ObjectionPhase>({ kind: 'idle' });
  /* Belt and braces with `disabled`: a double-tap before React re-renders is one request too many. */
  const busy = useRef(false);

  const run = useCallback(
    async (work: () => Promise<{ ok: boolean; problem?: OrderActionProblem; detail?: string | undefined }>, doneKey: PlainKey) => {
      if (busy.current) return;
      busy.current = true;
      setPhase({ kind: 'sending' });

      try {
        const result = await work();
        if (result.ok) {
          setPhase({ kind: 'done', messageKey: doneKey });
          setNote('');
          onChanged();
          return;
        }
        setPhase({
          kind: 'failed',
          message: messageOf(t, result.problem ?? 'refused', result.detail),
        });
      } finally {
        busy.current = false;
      }
    },
    [onChanged, t],
  );

  const open = offers.openChangeRequest;

  /*
   * An objection already open is a different screen, not a disabled version of the same one:
   * the customer's remaining choice is to withdraw it, and the note field would be a second
   * objection the partial unique index refuses anyway.
   */
  if (open !== null) {
    return (
      <div className="mt-4 border-t border-line pt-4">
        <h3 className="text-body text-chalk">{t('orderActions.object.title')}</h3>
        <p className={NOTE_BOX}>
          {t('orderActions.object.open', { openedAt: f.date(new Date(open.openedAt)) })}
        </p>
        {open.noteTh === null ? null : (
          <p className="mt-2 text-small whitespace-pre-wrap text-chalk-2">{open.noteTh}</p>
        )}
        <p className="mt-2 text-small text-chalk-2">{t('orderActions.object.openBody')}</p>

        <Button
          variant="secondary"
          className="mt-3"
          disabled={phase.kind === 'sending'}
          onClick={() => {
            void run(
              () => withdrawChangeRequest(offers.orderId, open.id, accessToken),
              'orderActions.object.withdrawn',
            );
          }}
        >
          {t(phase.kind === 'sending' ? 'orderActions.object.withdrawing' : 'orderActions.object.withdraw')}
        </Button>

        {phase.kind === 'failed' ? <p className={ERROR_BOX}>{phase.message}</p> : null}
        {phase.kind === 'done' ? (
          <p className="mt-3 border border-line bg-panel-2 p-3 text-small text-chalk">
            {t(phase.messageKey)}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-4 border-t border-line pt-4">
      <h3 className="text-body text-chalk">{t('orderActions.object.title')}</h3>
      <p className="mt-1 text-small text-chalk-2">{t('orderActions.object.body')}</p>

      <label className="mt-3 flex flex-col gap-1">
        <span className="text-caption text-chalk-2">{t('orderActions.object.noteLabel')}</span>
        <textarea
          className={FIELD}
          rows={3}
          value={note}
          placeholder={t('orderActions.object.notePlaceholder')}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>

      <Button
        variant="secondary"
        className="mt-3"
        /* `noteSchema` is `.trim().min(1)`, so three spaces is a 422 — refused here instead. */
        disabled={phase.kind === 'sending' || note.trim() === ''}
        onClick={() => {
          void run(
            () => openChangeRequest(offers.orderId, note, accessToken),
            'orderActions.object.sent',
          );
        }}
      >
        {t(phase.kind === 'sending' ? 'orderActions.object.sending' : 'orderActions.object.submit')}
      </Button>

      {phase.kind === 'failed' ? <p className={ERROR_BOX}>{phase.message}</p> : null}
      {phase.kind === 'done' ? (
        <p className="mt-3 border border-line bg-panel-2 p-3 text-small text-chalk">
          {t(phase.messageKey)}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Cancelling
 * ------------------------------------------------------------------ */

/**
 * ⚠️ `'confirming'` **carries the preview**, which is what makes the figure unskippable.
 *
 * The confirm control only exists inside that variant, and the only way into it is through
 * `'pricing'` returning a priced preview. There is no state in which the POST is reachable and
 * the cost has not been rendered — expressed as the shape of the union rather than as a flag
 * somebody could forget to check.
 */
type CancelPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pricing' }
  | { readonly kind: 'confirming'; readonly preview: CancellationPreview }
  | { readonly kind: 'cancelling'; readonly preview: CancellationPreview }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'done' };

function Cancellation({
  orderId,
  postFreeze,
  accessToken,
  onChanged,
  t,
}: {
  readonly orderId: string;
  /** From the transition's `payloadKind`, not from the status — see `cancellationOffer`. */
  readonly postFreeze: boolean;
  readonly accessToken: string;
  readonly onChanged: () => void;
  /*
   * No `f` here, deliberately. Every figure in this block is rendered by a catalogue entry —
   * `t('orderActions.cancel.forfeit', { forfeitMinor })` — which receives the locale's own
   * formatters and decides where the number goes. A component that formatted money itself and
   * passed the string in would be the exact thing `keys.ts` forbids.
   */
  readonly t: Translate;
}): ReactElement {
  const [reason, setReason] = useState('');
  const [phase, setPhase] = useState<CancelPhase>({ kind: 'idle' });
  const busy = useRef(false);

  const price = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setPhase({ kind: 'pricing' });

    try {
      const result = await fetchCancellationPreview(orderId, accessToken);
      setPhase(
        result.ok
          ? { kind: 'confirming', preview: result.data }
          : { kind: 'failed', message: messageOf(t, result.problem, result.detail) },
      );
    } finally {
      busy.current = false;
    }
  }, [accessToken, orderId, t]);

  const confirm = useCallback(
    async (preview: CancellationPreview) => {
      if (busy.current) return;
      busy.current = true;
      setPhase({ kind: 'cancelling', preview });

      try {
        const result = await cancelOrder(orderId, reason, accessToken);
        if (result.ok) {
          setPhase({ kind: 'done' });
          onChanged();
          return;
        }
        setPhase({ kind: 'failed', message: messageOf(t, result.problem, result.detail) });
      } finally {
        busy.current = false;
      }
    },
    [accessToken, onChanged, orderId, reason, t],
  );

  const preview = phase.kind === 'confirming' || phase.kind === 'cancelling' ? phase.preview : null;

  return (
    <div className="mt-4 border-t border-line pt-4">
      <h3 className="text-body text-chalk">{t('orderActions.cancel.title')}</h3>
      <p className="mt-1 text-small text-chalk-2">{t('orderActions.cancel.body')}</p>
      <p className={NOTE_BOX}>
        {t(postFreeze ? 'orderActions.cancel.postFreezeNote' : 'orderActions.cancel.preFreezeNote')}
      </p>

      {phase.kind === 'done' ? (
        <p className="mt-3 border border-line bg-panel-2 p-3 text-small text-chalk">
          {t('orderActions.cancel.done')}
        </p>
      ) : null}

      {phase.kind === 'idle' || phase.kind === 'failed' ? (
        <Button
          variant="danger"
          className="mt-3"
          onClick={() => {
            void price();
          }}
        >
          {t('orderActions.cancel.start')}
        </Button>
      ) : null}

      {phase.kind === 'pricing' ? (
        <p className="mt-3 text-small text-chalk-2">{t('orderActions.cancel.pricing')}</p>
      ) : null}

      {preview === null ? null : (
        <div className="mt-3 border border-line bg-panel-2 p-3">
          {/*
           * ⭐ THE FIGURE, and the three cases are three different sentences.
           *
           * Nothing held is not the same statement as "you forfeit ฿0.00 of ฿0.00", and a policy
           * that keeps nothing is not the same statement as one that keeps something. Choosing
           * between them from the priced numbers — rather than from the freeze, or from a guess
           * — is what keeps the copy true when the owner finally sets a rate.
           */}
          {preview.heldThbMinor === 0n ? (
            <p className="text-small text-chalk">{t('orderActions.cancel.noMoney')}</p>
          ) : (
            <>
              <p className="text-small text-chalk">
                {t('orderActions.cancel.held', { heldMinor: preview.heldThbMinor })}
              </p>
              {preview.forfeitThbMinor === 0n ? (
                <p className="mt-1 text-small text-chalk">
                  {t('orderActions.cancel.freeCancellation')}
                </p>
              ) : (
                <p className="mt-1 text-small text-danger">
                  {t('orderActions.cancel.forfeit', { forfeitMinor: preview.forfeitThbMinor })}
                </p>
              )}
              <p className="mt-1 text-small text-chalk">
                {t('orderActions.cancel.refund', { refundMinor: preview.refundThbMinor })}
              </p>
            </>
          )}

          <label className="mt-3 flex flex-col gap-1">
            <span className="text-caption text-chalk-2">
              {t('orderActions.cancel.reasonLabel')}
            </span>
            <textarea
              className={FIELD}
              rows={2}
              value={reason}
              placeholder={t('orderActions.cancel.reasonPlaceholder')}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>

          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="danger"
              /* `reasonSchema` is `.trim().min(1)` — an empty reason is a 422, refused here. */
              disabled={phase.kind === 'cancelling' || reason.trim() === ''}
              onClick={() => {
                void confirm(preview);
              }}
            >
              {t(
                phase.kind === 'cancelling'
                  ? 'orderActions.cancel.cancelling'
                  : 'orderActions.cancel.confirm',
              )}
            </Button>
            <Button
              variant="ghost"
              disabled={phase.kind === 'cancelling'}
              onClick={() => {
                setPhase({ kind: 'idle' });
                setReason('');
              }}
            >
              {t('orderActions.cancel.keep')}
            </Button>
          </div>
        </div>
      )}

      {phase.kind === 'failed' ? <p className={ERROR_BOX}>{phase.message}</p> : null}
    </div>
  );
}
