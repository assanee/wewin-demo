'use client';

import { useEffect, useState, type ReactElement } from 'react';
import { getProductBySlug } from '@wewin/core/fixtures';

import { useLocale } from '../../state/localeContext';
import { CatalogText } from '../common/CatalogText';
import { UnitText } from '../catalog/UnitText';
import { unitVariants } from '../catalog/unitVariants';
import { Stars } from './Stars';
import {
  fetchInvitation,
  submitReview,
  type InvitationWire,
} from '../../lib/reviews/invitation';

/**
 * The form a customer reaches from their invitation — one client island, on a page that
 * stays prerendered.
 *
 * ── Why the token is in the query string and read here ───────────────────────────
 *
 * The obvious route is `/[locale]/review/[token]`, and it is the wrong one twice. A dynamic
 * segment with no `generateStaticParams` under a layout that sets `dynamicParams = false`
 * does not resolve; and reading the token on the server would put a personal secret into a
 * render whose whole design is that it is cached. `?t=…` read in the browser is the shape
 * this app already uses for share links — "query strings are read by the client island and
 * nowhere else" — so the page is 8 prerendered shells and the token never touches a cache
 * key, a log line or `generateMetadata`.
 *
 * ── The server render is the loading state, deliberately ─────────────────────────
 *
 * `window.location.search` does not exist during the prerender, so the first render is
 * `reading` in all eight locales and the token arrives in an effect one commit later.
 * That is the same rule `useUrlSearch` states at length: a value that differs between the
 * server render and the first client render is a hydration mismatch, and React answers a
 * mismatch by quietly re-rendering rather than by saying so.
 *
 * ── ⚠️ There is no photo control, and that is a decision ─────────────────────────
 *
 * Plan 9.4 is unambiguous: *strip EXIF, GPS above all — a customer photographs their own
 * window, and publishing the file publishes their home address.* Stripping happens where
 * the bytes are, which is not here, and packages/db can only verify the negative
 * (`checksum_sha256 <> source_checksum_sha256` — the stored bytes are not the uploaded
 * bytes). A picker on this form would put a customer's GPS-stamped photograph on the wire
 * towards a service this app cannot show has a stripper in front of it. The read side is
 * ready — `ReviewCard` renders photos the moment the API returns any — and the write side
 * arrives on the day an upload endpoint exists that has been shown to strip. Absent and
 * named beats present and hopeful.
 */

type Phase =
  | { readonly kind: 'reading' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'ready'; readonly token: string; readonly invitation: InvitationWire }
  | { readonly kind: 'sending'; readonly token: string; readonly invitation: InvitationWire }
  | { readonly kind: 'failed'; readonly token: string; readonly invitation: InvitationWire }
  | { readonly kind: 'sent' };

/** 1–5 — `REVIEW_RATING_MIN`/`REVIEW_RATING_MAX` in packages/db, and five stars. */
const RATINGS = [1, 2, 3, 4, 5] as const;

export function ReviewFormIsland(): ReactElement {
  const { t } = useLocale();

  const [phase, setPhase] = useState<Phase>({ kind: 'reading' });
  const [rating, setRating] = useState<number | null>(null);
  const [bodyTh, setBodyTh] = useState('');
  const [authorDisplayName, setAuthorDisplayName] = useState('');
  const [ratingMissing, setRatingMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // The whole read, in one effect: no `useSearchParams` (it makes the route dynamic —
    // see `state/useUrlSearch.ts`), and no `popstate` subscription, because a review form
    // whose token changes underneath the person filling it in is not a thing to support.
    const token = new URLSearchParams(window.location.search).get('t');
    if (token === null || token === '') {
      setPhase({ kind: 'invalid' });
      return;
    }

    void fetchInvitation(token).then((invitation) => {
      if (cancelled) return;
      if (invitation === null || invitation.submitted) {
        setPhase({ kind: 'invalid' });
        return;
      }
      setPhase({ kind: 'ready', token, invitation });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  if (phase.kind === 'reading') {
    return <p className="text-body text-chalk-2">{t('review.form.loading')}</p>;
  }

  if (phase.kind === 'invalid') {
    return (
      <Notice title={t('review.form.invalid.title')} body={t('review.form.invalid.body')} />
    );
  }

  if (phase.kind === 'sent') {
    return <Notice title={t('review.form.done.title')} body={t('review.form.done.body')} />;
  }

  const { token, invitation } = phase;
  const product = getProductBySlug(invitation.productSlug);
  const sending = phase.kind === 'sending';
  /* Out of the object, so the narrowing survives into the closure that renders it. */
  const size = invitation.size;

  const send = (): void => {
    if (rating === null) {
      setRatingMissing(true);
      return;
    }
    setRatingMissing(false);
    setPhase({ kind: 'sending', token, invitation });
    void submitReview(token, { rating, bodyTh, authorDisplayName }).then((accepted) => {
      setPhase(accepted ? { kind: 'sent' } : { kind: 'failed', token, invitation });
    });
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-display text-chalk">{t('review.form.heading')}</h1>
        {product === undefined ? null : (
          <p className="mt-1 text-body text-chalk-2">
            {/* The product's own name, from the compiled-in catalogue and through the
                content resolver, so an untranslated name is marked `lang="th"` rather than
                spoken as German. The API sends a slug and never a name — a name on the
                wire would be a second copy of the catalogue with its own staleness. */}
            <CatalogText at={{ on: 'productName', productId: product.id }} th={product.nameTh} />
          </p>
        )}
        {size === null ? null : (
          <p className="mt-1 text-caption text-chalk-3">
            <UnitText
              variants={unitVariants((unit) =>
                t('review.size', { widthUm: size.widthUm, heightUm: size.heightUm, unit }),
              )}
            />
          </p>
        )}
        <p className="mt-3 text-small text-chalk-2">{t('review.form.intro')}</p>
      </div>

      <fieldset className="border border-line bg-panel p-4">
        <legend className="px-1 text-small text-chalk-2">{t('review.form.rating.legend')}</legend>
        <div className="flex flex-wrap gap-2">
          {RATINGS.map((stars) => {
            const chosen = rating === stars;
            return (
              <button
                key={stars}
                type="button"
                aria-pressed={chosen}
                onClick={() => {
                  setRating(stars);
                  setRatingMissing(false);
                }}
                className={`flex min-h-11 items-center gap-2 border px-3 transition-colors duration-180 ease-out ${
                  chosen
                    ? 'border-sel-line bg-sel-bg text-chalk'
                    : 'border-line bg-panel-2 text-chalk-2 hover:text-chalk'
                }`}
              >
                {/* The picture is decoration; the label is the accessible name. */}
                <Stars
                  fills={RATINGS.map((position) => (position <= stars ? 'full' : 'empty'))}
                />
                <span className="text-small">{t('review.form.rating.option', { stars })}</span>
              </button>
            );
          })}
        </div>
        {ratingMissing ? (
          <p className="mt-2 text-caption text-danger">{t('review.form.rating.required')}</p>
        ) : null}
      </fieldset>

      <label className="flex flex-col gap-1">
        <span className="text-small text-chalk-2">{t('review.form.body.label')}</span>
        <textarea
          value={bodyTh}
          onChange={(event) => setBodyTh(event.target.value)}
          rows={6}
          className="min-h-11 w-full border border-line bg-panel-2 p-3 text-body text-chalk"
        />
        <span className="text-caption text-chalk-3">{t('review.form.body.help')}</span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-small text-chalk-2">{t('review.form.name.label')}</span>
        <input
          type="text"
          value={authorDisplayName}
          onChange={(event) => setAuthorDisplayName(event.target.value)}
          className="min-h-11 w-full border border-line bg-panel-2 px-3 text-body text-chalk"
        />
        <span className="text-caption text-chalk-3">{t('review.form.name.help')}</span>
      </label>

      {phase.kind === 'failed' ? (
        <Notice title={t('review.form.failed.title')} body={t('review.form.failed.body')} />
      ) : null}

      <div className="flex flex-col gap-2">
        {/*
          The one lime element on this screen — spec section 2 caps lime at two per screen
          and reserves it for the price and the single active action. There is no price
          here, so the submit button is the whole budget and nothing else may take any of it.
        */}
        <button
          type="button"
          onClick={send}
          disabled={sending}
          className="min-h-11 self-start border border-lime bg-lime px-5 font-medium text-ink transition-[filter] duration-180 ease-out hover:brightness-110 disabled:opacity-60"
        >
          {sending ? t('review.form.submitting') : t('review.form.submit')}
        </button>
        <p className="text-caption text-chalk-3">{t('review.form.moderation')}</p>
      </div>

    </div>
  );
}

function Notice({ title, body }: { readonly title: string; readonly body: string }): ReactElement {
  return (
    <div className="border border-line bg-panel p-4">
      <p className="text-lead text-chalk">{title}</p>
      <p className="mt-1 text-small text-chalk-2">{body}</p>
    </div>
  );
}
