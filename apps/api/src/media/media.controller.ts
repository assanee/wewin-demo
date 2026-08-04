import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Readable, pipeline } from 'node:stream';
import { promisify } from 'node:util';

import { AllowAnonymous } from '../rbac';
import { MediaService } from './media.service';

const pipe = promisify(pipeline);

/**
 * `GET /media/:id` — the bytes, to anyone.
 *
 * This is the only route in the media feature with no permission, and the reason is the same
 * one that makes `GET /catalog/products` anonymous: the storefront is the funnel, a product
 * page has to render for a visitor who has never signed in, and an image behind a session is
 * not an image on a product page. The URL is unguessable (a v4 uuid) but that is not a
 * security control and is not treated as one — everything uploaded here is company product
 * imagery meant to be seen.
 *
 * ── Serving user-supplied bytes back to browsers ──────────────────────────────
 *
 * Every header below is load-bearing. The threat is not hypothetical: an upload endpoint
 * hands an attacker control of a file's contents, and if the browser can be persuaded to
 * interpret that file as a *document* rather than an image, it runs in this API's origin —
 * where the session cookie lives.
 *
 *   **Content-Type comes from the stored row**, which came from reading the bytes at upload
 *   (image/index.ts). Never from the request, never from a filename, never from a guess.
 *
 *   **X-Content-Type-Options: nosniff** stops the browser from second-guessing that. Without
 *   it, Internet Explorer's old sniffing behaviour and its modern descendants will happily
 *   decide that a file beginning with `<html>` is HTML whatever the header said. The stored
 *   type is only a defence if the browser is made to honour it.
 *
 *   **Content-Security-Policy: default-src 'none'; sandbox** is the belt to that braces. If
 *   something ever *did* get interpreted as a document, it would load nothing, run no
 *   script, and sit in a unique opaque origin. It costs nothing on an actual image.
 *
 *   **Content-Disposition: inline, with no filename.** A filename in a header is a header
 *   injection surface and an encoding problem in two directions; the browser does not need
 *   one to render an `<img>`, and the dashboard already knows the name from the API.
 *
 *   **Cross-Origin-Resource-Policy: cross-origin** is what *allows* a legitimate use: the
 *   storefront and the dashboard are different origins from this one, and without it a
 *   browser enforcing COEP on those pages refuses to render the image at all.
 *
 * ── Caching ───────────────────────────────────────────────────────────────────
 *
 * The bytes at a given id can never change — the row that names them is frozen by a trigger
 * (0005_media.sql) and the key is the content's own hash — so `immutable` is a fact rather
 * than an optimistic claim, and the ETag is the checksum. A conditional request is answered
 * 304 before the object store is touched at all.
 *
 * ── What this route is not ────────────────────────────────────────────────────
 *
 * It is not a CDN and it is not a resizer. Every request proxies the full object through
 * this process, which is correct for a catalogue of tens of images and wrong for a busy
 * storefront; the intended production shape is a CDN in front of this path, which the
 * cache headers here are already written for. There is also no `Range` support: browsers do
 * not range-request images, and adding it would mean the object store's own range semantics
 * leaking through a route that currently has none.
 */
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get(':mediaId')
  @AllowAnonymous(
    'product imagery is the storefront funnel — a published product page must render for a visitor who has never signed in',
  )
  async serve(
    @Param('mediaId') mediaId: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const { row, object } = await this.media.open(mediaId);
    const etag = `"${row.checksumSha256}"`;

    response.setHeader('Content-Type', row.contentType);
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    response.setHeader('ETag', etag);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    response.setHeader('Content-Disposition', 'inline');

    if (matchesEtag(request.headers['if-none-match'], etag)) {
      response.status(304).end();
      return;
    }

    response.setHeader('Content-Length', String(row.byteSize));

    /*
     * `pipeline` and not `for await … res.write()`: it is what propagates backpressure from
     * a slow client to the object store, and — more importantly here — what destroys both
     * ends when either side fails. A browser that navigates away mid-image otherwise leaves
     * the upstream response open, holding a connection to the store for as long as it takes
     * to time out.
     */
    await pipe(Readable.from(object.body), response);
  }
}

/**
 * `If-None-Match` may carry a list, and may carry `W/`-prefixed weak tags.
 *
 * Handled by hand rather than with `response.set('ETag')` + Express's own `fresh` check,
 * because Express only applies that to the responses it generates itself, and this one is
 * a stream it never sees the body of.
 */
function matchesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .some((candidate) => candidate === etag || candidate === '*');
}
