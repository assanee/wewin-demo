import type { ReactElement } from 'react';

import { localeBundle } from '../../i18n/server';
import type { Locale } from '../../i18n/locales';
import { galleryItems, type GalleryItem } from '../../lib/catalog/gallery';
import { loadProductMedia } from '../../lib/catalog/media-api';
import { reviewsApiBaseUrl } from '../../lib/reviews/api';

/**
 * ⭐ 0052. The pictures on a product page — video first, then the gallery in its order.
 *
 * ── It is usually not there, and that is the same decision `ReviewBlock` made ────
 *
 * Eighty-one seeded products have no gallery, so this renders `null` on all 648 pages until
 * somebody attaches a picture in the dashboard. No placeholder, no "รูปเร็ว ๆ นี้", no
 * broken-image icon from the `heroImage` paths — which point at 81 `.svg` files that are
 * not in this repository. Silence says nothing; an empty state says something, and what it
 * would say here is "this shop has no photographs of its products".
 *
 * ── Why the whole thing is server-rendered ──────────────────────────────────────
 *
 * There is no lightbox, no carousel state, no client component. Pictures in a column that
 * the browser lazy-loads is the entire feature, and it costs nothing on a page whose one
 * interactive island is already the configurator. The day somebody asks for a lightbox is
 * the day this grows a client child — not before.
 */
export async function ProductGallery({
  slug,
  productId,
  locale,
}: {
  readonly slug: string;
  readonly productId: string;
  readonly locale: Locale;
}): Promise<ReactElement | null> {
  const media = await loadProductMedia(slug, productId);
  const items = galleryItems(media);
  if (items.length === 0) return null;

  const { t } = localeBundle(locale);
  const base = reviewsApiBaseUrl() ?? '';

  return (
    /*
     * ⚠️ Width-capped, and the cap is not decoration. Without one the gallery is a column of
     * full-bleed media and the configurator — the thing this page exists for — starts below
     * the fold on every product that has pictures. Seen by screenshotting it: a two-picture
     * gallery filled the viewport twice over before the price appeared.
     */
    <section
      aria-label={t('product.gallery.label')}
      /*
       * ⛔ `items-start` is what stops a small picture being stretched. A flex column
       * defaults to `align-items: stretch`, which sets the *width* of every child to the
       * column's — so `max-w-full` was inert and a 240 px image rendered at 468 px. There is
       * no width rule anywhere to find; the stretching comes from the parent's default.
       * Measured in the browser, because nothing in the source says it.
       */
      className="flex w-full max-w-2xl flex-col items-start gap-3"
    >
      {items.map((item, index) => (
        <GalleryFigure
          key={keyOf(item)}
          item={item}
          /*
           * ⚠️ The index of this *picture*, not of this item. The video is item 0 whenever
           * there is one, so passing the item index made the first photograph — the page's
           * likely LCP element — load lazily on every product that has a video.
           */
          imageIndex={items.slice(0, index).filter((earlier) => earlier.kind === 'image').length}
          base={base}
          label={t}
        />
      ))}
    </section>
  );
}

const keyOf = (item: GalleryItem): string =>
  item.kind === 'video' ? `video:${item.href}` : `image:${item.path}`;

function GalleryFigure({
  item,
  imageIndex,
  base,
  label,
}: {
  readonly item: GalleryItem;
  readonly imageIndex: number;
  readonly base: string;
  readonly label: (key: string) => string;
}): ReactElement {
  if (item.kind === 'video') {
    if (item.embedUrl === null) {
      /*
       * An http(s) link that is not a recognised player. Rendered as a link out rather than
       * framed — see `gallery.ts` for why an unrecognised host never gets an `<iframe>`.
       * `rel="noreferrer"` because this is a third party and there is no reason to hand it
       * the customer's path through the shop.
       */
      return (
        <a
          href={item.href}
          target="_blank"
          rel="noreferrer noopener"
          className="border-line text-chalk focus-visible:outline-sel-line min-h-11 border px-4 py-3 text-small hover:bg-panel-2 focus-visible:outline-2 focus-visible:-outline-offset-2"
        >
          {label('product.gallery.video.link')}
        </a>
      );
    }

    return (
      <div className="aspect-video max-h-[60vh] w-full self-stretch">
        <iframe
          src={item.embedUrl}
          title={label('product.gallery.video.title')}
          loading="lazy"
          /*
           * ⛔ `allow` names exactly what the player needs and nothing else. The default is
           * every permission this page holds, and a product video has no business asking for
           * a camera. `referrerpolicy` keeps the customer's path out of the third party's log.
           */
          allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture; fullscreen"
          referrerPolicy="strict-origin-when-cross-origin"
          className="border-line size-full border"
        />
      </div>
    );
  }

  return (
    /* eslint-disable-next-line @next/next/no-img-element -- the API is a different origin
       and serves already-sized files; `next/image` would need it in `remotePatterns` and
       would proxy every byte through the storefront for no gain here. */
    <img
      src={`${base}${item.path}`}
      alt=""
      /*
       * ⚠️ Empty `alt`, deliberately. `media_objects.alt_text_th` exists and is editable, but
       * it is not on the catalogue document — only the path is (see 0052: the reference
       * between the ledger and the catalogue is exactly one string) — so this component does
       * not have it. An invented alt ("รูปสินค้า 2") is worse than none: a screen reader
       * announcing three of those has been given nothing and made to say something. The
       * first picture is not decorative and should carry the product's name; wiring the real
       * alt text through the document is the follow-up, and it is named in the commit.
       */
      loading={imageIndex === 0 ? 'eager' : 'lazy'}
      decoding="async"
      /*
       * ⚠️ `max-w-full`, never `w-full`. `w-full` *upscales* — a 240 px photograph stretched
       * to the column width is a blurred rectangle, and the shop looks broken rather than
       * empty. `max-h` keeps a tall picture from doing the same thing vertically. Together
       * they mean a picture is shown at its own size, or smaller, and never larger.
       */
      className="border-line max-h-[60vh] max-w-full border object-contain"
    />
  );
}
