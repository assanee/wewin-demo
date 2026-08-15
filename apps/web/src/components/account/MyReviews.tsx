'use client';

import { useEffect, useState, type ReactElement } from 'react';

import { reviewsApiBaseUrl } from '../../lib/reviews/api';
import type { Session } from '../../lib/auth/account';
import { useLocale } from '../../state/localeContext';
import {
  REVIEW_RATINGS,
  splitReviewable,
  writeReviewBody,
  type ReviewRating,
  type ReviewableLine,
} from './reviewableLines';

/**
 * รีวิวของฉัน — the signed-in review surface.
 *
 * See `reviewableLines.ts` for why this exists beside `ReviewFormIsland` rather than instead of it:
 * that form is reached from an emailed invitation, posts a body the API's `strictObject`
 * refuses, and the invitation it depends on is never sent. This one uses the path the API
 * implements and has tests for — `GET /reviews/reviewable-lines`, then
 * `POST /reviews { quoteLineId, … }`.
 *
 * ⚠️ A tab rather than a link on each order row. Reviewable lines are per *line*, and one
 * order can hold several: hanging the entry point off the order list would put three "write a
 * review" links on one row with nothing to tell them apart.
 */

type Phase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly lines: readonly ReviewableLine[] };

const decode = (body: unknown): readonly ReviewableLine[] | null => {
  if (typeof body !== 'object' || body === null || !('items' in body)) return null;
  const { items } = body as { items: unknown };
  if (!Array.isArray(items)) return null;

  return items.flatMap((raw: unknown): ReviewableLine[] => {
    if (typeof raw !== 'object' || raw === null) return [];
    const item = raw as Record<string, unknown>;
    const quoteLineId = item['quoteLineId'];
    const productNameTh = item['productNameTh'];
    if (typeof quoteLineId !== 'string' || typeof productNameTh !== 'string') return [];

    return [
      {
        quoteLineId,
        orderId: typeof item['orderId'] === 'string' ? item['orderId'] : '',
        orderNo: typeof item['orderNo'] === 'string' ? item['orderNo'] : null,
        productId: typeof item['productId'] === 'string' ? item['productId'] : '',
        productNameTh,
        deliveredAt: typeof item['deliveredAt'] === 'string' ? item['deliveredAt'] : '',
        reviewId: typeof item['reviewId'] === 'string' ? item['reviewId'] : null,
      },
    ];
  });
};

export function MyReviews({ session }: { readonly session: Session }): ReactElement {
  const { t } = useLocale();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [writing, setWriting] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const base = reviewsApiBaseUrl();
    if (base === null) {
      setPhase({ kind: 'failed' });
      return;
    }

    void fetch(`${base}/reviews/reviewable-lines`, {
      credentials: 'include',
      headers: { accept: 'application/json', authorization: `Bearer ${session.accessToken}` },
      /* Somebody's own deliveries have no business in a shared cache. */
      cache: 'no-store',
    })
      .then(async (response) => (response.ok ? decode(await response.json()) : null))
      .catch(() => null)
      .then((lines) => {
        if (cancelled) return;
        setPhase(lines === null ? { kind: 'failed' } : { kind: 'ready', lines });
      });

    return () => {
      cancelled = true;
    };
  }, [reloadKey, session.accessToken]);

  if (phase.kind === 'loading') {
    return <p className="text-small text-chalk-2">{t('account.checking')}</p>;
  }

  if (phase.kind === 'failed') {
    return <p className="text-small text-chalk-2">{t('review.form.failed.body')}</p>;
  }

  const { pending, written } = splitReviewable(phase.lines);

  if (pending.length === 0 && written.length === 0) {
    return <p className="text-small text-chalk-2">{t('account.reviews.none')}</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      {pending.map((line) => (
        <ReviewRow
          key={line.quoteLineId}
          line={line}
          session={session}
          open={writing === line.quoteLineId}
          onOpen={() => setWriting(line.quoteLineId)}
          onDone={() => {
            setWriting(null);
            setReloadKey((key) => key + 1);
          }}
        />
      ))}

      {written.map((line) => (
        <div key={line.quoteLineId} className="flex flex-col gap-1">
          <p className="text-chalk">{line.productNameTh}</p>
          <p className="text-small text-chalk-2">
            {line.orderNo ?? ''} · {t('account.reviews.written')}
          </p>
        </div>
      ))}
    </div>
  );
}

function ReviewRow({
  line,
  session,
  open,
  onOpen,
  onDone,
}: {
  readonly line: ReviewableLine;
  readonly session: Session;
  readonly open: boolean;
  readonly onOpen: () => void;
  readonly onDone: () => void;
}): ReactElement {
  const { t } = useLocale();
  const [rating, setRating] = useState<ReviewRating | null>(null);
  const [bodyTh, setBodyTh] = useState('');
  const [name, setName] = useState('');
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function submit(): Promise<void> {
    if (rating === null) return;
    const base = reviewsApiBaseUrl();
    if (base === null) {
      setFailed(true);
      return;
    }

    setSending(true);
    setFailed(false);
    try {
      const response = await fetch(`${base}/reviews`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify(writeReviewBody(line.quoteLineId, rating, bodyTh, name)),
      });
      if (!response.ok) {
        setFailed(true);
        return;
      }
      onDone();
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-b border-line pb-6">
      <p className="text-chalk">{line.productNameTh}</p>
      <p className="text-small text-chalk-2">{line.orderNo ?? ''}</p>

      {!open ? (
        <button
          type="button"
          onClick={onOpen}
          className="min-h-11 w-fit border border-line px-4 py-2 text-small text-chalk hover:bg-panel-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sel-line"
        >
          {t('review.form.heading')}
        </button>
      ) : (
        <div className="flex flex-col gap-3">
          <fieldset className="flex flex-col gap-2">
            <legend className="text-small text-chalk-2">{t('review.form.rating.legend')}</legend>
            <div className="flex flex-wrap gap-2">
              {REVIEW_RATINGS.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={rating === value}
                  onClick={() => setRating(value)}
                  className={`min-h-11 min-w-11 border px-3 py-2 text-small focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sel-line ${
                    rating === value
                      ? 'border-sel-line bg-sel-bg text-chalk'
                      : 'border-line text-chalk-2 hover:text-chalk'
                  }`}
                >
                  {value}
                </button>
              ))}
            </div>
          </fieldset>

          <label className="flex flex-col gap-1 text-small text-chalk-2">
            {t('review.form.body.label')}
            <textarea
              rows={3}
              value={bodyTh}
              onChange={(event) => setBodyTh(event.target.value)}
              className="border border-line bg-panel-2 px-3 py-2 text-chalk focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sel-line"
            />
          </label>

          <label className="flex flex-col gap-1 text-small text-chalk-2">
            {t('review.form.name.label')}
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="min-h-11 border border-line bg-panel-2 px-3 text-chalk focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sel-line"
            />
          </label>

          <p className="text-small text-chalk-2">{t('review.form.moderation')}</p>

          {failed && <p className="text-small text-chalk">{t('review.form.failed.body')}</p>}

          <button
            type="button"
            disabled={rating === null || sending}
            onClick={() => void submit()}
            className="min-h-11 w-fit border border-sel-line bg-sel-bg px-4 py-2 text-small text-chalk disabled:opacity-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sel-line"
          >
            {sending ? t('review.form.submitting') : t('review.form.submit')}
          </button>
        </div>
      )}
    </div>
  );
}
