import { DEFAULT_ENDPOINTS } from './providers';
import {
  PROVIDER_NAMES,
  type ProviderName,
  type ProviderSecret,
  type ResolvedProvider,
} from './providers/provider.types';

/**
 * OAuth configuration, parsed once, before Nest builds anything.
 *
 * The same discipline as src/config/env.ts and for the same reason: a credential read at
 * the moment it is needed turns a deploy mistake into a customer-facing failure on the
 * first login attempt rather than a refusal to start. What is deliberately *not* the same
 * is the failure mode for a provider that is not configured at all.
 *
 *   configured wrongly    stops the process. A LINE channel id with no channel secret is
 *                         not a decision anybody made; it is half an edit.
 *   not configured        the provider simply does not exist. `/auth/oauth/line/start`
 *                         answers 404 and the rest of the API boots and serves.
 *
 * That second rule is what lets this repository's 506 existing tests, and a developer with
 * no credentials at all, boot the app unchanged — and it is honest besides: there are no
 * real credentials for LINE, Google, Facebook or Apple in this environment, so "no provider
 * is configured" is the true state of the world here rather than a special case.
 */

/**
 * Injection token for the parsed configuration.
 *
 * A separate token from `ENV` (src/config/config.module.ts) because the two have different
 * lifetimes and different owners: `Env` is the process's, validated in main.ts before Nest
 * exists; this is one module's, and it holds credentials that nothing outside this module
 * should be able to reach by injecting the environment.
 */
export const OAUTH_CONFIG = Symbol('wewin.auth.oauthConfig');

export interface OAuthConfig {
  /**
   * Absolute origin of the site the customer is actually using.
   *
   * Every redirect this module emits is built as `webBaseUrl + path`, where the path has
   * been through `isLocalReturnTo`. Two halves, one of which is configuration and one of
   * which is validated input — which is what makes an open redirect unrepresentable rather
   * than merely unlikely.
   */
  readonly webBaseUrl: string;
  /** Where a failed or cancelled sign-in lands, as a path on `webBaseUrl`. */
  readonly failurePath: string;
  /** See state-cookie.ts: one flag, because `Secure`, `SameSite=None` and `__Host-` move together. */
  readonly cookieSecure: boolean;
  /**
   * How long an authorisation may stay in flight.
   *
   * Ten minutes is long enough for a customer to find their password manager, install the
   * LINE app, or fail a 2FA prompt once, and short enough that `oauth_states` is a small
   * table. It is also the cookie's `Max-Age`, so the row and the cookie expire together —
   * two different expiries would produce a callback that fails for a reason depending on
   * which one lapsed first.
   */
  readonly stateTtlSeconds: number;
  readonly providers: ReadonlyMap<ProviderName, ResolvedProvider>;
}

export class OAuthConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      ['Invalid OAuth configuration:', ...problems.map((problem) => `  - ${problem}`)].join('\n'),
    );
    this.name = 'OAuthConfigError';
    this.problems = problems;
  }
}

const DEFAULT_STATE_TTL_SECONDS = 600;

/** Every provider's callback path, so a redirect URI is never typed twice. */
export function callbackPath(provider: ProviderName): string {
  return `/auth/oauth/${provider}/callback`;
}

export function startPath(provider: ProviderName): string {
  return `/auth/oauth/${provider}/start`;
}

interface Source {
  readonly [key: string]: string | undefined;
}

/**
 * Any environment variable at all for a provider means somebody was configuring it.
 *
 * This is what makes "half-configured stops the process" and "not configured is fine" two
 * different states rather than a judgement call. It is also what keeps the two base URLs
 * optional in a checkout with no credentials: they are required the moment a single
 * provider variable appears, and irrelevant before that.
 */
function isMentioned(source: Source, name: ProviderName): boolean {
  const prefix = `OAUTH_${name.toUpperCase()}_`;
  return Object.keys(source).some((key) => key.startsWith(prefix) && source[key] !== undefined);
}

/* Only reachable when no provider is configured, so nothing is ever redirected to them. */
const UNCONFIGURED_WEB_BASE_URL = 'http://localhost:5173';
const UNCONFIGURED_CALLBACK_BASE_URL = 'http://localhost:3000';

export function parseOAuthConfig(source: Source): OAuthConfig {
  const problems: string[] = [];
  const required = PROVIDER_NAMES.some((name) => isMentioned(source, name));

  const webBaseUrl = absoluteOrigin(
    source['OAUTH_WEB_BASE_URL'],
    'OAUTH_WEB_BASE_URL',
    problems,
    required,
    UNCONFIGURED_WEB_BASE_URL,
  );
  const callbackBaseUrl = absoluteOrigin(
    source['OAUTH_CALLBACK_BASE_URL'],
    'OAUTH_CALLBACK_BASE_URL',
    problems,
    required,
    UNCONFIGURED_CALLBACK_BASE_URL,
  );

  const failurePath = source['OAUTH_FAILURE_PATH'] ?? '/login';
  if (!failurePath.startsWith('/') || failurePath.startsWith('//')) {
    problems.push('OAUTH_FAILURE_PATH must be a path on this site, starting with a single "/"');
  }

  const stateTtlSeconds = positiveInteger(
    source['OAUTH_STATE_TTL_SECONDS'],
    DEFAULT_STATE_TTL_SECONDS,
    'OAUTH_STATE_TTL_SECONDS',
    problems,
  );

  /*
   * `COOKIE_SECURE`, the same flag src/config/env.ts parses for the guest cookie and the
   * refresh cookie. It used to be `OAUTH_COOKIE_SECURE`, a second name for the same
   * decision — and a second name is a second profile, one of which nobody sets.
   *
   * Defaults to on and is only turned off explicitly, because the whole of ⓑ's browser
   * binding is enforced by cookie attributes: without `Secure` there is no `SameSite=None`
   * and no `__Host-`, so a sibling subdomain can plant a binding secret and the attack in
   * plan 6(b) works again. Which is why turning it off is not merely discouraged below.
   */
  const cookieSecure = booleanFlag(source['COOKIE_SECURE'], true, 'COOKIE_SECURE', problems);

  /*
   * The insecure profile is a development affordance and is refused anywhere it could be
   * anything else. A laptop has no TLS terminator, so `false` has to exist; a deployment
   * that reaches a real callback origin over a cookie with no `Secure` and no `__Host-` has
   * turned fix ⓑ off, and the only place that is a decision rather than an accident is
   * loopback. Failing to boot is the correct response — the alternative is an API that
   * serves logins with the binding disabled and says nothing.
   */
  if (!cookieSecure && !isLoopback(callbackBaseUrl)) {
    problems.push(
      `COOKIE_SECURE=false is only allowed when OAUTH_CALLBACK_BASE_URL is a loopback address ` +
        `(it is "${callbackBaseUrl}") — the OAuth state binding is enforced by Secure, SameSite=None and __Host-`,
    );
  }

  const providers = new Map<ProviderName, ResolvedProvider>();
  for (const name of PROVIDER_NAMES) {
    const resolved = resolveProvider(name, source, callbackBaseUrl, problems);
    if (resolved) providers.set(name, resolved);
  }

  if (problems.length > 0) throw new OAuthConfigError(problems);

  return Object.freeze({
    webBaseUrl,
    failurePath,
    cookieSecure,
    stateTtlSeconds,
    providers,
  });
}

function resolveProvider(
  name: ProviderName,
  source: Source,
  callbackBaseUrl: string,
  problems: string[],
): ResolvedProvider | undefined {
  const prefix = `OAUTH_${name.toUpperCase()}`;
  const clientId = source[`${prefix}_CLIENT_ID`];

  const secret = name === 'apple' ? appleSecret(source, prefix) : staticSecret(source, prefix);

  if (clientId === undefined && secret === undefined) return undefined;

  if (clientId === undefined) {
    problems.push(`${prefix}_CLIENT_ID is required when ${name} is configured`);
    return undefined;
  }
  if (secret === undefined) {
    problems.push(
      name === 'apple'
        ? `${prefix}_TEAM_ID, ${prefix}_KEY_ID and ${prefix}_PRIVATE_KEY are all required when apple is configured`
        : `${prefix}_CLIENT_SECRET is required when ${name} is configured`,
    );
    return undefined;
  }

  const endpoints = DEFAULT_ENDPOINTS.get(name);
  if (endpoints === undefined) {
    problems.push(`no endpoints are known for provider "${name}"`);
    return undefined;
  }

  return {
    name,
    clientId,
    secret,
    redirectUri: `${callbackBaseUrl}${callbackPath(name)}`,
    endpoints,
  };
}

function staticSecret(source: Source, prefix: string): ProviderSecret | undefined {
  const value = source[`${prefix}_CLIENT_SECRET`];
  return value === undefined ? undefined : { kind: 'static', value };
}

/**
 * All three or none.
 *
 * `undefined` here means "Apple is not configured"; a partial answer would mean a service
 * that boots, offers Apple sign-in, and fails at the token endpoint with `invalid_client` —
 * which is also what a wrong key id looks like, so the two would be indistinguishable in
 * production.
 */
function appleSecret(source: Source, prefix: string): ProviderSecret | undefined {
  const teamId = source[`${prefix}_TEAM_ID`];
  const keyId = source[`${prefix}_KEY_ID`];
  const privateKeyPem = source[`${prefix}_PRIVATE_KEY`];

  if (teamId === undefined || keyId === undefined || privateKeyPem === undefined) return undefined;

  return {
    kind: 'apple-jwt',
    teamId,
    keyId,
    /*
     * `\n` un-escaped: a PEM is multi-line and an environment variable is not, so every
     * deployment target that carries one carries it with the newlines escaped. Without this
     * the key parses as a single line and `createPrivateKey` fails with a message about
     * the header, which reads as a wrong key rather than a wrong encoding.
     */
    privateKeyPem: privateKeyPem.replace(/\\n/g, '\n'),
  };
}

function absoluteOrigin(
  value: string | undefined,
  name: string,
  problems: string[],
  required: boolean,
  fallback: string,
): string {
  if (value === undefined || value === '') {
    if (required) problems.push(`${name} is required once any OAuth provider is configured`);
    return fallback;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    problems.push(`${name} must be an absolute URL`);
    return fallback;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    problems.push(`${name} must be http:// or https://`);
    return fallback;
  }
  // Trailing slash stripped once, here, so that `webBaseUrl + '/quote'` cannot produce
  // `//quote` — which a browser reads as a protocol-relative URL to the host `quote`.
  return value.replace(/\/+$/, '');
}

/**
 * Loopback by *address*, not by name.
 *
 * `localhost` is here because browsers treat it as a secure context and because it is what
 * a developer types; `127.0.0.0/8` and `[::1]` are here because that is what a test harness
 * binds. Anything else — including a hostname that happens to resolve to 127.0.0.1 today —
 * is not loopback for this purpose: DNS is not part of the trust decision.
 */
function isLoopback(origin: string): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }

  if (host === 'localhost' || host === '[::1]' || host === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  problems: string[],
): number {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) {
    problems.push(`${name} must be a whole number of seconds`);
    return fallback;
  }
  const parsed = Number(value);
  if (parsed <= 0) {
    problems.push(`${name} must be greater than zero`);
    return fallback;
  }
  return parsed;
}

function booleanFlag(
  value: string | undefined,
  fallback: boolean,
  name: string,
  problems: string[],
): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  problems.push(`${name} must be "true" or "false"`);
  return fallback;
}
