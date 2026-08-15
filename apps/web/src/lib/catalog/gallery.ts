/**
 * ⭐ 0052. What a product page shows, in the order it shows it.
 *
 * ── The video comes first, and that is the owner's decision ──────────────────────
 *
 * Asked directly, the answer was: one video, attached as a link, and *first* in the list of
 * pictures. So it is not a separate block below the gallery — it is item 1, and the pictures
 * follow it.
 *
 * ── Only two hosts get an `<iframe>` ─────────────────────────────────────────────
 *
 * ⛔ Embedding whatever URL a staff member typed would put an arbitrary third-party document
 * inside this page, with whatever that document decides to do. The contract already refuses
 * anything that is not http(s) — that is the check that stops `javascript:` — but
 * `https://anything.example/` is still a page we would be framing.
 *
 * So a link is only ever framed when it is recognisably a YouTube or Vimeo *player* URL,
 * which is what the owner said the videos are. Anything else is rendered as a link out. The
 * failure mode of being wrong is a visible link instead of a player; the failure mode of the
 * permissive version is an iframe nobody chose.
 *
 * ⚠️ `youtube-nocookie.com` rather than `youtube.com`: same player, and it does not write a
 * tracking cookie until somebody actually presses play. The storefront has a consent banner
 * for exactly this class of thing and a product video should not be the one component that
 * quietly opts out of it.
 */

export interface GalleryVideo {
  readonly kind: 'video';
  /** Set when the link is a recognised player and may be framed. `null` means link out. */
  readonly embedUrl: string | null;
  readonly href: string;
}

export interface GalleryImage {
  readonly kind: 'image';
  /** Relative, as the API stores it — the caller prefixes the API base to display it. */
  readonly path: string;
}

export type GalleryItem = GalleryVideo | GalleryImage;

export interface ProductMedia {
  readonly images: readonly string[];
  readonly videoUrl: string | null;
  readonly heroImage: string;
}

/**
 * A YouTube or Vimeo watch link → the URL of its player, or `null` for everything else.
 *
 * Exported for its test. The parsing is deliberately narrow: the id has to be present, in
 * the shape that host uses, and nothing is guessed from a URL that merely mentions the host.
 */
export function embedUrlOf(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const host = url.hostname.replace(/^www\./u, '');

  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    const id = url.searchParams.get('v');
    /* `/embed/<id>` is already a player URL; normalised to the no-cookie host all the same. */
    const embedded = /^\/embed\/([A-Za-z0-9_-]{6,})$/u.exec(url.pathname)?.[1];
    const chosen = id !== null && /^[A-Za-z0-9_-]{6,}$/u.test(id) ? id : embedded;
    return chosen === undefined || chosen === null
      ? null
      : `https://www.youtube-nocookie.com/embed/${chosen}`;
  }

  if (host === 'youtu.be') {
    const id = url.pathname.slice(1);
    return /^[A-Za-z0-9_-]{6,}$/u.test(id)
      ? `https://www.youtube-nocookie.com/embed/${id}`
      : null;
  }

  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = /(?:^|\/)(\d{6,})(?:$|\/|\?)/u.exec(url.pathname)?.[1];
    return id === undefined ? null : `https://player.vimeo.com/video/${id}`;
  }

  return null;
}

/**
 * Everything to show for one product, in order: the video, then the pictures.
 *
 * ⚠️ `heroImage` is **not** appended when a gallery exists. It is the picture that stands
 * for the product in a list, and the gallery is what the product looks like; a hero that is
 * also in the gallery would show twice, and one that is not would appear at the end for no
 * reason a reader could work out.
 *
 * ⚠️ It is not used as a fallback either. All 81 seeded products carry
 * `/products/<slug>.svg`, and **none of those files exist in this repository** — which is
 * why nothing has ever rendered the field. Falling back to it would put 81 broken-image
 * icons on the storefront, which is worse than the nothing that is there today. A product
 * with no gallery therefore shows no gallery, until somebody attaches a picture in the
 * dashboard, which is the whole point of this round.
 */
export function galleryItems(media: ProductMedia | null): readonly GalleryItem[] {
  if (media === null) return [];

  const items: GalleryItem[] = [];

  if (media.videoUrl !== null && media.videoUrl !== '') {
    items.push({ kind: 'video', embedUrl: embedUrlOf(media.videoUrl), href: media.videoUrl });
  }
  for (const path of media.images) {
    items.push({ kind: 'image', path });
  }

  return items;
}
