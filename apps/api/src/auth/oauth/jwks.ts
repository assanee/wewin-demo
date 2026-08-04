import { Injectable } from '@nestjs/common';
import type { KeyObject } from 'node:crypto';

import { OAuthHttp } from './http';
import { JwtError, publicKeyFromJwk, type Jwk, type JwsHeader } from './jwt';

/**
 * A provider's published signing keys, cached.
 *
 * Google and Apple both rotate RSA keys on their own schedule and both publish the current
 * set at a well-known URL. Two failure modes bracket the caching decision and the code
 * below sits between them:
 *
 *   fetch every time  a login now depends on a second provider round-trip, and a provider
 *                     that rate-limits the key set turns a busy minute into failed logins.
 *   cache forever     the first rotation breaks every login until the process restarts.
 *
 * So: cached for `TTL_MS`, plus one refetch when a token names a `kid` the cache does not
 * hold, which is exactly the shape of a rotation — the new key appears in the set before
 * tokens signed with it arrive. `refreshedAt` bounds that refetch to once per
 * `MIN_REFETCH_INTERVAL_MS`, because "unknown kid" is attacker-controlled: without the
 * floor, a stream of tokens carrying random `kid` values is an amplified request flood
 * aimed at the provider with our IP on it.
 */

const TTL_MS = 10 * 60 * 1000;
const MIN_REFETCH_INTERVAL_MS = 30 * 1000;

interface CachedKeys {
  readonly keys: ReadonlyMap<string, KeyObject>;
  /** The single key of a set that publishes exactly one, so a token with no `kid` still verifies. */
  readonly only: KeyObject | undefined;
  readonly fetchedAt: number;
}

@Injectable()
export class JwksCache {
  private readonly byUrl = new Map<string, CachedKeys>();

  /** In flight per URL, so six simultaneous logins after a restart make one request, not six. */
  private readonly inFlight = new Map<string, Promise<CachedKeys>>();

  constructor(private readonly http: OAuthHttp) {}

  /** A `KeyResolver` bound to one key set — the shape `verifyIdToken` takes. */
  resolver(jwksUrl: string): (header: JwsHeader) => Promise<KeyObject> {
    return async (header) => this.keyFor(jwksUrl, header.kid);
  }

  private async keyFor(jwksUrl: string, kid: string | undefined): Promise<KeyObject> {
    const cached = await this.load(jwksUrl, false);
    const found = select(cached, kid);
    if (found) return found;

    // Unknown kid: either a rotation we have not seen, or noise. `load(…, true)` is the one
    // that is allowed to bypass the TTL, and it is rate-limited.
    const refreshed = await this.load(jwksUrl, true);
    const afterRefresh = select(refreshed, kid);
    if (afterRefresh) return afterRefresh;

    throw new JwtError(`no signing key for kid ${kid ?? '(absent)'} at ${jwksUrl}`);
  }

  private async load(jwksUrl: string, force: boolean): Promise<CachedKeys> {
    const now = Date.now();
    const cached = this.byUrl.get(jwksUrl);

    if (cached) {
      const age = now - cached.fetchedAt;
      if (force ? age < MIN_REFETCH_INTERVAL_MS : age < TTL_MS) return cached;
    }

    const existing = this.inFlight.get(jwksUrl);
    if (existing) return existing;

    const pending = this.fetch(jwksUrl, now).finally(() => {
      this.inFlight.delete(jwksUrl);
    });
    this.inFlight.set(jwksUrl, pending);
    return pending;
  }

  private async fetch(jwksUrl: string, at: number): Promise<CachedKeys> {
    const payload = await this.http.getJson(jwksUrl);
    const parsed = parseKeySet(payload, at);
    this.byUrl.set(jwksUrl, parsed);
    return parsed;
  }
}

function select(cached: CachedKeys, kid: string | undefined): KeyObject | undefined {
  if (kid !== undefined) return cached.keys.get(kid);
  /*
   * A token with no `kid` is only unambiguous when the set has one key. Picking "the first"
   * out of a multi-key set would mean a token verifying or not depending on JSON ordering,
   * which is the kind of intermittent failure nobody reproduces.
   */
  return cached.only;
}

function parseKeySet(payload: unknown, at: number): CachedKeys {
  if (typeof payload !== 'object' || payload === null || !('keys' in payload)) {
    throw new JwtError('JWKS response has no keys array');
  }
  const { keys } = payload as { keys: unknown };
  if (!Array.isArray(keys)) {
    throw new JwtError('JWKS response has no keys array');
  }

  const byKid = new Map<string, KeyObject>();
  const loaded: KeyObject[] = [];

  for (const entry of keys as readonly unknown[]) {
    const jwk = asJwk(entry);
    // A key set that mixes a usable key with an unusable one should still let the usable
    // one verify: providers publish `use: "enc"` entries and future key types alongside.
    if (jwk === undefined || (jwk.use !== undefined && jwk.use !== 'sig')) continue;

    let key: KeyObject;
    try {
      key = publicKeyFromJwk(jwk);
    } catch {
      continue;
    }

    loaded.push(key);
    if (jwk.kid !== undefined) byKid.set(jwk.kid, key);
  }

  if (loaded.length === 0) {
    throw new JwtError('JWKS response contained no usable signing key');
  }

  return { keys: byKid, only: loaded.length === 1 ? loaded[0] : undefined, fetchedAt: at };
}

/** Every field is optional except `kty`, and every one is a string or it is not there. */
function asJwk(value: unknown): Jwk | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;

  const kty = record['kty'];
  if (typeof kty !== 'string') return undefined;

  // Conditional spread rather than `field: valueOrUndefined`: node's JWK import reads the
  // properties that are *present*, and under `exactOptionalPropertyTypes` an explicit
  // `undefined` is not the same thing as an absent field — see the note on `Jwk`.
  const optional = (name: string): Record<string, string> => {
    const found = record[name];
    return typeof found === 'string' ? { [name]: found } : {};
  };

  return {
    kty,
    ...optional('kid'),
    ...optional('alg'),
    ...optional('use'),
    ...optional('n'),
    ...optional('e'),
    ...optional('crv'),
    ...optional('x'),
    ...optional('y'),
  };
}
