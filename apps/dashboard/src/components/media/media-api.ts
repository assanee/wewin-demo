import 'client-only';

import { apiFetch, apiJson } from '@/lib/api/client';
import { apiErrorFromResponse } from '@/lib/api/errors';

/**
 * Every call the media screen makes.
 *
 * ── These types are declared here, and that is a debt rather than a design ───────
 *
 * `MediaObjectWire` and friends live in `apps/api/src/media/media.contract.ts`, not in
 * `@wewin/contract`. The dashboard may not import from apps/api — `turbo boundaries`
 * enforces that and should — so the shapes are restated below and the decoders check them
 * at runtime, which is what keeps a rename from becoming `undefined` three components deep.
 *
 * ⚠️ It is still two declarations of one shape. The right fix is moving the media contract
 * into `@wewin/contract` beside `admin.ts`, which is a change to a package two other things
 * import and is not this screen's to make on its way past. Recorded in the plan.
 */

export interface MediaReference {
  readonly productId: string;
  readonly productNameTh: string;
  readonly version: number;
  readonly status: 'draft' | 'published' | 'archived';
}

export interface MediaUsage {
  /** Non-empty means the object **cannot be deleted** — a frozen document cites it. */
  readonly frozen: readonly MediaReference[];
  /** Drafts do not block deletion; they dangle, visibly, in the product editor. */
  readonly drafts: readonly MediaReference[];
}

export interface MediaObject {
  readonly id: string;
  /** Relative on purpose — see the contract. Prefix with the API base to display it. */
  readonly path: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
  readonly checksumSha256: string;
  readonly originalFilename: string | null;
  readonly altTextTh: string | null;
  readonly createdAt: string;
  readonly usage: MediaUsage;
}

export interface MediaList {
  readonly items: readonly MediaObject[];
  readonly nextCursor: string | null;
}

export interface MediaUploadResult {
  readonly media: MediaObject;
  /** True when these exact bytes were already stored and somebody else's row came back. */
  readonly deduplicated: boolean;
  /** Which metadata containers were removed. Empty for a file that carried none. */
  readonly stripped: readonly string[];
}

const asArray = (value: unknown, what: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new TypeError(`${what}: expected an array`);
  return value;
};

const decodeReference = (raw: unknown): MediaReference => {
  const row = raw as Record<string, unknown>;
  if (typeof row['productId'] !== 'string') throw new TypeError('reference: no productId');
  return {
    productId: row['productId'],
    productNameTh: String(row['productNameTh'] ?? ''),
    version: Number(row['version'] ?? 0),
    status: row['status'] as MediaReference['status'],
  };
};

function decodeMedia(raw: unknown): MediaObject {
  if (typeof raw !== 'object' || raw === null) throw new TypeError('media: not an object');
  const row = raw as Record<string, unknown>;

  for (const key of ['id', 'path', 'contentType', 'checksumSha256', 'createdAt']) {
    if (typeof row[key] !== 'string') throw new TypeError(`media: ${key} is not a string`);
  }
  const usage = (row['usage'] ?? {}) as Record<string, unknown>;

  return {
    id: row['id'] as string,
    path: row['path'] as string,
    contentType: row['contentType'] as string,
    byteSize: Number(row['byteSize'] ?? 0),
    width: Number(row['width'] ?? 0),
    height: Number(row['height'] ?? 0),
    checksumSha256: row['checksumSha256'] as string,
    originalFilename: (row['originalFilename'] as string | null) ?? null,
    altTextTh: (row['altTextTh'] as string | null) ?? null,
    createdAt: row['createdAt'] as string,
    usage: {
      frozen: asArray(usage['frozen'] ?? [], 'usage.frozen').map(decodeReference),
      drafts: asArray(usage['drafts'] ?? [], 'usage.drafts').map(decodeReference),
    },
  };
}

export const listMedia = (cursor?: string): Promise<MediaList> =>
  apiJson(
    `/admin/media?limit=50${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
    (body) => {
      const row = body as Record<string, unknown>;
      return {
        items: asArray(row['items'] ?? [], 'items').map(decodeMedia),
        nextCursor: (row['nextCursor'] as string | null) ?? null,
      };
    },
  );

/**
 * Upload one image.
 *
 * ⚠️ **The bytes are the body — this is not `multipart/form-data`.** The endpoint reads the
 * request stream directly and bounds it at `MEDIA_MAX_BYTES`, which is why a `FormData`
 * here would arrive as a multipart envelope the server would refuse as the wrong content
 * type. The `File` goes on the wire as itself.
 *
 * `X-Upload-Filename` is **percent-encoded**, because headers are latin-1 on the wire and a
 * Thai filename would otherwise throw in `fetch` before the request left the browser. The
 * API decodes it and drops it silently if it will not decode — the filename is decoration
 * and no upload should fail over one.
 */
export async function uploadMedia(file: File): Promise<MediaUploadResult> {
  const response = await apiFetch('/admin/media', {
    method: 'POST',
    headers: {
      'Content-Type': file.type === '' ? 'application/octet-stream' : file.type,
      'X-Upload-Filename': encodeURIComponent(file.name),
    },
    body: file,
  });

  if (!response.ok) throw await apiErrorFromResponse(response);

  const body = (await response.json()) as Record<string, unknown>;
  return {
    media: decodeMedia(body['media']),
    /*
     * 200 rather than 201 is the *other* signal that these bytes were already here, and the
     * body's own flag is the one read: a status code is easy to lose behind a wrapper, and
     * the difference matters — on a duplicate, the row that comes back carries whoever
     * uploaded it first's alt text, not this person's filename.
     */
    deduplicated: body['deduplicated'] === true,
    stripped: asArray(body['stripped'] ?? [], 'stripped').map(String),
  };
}

export const updateMediaAltText = (mediaId: string, altTextTh: string | null): Promise<MediaObject> =>
  apiJson(`/admin/media/${encodeURIComponent(mediaId)}`, decodeMedia, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ altTextTh }),
  });

/**
 * Delete an object.
 *
 * The API refuses when a *frozen* version cites it — plan section 5's freeze covers the
 * picture as much as the price, because the document a customer was shown is what the
 * company has to be able to reproduce. The screen checks `usage.frozen` and does not offer
 * the button, so this call's refusal is a backstop and not the user experience.
 */
export async function deleteMedia(mediaId: string): Promise<void> {
  const response = await apiFetch(`/admin/media/${encodeURIComponent(mediaId)}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw await apiErrorFromResponse(response);
}
