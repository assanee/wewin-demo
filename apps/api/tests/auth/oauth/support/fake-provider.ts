import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomUUID,
  sign as signPayload,
  verify as verifySignature,
  type KeyObject,
} from 'node:crypto';

/**
 * An OAuth 2.0 / OpenID Connect provider, in this process, that we control.
 *
 * There are no real LINE, Google, Facebook or Apple credentials in this environment, so the
 * choice is between testing the flow against something and asserting that it probably works.
 * This is that something, and it is deliberately a *real HTTP server* rather than a stubbed
 * method on `OAuthHttp`: the code under test then does its own `fetch`, its own form
 * encoding, its own JWKS retrieval and its own signature verification, and the only thing
 * the test replaced is the far end of the socket.
 *
 * It is also adversarial where that matters. It refuses a wrong `code_verifier`, a reused
 * `code`, a mismatched `redirect_uri` and a bad `client_secret` — including Apple's, whose
 * ES256 JWT it verifies against the public half of the key the test generated. A fake that
 * accepted everything would let a broken PKCE implementation pass.
 *
 * What it cannot tell us is whether the real providers behave as documented. That is stated
 * plainly in the hand-off notes rather than papered over here.
 */

export type FakeMode = 'line' | 'google' | 'facebook' | 'apple';

export interface FakeAccount {
  readonly subject: string;
  readonly email?: string | undefined;
  /** Apple has shipped this as both a boolean and the string `"true"`; both are expressible. */
  readonly emailVerified?: boolean | string | undefined;
  readonly name?: string | undefined;
  /** Apple's first-authorisation `user` form field, verbatim JSON. */
  readonly userField?: string | undefined;
}

/** Ways to make the provider misbehave, one per attack the code claims to survive. */
export interface FakeFaults {
  readonly omitIdToken?: boolean;
  readonly wrongNonce?: boolean;
  readonly wrongIssuer?: boolean;
  readonly wrongAudience?: boolean;
  readonly expiredIdToken?: boolean;
  /** Sign with a key the provider never published — a forged token from a stolen kid. */
  readonly foreignSigningKey?: boolean;
  /** LINE signed HS256 where the adapter expects it, but with the algorithm swapped to RS256. */
  readonly swapAlgorithm?: boolean;
}

export interface AuthorizeRecord {
  readonly params: Readonly<Record<string, string>>;
}

interface PendingCode {
  readonly nonce: string | undefined;
  readonly codeChallenge: string;
  readonly redirectUri: string;
}

const base64url = (value: object): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

export class FakeProvider {
  readonly mode: FakeMode;
  readonly clientId = 'test-client-id';
  readonly clientSecret = 'test-client-secret-0123456789';

  /** RS256 for Google and Apple; LINE uses the client secret and Facebook signs nothing. */
  private readonly signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private readonly foreign = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private readonly kid = 'fake-key-1';

  /** Apple's `.p8`, and the public half the fake checks the client-secret JWT against. */
  private readonly appleKeyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  private server: Server | undefined;
  private origin = '';

  private readonly codes = new Map<string, PendingCode>();
  private readonly accessTokens = new Set<string>();

  account: FakeAccount = { subject: 'fake-subject' };
  faults: FakeFaults = {};

  readonly authorizeRequests: AuthorizeRecord[] = [];
  readonly tokenRequests: Readonly<Record<string, string>>[] = [];

  constructor(mode: FakeMode) {
    this.mode = mode;
  }

  get baseUrl(): string {
    return this.origin;
  }

  get applePrivateKeyPem(): string {
    return this.appleKeyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  }

  async listen(): Promise<void> {
    const server = createServer((request, response) => {
      this.handle(request, response).catch(() => {
        response.statusCode = 500;
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    this.origin = `http://127.0.0.1:${String(address.port)}`;
    this.server = server;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  reset(): void {
    this.faults = {};
    this.codes.clear();
    this.accessTokens.clear();
    this.authorizeRequests.length = 0;
    this.tokenRequests.length = 0;
  }

  endpoints(): {
    authorizationUrl: string;
    tokenUrl: string;
    issuer: string;
    jwksUrl: string | undefined;
    userInfoUrl: string | undefined;
  } {
    return {
      authorizationUrl: `${this.origin}/authorize`,
      tokenUrl: `${this.origin}/token`,
      issuer: this.origin,
      jwksUrl: this.mode === 'google' || this.mode === 'apple' ? `${this.origin}/keys` : undefined,
      userInfoUrl: this.mode === 'facebook' ? `${this.origin}/me` : undefined,
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.origin);

    if (url.pathname === '/authorize') return this.authorize(url, response);
    if (url.pathname === '/token') return this.token(request, response);
    if (url.pathname === '/keys') return this.keys(response);
    if (url.pathname === '/me') return this.graph(url, response);

    response.statusCode = 404;
    response.end();
  }

  private authorize(url: URL, response: ServerResponse): void {
    const params = Object.fromEntries(url.searchParams.entries());
    this.authorizeRequests.push({ params });

    const redirectUri = params['redirect_uri'];
    const state = params['state'];
    const challenge = params['code_challenge'];

    if (redirectUri === undefined || state === undefined || challenge === undefined) {
      response.statusCode = 400;
      response.end('missing redirect_uri, state or code_challenge');
      return;
    }
    if (params['code_challenge_method'] !== 'S256') {
      response.statusCode = 400;
      response.end('this provider requires S256');
      return;
    }
    if (params['client_id'] !== this.clientId) {
      response.statusCode = 400;
      response.end('unknown client');
      return;
    }

    const code = randomUUID();
    this.codes.set(code, { nonce: params['nonce'], codeChallenge: challenge, redirectUri });

    if (this.mode === 'apple') {
      // Apple's cross-site form POST, as the browser would auto-submit it. Rendered rather
      // than described, so the test has to go through the same shape a browser does.
      const fields: Record<string, string> = { code, state };
      if (this.account.userField !== undefined) fields['user'] = this.account.userField;
      response.statusCode = 200;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(formPostHtml(redirectUri, fields));
      return;
    }

    const location = new URL(redirectUri);
    location.searchParams.set('code', code);
    location.searchParams.set('state', state);
    response.statusCode = 302;
    response.setHeader('location', location.toString());
    response.end();
  }

  private async token(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    const form = Object.fromEntries(new URLSearchParams(body).entries());
    this.tokenRequests.push(form);

    const fail = (why: string): void => {
      response.statusCode = 400;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: 'invalid_grant', error_description: why }));
    };

    if (form['grant_type'] !== 'authorization_code') return fail('grant_type');
    if (form['client_id'] !== this.clientId) return fail('client_id');
    if (!this.clientSecretIsValid(form['client_secret'])) return fail('client_secret');

    const code = form['code'];
    const pending = code === undefined ? undefined : this.codes.get(code);
    if (code === undefined || pending === undefined) return fail('code');
    // Single use, like the real thing: a replayed callback must not be able to buy a second
    // token even if every other check somehow passed.
    this.codes.delete(code);

    if (form['redirect_uri'] !== pending.redirectUri) return fail('redirect_uri');

    const verifier = form['code_verifier'];
    if (verifier === undefined) return fail('code_verifier missing');
    const derived = createHash('sha256').update(verifier, 'utf8').digest('base64url');
    if (derived !== pending.codeChallenge) return fail('code_verifier');

    const accessToken = randomUUID();
    this.accessTokens.add(accessToken);

    const payload: Record<string, unknown> = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
    };
    if (this.mode !== 'facebook' && this.faults.omitIdToken !== true) {
      payload['id_token'] = this.idToken(pending.nonce);
    }

    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(payload));
  }

  private clientSecretIsValid(secret: string | undefined): boolean {
    if (secret === undefined) return false;
    if (this.mode !== 'apple') return secret === this.clientSecret;

    // Apple's client secret is an ES256 JWT this service signed. Verified for real, because
    // the JOSE r‖s encoding is the part that is easy to get wrong and impossible to notice.
    const parts = secret.split('.');
    if (parts.length !== 3) return false;
    const [header, body, signature] = parts;
    if (header === undefined || body === undefined || signature === undefined) return false;

    const ok = verifySignature(
      'sha256',
      Buffer.from(`${header}.${body}`, 'utf8'),
      { key: this.appleKeyPair.publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    );
    if (!ok) return false;

    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    return (
      claims['aud'] === 'https://appleid.apple.com' &&
      claims['sub'] === this.clientId &&
      typeof claims['exp'] === 'number' &&
      claims['exp'] > Math.floor(Date.now() / 1000)
    );
  }

  private idToken(nonce: string | undefined): string {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const usesHmac = this.mode === 'line';

    const header: Record<string, string> = {
      alg: this.faults.swapAlgorithm === true ? (usesHmac ? 'RS256' : 'HS256') : usesHmac ? 'HS256' : 'RS256',
      typ: 'JWT',
    };
    if (!usesHmac) header['kid'] = this.kid;

    const claims: Record<string, unknown> = {
      iss: this.faults.wrongIssuer === true ? 'https://impostor.example' : this.origin,
      aud: this.faults.wrongAudience === true ? 'some-other-client' : this.clientId,
      sub: this.account.subject,
      iat: nowSeconds,
      exp: this.faults.expiredIdToken === true ? nowSeconds - 3600 : nowSeconds + 3600,
      nonce: this.faults.wrongNonce === true ? 'a-nonce-from-another-flow' : nonce,
    };
    if (this.account.email !== undefined) claims['email'] = this.account.email;
    if (this.account.emailVerified !== undefined) claims['email_verified'] = this.account.emailVerified;
    if (this.account.name !== undefined) claims['name'] = this.account.name;

    const signingInput = `${base64url(header)}.${base64url(claims)}`;

    if (usesHmac) {
      const signature = createHmac('sha256', this.clientSecret)
        .update(signingInput, 'utf8')
        .digest('base64url');
      return `${signingInput}.${signature}`;
    }

    const key: KeyObject =
      this.faults.foreignSigningKey === true ? this.foreign.privateKey : this.signing.privateKey;
    const signature = signWithRsa(signingInput, key);
    return `${signingInput}.${signature}`;
  }

  private keys(response: ServerResponse): void {
    const jwk = this.signing.publicKey.export({ format: 'jwk' });
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ keys: [{ ...jwk, kid: this.kid, use: 'sig', alg: 'RS256' }] }));
  }

  private graph(url: URL, response: ServerResponse): void {
    const accessToken = url.searchParams.get('access_token');
    if (accessToken === null || !this.accessTokens.has(accessToken)) {
      response.statusCode = 401;
      response.end();
      return;
    }

    // Facebook's `appsecret_proof`, checked rather than ignored: the adapter claims to send
    // it, and a claim nothing verifies is a comment.
    const expectedProof = createHmac('sha256', this.clientSecret)
      .update(accessToken, 'utf8')
      .digest('hex');
    if (url.searchParams.get('appsecret_proof') !== expectedProof) {
      response.statusCode = 400;
      response.end();
      return;
    }

    const profile: Record<string, unknown> = { id: this.account.subject };
    if (this.account.name !== undefined) profile['name'] = this.account.name;
    if (this.account.email !== undefined) profile['email'] = this.account.email;

    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(profile));
  }
}

function signWithRsa(signingInput: string, key: KeyObject): string {
  return signPayload('sha256', Buffer.from(signingInput, 'utf8'), key).toString('base64url');
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve());
    request.on('error', reject);
  });
  return Buffer.concat(chunks).toString('utf8');
}

function formPostHtml(action: string, fields: Readonly<Record<string, string>>): string {
  const inputs = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
    .join('');
  return `<!doctype html><html><body onload="document.forms[0].submit()"><form method="post" action="${escapeHtml(action)}">${inputs}</form></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
