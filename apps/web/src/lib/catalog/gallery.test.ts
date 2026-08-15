import { describe, expect, it } from 'vitest';

import { embedUrlOf, galleryItems, type ProductMedia } from './gallery';

const media = (over: Partial<ProductMedia> = {}): ProductMedia => ({
  images: [],
  videoUrl: null,
  heroImage: '/products/casement.svg',
  ...over,
});

describe('turning a video link into a player', () => {
  it('recognises the YouTube shapes people paste', () => {
    const player = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ';

    expect(embedUrlOf('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(player);
    expect(embedUrlOf('https://youtube.com/watch?v=dQw4w9WgXcQ&t=30')).toBe(player);
    expect(embedUrlOf('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(player);
    expect(embedUrlOf('https://youtu.be/dQw4w9WgXcQ')).toBe(player);
    expect(embedUrlOf('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe(player);
  });

  it('recognises Vimeo', () => {
    expect(embedUrlOf('https://vimeo.com/123456789')).toBe('https://player.vimeo.com/video/123456789');
    expect(embedUrlOf('https://player.vimeo.com/video/123456789')).toBe(
      'https://player.vimeo.com/video/123456789',
    );
  });

  it('⛔ refuses to frame anything else', () => {
    /*
     * The whole point of the function. An `<iframe>` puts a third-party document inside this
     * page; the contract stops `javascript:` from ever being stored, but nothing stops a
     * staff member from pasting a link to an ordinary web page, and a page that framed it
     * would be framing whatever that page does. Unrecognised means a link, not a player.
     */
    for (const other of [
      'https://example.com/our-video.mp4',
      'https://not-youtube.com/watch?v=abc',
      'https://vimeo.com/about',
      'https://www.youtube.com/watch?v=',
      'https://youtu.be/',
      'not a url at all',
    ]) {
      expect(embedUrlOf(other), other).toBeNull();
    }
  });

  it('⛔ refuses a host that merely mentions youtube', () => {
    expect(embedUrlOf('https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(embedUrlOf('https://evil.example/?x=youtube.com/watch?v=abc')).toBeNull();
  });
});

describe('what a product page shows', () => {
  it('⭐ puts the video first, then the pictures in their order', () => {
    const items = galleryItems(
      media({ images: ['/media/a', '/media/b'], videoUrl: 'https://youtu.be/dQw4w9WgXcQ' }),
    );

    expect(items).toHaveLength(3);
    expect(items[0]?.kind).toBe('video');
    expect(items[1]).toStrictEqual({ kind: 'image', path: '/media/a' });
    expect(items[2]).toStrictEqual({ kind: 'image', path: '/media/b' });
  });

  it('keeps the picture order exactly as given — order is content', () => {
    const items = galleryItems(media({ images: ['/media/b', '/media/a'] }));
    expect(items.map((item) => (item.kind === 'image' ? item.path : 'video'))).toStrictEqual([
      '/media/b',
      '/media/a',
    ]);
  });

  it('a video with no pictures is still a gallery of one', () => {
    const items = galleryItems(media({ videoUrl: 'https://vimeo.com/123456789' }));
    expect(items).toHaveLength(1);
    expect(items[0]).toStrictEqual({
      kind: 'video',
      embedUrl: 'https://player.vimeo.com/video/123456789',
      href: 'https://vimeo.com/123456789',
    });
  });

  it('an unrecognised link is carried as a link, not dropped', () => {
    const items = galleryItems(media({ videoUrl: 'https://example.com/v.mp4' }));
    expect(items[0]).toStrictEqual({
      kind: 'video',
      embedUrl: null,
      href: 'https://example.com/v.mp4',
    });
  });

  it('⛔ never falls back to heroImage — those 81 files do not exist', () => {
    /*
     * Every seeded product carries `/products/<slug>.svg` and not one of those files is in
     * the repository. A fallback would put 81 broken-image icons on the storefront, which is
     * worse than the nothing there today: nothing is invisible, a broken icon is a bug.
     */
    expect(galleryItems(media())).toStrictEqual([]);
    expect(galleryItems(media({ heroImage: '/products/anything.svg' }))).toStrictEqual([]);
  });

  it('shows nothing at all when the fetch failed', () => {
    expect(galleryItems(null)).toStrictEqual([]);
  });
});
