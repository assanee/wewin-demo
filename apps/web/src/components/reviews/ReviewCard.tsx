import type { ReactElement } from 'react';

import { UnitText } from '../catalog/UnitText';
import { unitVariants } from '../catalog/unitVariants';
import type { LocaleBundle } from '../../i18n/server';
import { starFills } from '../../lib/reviews/average';
import type { PublishedReviewWire } from '../../lib/reviews/wire';
import { Stars } from './Stars';

/**
 * One review, of one **order line** — which is the whole of plan 9.1 arriving on a screen.
 *
 * > A two-star review saying "too small" is an opinion about a size the customer chose, not
 * > about the product. Tie reviews to the product alone and the ratings are read wrong for
 * > ever.
 *
 * So the size the customer actually ordered is printed on the card, beside their words. It
 * costs one line and it is the reason the schema put the review on `quote_line_id` rather
 * than on `product_id` — a design decision that would be invisible if no screen ever showed
 * what it bought.
 *
 * The size is rendered in **all five units on the server** and indexed in the browser by
 * `UnitText`, exactly as `ProductCard` renders a size range. That is plan 8.2's third trap:
 * the display unit is a per-visitor preference and is in no cache key, so a cached page has
 * to carry every answer rather than one visitor's.
 *
 * ── An erased review is a different thing from a quiet one ───────────────────────
 *
 * `content_erased_at` set means the prose and the display name were removed under an
 * erasure request while the rating stayed (packages/db spells out that split and what a
 * lawyer still has to settle). A blank card would read as "this customer said nothing";
 * this one says what happened. That is the same honesty `payment_slips.storage_key_erased_at`
 * buys for a deleted slip image — a row whose content was erased on policy must be
 * distinguishable from a row that never had any.
 */
export function ReviewCard({
  review,
  l,
}: {
  readonly review: PublishedReviewWire;
  readonly l: LocaleBundle;
}): ReactElement {
  const { t } = l;
  const erased = review.contentErasedAt !== null;
  /* Pulled out of the object so the narrowing survives into the closure below. */
  const size = review.size;

  return (
    <article className="border border-line bg-panel p-4 md:p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex flex-wrap items-center gap-2">
          {/*
            One review is one rating, so the tally is `{ sum: rating, count: 1 }` — the same
            type the block header uses, which is what stops a "just the stars" shortcut
            existing anywhere.
          */}
          <Stars fills={starFills({ sum: BigInt(review.rating), count: 1n })} />
          <span className="text-small text-chalk-2">
            {erased || review.authorDisplayName === null || review.authorDisplayName === ''
              ? t('review.author.anonymous')
              : review.authorDisplayName}
          </span>
        </div>
        <time className="text-caption text-chalk-3" dateTime={review.publicSince}>
          {t('review.publishedOn', { at: new Date(review.publicSince) })}
        </time>
      </header>

      {size === null ? null : (
        <p className="mt-2 text-caption text-chalk-3">
          <UnitText
            variants={unitVariants((unit) =>
              t('review.size', { widthUm: size.widthUm, heightUm: size.heightUm, unit }),
            )}
          />
        </p>
      )}

      {erased ? (
        <p className="mt-3 border-l-2 border-line-2 pl-3 text-small text-chalk-3">
          {t('review.erased')}
        </p>
      ) : review.bodyTh === null || review.bodyTh === '' ? null : (
        /* `whitespace-pre-line`: the customer's own paragraph breaks, and nothing else —
           the text is rendered as text, never as markup. */
        <p className="mt-3 whitespace-pre-line text-body text-chalk">{review.bodyTh}</p>
      )}

      {review.photos.length === 0 ? null : (
        <ul className="mt-3 flex flex-wrap gap-2">
          {review.photos.map((photo, index) => (
            <li key={photo.id}>
              {/*
                A plain `<img>`, and the dimensions come from the API rather than from a
                layout guess, so the row does not reflow when the pictures arrive.

                ⚠️ **This app never touches the bytes.** Plan 9.4's requirement — strip EXIF,
                GPS above all, because a customer photographing their own window publishes
                their home address with it — is met on the way *in*, by whatever accepts the
                upload, and `review_photos.checksum_sha256 <> source_checksum_sha256` in
                packages/db is what makes "the stored bytes are not the uploaded bytes"
                checkable. There is deliberately no upload control on this storefront's
                review form for the same reason: see `ReviewFormIsland`.
              */}
              <img
                src={photo.url}
                alt={t('review.photo.alt', { index: index + 1 })}
                width={photo.widthPx ?? 160}
                height={photo.heightPx ?? 160}
                loading="lazy"
                decoding="async"
                className="h-30 w-auto border border-line object-cover"
              />
            </li>
          ))}
        </ul>
      )}

      {review.replyTh === null || review.replyTh === '' ? null : (
        <div className="mt-4 border-t border-line pt-3">
          <p className="text-caption text-chalk-2">
            {t('review.reply.heading')}
            {review.repliedAt === null ? null : (
              <>
                {' · '}
                <time dateTime={review.repliedAt}>
                  {t('review.reply.on', { at: new Date(review.repliedAt) })}
                </time>
              </>
            )}
          </p>
          <p className="mt-1 whitespace-pre-line text-small text-chalk-2">{review.replyTh}</p>
        </div>
      )}
    </article>
  );
}
