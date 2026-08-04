import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppError } from '../../common/errors/app-error';
import type { GuestCookie } from '../../rbac';
import { sha256Hex } from './crypto';
import { OAuthHttp } from './http';
import { AccountSuspendedError, IdentityLinkService, type LinkedAccount } from './identity-link.service';
import { JwksCache } from './jwks';
import { OAuthStateService } from './oauth-state.service';
import { OAUTH_CONFIG, type OAuthConfig } from './oauth.config';
import { verifierMatches } from './pkce';
import { adapterFor } from './providers';
import { createAppleClientSecret } from './providers/apple-client-secret';
import {
  isProviderName,
  parseTokenResponse,
  type ProviderName,
  type ResolvedProvider,
  type TokenSet,
} from './providers/provider.types';
import { deriveNonce } from './nonce';
import { parseReturnTo } from './return-to';
import { SESSION_ISSUER, type SessionIssuer } from './session-issuer';
import {
  clearStateCookie,
  decodeStateCookieValue,
  encodeStateCookieValue,
  readCookie,
  serialiseStateCookie,
  stateCookieName,
} from './state-cookie';

/**
 * The two halves of an OAuth sign-in, and the only place they are sequenced.
 *
 * `start` mints the flow; `complete` spends it. Everything security-relevant about the pair
 * is somewhere else on purpose — the atomic consume is in `oauth-state.service.ts`, the
 * linking rule is in `identity-link.service.ts`, the cookie attributes are in
 * `state-cookie.ts` — so what is left here is the order things happen in, which is itself
 * load-bearing:
 *
 *   the state row is consumed **before** the code is exchanged. A callback that fails at
 *   the token endpoint has still burned its state, so a replay of the same URL cannot get a
 *   second attempt at anything.
 *
 *   the id_token is verified **before** any claim in it is read. `providers/*` enforce
 *   that; this file never touches a raw token.
 *
 *   the session is issued **last**, after linking succeeded. A partial failure leaves the
 *   customer signed out with an account that exists, which is recoverable by signing in
 *   again; the reverse — a session for an account that was not finished — is not.
 *
 * Failure never says which check failed. `denied` (the customer pressed cancel, which the
 * UI should treat gently) and `failed` (everything else) are the only two answers a browser
 * gets, because a distinguishable "expired" versus "wrong browser" is an oracle for
 * somebody probing a `state` they hold. The reason is logged.
 */

export type OAuthFailureReason = 'denied' | 'failed';

export interface StartRequest {
  readonly provider: string;
  readonly returnTo: string | undefined;
  readonly guestCookie: GuestCookie | undefined;
}

export interface StartResult {
  readonly redirectTo: string;
  readonly cookies: readonly string[];
}

export interface CompleteRequest {
  readonly provider: string;
  /** Query string for three providers, form body for Apple — merged by the controller. */
  readonly params: Readonly<Record<string, string>>;
  readonly cookieHeader: string | undefined;
  readonly userAgent: string | undefined;
  readonly ip: string | undefined;
}

export type CompleteResult =
  | { readonly kind: 'signed-in'; readonly redirectTo: string; readonly cookies: readonly string[] }
  | {
      readonly kind: 'failed';
      readonly redirectTo: string;
      readonly cookies: readonly string[];
      readonly reason: OAuthFailureReason;
    };

/** Thrown inside `complete` and never escapes it: every path ends as a redirect. */
class CallbackRejected extends Error {
  readonly reason: OAuthFailureReason;

  constructor(reason: OAuthFailureReason, why: string) {
    super(why);
    this.name = 'CallbackRejected';
    this.reason = reason;
  }
}

@Injectable()
export class OAuthService {
  private readonly logger = new Logger('OAuth');

  constructor(
    @Inject(OAUTH_CONFIG) private readonly config: OAuthConfig,
    private readonly states: OAuthStateService,
    private readonly identities: IdentityLinkService,
    private readonly http: OAuthHttp,
    private readonly jwks: JwksCache,
    @Inject(SESSION_ISSUER) private readonly sessions: SessionIssuer,
  ) {}

  /** The providers a client may offer. Unconfigured ones are not listed and 404 on start. */
  enabledProviders(): readonly ProviderName[] {
    return [...this.config.providers.keys()];
  }

  /**
   * Which cookie profile this deployment runs, so the controller reads the guest cookie
   * under the name the rest of the process writes it under. One flag (`COOKIE_SECURE`)
   * reaches three cookies; exposing it here rather than injecting the environment into a
   * controller keeps that one flag one flag.
   */
  get cookieSecure(): boolean {
    return this.config.cookieSecure;
  }

  async start(request: StartRequest): Promise<StartResult> {
    const provider = this.resolve(request.provider);
    const adapter = adapterFor(provider.name);

    const returnTo = parseReturnTo(request.returnTo);
    if (returnTo === undefined) {
      throw AppError.badRequest('returnTo must be a path on this site.', {
        returnTo: request.returnTo ?? null,
      });
    }

    const minted = await this.states.mint({
      provider: provider.name,
      returnTo,
      guestCookie: request.guestCookie,
      ttlSeconds: this.config.stateTtlSeconds,
    });

    const url = new URL(provider.endpoints.authorizationUrl);
    const parameters: Record<string, string> = {
      response_type: 'code',
      client_id: provider.clientId,
      redirect_uri: provider.redirectUri,
      scope: adapter.scope,
      state: minted.state,
      code_challenge: minted.challenge,
      code_challenge_method: 'S256',
      ...adapter.authorizationParameters({
        state: minted.state,
        nonce: deriveNonce(minted.verifier),
        codeChallenge: minted.challenge,
        provider,
      }),
    };
    for (const [key, value] of Object.entries(parameters)) {
      url.searchParams.set(key, value);
    }

    const cookie = serialiseStateCookie(
      stateCookieName(minted.stateHash, this.config.cookieSecure),
      encodeStateCookieValue({ binding: minted.binding, verifier: minted.verifier }),
      { cookieSecure: this.config.cookieSecure, maxAgeSeconds: this.config.stateTtlSeconds },
    );

    return { redirectTo: url.toString(), cookies: [cookie] };
  }

  async complete(request: CompleteRequest): Promise<CompleteResult> {
    const provider = this.resolve(request.provider);
    const state = request.params['state'];

    /*
     * Computed before anything can fail, so the failure path clears the same cookie the
     * success path does. A flow that ends without clearing leaves a live binding secret in
     * the browser until its Max-Age lapses.
     */
    const cookieName =
      state === undefined ? undefined : stateCookieName(sha256Hex(state), this.config.cookieSecure);
    const cookies =
      cookieName === undefined ? [] : [clearStateCookie(cookieName, this.config.cookieSecure)];

    try {
      const result = await this.exchange(provider, request, state, cookieName);
      return { kind: 'signed-in', redirectTo: result.redirectTo, cookies: [...cookies, ...result.cookies] };
    } catch (error) {
      const reason = error instanceof CallbackRejected ? error.reason : 'failed';
      /*
       * `warn` and not `error`: a cancelled sign-in and a probe are both ordinary traffic,
       * and a 500-level log line for either is a pager that fires on customers changing
       * their minds. The message names the provider and the check that refused, never a
       * token, a code, a cookie or a `state`.
       */
      this.logger.warn(
        `${provider.name} callback rejected (${reason}): ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return { kind: 'failed', redirectTo: this.failureUrl(reason), cookies, reason };
    }
  }

  private async exchange(
    provider: ResolvedProvider,
    request: CompleteRequest,
    state: string | undefined,
    cookieName: string | undefined,
  ): Promise<{ redirectTo: string; cookies: readonly string[] }> {
    /*
     * The provider's own refusal, first. `error=access_denied` is the customer pressing
     * cancel and is not a security event; treating it as one fills the log with noise and
     * shows them a scary page.
     */
    const providerError = request.params['error'];
    if (providerError !== undefined) {
      throw new CallbackRejected(
        providerError === 'access_denied' ? 'denied' : 'failed',
        `provider returned error=${providerError}`,
      );
    }

    const code = request.params['code'];
    if (state === undefined || cookieName === undefined || code === undefined) {
      throw new CallbackRejected('failed', 'callback is missing state or code');
    }

    /* ⓑ The browser half. A callback opened in a browser that did not start the flow has no cookie here. */
    const cookie = decodeStateCookieValue(readCookie(request.cookieHeader, cookieName));
    if (cookie === undefined) {
      throw new CallbackRejected('failed', 'no binding cookie for this state');
    }

    const claimed = await this.states.consume({
      provider: provider.name,
      state,
      binding: cookie.binding,
    });
    if (claimed === undefined) {
      // Replayed, expired, wrong provider, or a binding secret that does not match the row.
      // One answer for all four, deliberately.
      throw new CallbackRejected('failed', 'no live authorisation matches this callback');
    }

    if (!verifierMatches(cookie.verifier, claimed.pkceChallenge)) {
      // The cookie carried a verifier from some other flow. The provider would reject the
      // exchange too; refusing here means the code is never spent.
      throw new CallbackRejected('failed', 'PKCE verifier does not match this authorisation');
    }

    const tokens = await this.redeem(provider, code, cookie.verifier);

    const adapter = adapterFor(provider.name);
    const profile = await adapter.profile({
      tokens,
      provider,
      nonce: deriveNonce(cookie.verifier),
      http: this.http,
      jwks: this.jwks,
      callbackParams: request.params,
      now: new Date(),
    });

    const linked = await this.linkOrRefuse(provider.name, profile);

    const guestId = claimed.guestId ?? undefined;
    if (guestId !== undefined) {
      /*
       * Non-fatal, deliberately. The customer is identified and their account exists; losing
       * the cart they built before signing in is a bad afternoon, and failing the sign-in
       * over it is a worse one. Logged rather than swallowed, because a claim that stops
       * working is a funnel that stops converting and nothing else would say so.
       */
      try {
        await this.identities.claimGuest(guestId, linked.userId);
      } catch (error) {
        this.logger.warn(
          `${provider.name} sign-in could not claim guest ${guestId}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }

    this.logger.log(
      `${provider.name} sign-in for user ${linked.userId} ` +
        `(${linked.accountCreated ? 'new account' : linked.attachedToVerifiedOwner ? 'attached to a verified address' : 'existing identity'})`,
    );

    const issued = await this.sessions.issueForUser({
      userId: linked.userId,
      userAgent: request.userAgent,
      ip: request.ip,
      guestId,
    });

    return {
      redirectTo: `${this.config.webBaseUrl}${claimed.returnTo}`,
      cookies: issued.cookies,
    };
  }

  /**
   * Linking, with a suspended account turned into the same refusal as everything else.
   *
   * A suspended person must not learn from the login page that suspension is why they are
   * being turned away — the message belongs in the email an administrator sends, not in a
   * redirect that anybody can trigger for any address. And a stranger probing the flow must
   * not learn that an account exists at all. So this collapses into `failed`, exactly like a
   * replayed state or a provider that lied, and the reason is written to the log where
   * support can find it against a user id.
   */
  private async linkOrRefuse(
    provider: ProviderName,
    profile: { subject: string; email: string | undefined; emailProven: boolean; displayName: string | undefined },
  ): Promise<LinkedAccount> {
    try {
      return await this.identities.link({
        provider,
        subject: profile.subject,
        email: profile.email,
        emailProven: profile.emailProven,
        displayName: profile.displayName,
      });
    } catch (error) {
      if (error instanceof AccountSuspendedError) {
        this.logger.warn(`${provider} sign-in refused: account ${error.userId} is suspended`);
        throw new CallbackRejected('failed', 'the account this identity belongs to is not active');
      }
      throw error;
    }
  }

  private async redeem(
    provider: ResolvedProvider,
    code: string,
    verifier: string,
  ): Promise<TokenSet> {
    const payload = await this.http.postForm(provider.endpoints.tokenUrl, {
      grant_type: 'authorization_code',
      code,
      // Sent again at the token endpoint because RFC 6749 requires the two to match; a
      // provider that skipped the comparison would let a code issued for one redirect URI
      // be spent against another.
      redirect_uri: provider.redirectUri,
      client_id: provider.clientId,
      client_secret: this.clientSecret(provider),
      code_verifier: verifier,
    });

    return parseTokenResponse(payload);
  }

  /** Apple's is signed per request; everyone else's is the string from configuration. */
  private clientSecret(provider: ResolvedProvider): string {
    if (provider.secret.kind === 'static') return provider.secret.value;

    return createAppleClientSecret({
      teamId: provider.secret.teamId,
      keyId: provider.secret.keyId,
      privateKeyPem: provider.secret.privateKeyPem,
      clientId: provider.clientId,
      now: new Date(),
    });
  }

  private resolve(name: string): ResolvedProvider {
    const provider = isProviderName(name) ? this.config.providers.get(name) : undefined;
    if (provider === undefined) {
      /*
       * 404 and not 400, and the same answer for "no such provider" and "that provider is
       * not configured here". Which providers a deployment has credentials for is not
       * information a caller needs to enumerate.
       */
      throw AppError.notFound(`No OAuth provider named "${name}" is enabled.`);
    }
    return provider;
  }

  private failureUrl(reason: OAuthFailureReason): string {
    const url = new URL(`${this.config.webBaseUrl}${this.config.failurePath}`);
    url.searchParams.set('error', reason);
    return url.toString();
  }
}
