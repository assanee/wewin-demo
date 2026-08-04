import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, for S3, written out.
 *
 * Two hundred lines of a published specification, rather than `@aws-sdk/client-s3`, and the
 * reason is not taste. This round runs alongside other agents editing this monorepo, and a
 * dependency is not a file — it is `apps/api/package.json` **and** `pnpm-lock.yaml`, both of
 * which are shared surfaces that somebody else's uncommitted work is already sitting on. The
 * v3 SDK also arrives as forty-odd `@smithy/*` packages, for one PUT, one GET and one DELETE
 * against a single bucket.
 *
 * What is given up by not using it, said plainly: retries with jitter, multipart upload for
 * objects over 5 GB, IMDS/SSO credential resolution, and the checksum negotiation the SDK
 * does. None of those are load-bearing here — uploads are capped at a few megabytes and
 * credentials come from the environment — but a future round that needs any of them should
 * take the dependency rather than grow this file.
 *
 * SigV4 itself is worth understanding before changing anything below, because every mistake
 * in it produces the same symptom, `SignatureDoesNotMatch`, with no clue which of the six
 * steps was wrong. The signature covers a *canonical request*: the method, the path, the
 * query, a chosen set of headers, and a hash of the body. Both sides build that string
 * independently and compare hashes, so a single byte of disagreement — a header the server
 * normalised differently, a slash encoded where it should not be, a body hashed before
 * rather than after modification — fails identically.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';

/** SHA-256 of zero bytes. Every request with no body carries this as its payload hash. */
export const EMPTY_PAYLOAD_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
}

export interface SignableRequest {
  readonly method: string;
  /** Absolute. Its path and query are what get canonicalised; its host is what gets signed. */
  readonly url: URL;
  /** Without `host`, `x-amz-date` or `x-amz-content-sha256` — those are added here. */
  readonly headers: Readonly<Record<string, string>>;
  /** Hex SHA-256 of the exact bytes that will be sent. */
  readonly payloadSha256: string;
  /** Injectable so a test can pin the signature of a known request. */
  readonly now?: Date;
}

export function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * The signed header set, ready to hand to `fetch`.
 *
 * Returns headers rather than mutating the input, because a signature is only valid for the
 * exact headers it was computed over — and a function that signs *and* lets the caller keep
 * editing the object it signed is a function that produces valid-looking invalid requests.
 */
export function signRequest(request: SignableRequest, credentials: SigV4Credentials): Record<string, string> {
  const now = request.now ?? new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    ...lowercaseKeys(request.headers),
    host: request.url.host,
    'x-amz-date': amzDate,
    /*
     * Not optional for S3, and not merely informational: the payload hash is part of the
     * canonical request, so this header and the signature have to agree or the request is
     * rejected. UNSIGNED-PAYLOAD is the alternative and is not used here — every body this
     * app sends is already in memory and already hashed for its content address, so signing
     * it costs nothing and means a proxy cannot alter an upload in flight undetected.
     */
    'x-amz-content-sha256': request.payloadSha256,
  };

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${collapseWhitespace(headers[name] ?? '')}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalPath(request.url.pathname),
    canonicalQuery(request.url.searchParams),
    canonicalHeaders,
    signedHeaders,
    request.payloadSha256,
  ].join('\n');

  const scope = `${dateStamp}/${credentials.region}/s3/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const signature = hmac(signingKey(credentials, dateStamp), stringToSign).toString('hex');

  return {
    ...headers,
    authorization:
      `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** `20130524T000000Z` — basic ISO 8601, which is not what `toISOString` produces. */
function formatAmzDate(now: Date): string {
  return `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
}

function hmac(key: Buffer | string, message: string): Buffer {
  return createHmac('sha256', key).update(message, 'utf8').digest();
}

/**
 * The four-step derived key: date, region, service, terminator.
 *
 * Chained deliberately so that a leaked signing key is only good for one day, in one region,
 * for one service — which is the entire reason SigV4 does not just HMAC with the secret.
 */
function signingKey(credentials: SigV4Credentials, dateStamp: string): Buffer {
  const date = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const region = hmac(date, credentials.region);
  const service = hmac(region, 's3');
  return hmac(service, 'aws4_request');
}

/**
 * Percent-encode the path, one segment at a time, leaving the separators alone.
 *
 * S3 is the exception among AWS services: its canonical path is encoded **once**, not twice.
 * Encoding a slash inside a key here is what makes `a/b` and `a%2Fb` different objects
 * rather than one object with two spellings.
 */
function canonicalPath(pathname: string): string {
  if (pathname === '') return '/';
  return pathname
    .split('/')
    .map((segment) => encodeRfc3986(decodeURIComponent(segment)))
    .join('/');
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params]
    .map(([key, value]): readonly [string, string] => [encodeRfc3986(key), encodeRfc3986(value)])
    .sort((left, right) => (left[0] === right[0] ? compare(left[1], right[1]) : compare(left[0], right[0])))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * `encodeURIComponent` leaves `!'()*` unescaped; RFC 3986 — and therefore AWS — does not.
 * A key containing an apostrophe would otherwise sign one way and be read another.
 */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Header values are compared with runs of whitespace collapsed and the ends trimmed. */
function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function lowercaseKeys(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}
