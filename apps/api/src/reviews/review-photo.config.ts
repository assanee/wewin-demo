import { z } from 'zod';

import { parseMediaConfig, MediaConfigError, type MediaConfig } from '../media/media.config';

/**
 * Where a customer's photograph of their own window lives.
 *
 * Parsed in this directory rather than in `src/config/env.ts`, on the precedent
 * `media.config.ts`, `oauth.config.ts` and `slip-storage.config.ts` all set: `Env` is
 * frozen, logged in parts and handed whole to every module in the graph.
 *
 * ── A third bucket, and the refusal is the point ─────────────────────────────────
 *
 * The endpoint, region, credentials and addressing style are the media module's — one object
 * store, configured once. **The bucket is neither of the other two**, and the parse refuses
 * to start if it is either:
 *
 *   the media bucket   `GET /media/:id` serves it to anybody with no permission at all.
 *                      That is correct for a product photograph and is precisely wrong for a
 *                      picture taken inside a customer's house. Sharing the bucket would not
 *                      expose one *today* — that route serves by `media_objects.id` and a
 *                      review photo has no such row — but "not reachable today" is a property
 *                      of one controller, and the separation should be a property of the
 *                      deployment.
 *   the slip bucket    a bank transfer and a photograph of a home have different retention
 *                      clocks and different erasure rules (`erase_user()` DELETEs review
 *                      photos outright and does not touch slips), and a bucket policy that
 *                      has to serve both is a policy that serves neither.
 *
 * ── The ceiling is a phone's photograph, not a DSLR's ────────────────────────────
 *
 * ⚠️ Not a plan 13 number. 8 MiB is a generous modern phone JPEG, and it is counted as the
 * bytes arrive rather than read from `Content-Length` (see `readBoundedBody`). Larger than
 * the slip ceiling would buy nothing: nobody needs more detail of a window than of a bank
 * slip, and the memory is this process's.
 */

const positiveInt = (fallback: number) =>
  z
    .string()
    .regex(/^\d+$/, 'must be a whole number')
    .transform(Number)
    .refine((value) => value > 0, { message: 'must be greater than zero' })
    .default(fallback);

const schema = z.object({
  REVIEW_PHOTO_STORAGE_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'must be a valid S3 bucket name')
    .default('wewin-review-photos'),
  REVIEW_PHOTO_MAX_BYTES: positiveInt(8 * 1024 * 1024),
  /** Read only to be refused if it matches. Never used to address anything from here. */
  PAYMENT_SLIP_STORAGE_BUCKET: z.string().default('wewin-slips'),
});

export interface ReviewPhotoConfig {
  /** Endpoint, region, credentials and addressing — the media module's, with our bucket. */
  readonly storage: MediaConfig;
  readonly maxBytes: number;
}

export function parseReviewPhotoConfig(source: Record<string, string | undefined>): ReviewPhotoConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new MediaConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`),
    );
  }

  const storage = parseMediaConfig(source);
  const bucket = parsed.data.REVIEW_PHOTO_STORAGE_BUCKET;

  if (bucket === storage.bucket) {
    throw new MediaConfigError([
      'REVIEW_PHOTO_STORAGE_BUCKET must not be MEDIA_STORAGE_BUCKET. Product imagery is served to ' +
        'anonymous callers by GET /media/:id; a photograph taken inside a customer\'s house is not, ' +
        'and the two must not share a bucket policy.',
    ]);
  }

  if (bucket === parsed.data.PAYMENT_SLIP_STORAGE_BUCKET) {
    throw new MediaConfigError([
      'REVIEW_PHOTO_STORAGE_BUCKET must not be PAYMENT_SLIP_STORAGE_BUCKET. erase_user() DELETEs a ' +
        'review photograph outright and leaves a payment slip alone; one bucket cannot carry two ' +
        'retention rules.',
    ]);
  }

  return { storage: { ...storage, bucket, maxBytes: parsed.data.REVIEW_PHOTO_MAX_BYTES }, maxBytes: parsed.data.REVIEW_PHOTO_MAX_BYTES };
}
