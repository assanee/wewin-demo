import { Inject, Injectable, Logger } from '@nestjs/common';

import { MEDIA_CONFIG } from '../media.tokens';
import type { MediaConfig } from '../media.config';
import { EMPTY_PAYLOAD_SHA256, sha256Hex, signRequest } from './sigv4';

/**
 * The bucket, as three verbs.
 *
 * Deliberately small and deliberately unaware of the catalogue: it moves bytes to and from
 * a key and has no opinion about what a key means. Everything that decides *which* key —
 * content addressing, deduplication, the delete guard — lives in media.service.ts, so that
 * this file can be pointed at AWS S3, R2 or a Thai provider's object store by changing four
 * environment variables and nothing else.
 *
 * Nothing here retries. A failed upload surfaces to the caller as a 502 and the person
 * presses the button again, which is the correct behaviour for an interactive operation and
 * is not the correct behaviour for a background job — when the first background job lands,
 * that is the moment to reach for the SDK rather than to grow a retry loop in here.
 */

export class StorageError extends Error {
  /** HTTP status from the store, or 0 when the request never produced a response. */
  readonly status: number;
  /** S3's own error code (`NoSuchKey`, `AccessDenied`) when the body carried one. */
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'StorageError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Not `RequestInit`. Everything that reaches the wire has to be signed, and `RequestInit`
 * admits shapes SigV4 cannot canonicalise — `Headers`, an array of pairs, a stream body
 * whose bytes cannot be hashed before they are sent. Narrowing here is what makes
 * "the signature covers what was actually sent" true by construction.
 */
interface SignedRequestInit {
  readonly body?: Buffer;
  readonly headers?: Record<string, string>;
}

export interface StoredObject {
  /** Streamed rather than buffered: the serving route pipes this straight to the client. */
  readonly body: AsyncIterable<Uint8Array>;
  readonly contentLength: number | undefined;
}

@Injectable()
export class ObjectStorage {
  private readonly logger = new Logger('ObjectStorage');
  /**
   * Memoised, so the existence check costs one round trip per process rather than one per
   * upload. A rejected promise is cleared, because a store that was down at boot is not a
   * store that is down forever.
   */
  private bucketReady: Promise<void> | undefined;

  constructor(@Inject(MEDIA_CONFIG) private readonly config: MediaConfig) {}

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.ensureBucket();

    const response = await this.send('PUT', key, {
      body,
      headers: {
        'content-type': contentType,
        /*
         * `content-length` is deliberately not set and therefore not signed. `fetch` derives
         * it from the body itself, and a header the runtime is entitled to rewrite must not
         * appear in `SignedHeaders` — the store would then hash a value we did not send and
         * answer `SignatureDoesNotMatch`, which says nothing about the actual cause.
         */
        /*
         * The bytes are immutable by construction — the key is their own SHA-256 — so this
         * is a fact about the object rather than a hint. It is set here, at the moment of
         * writing, so that a CDN put in front of the bucket later gets it for free.
         */
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });

    await drain(response);
    if (!response.ok) throw await storageError(response, `PUT ${key}`);
  }

  async getObject(key: string): Promise<StoredObject> {
    const response = await this.send('GET', key, {});

    if (!response.ok) throw await storageError(response, `GET ${key}`);
    if (response.body === null) throw new StorageError(`GET ${key} returned no body`, response.status);

    const declared = response.headers.get('content-length');
    return {
      body: response.body,
      contentLength: declared === null ? undefined : Number(declared),
    };
  }

  /**
   * Removing an object that is not there is a success, not an error — S3 says so, and it is
   * also what the caller wants: the delete path runs after the row is already gone, so a
   * retry must not fail on the second attempt.
   */
  async deleteObject(key: string): Promise<void> {
    const response = await this.send('DELETE', key, {});
    await drain(response);
    if (!response.ok && response.status !== 404) throw await storageError(response, `DELETE ${key}`);
  }

  /**
   * Create the bucket if it is not there.
   *
   * docker-compose.yml already creates it, and this still exists — because a bucket that
   * exists only because of a line in a compose file is a bucket that does not exist in
   * production, and the failure would be a 404 on the first upload of a new deployment
   * rather than at any point somebody was watching. If the credentials are scoped to
   * object operations only (which is what a production account should be), the create is
   * refused with 403 and that is logged and carried on from: the bucket was provisioned by
   * whoever scoped the account.
   */
  async ensureBucket(): Promise<void> {
    this.bucketReady ??= this.checkOrCreateBucket().catch((error: unknown) => {
      this.bucketReady = undefined;
      throw error;
    });
    return this.bucketReady;
  }

  private async checkOrCreateBucket(): Promise<void> {
    const head = await this.sendToUrl('HEAD', this.bucketUrl(), {});
    await drain(head);
    if (head.ok) return;
    if (head.status !== 404) throw await storageError(head, `HEAD bucket ${this.config.bucket}`);

    const created = await this.sendToUrl('PUT', this.bucketUrl(), {});
    await drain(created);
    if (created.ok) {
      this.logger.log(`Created bucket ${this.config.bucket}`);
      return;
    }
    if (created.status === 403) {
      this.logger.warn(
        `Bucket ${this.config.bucket} is not visible and cannot be created with these credentials; ` +
          'assuming it exists and is scoped to object operations.',
      );
      return;
    }
    throw await storageError(created, `PUT bucket ${this.config.bucket}`);
  }

  private send(method: string, key: string, init: SignedRequestInit): Promise<Response> {
    return this.sendToUrl(method, this.objectUrl(key), init);
  }

  private async sendToUrl(method: string, url: URL, init: SignedRequestInit): Promise<Response> {
    const body = init.body;
    const headers = signRequest(
      {
        method,
        url,
        headers: init.headers ?? {},
        payloadSha256: body === undefined ? EMPTY_PAYLOAD_SHA256 : sha256Hex(body),
      },
      {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
        region: this.config.region,
      },
    );

    try {
      return await fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: new Uint8Array(body) }),
      });
    } catch (cause) {
      /*
       * The message names the endpoint and never the credentials. A connection refused here
       * is the single most likely failure on a laptop — `docker compose up` not run — and
       * the endpoint is the entire diagnostic.
       */
      throw new StorageError(
        `${method} to ${url.origin} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        0,
      );
    }
  }

  private bucketUrl(): URL {
    return this.config.pathStyle
      ? new URL(`${this.config.endpoint}/${this.config.bucket}`)
      : withBucketHost(this.config.endpoint, this.config.bucket, '');
  }

  /**
   * Path style (`endpoint/bucket/key`) is what MinIO serves and what AWS has been retiring
   * for years, hence the switch. The key is *not* URI-encoded into the URL here: `URL`
   * normalises the path it is given, and `sigv4.ts` re-encodes segment by segment when it
   * canonicalises — encoding twice is one of the two ways to get `SignatureDoesNotMatch`
   * with a perfectly correct key.
   */
  private objectUrl(key: string): URL {
    return this.config.pathStyle
      ? new URL(`${this.config.endpoint}/${this.config.bucket}/${key}`)
      : withBucketHost(this.config.endpoint, this.config.bucket, `/${key}`);
  }
}

function withBucketHost(endpoint: string, bucket: string, path: string): URL {
  const url = new URL(endpoint + path);
  url.hostname = `${bucket}.${url.hostname}`;
  return url;
}

/**
 * Read and discard a body we do not want.
 *
 * `fetch` keeps the connection allocated until the body is consumed or cancelled, so a PUT
 * whose (empty) response body is ignored leaks a socket per upload — a slow leak that looks
 * like the object store getting gradually slower.
 */
async function drain(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    /* The body failed to read; the request already succeeded or failed on its status. */
  }
}

/**
 * S3 reports errors as an XML document. Only the `<Code>` is extracted, and the raw body is
 * never carried into the thrown error: it echoes the key, and in some deployments the
 * bucket policy, into whatever logs this.
 */
async function storageError(response: Response, what: string): Promise<StorageError> {
  const text = await response.text().catch(() => '');
  const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
  return new StorageError(`${what} failed with ${String(response.status)}`, response.status, code);
}
