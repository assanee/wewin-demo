import { describe, expect, it } from 'vitest';

import {
  OAuthConfigError,
  callbackPath,
  parseOAuthConfig,
} from '../../../src/auth/oauth/oauth.config';

/**
 * The boot-time contract: half-configured stops the process, unconfigured is fine.
 *
 * The second half is what lets this repository's existing suites, and a developer with no
 * credentials, boot the API unchanged — and it is the true state of this environment, where
 * no real provider credentials exist at all.
 */
describe('parseOAuthConfig', () => {
  it('enables nothing, and requires nothing, when no provider is mentioned', () => {
    const config = parseOAuthConfig({});
    expect([...config.providers.keys()]).toEqual([]);
    expect(config.cookieSecure).toBe(true);
    expect(config.stateTtlSeconds).toBe(600);
  });

  /**
   * ⓑ The cookie profile is not a preference.
   *
   * The whole of the browser binding is enforced by cookie attributes — `Secure`,
   * `SameSite=None` and `__Host-` — and every one of them is off in the insecure profile.
   * So `COOKIE_SECURE=false` is a development affordance and is refused anywhere it could
   * be anything else: a laptop has no TLS terminator and needs it, and a deployment that
   * reaches a real callback origin with the binding disabled has turned fix ⓑ off without
   * saying so. One flag, read by the OAuth binding cookie, the refresh cookie and the guest
   * cookie, so the three cannot end up in two profiles.
   */
  describe('COOKIE_SECURE', () => {
    const line = {
      OAUTH_LINE_CLIENT_ID: 'channel-id',
      OAUTH_LINE_CLIENT_SECRET: 'channel-secret',
    };

    it('defaults to on, so a forgotten variable is the safe profile', () => {
      expect(parseOAuthConfig({}).cookieSecure).toBe(true);
    });

    it('allows the insecure profile only against a loopback callback origin', () => {
      const config = parseOAuthConfig({
        COOKIE_SECURE: 'false',
        OAUTH_WEB_BASE_URL: 'http://localhost:5173',
        OAUTH_CALLBACK_BASE_URL: 'http://127.0.0.1:3000',
        ...line,
      });
      expect(config.cookieSecure).toBe(false);
    });

    it('refuses to boot with the insecure profile on a real callback origin', () => {
      const failure = (): unknown =>
        parseOAuthConfig({
          COOKIE_SECURE: 'false',
          OAUTH_WEB_BASE_URL: 'https://shop.example',
          OAUTH_CALLBACK_BASE_URL: 'https://api.shop.example',
          ...line,
        });

      expect(failure).toThrow(OAuthConfigError);
      expect(failure).toThrow(/COOKIE_SECURE=false is only allowed/);
    });

    it('does not accept a hostname that merely resolves to loopback', () => {
      // DNS is not part of the decision: whoever answers for that name today is not who
      // answers for it after somebody edits a zone file.
      expect(() =>
        parseOAuthConfig({
          COOKIE_SECURE: 'false',
          OAUTH_WEB_BASE_URL: 'http://dev.example',
          OAUTH_CALLBACK_BASE_URL: 'http://dev.example:3000',
          ...line,
        }),
      ).toThrow(OAuthConfigError);
    });
  });

  it('enables only the providers that are fully configured', () => {
    const config = parseOAuthConfig({
      OAUTH_WEB_BASE_URL: 'https://shop.example',
      OAUTH_CALLBACK_BASE_URL: 'https://api.shop.example',
      OAUTH_LINE_CLIENT_ID: 'channel-id',
      OAUTH_LINE_CLIENT_SECRET: 'channel-secret',
    });

    expect([...config.providers.keys()]).toEqual(['line']);
    expect(config.providers.get('line')?.redirectUri).toBe(
      `https://api.shop.example${callbackPath('line')}`,
    );
  });

  it('stops the process on half an edit rather than offering a broken button', () => {
    expect(() =>
      parseOAuthConfig({
        OAUTH_WEB_BASE_URL: 'https://shop.example',
        OAUTH_CALLBACK_BASE_URL: 'https://api.shop.example',
        OAUTH_GOOGLE_CLIENT_ID: 'client-id',
      }),
    ).toThrow(OAuthConfigError);
  });

  it('requires all three of Apple, because two of them look exactly like a wrong key id', () => {
    expect(() =>
      parseOAuthConfig({
        OAUTH_WEB_BASE_URL: 'https://shop.example',
        OAUTH_CALLBACK_BASE_URL: 'https://api.shop.example',
        OAUTH_APPLE_CLIENT_ID: 'services.id',
        OAUTH_APPLE_TEAM_ID: 'TEAM',
        OAUTH_APPLE_KEY_ID: 'KEY',
      }),
    ).toThrow(/PRIVATE_KEY/);
  });

  it('un-escapes the newlines every deployment target puts in a PEM', () => {
    const config = parseOAuthConfig({
      OAUTH_WEB_BASE_URL: 'https://shop.example',
      OAUTH_CALLBACK_BASE_URL: 'https://api.shop.example',
      OAUTH_APPLE_CLIENT_ID: 'services.id',
      OAUTH_APPLE_TEAM_ID: 'TEAM',
      OAUTH_APPLE_KEY_ID: 'KEY',
      OAUTH_APPLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nMIG\\n-----END PRIVATE KEY-----\\n',
    });

    const secret = config.providers.get('apple')?.secret;
    expect(secret?.kind).toBe('apple-jwt');
    expect(secret?.kind === 'apple-jwt' ? secret.privateKeyPem : '').toContain('\n');
  });

  it('requires the two base URLs as soon as a provider is mentioned', () => {
    expect(() => parseOAuthConfig({ OAUTH_LINE_CLIENT_ID: 'x', OAUTH_LINE_CLIENT_SECRET: 'y' })).toThrow(
      /OAUTH_WEB_BASE_URL/,
    );
  });

  it('rejects a base URL that is not an absolute http(s) origin', () => {
    expect(() =>
      parseOAuthConfig({
        OAUTH_WEB_BASE_URL: '/relative',
        OAUTH_CALLBACK_BASE_URL: 'https://api.shop.example',
        OAUTH_LINE_CLIENT_ID: 'x',
        OAUTH_LINE_CLIENT_SECRET: 'y',
      }),
    ).toThrow(/absolute URL/);
  });

  it('strips a trailing slash so a redirect can never become protocol-relative', () => {
    // `https://shop.example/` + `/quote` would be `https://shop.example//quote`, which a
    // browser reads as a URL to the host `quote`.
    const config = parseOAuthConfig({
      OAUTH_WEB_BASE_URL: 'https://shop.example/',
      OAUTH_CALLBACK_BASE_URL: 'https://api.shop.example/',
      OAUTH_LINE_CLIENT_ID: 'x',
      OAUTH_LINE_CLIENT_SECRET: 'y',
    });
    expect(config.webBaseUrl).toBe('https://shop.example');
  });

  it('never puts a secret in the message when it refuses', () => {
    let message = '';
    try {
      parseOAuthConfig({
        OAUTH_WEB_BASE_URL: 'not-a-url',
        OAUTH_GOOGLE_CLIENT_SECRET: 'super-secret-value',
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain('super-secret-value');
  });
});
