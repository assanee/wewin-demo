import type { ReactElement } from 'react';

import { localeBundle } from '../../i18n/server';
import type { Locale } from '../../i18n/locales';
import { galleryItems } from '../../lib/catalog/gallery';
import { loadProductMedia } from '../../lib/catalog/media-api';
import { reviewsApiBaseUrl } from '../../lib/reviews/api';
import { GalleryViewer } from './GalleryViewer';

/**
 * ⭐ 0052. The pictures on a product page — video first, then the gallery in its order.
 *
 * The fetch, and the decision to show anything at all, live here on the server; the viewing
 * lives in `GalleryViewer`, the client half. The split is the usual one: this component
 * talks to the API and holds the locale bundle, and only what a person can *press* crosses
 * into the browser.
 *
 * ── It is usually not there, and that is the same decision `ReviewBlock` made ────
 *
 * Eighty-one seeded products have no gallery, so this renders `null` on all of their pages
 * until somebody attaches a picture in the dashboard. No placeholder, no "รูปเร็ว ๆ นี้", no
 * broken-image icon from the `heroImage` paths — which point at 81 `.svg` files that are not
 * in this repository. Silence says nothing; an empty state says something, and what it would
 * say here is "this shop has no photographs of its products".
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

  return (
    <GalleryViewer
      items={items}
      base={reviewsApiBaseUrl() ?? ''}
      /*
       * ⚠️ The strings are resolved here, not in the client half. `t` is the compiled locale
       * bundle for all eight languages; handing it across the boundary would ship every
       * catalogue to the browser to render four labels.
       */
      labels={{
        sectionTh: t('product.gallery.label'),
        videoTitleTh: t('product.gallery.video.title'),
        videoLinkTh: t('product.gallery.video.link'),
        /*
         * ⛔ A resolved string per item, not a function. React refuses to serialise a
         * function across this boundary — and the comment above already said the strings
         * were resolved here, while the code passed a closure that would have had to run in
         * the browser with a bundle it does not have. The count is known on this side.
         */
        showTh: items.map((_item, index) => t('product.gallery.show', { position: index + 1 })),
      }}
    />
  );
}
