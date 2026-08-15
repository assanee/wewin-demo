import { z } from 'zod';

/**
 * Where the bytes go, parsed in this module rather than in `src/config/env.ts`.
 *
 * Precedent and reason are the same one: `parseOAuthConfig` does exactly this. `Env` is
 * frozen, logged in parts and handed whole to every module in the graph, and a secret access
 * key belongs in none of those places. Keeping the parse here also means the media feature
 * is one directory — delete it and nothing else in the app has a dangling variable.
 *
 * ── The variables ─────────────────────────────────────────────────────────────
 *
 *   MEDIA_STORAGE_ENDPOINT     http://localhost:9110   the compose service, on the host port
 *                                                      docker-compose.yml explains — and it
 *                                                      explains why the port moved off 9100
 *   MEDIA_STORAGE_REGION       us-east-1               MinIO ignores it; SigV4 does not, and
 *                                                      it must match the bucket's real region
 *                                                      in front of AWS
 *   MEDIA_STORAGE_BUCKET       wewin-media
 *   MEDIA_STORAGE_ACCESS_KEY_ID / _SECRET_ACCESS_KEY   see below
 *   MEDIA_STORAGE_PATH_STYLE   true                    `endpoint/bucket/key`, which is what
 *                                                      MinIO serves. AWS S3 wants
 *                                                      `bucket.endpoint/key`; set false there
 *   MEDIA_MAX_BYTES            8388608                 8 MiB, per upload
 *
 * ── Credentials, and the one rule that is not a default ───────────────────────
 *
 * Outside production the credentials fall back to the local compose values, so a fresh
 * checkout runs `pnpm dev` and uploads work. **In production both are required** and the
 * process refuses to boot without them, exactly as main.ts refuses to boot without
 * AUTH_ACCESS_TOKEN_SECRET. A default credential is a credential in the repository, and one
 * that happens to be right on somebody's laptop is how it reaches a real bucket.
 */

const positiveInt = (fallback: number) =>
  z
    .string()
    .regex(/^\d+$/, 'must be a whole number')
    .transform(Number)
    .refine((value) => value > 0, { message: 'must be greater than zero' })
    .default(fallback);

const httpUrl = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'must be an http:// or https:// URL' },
  )
  // Trailing slash removed once, here: every URL this module builds is endpoint + '/' + …
  .transform((value) => value.replace(/\/+$/, ''));

const LOCAL_ACCESS_KEY_ID = 'wewin';
const LOCAL_SECRET_ACCESS_KEY = 'wewin-local';

const schema = z.object({
  /*
   * ⚠️ 9110 since a `dart` dev server was found shadowing 9100 — it binds `127.0.0.1`
   * specifically while Docker publishes on the wildcard, and macOS gives the specific bind
   * priority, so this default reached Flutter's 404 instead of MinIO while `docker compose ps`
   * reported healthy. docker-compose.yml carries the full account. Keep the two in step: this
   * default is what every developer and every test run uses when nobody sets the variable.
   */
  MEDIA_STORAGE_ENDPOINT: httpUrl.default('http://localhost:9110'),
  MEDIA_STORAGE_REGION: z.string().min(1).default('us-east-1'),
  /*
   * The naming rules S3 actually enforces, restated where a typo fails at boot instead of on
   * the first upload: 3–63 characters, lowercase, no underscores, no leading or trailing dot
   * or dash. A bucket name with an uppercase letter is unreachable in virtual-host style
   * because DNS labels are case-insensitive, which is a confusing way to find out.
   */
  MEDIA_STORAGE_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'must be a valid S3 bucket name')
    .default('wewin-media'),
  MEDIA_STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
  MEDIA_STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  MEDIA_STORAGE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /*
   * 8 MiB. Above any product photograph exported at a sane quality, below anything that
   * makes buffering one upload per request worth worrying about. It is a ceiling on bytes
   * *received*, counted as they arrive — see read-body.ts, which does not trust
   * Content-Length.
   */
  MEDIA_MAX_BYTES: positiveInt(8 * 1024 * 1024),
});

export interface MediaConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly pathStyle: boolean;
  readonly maxBytes: number;
}

export class MediaConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(['Invalid media storage configuration:', ...problems.map((problem) => `  - ${problem}`)].join('\n'));
    this.name = 'MediaConfigError';
    this.problems = problems;
  }
}

export function parseMediaConfig(source: Record<string, string | undefined>): MediaConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new MediaConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`),
    );
  }

  const production = source['NODE_ENV'] === 'production';
  const accessKeyId = parsed.data.MEDIA_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = parsed.data.MEDIA_STORAGE_SECRET_ACCESS_KEY;

  if (production && (accessKeyId === undefined || secretAccessKey === undefined)) {
    throw new MediaConfigError([
      'MEDIA_STORAGE_ACCESS_KEY_ID and MEDIA_STORAGE_SECRET_ACCESS_KEY are required in production. ' +
        'The local fallback exists only so a fresh checkout can upload against docker compose.',
    ]);
  }

  return {
    endpoint: parsed.data.MEDIA_STORAGE_ENDPOINT,
    region: parsed.data.MEDIA_STORAGE_REGION,
    bucket: parsed.data.MEDIA_STORAGE_BUCKET,
    accessKeyId: accessKeyId ?? LOCAL_ACCESS_KEY_ID,
    secretAccessKey: secretAccessKey ?? LOCAL_SECRET_ACCESS_KEY,
    pathStyle: parsed.data.MEDIA_STORAGE_PATH_STYLE,
    maxBytes: parsed.data.MEDIA_MAX_BYTES,
  };
}
