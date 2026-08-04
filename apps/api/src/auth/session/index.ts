/**
 * The surface the rest of the auth code may use.
 *
 * Deliberately does not re-export `secrets.ts`. Minting and hashing token secrets is this
 * module's job; a second caller doing it is a second place that can forget to hash, and
 * `refresh_tokens.token_hash`'s format CHECK is the only thing that would notice.
 */

export { SessionModule } from './session.module';
export { SessionService } from './session.service';
export type { IssuedSession, RefreshResult, StartSessionInput } from './session.service';
export { AccessTokenService } from './access-token';
export type {
  AccessTokenClaims,
  AccessTokenRejection,
  AccessTokenVerification,
  IssuedAccessToken,
} from './access-token';
export { SESSION_CONFIG } from './session.tokens';
export {
  ACCESS_TOKEN_TTL_DEFAULT_SECONDS,
  REFRESH_GRACE_DEFAULT_SECONDS,
  SessionConfigError,
  parseSessionConfig,
  sessionEnvSchema,
} from './session.config';
export type { SessionConfig } from './session.config';
export { REFRESH_COOKIE_NAME, clearedRefreshCookie, refreshCookie } from './refresh-cookie';
export type { RevocationReason, RotationOutcome } from './session.repository';
