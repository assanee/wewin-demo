'use client';

import { useState, type ReactElement } from 'react';

import type { GalleryItem } from '../../lib/catalog/gallery';

/**
 * ⭐ The product gallery — one picture at a time, with the rest as thumbnails.
 *
 * ── What this replaces, and why ─────────────────────────────────────────────────
 *
 * The first version rendered every item as an `<img>` in a column, at each file's own size,
 * and its own comment argued that "pictures in a column the browser lazy-loads is the entire
 * feature". Seen with three real items it is not a gallery: a tall photograph, then two small
 * rectangles, stacked down the page at three different widths, pushing the elevation drawing
 * and the configurator below the fold. Nothing about it reads as one product's pictures.
 *
 * So it grows the client child that note said it would grow "the day somebody asks". A fixed
 * viewport with a thumbnail strip is the shape every shop uses for the same reason: the
 * pictures stop competing with each other for size, and the page below them stops moving.
 *
 * ⚠️ The viewport is a fixed 4:3 box and every picture is `object-contain` inside it. Product
 * photographs here will be portrait windows and landscape louvres in the same gallery, and
 * `cover` would crop somebody's product to fit a frame this file chose. Letterboxing shows
 * the whole thing; cropping quietly hides part of what is being sold.
 *
 * ⚠️ A video is letterboxed inside that same box rather than resizing it. Switching between
 * a photo and a video must not move the configurator underneath — a page that jumps when a
 * thumbnail is pressed is a page people stop pressing thumbnails on.
 */
export function GalleryViewer({
  items,
  base,
  labels,
}: {
  readonly items: readonly GalleryItem[];
  /** The API origin. Paths on the wire are relative — see `media-api.ts`. */
  readonly base: string;
  readonly labels: {
    readonly sectionTh: string;
    readonly videoTitleTh: string;
    readonly videoLinkTh: string;
    /** One resolved label per item, in the same order — see `ProductGallery`. */
    readonly showTh: readonly string[];
  };
}): ReactElement | null {
  const [shown, setShown] = useState(0);
  if (items.length === 0) return null;

  const active = items[Math.min(shown, items.length - 1)];
  if (active === undefined) return null;

  return (
    <section aria-label={labels.sectionTh} /* Width comes from the column it sits in — see `ConfiguratorIsland`. */
      className="flex w-full flex-col gap-3">
      <div className="border-line bg-panel-2 flex aspect-[4/3] w-full items-center justify-center overflow-hidden border">
        {active.kind === 'video' ? <VideoFrame item={active} labels={labels} /> : (
          /* eslint-disable-next-line @next/next/no-img-element -- the API is a different
             origin and serves already-sized files; `next/image` would need it in
             `remotePatterns` and would proxy every byte through the storefront. */
          <img
            src={`${base}${active.path}`}
            alt=""
            /*
             * ⚠️ Only the first picture is eager. The others are behind a thumbnail press,
             * so loading them up front spends a customer's bandwidth on pictures most of
             * them never look at.
             */
            loading={shown === 0 ? 'eager' : 'lazy'}
            decoding="async"
            className="size-full object-contain"
          />
        )}
      </div>

      {/*
       * One item needs no thumbnails: a strip of one is a control that cannot do anything,
       * and it takes vertical space from the product below it.
       */}
      {items.length > 1 && (
        <ul className="flex flex-wrap gap-2">
          {items.map((item, index) => (
            <li key={keyOf(item)}>
              <button
                type="button"
                onClick={() => setShown(index)}
                /*
                 * `aria-current` rather than `aria-selected`: this is a set of links to
                 * views of one thing, not a tablist, and claiming the tab pattern without
                 * its keyboard behaviour is worse than not claiming it.
                 */
                aria-current={index === shown}
                aria-label={labels.showTh[index]}
                className={`focus-visible:outline-sel-line bg-panel-2 flex size-16 items-center justify-center overflow-hidden border focus-visible:outline-2 focus-visible:-outline-offset-2 ${
                  index === shown ? 'border-sel-line' : 'border-line hover:border-chalk-3'
                }`}
              >
                {item.kind === 'video' ? (
                  <PlayGlyph />
                ) : (
                  /* eslint-disable-next-line @next/next/no-img-element -- see above. */
                  <img
                    src={`${base}${item.path}`}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="size-full object-cover"
                  />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const keyOf = (item: GalleryItem): string =>
  item.kind === 'video' ? `video:${item.href}` : `image:${item.path}`;

function VideoFrame({
  item,
  labels,
}: {
  readonly item: Extract<GalleryItem, { kind: 'video' }>;
  readonly labels: { readonly videoTitleTh: string; readonly videoLinkTh: string };
}): ReactElement {
  if (item.embedUrl === null) {
    /*
     * An http(s) link that is not a recognised player — see `gallery.ts` for why an
     * unrecognised host never gets an `<iframe>`. `noreferrer` because this is a third party
     * with no reason to be handed the customer's path through the shop.
     */
    return (
      <a
        href={item.href}
        target="_blank"
        rel="noreferrer noopener"
        className="border-line text-chalk focus-visible:outline-sel-line hover:bg-panel min-h-11 border px-4 py-3 text-small focus-visible:outline-2 focus-visible:-outline-offset-2"
      >
        {labels.videoLinkTh}
      </a>
    );
  }

  return (
    <div className="aspect-video w-full">
      <iframe
        src={item.embedUrl}
        title={labels.videoTitleTh}
        loading="lazy"
        /*
         * ⛔ `allow` names exactly what a player needs. The default is every permission this
         * page holds, and a product video has no business asking for a camera.
         */
        allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture; fullscreen"
        referrerPolicy="strict-origin-when-cross-origin"
        className="size-full border-0"
      />
    </div>
  );
}

/** A play mark for the video's thumbnail. */
function PlayGlyph(): ReactElement {
  /*
   * ⚠️ Drawn, not fetched. YouTube serves a thumbnail for every video, and using it would
   * put a request to a Google host on this page before anybody pressed play — which is the
   * exact cost `youtube-nocookie` was chosen to avoid in the first place.
   */
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="text-chalk-2 size-6">
      <path fill="currentColor" d="M8 5v14l11-7z" />
    </svg>
  );
}
