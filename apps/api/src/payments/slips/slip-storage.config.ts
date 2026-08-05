import { z } from 'zod';

import { parseMediaConfig, MediaConfigError, type MediaConfig } from '../../media/media.config';
import { mintGrantKey } from './slip-grant';

/**
 * Where slip images live, and the key that signs the URLs to them.
 *
 * Parsed in this directory rather than in `src/config/env.ts`, on the precedent and for the
 * reason `media.config.ts` and `oauth.config.ts` both give: `Env` is frozen, logged in
 * parts and handed whole to every module in the graph, and a signing key belongs in none of
 * those places.
 *
 * ── A different bucket from the product imagery, and why that matters ────────────
 *
 * The endpoint, region, credentials and addressing style are the media module's — one
 * object store, configured once. **The bucket is not.** `src/media/media.controller.ts`
 * serves `GET /media/:id` to anybody with no permission at all, which is correct for a
 * product photograph and is the exact opposite of what a photograph of somebody's bank
 * transfer needs. That route serves by `media_objects.id` and a slip has no such row, so
 * sharing a bucket would not actually expose one today — but "not reachable today" is a
 * property of one controller, and the separation should be a property of the deployment.
 * A private bucket is one bucket policy away from being genuinely private; a shared bucket
 * is one route away from not being.
 *
 * ── The variables ───────────────────────────────────────────────────────────────
 *
 *   PAYMENT_SLIP_STORAGE_BUCKET   wewin-slips   must not be the media bucket, and the parse
 *                                               refuses it if it is
 *   PAYMENT_SLIP_MAX_BYTES        8388608       8 MiB, counted as the bytes arrive
 *   PAYMENT_SLIP_GRANT_SECRET     —             required in production; see below
 */

const positiveInt = (fallback: number) =>
  z
    .string()
    .regex(/^\d+$/, 'must be a whole number')
    .transform(Number)
    .refine((value) => value > 0, { message: 'must be greater than zero' })
    .default(fallback);

const schema = z.object({
  PAYMENT_SLIP_STORAGE_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'must be a valid S3 bucket name')
    .default('wewin-slips'),
  PAYMENT_SLIP_MAX_BYTES: positiveInt(8 * 1024 * 1024),
  /**
   * 32 bytes or more of base64url, and **required in production**.
   *
   * Outside production a fresh key is minted per process, which is a deliberate and stated
   * trade: grants do not survive a restart and do not work across two instances. Both are
   * fine for a laptop and for a test suite, and both are unacceptable behind a load
   * balancer — which is why production has no fallback at all, exactly as `main.ts` has
   * none for `AUTH_ACCESS_TOKEN_SECRET`. A default signing key is a signing key in the
   * repository.
   */
  PAYMENT_SLIP_GRANT_SECRET: z.string().min(32).optional(),
});

export interface SlipStorageConfig {
  /** Endpoint, region, credentials and addressing — the media module's, with our bucket. */
  readonly storage: MediaConfig;
  readonly maxBytes: number;
  readonly grantKey: Buffer;
}

export function parseSlipStorageConfig(source: Record<string, string | undefined>): SlipStorageConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new MediaConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`),
    );
  }

  /*
   * Reusing the media parse is what keeps one object store one object store. It also means
   * a production deployment that has set `MEDIA_STORAGE_*` correctly has already set
   * everything here except the bucket and the signing key.
   */
  const storage = parseMediaConfig(source);
  const bucket = parsed.data.PAYMENT_SLIP_STORAGE_BUCKET;

  if (bucket === storage.bucket) {
    throw new MediaConfigError([
      'PAYMENT_SLIP_STORAGE_BUCKET must not be MEDIA_STORAGE_BUCKET. Product imagery is served to ' +
        'anonymous callers by GET /media/:id; a photograph of a customer\'s bank transfer is not, and ' +
        'the two must not share a bucket policy.',
    ]);
  }

  const production = source['NODE_ENV'] === 'production';
  const secret = parsed.data.PAYMENT_SLIP_GRANT_SECRET;

  if (production && secret === undefined) {
    throw new MediaConfigError([
      'PAYMENT_SLIP_GRANT_SECRET is required in production. Without it every process signs slip image ' +
        'URLs with a key of its own, so a grant minted by one instance is rejected by the next.',
    ]);
  }

  return {
    storage: { ...storage, bucket },
    maxBytes: parsed.data.PAYMENT_SLIP_MAX_BYTES,
    grantKey: secret === undefined ? mintGrantKey() : Buffer.from(secret, 'utf8'),
  };
}
