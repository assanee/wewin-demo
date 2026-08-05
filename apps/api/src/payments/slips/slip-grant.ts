import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived, signed references to a slip image — plan 7.6's "URL ที่มีอายุสั้นและถูก audit".
 *
 * ── Why a signed token and not simply an authenticated route ─────────────────────
 *
 * Two reasons, and only the second is about convenience.
 *
 * **The upload handle is a capability, not an identifier.** The bytes go to the object
 * store before the slip row exists, so something has to carry "these bytes, for this order"
 * across two requests. If that something were the storage key in plain text, a caller could
 * send back *somebody else's* key — the key of a stranger's slip image — and the row they
 * created would name it. They would then be entitled to view it through their own slip,
 * because every check downstream is about the slip they own. Two endpoints that are each
 * individually correct, composing into a disclosure of a stranger's bank details. A MAC
 * over `(order, key)` makes the key unforgeable, so the composition cannot happen.
 *
 * **The view grant is what puts a private image in an `<img>` tag.** A browser does not
 * attach an `Authorization` header to an image request, so a route behind a bearer token
 * cannot be rendered by the dashboard without fetching the whole file into a blob. This is
 * the same shape as an S3 presigned URL and carries the same, stated, property: **anybody
 * holding the URL can fetch it until it expires.** That is why the window is minutes and
 * why the grant names its audience, so the log line says who it was minted for.
 *
 * ── Domain separation is not decoration ─────────────────────────────────────────
 *
 * The kind is part of the signed message, not merely part of the payload. Without it an
 * upload handle — which a caller is *given*, and which names a storage key — could be
 * replayed as a view grant for that key. With it, the two live in different namespaces of
 * the same key and a token of one kind fails verification as the other.
 *
 * ── What this file is not ───────────────────────────────────────────────────────
 *
 * It is not an authentication mechanism and no route may treat it as one beyond the single
 * thing it asserts: *this server minted this token, for this subject, and it has not
 * expired.* Everything else — does the slip still exist, was the image erased, is this
 * order terminal — is read from the database when the token is redeemed.
 */

/** Digits of a base64url payload plus a MAC. Compact enough for a query-free path segment. */
const SEPARATOR = '.';

const HMAC = 'sha256';

/** Minted for one request; the caller redeems it immediately. Five minutes is generous. */
export const UPLOAD_HANDLE_TTL_SECONDS = 15 * 60;

/**
 * ⚠️ A DEFAULT, and a small one on purpose.
 *
 * Plan 13 does not ask for this number, so it is not a plan-13 default with an owner
 * waiting to answer it — it is an engineering choice, stated: long enough for a dashboard
 * to render an image and for a person to click "download", short enough that a URL pasted
 * into a chat is useless by the time anybody reads it. If a review screen ever needs to sit
 * open for an hour, the fix is for the client to re-mint, not for this to grow.
 */
export const IMAGE_GRANT_TTL_SECONDS = 5 * 60;

export type GrantKind = 'upload' | 'view' | 'download';

/** What an upload handle carries: the bytes, and the order they were accepted for. */
export interface UploadClaims {
  readonly kind: 'upload';
  readonly orderId: string;
  readonly storageKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
  readonly expiresAtMs: number;
}

/** What a view or download grant carries: one slip, one purpose, one named audience. */
export interface ImageGrantClaims {
  readonly kind: 'view' | 'download';
  readonly slipId: string;
  readonly storageKey: string;
  /**
   * Who it was minted for — `user:<id>`, `guest:<id>`.
   *
   * Not enforced on redemption (the whole point is that the browser presents no identity),
   * and that is exactly why it is *recorded*: it is the difference between an access log
   * that says "somebody fetched a slip" and one that says which member of staff was handed
   * the URL that fetched it.
   */
  readonly audience: string;
  readonly expiresAtMs: number;
}

export type GrantClaims = UploadClaims | ImageGrantClaims;

export type GrantFailure =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'wrong_kind';

export type GrantResult<T> = { readonly ok: true; readonly claims: T } | { readonly ok: false; readonly reason: GrantFailure };

/* ────────────────────────────────────────────────────────────────────────────── *
 * The wire form
 * ────────────────────────────────────────────────────────────────────────────── */

/**
 * Short keys because the token is a path segment and a path segment has a length budget.
 *
 * They are also never read by anything but this file: the token is opaque to every client,
 * which is what lets the shape change without a contract version.
 */
interface UploadPayload {
  readonly k: 'upload';
  readonly o: string;
  readonly s: string;
  readonly c: string;
  readonly b: number;
  readonly w: number;
  readonly h: number;
  readonly x: number;
}

interface ImagePayload {
  readonly k: 'view' | 'download';
  readonly l: string;
  readonly s: string;
  readonly a: string;
  readonly x: number;
}

function encode(payload: UploadPayload | ImagePayload, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}${SEPARATOR}${mac(payload.k, body, key)}`;
}

/**
 * The MAC covers the kind *and* the body.
 *
 * `hmac(kind || '\0' || body)` and not `hmac(kind + body)`: a separator that cannot occur
 * in either operand is what stops two different (kind, body) pairs from producing the same
 * message. Base64url has no NUL, so this one cannot.
 */
function mac(kind: GrantKind, body: string, key: Buffer): string {
  return createHmac(HMAC, key).update(kind).update('\0').update(body).digest('base64url');
}

/**
 * Constant-time comparison, with the length check done on buffers of equal size.
 *
 * `timingSafeEqual` throws on a length mismatch, and a caller that catches that and returns
 * false has leaked the length through an exception path. Both sides are re-encoded from the
 * same digest length here, so a token with a truncated MAC fails the `Buffer.byteLength`
 * test below rather than reaching the comparison.
 */
function macMatches(expected: string, received: string): boolean {
  const left = Buffer.from(expected, 'base64url');
  const right = Buffer.from(received, 'base64url');
  if (left.byteLength !== right.byteLength || left.byteLength === 0) return false;
  return timingSafeEqual(left, right);
}

function decode(token: string, kind: GrantKind, key: Buffer, nowMs: number): GrantResult<unknown> {
  const cut = token.indexOf(SEPARATOR);
  if (cut <= 0 || cut === token.length - 1) return { ok: false, reason: 'malformed' };

  const body = token.slice(0, cut);
  const received = token.slice(cut + 1);

  if (!macMatches(mac(kind, body, key), received)) return { ok: false, reason: 'bad_signature' };

  const parsed = parseJson(body);
  if (parsed === undefined) return { ok: false, reason: 'malformed' };

  /*
   * The kind is checked again after the MAC even though it was part of the signed message.
   * Belt and braces on purpose: the MAC proves *we* minted a token of this kind, and this
   * proves the payload we are about to read agrees. A future edit that widened the MAC
   * input would otherwise silently remove the separation.
   */
  if (!isRecord(parsed) || parsed['k'] !== kind) return { ok: false, reason: 'wrong_kind' };

  const expiry = parsed['x'];
  if (typeof expiry !== 'number' || !Number.isFinite(expiry)) return { ok: false, reason: 'malformed' };
  if (expiry <= nowMs) return { ok: false, reason: 'expired' };

  return { ok: true, claims: parsed };
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(source: Record<string, unknown>, name: string): string | undefined {
  const value = source[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(source: Record<string, unknown>, name: string): number | undefined {
  const value = source[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/* ────────────────────────────────────────────────────────────────────────────── *
 * Minting and verifying
 * ────────────────────────────────────────────────────────────────────────────── */

export interface UploadHandleInput {
  readonly orderId: string;
  readonly storageKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
}

export function mintUploadHandle(
  input: UploadHandleInput,
  key: Buffer,
  nowMs: number,
  ttlSeconds: number = UPLOAD_HANDLE_TTL_SECONDS,
): { readonly token: string; readonly expiresAtMs: number } {
  const expiresAtMs = nowMs + ttlSeconds * 1000;
  return {
    token: encode(
      {
        k: 'upload',
        o: input.orderId,
        s: input.storageKey,
        c: input.contentType,
        b: input.byteSize,
        w: input.width,
        h: input.height,
        x: expiresAtMs,
      },
      key,
    ),
    expiresAtMs,
  };
}

export function verifyUploadHandle(token: string, key: Buffer, nowMs: number): GrantResult<UploadClaims> {
  const decoded = decode(token, 'upload', key, nowMs);
  if (!decoded.ok) return decoded;

  const claims = decoded.claims;
  if (!isRecord(claims)) return { ok: false, reason: 'malformed' };

  const orderId = stringField(claims, 'o');
  const storageKey = stringField(claims, 's');
  const contentType = stringField(claims, 'c');
  const byteSize = numberField(claims, 'b');
  const width = numberField(claims, 'w');
  const height = numberField(claims, 'h');
  const expiresAtMs = numberField(claims, 'x');

  if (
    orderId === undefined ||
    storageKey === undefined ||
    contentType === undefined ||
    byteSize === undefined ||
    width === undefined ||
    height === undefined ||
    expiresAtMs === undefined
  ) {
    return { ok: false, reason: 'malformed' };
  }

  return {
    ok: true,
    claims: { kind: 'upload', orderId, storageKey, contentType, byteSize, width, height, expiresAtMs },
  };
}

export interface ImageGrantInput {
  readonly slipId: string;
  readonly storageKey: string;
  readonly audience: string;
  readonly purpose: 'view' | 'download';
}

export function mintImageGrant(
  input: ImageGrantInput,
  key: Buffer,
  nowMs: number,
  ttlSeconds: number = IMAGE_GRANT_TTL_SECONDS,
): { readonly token: string; readonly expiresAtMs: number } {
  const expiresAtMs = nowMs + ttlSeconds * 1000;
  return {
    token: encode(
      { k: input.purpose, l: input.slipId, s: input.storageKey, a: input.audience, x: expiresAtMs },
      key,
    ),
    expiresAtMs,
  };
}

/**
 * Verify a grant of *either* purpose, and report which one it was.
 *
 * The purpose is not an argument, because the redeeming route must not be able to decide
 * it: a route that took `purpose` from the path and verified against that would accept a
 * `view` token on the download path by simply being called differently. The token says what
 * it is for, and the route reads that back.
 */
export function verifyImageGrant(token: string, key: Buffer, nowMs: number): GrantResult<ImageGrantClaims> {
  for (const kind of ['view', 'download'] as const) {
    const decoded = decode(token, kind, key, nowMs);

    if (decoded.ok) {
      const claims = decoded.claims;
      if (!isRecord(claims)) return { ok: false, reason: 'malformed' };

      const slipId = stringField(claims, 'l');
      const storageKey = stringField(claims, 's');
      const audience = stringField(claims, 'a');
      const expiresAtMs = numberField(claims, 'x');

      if (slipId === undefined || storageKey === undefined || audience === undefined || expiresAtMs === undefined) {
        return { ok: false, reason: 'malformed' };
      }

      return { ok: true, claims: { kind, slipId, storageKey, audience, expiresAtMs } };
    }

    /*
     * An expired token is expired whichever purpose it carries, and saying so is better
     * than the `bad_signature` the other branch would report. A signature failure, by
     * contrast, only means "not this kind" and the loop must go on to try the other.
     */
    if (decoded.reason === 'expired') return decoded;
  }

  return { ok: false, reason: 'bad_signature' };
}

/** A fresh key, for the non-production fallback. 32 bytes, which is the block size of SHA-256. */
export function mintGrantKey(): Buffer {
  return randomBytes(32);
}
