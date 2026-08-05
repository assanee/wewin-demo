import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Readable, pipeline } from 'node:stream';
import { promisify } from 'node:util';

import { AllowAnonymous } from '../../rbac';
import { contentTypeForKey, extensionForKey } from './slip-storage';
import { SlipsService } from './slips.service';

const pipe = promisify(pipeline);

/**
 * `GET /payments/slip-images/:grant` — the bytes, to whoever holds a valid grant.
 *
 * ── Why this route is anonymous, said plainly ────────────────────────────────────
 *
 * It is the one route in this feature with no principal, and the reason is not the one that
 * makes `GET /media/:id` anonymous. A product photograph is meant to be seen; a photograph
 * of somebody's bank transfer is not. What makes this route work is that **the grant is the
 * credential**: an unforgeable MAC over one slip id, one storage key, one purpose and an
 * expiry minutes away, minted only for a caller who passed the scoped ownership check on
 * `POST /payments/slips/:id/image-grant`.
 *
 * This is the same arrangement as an S3 presigned URL and it carries the same property,
 * which is stated rather than glossed: **anybody holding the URL can fetch it until it
 * expires.** It exists because a browser attaches no `Authorization` header to an `<img>`
 * request, so a private image behind a bearer token cannot be rendered by the dashboard
 * without pulling the whole file into a blob. Plan 7.6 asks for short-lived audited URLs by
 * name; this is that, and the audit is a log line — the missing durable access table is
 * reported in `SlipsService.mintGrant`.
 *
 * Nothing below the signature check is trusted from the token. The slip is re-read, and its
 * `storage_key` must still match the one that was signed, so a grant minted a minute before
 * a PDPA erasure is dead the moment the erasure commits.
 *
 * ── Serving user-supplied bytes back to browsers ─────────────────────────────────
 *
 * Every header is load-bearing and every one of them is the argument
 * `src/media/media.controller.ts` makes, with one deliberate difference:
 *
 *   **`Cache-Control: private, no-store`**, where the media route says `public, immutable`.
 *   A product image is public and content-addressed; this is one customer's bank details on
 *   a URL that expires, and a shared cache holding it is the URL outliving its own expiry.
 *
 *   **Content-Type comes from the stored key**, which came from reading the magic bytes at
 *   upload — never from the request, never from a filename, never from a guess.
 *
 *   **`X-Content-Type-Options: nosniff`** stops the browser second-guessing that. The stored
 *   type is only a defence if the browser is made to honour it.
 *
 *   **`Content-Security-Policy: default-src 'none'; sandbox`** is the belt to that braces:
 *   if something ever were interpreted as a document, it would load nothing, run no script,
 *   and sit in a unique opaque origin.
 *
 *   **`Cross-Origin-Resource-Policy: cross-origin`** is what *allows* the legitimate use.
 *   The dashboard is a different origin, and a browser enforcing COEP there would otherwise
 *   refuse to render the image at all. It does not weaken anything the grant protects: the
 *   URL is still required, and a page that has the URL can already fetch it.
 *
 *   **`Content-Disposition`** is the entire difference between the two purposes plan 7.6
 *   asks to separate — `inline` for a review screen, `attachment` for a copy somebody keeps.
 *   The filename is built from the slip's uuid and the key's own extension, both
 *   server-controlled and both matching a character class narrow enough that there is
 *   nothing to inject.
 */
@Controller('payments/slip-images')
export class SlipImagesController {
  constructor(private readonly slips: SlipsService) {}

  @Get(':grant')
  @AllowAnonymous(
    'the grant IS the credential: an unforgeable, minutes-long MAC over one slip and one purpose, ' +
      'minted only for a caller who passed the scoped ownership check — a browser sends no bearer token with an <img>',
  )
  async serve(@Param('grant') grant: string, @Res() response: Response): Promise<void> {
    const { claims, object } = await this.slips.openImage(grant);

    response.setHeader('Content-Type', contentTypeForKey(claims.storageKey));
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    response.setHeader(
      'Content-Disposition',
      claims.kind === 'download'
        ? `attachment; filename="slip-${claims.slipId}.${extensionForKey(claims.storageKey)}"`
        : 'inline',
    );

    if (object.contentLength !== undefined) {
      response.setHeader('Content-Length', String(object.contentLength));
    }

    /*
     * `pipeline` and not `for await … res.write()`: it is what propagates backpressure from
     * a slow client to the object store and, more importantly here, what destroys both ends
     * when either side fails. A reviewer who closes the tab mid-image otherwise leaves the
     * upstream response open, holding a connection to the store until it times out.
     */
    await pipe(Readable.from(object.body), response);
  }
}
