import { createSecretKey, type KeyObject } from 'node:crypto';

import { z } from 'zod';

/**
 * Everything this module needs to know, parsed once at boot.
 *
 * It is parsed *here* rather than in src/config/env.ts because the signing key is the one
 * value in this application that must never be copied: `Env` is frozen, logged in parts,
 * and handed whole to every module in the graph. `SessionConfig` holds a `KeyObject`
 * instead of a string, so the key material is inside the crypto subsystem from the moment
 * it is read — `util.inspect`, `JSON.stringify` and a template literal all produce
 * `[object Object]`-shaped noise rather than the secret, which is the difference between a
 * discipline and a property.
 *
 * `parseSessionConfig` takes a plain record for the same reason `parseEnv` does: the
 * failure modes are testable without mutating the process the tests run in.
 */
export interface SessionConfig {
  /** HMAC key for the access token. Never leaves this object. */
  readonly accessTokenKey: KeyObject;
  /** `iss` on every access token, and the value verification requires. */
  readonly issuer: string;
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;
  /** Absolute session lifetime. A session refreshed forever is never re-authenticated. */
  readonly sessionTtlSeconds: number;
  /** Plan 6(c). Roughly 15 seconds; see the note on ACCESS_TOKEN_TTL_DEFAULT_SECONDS. */
  readonly refreshGraceSeconds: number;
}

/**
 * Ten minutes, and the number is a decision rather than a habit.
 *
 * An access token is verified by its signature alone — no database read, which is the
 * entire reason a short-lived bearer token exists next to a long-lived refresh token. The
 * consequence is that revocation is not immediate: when `rotate_refresh_token()` sees a
 * replayed token and revokes the session, or an admin suspends a user, or somebody signs
 * out everywhere, the access tokens already issued keep working until they expire. This
 * number *is* that window, so:
 *
 *   - not 60 minutes. Reuse detection is the point of fix ⓒ; leaving the thief a working
 *     access token for the hour after we detected them makes the detection decorative.
 *   - not 60 seconds. Every expiry is a rotation, and a dashboard with six panels turns
 *     each one into a fan-out of successors (see SessionService.refresh). At ten minutes a
 *     session rotates ~144 times a day; at one minute, ~1440, and `refresh_tokens` becomes
 *     the busiest table in the schema to buy back nine minutes of revocation latency.
 *   - and comfortably larger than the 15-second grace window — by 40× — so that grace stays
 *     what it is for, a burst of parallel requests that all expired at once, rather than
 *     the normal way tokens are used.
 */
export const ACCESS_TOKEN_TTL_DEFAULT_SECONDS = 600;

/** Plan 6(c) says "roughly 15 seconds", and the database function defaults to the same. */
export const REFRESH_GRACE_DEFAULT_SECONDS = 15;

const DAY_SECONDS = 24 * 60 * 60;

/**
 * 32 bytes of entropy, however it is spelled. Base64url of 32 random bytes is 43
 * characters, hex is 64, and a passphrase somebody typed is worth less per character —
 * so the floor is set where a hand-typed value is still uncomfortable and a generated one
 * passes without thought.
 */
const MIN_SECRET_LENGTH = 43;

const wholeSeconds = (fallback: number, minimum: number) =>
  z
    .string()
    .regex(/^\d+$/, 'must be a whole number of seconds')
    .transform(Number)
    .refine((value) => value >= minimum, {
      message: `must be at least ${String(minimum)} second${minimum === 1 ? '' : 's'}`,
    })
    .default(fallback);

export const sessionEnvSchema = z
  .object({
    /*
     * No default, ever. A default signing key is a key that is in the repository, and a
     * key in the repository forges access tokens for every deployment that forgot to set
     * one. Refusing to boot is the correct response.
     */
    AUTH_ACCESS_TOKEN_SECRET: z
      .string()
      .min(MIN_SECRET_LENGTH, `must be at least ${String(MIN_SECRET_LENGTH)} characters of random data`),

    AUTH_TOKEN_ISSUER: z.string().min(1).default('wewin-api'),

    AUTH_ACCESS_TOKEN_TTL_SECONDS: wholeSeconds(ACCESS_TOKEN_TTL_DEFAULT_SECONDS, 30),
    AUTH_REFRESH_TOKEN_TTL_SECONDS: wholeSeconds(30 * DAY_SECONDS, 60),
    AUTH_SESSION_TTL_SECONDS: wholeSeconds(90 * DAY_SECONDS, 60),

    /*
     * Zero is allowed and is not a footgun to be defended against — it is how a test
     * closes the window on demand instead of sleeping. It is a footgun in production, and
     * the cross-check below is where that is said out loud.
     */
    AUTH_REFRESH_GRACE_SECONDS: wholeSeconds(REFRESH_GRACE_DEFAULT_SECONDS, 0),
  })
  .superRefine((value, ctx) => {
    /*
     * The three lifetimes have to nest. A refresh token that outlives its session cannot
     * be inserted at all (`refresh_tokens_within_session` in 0003_auth_guards.sql clamps
     * it), so a configuration that inverts them does not fail — it silently makes the
     * refresh TTL a lie. Better to say so at boot than to have somebody measure it later.
     */
    if (value.AUTH_ACCESS_TOKEN_TTL_SECONDS >= value.AUTH_REFRESH_TOKEN_TTL_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_ACCESS_TOKEN_TTL_SECONDS'],
        message: 'must be shorter than AUTH_REFRESH_TOKEN_TTL_SECONDS, or refreshing achieves nothing',
      });
    }

    if (value.AUTH_REFRESH_TOKEN_TTL_SECONDS > value.AUTH_SESSION_TTL_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_REFRESH_TOKEN_TTL_SECONDS'],
        message:
          'must not exceed AUTH_SESSION_TTL_SECONDS — the database clamps it to the session anyway',
      });
    }

    if (value.AUTH_REFRESH_GRACE_SECONDS >= value.AUTH_ACCESS_TOKEN_TTL_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_REFRESH_GRACE_SECONDS'],
        message:
          'must be well under AUTH_ACCESS_TOKEN_TTL_SECONDS — a grace window as long as the token it protects stops being a window and becomes a second lifetime',
      });
    }
  });

export class SessionConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(['Invalid session configuration:', ...problems.map((problem) => `  - ${problem}`)].join('\n'));
    this.name = 'SessionConfigError';
    this.problems = problems;
  }
}

/**
 * Builds the configuration, or throws with every problem at once.
 *
 * The message is assembled from the path and zod's own text and never from the input, so
 * a mistyped secret cannot arrive in a crash log or a container's stderr. That is not a
 * theoretical worry: `AUTH_ACCESS_TOKEN_SECRET` failing `min()` is the single most likely
 * failure of this function, and the naive `JSON.stringify(result.error)` prints the value.
 */
export function parseSessionConfig(source: Record<string, string | undefined>): SessionConfig {
  const result = sessionEnvSchema.safeParse(source);

  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const name = issue.path.join('.') || '(root)';
      const message =
        issue.code === 'invalid_type' && !(name in source) ? 'is required but not set' : issue.message;
      return `${name} ${message}`;
    });
    throw new SessionConfigError(problems);
  }

  const parsed = result.data;

  return Object.freeze({
    accessTokenKey: createSecretKey(Buffer.from(parsed.AUTH_ACCESS_TOKEN_SECRET, 'utf8')),
    issuer: parsed.AUTH_TOKEN_ISSUER,
    accessTokenTtlSeconds: parsed.AUTH_ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds: parsed.AUTH_REFRESH_TOKEN_TTL_SECONDS,
    sessionTtlSeconds: parsed.AUTH_SESSION_TTL_SECONDS,
    refreshGraceSeconds: parsed.AUTH_REFRESH_GRACE_SECONDS,
  });
}
