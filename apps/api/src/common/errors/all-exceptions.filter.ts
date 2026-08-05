import {
  Catch,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import {
  encodeServerMessage,
  message,
  normaliseLocale,
  parseAcceptLanguage,
  renderInThai,
  renderServerMessage,
  type ServerMessage,
} from '../../i18n';
import { getRequestId } from '../request-id';
import { AppError, type ErrorCode, type ErrorEnvelope, type JsonValue } from './app-error';

/**
 * An explicit choice, which beats what the browser was configured with.
 *
 * A person who picked Vietnamese in the app has said something more specific than
 * `Accept-Language: en-GB,en;q=0.9`, and a header is the right place for it: it needs to
 * reach every endpoint without appearing in 200 route signatures, and unlike a query
 * parameter it does not fragment a cache key or leak into a shared URL.
 */
const LOCALE_HEADER = 'x-wewin-locale';

/** Codes Nest itself produces before any of our code runs — 404s, malformed JSON bodies. */
const CODE_BY_STATUS: ReadonlyMap<number, ErrorCode> = new Map([
  [HttpStatus.BAD_REQUEST, 'BAD_REQUEST'],
  // The guard throws Nest's own UnauthorizedException/ForbiddenException, so these two are
  // the entries that keep `code` honest for every 401 and 403 in the process.
  [HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED'],
  [HttpStatus.FORBIDDEN, 'FORBIDDEN'],
  [HttpStatus.NOT_FOUND, 'NOT_FOUND'],
  [HttpStatus.CONFLICT, 'CONFLICT'],
  [HttpStatus.PAYLOAD_TOO_LARGE, 'PAYLOAD_TOO_LARGE'],
  [HttpStatus.TOO_MANY_REQUESTS, 'TOO_MANY_REQUESTS'],
  [HttpStatus.UNPROCESSABLE_ENTITY, 'VALIDATION_FAILED'],
  [HttpStatus.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE'],
]);

interface Normalised {
  readonly status: number;
  readonly code: ErrorCode;
  /** The Thai sentence — what goes in the log, and what an un-migrated call site produced. */
  readonly message: string;
  /** Present when this error has a key, which is what lets the answer change language. */
  readonly serverMessage: ServerMessage | undefined;
  readonly details: JsonValue | undefined;
}

/**
 * What language to answer this request in.
 *
 * The explicit header first, then `Accept-Language`, then nothing — and `null` rather than
 * Thai for "nothing", because `renderServerMessage` distinguishes *no preference* from *a
 * preference we could not honour* and only the second is a degradation worth reporting.
 */
function requestedLocaleOf(request: Request): string | null {
  const explicit = request.headers[LOCALE_HEADER];
  const named = Array.isArray(explicit) ? explicit[0] : explicit;
  if (typeof named === 'string' && normaliseLocale(named) !== null) return named;

  const accept = request.headers['accept-language'];
  const header = Array.isArray(accept) ? accept.join(',') : accept;
  return parseAcceptLanguage(header);
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpException');

  constructor(@Inject(ENV) private readonly env: Env) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const normalised = this.normalise(exception);
    const { status, code, details, serverMessage } = normalised;

    /*
     * 5xx is our bug and gets the stack; 4xx is the caller's and would otherwise fill the
     * log with noise anyone can generate by typing a wrong URL.
     *
     * The *Thai* sentence is logged, never the rendered one. A German customer's error and
     * the log line an engineer greps for have to be the same string, and the only way they
     * can be is if the log does not follow the customer's language.
     */
    const { message } = normalised;
    if (status >= 500) {
      this.logger.error(`${request.method} ${request.url} -> ${status} ${code}: ${message}`, stackOf(exception));
    } else {
      this.logger.debug(`${request.method} ${request.url} -> ${status} ${code}: ${message}`);
    }

    /*
     * ⭐ The one place an error becomes prose in somebody's language.
     *
     * An un-migrated call site has no `serverMessage` and its Thai string is answered as-is,
     * with no `messageKey` and no `locale` — a client can therefore tell "this one cannot be
     * translated yet" from "this one was translated and came out Thai anyway".
     */
    const rendered =
      serverMessage === undefined ? undefined : renderServerMessage(serverMessage, requestedLocaleOf(request));
    const wire = serverMessage === undefined ? undefined : encodeServerMessage(serverMessage);

    const envelope: ErrorEnvelope = {
      error: {
        code,
        message: rendered?.text ?? message,
        ...(wire === undefined ? {} : { messageKey: wire.key, messageParams: wire.params as JsonValue }),
        ...(rendered === undefined
          ? {}
          : {
              locale: {
                requested: rendered.locale.requested,
                rendered: rendered.locale.rendered,
                degraded: rendered.locale.degraded,
              },
            }),
        ...(details === undefined ? {} : { details }),
        requestId: getRequestId(request),
        path: request.url,
        timestamp: new Date().toISOString(),
      },
    };

    if (response.headersSent) {
      // Streaming already started; the client will see a truncated body either way, and
      // writing headers now would throw inside the filter and mask the original error.
      response.end();
      return;
    }
    response.status(status).json(envelope);
  }

  private normalise(exception: unknown): Normalised {
    if (exception instanceof AppError) {
      return {
        status: exception.status,
        code: exception.code,
        message: exception.message,
        serverMessage: exception.serverMessage,
        details: exception.details,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = CODE_BY_STATUS.get(status) ?? (status >= 500 ? 'INTERNAL' : 'BAD_REQUEST');
      /*
       * No key. Nest's own messages — a 404 for an unrouted path, zod's field list — are
       * generated by a library and are not sentences this catalogue owns. Inventing keys for
       * them would mean a catalogue entry per validation error message, which is a catalogue
       * of somebody else's strings.
       */
      return { status, code, message: messageOf(exception), serverMessage: undefined, details: undefined };
    }

    const infrastructural = classifyInfrastructural(exception);
    if (infrastructural) return infrastructural;

    /*
     * An unrecognised throw is a bug in this service. Its message may name a table, a
     * column or a connection string, so outside development the client gets nothing but
     * the request id — which is enough to find the logged stack.
     *
     * In production it now goes through the catalogue like everything else. It was the
     * literal English `'Internal server error.'` with `serverMessage: undefined`, which made
     * the 500 — the error a client is most likely to actually meet — the one response that
     * skipped the language negotiation the rest of this file exists to do, and answered a
     * Thai customer in English.
     *
     * Development keeps the raw throw, unkeyed: the whole point of it is to be the
     * exception's own words, and a key would replace them with a sentence.
     */
    if (this.env.NODE_ENV === 'development') {
      const message = exception instanceof Error ? exception.message : String(exception);
      return { status: 500, code: 'INTERNAL', message, serverMessage: undefined, details: undefined };
    }

    return normalisedFrom(500, 'INTERNAL', message('error.internal.unexpected'));
  }
}

/**
 * Two throws that are neither ours nor Nest's, and that were both being reported as bugs.
 *
 * `normalise` had exactly two recognisers — `AppError` and `HttpException` — and everything
 * else was "a bug in this service": 500, `code: INTERNAL`, a logged stack, and, in
 * production, an alert. Both of the cases below are reachable by any client, neither is a
 * bug, and each has an answer that tells the caller something true.
 *
 * **The body was too large.** body-parser throws a plain `PayloadTooLargeError` with
 * `type: 'entity.too.large'`, which is not an `HttpException`. Its honest answer is 413 —
 * "you sent more than this endpoint accepts" — and the difference matters because a customer
 * whose legitimate hundred-line order crosses the limit is currently told the server broke.
 * Reachable unauthenticated on `POST /orders`.
 *
 * **The connection pool was exhausted.** Every order write holds a pooled connection across
 * a `SELECT … FOR UPDATE` that is *designed* to block on the other writers, so past
 * `DATABASE_POOL_MAX` concurrent writes to one order the surplus waits and then fails with
 * node-postgres's own timeout — measured at width 11 against a pool of 10. That is
 * congestion, not a defect: the correct answer is 503 with `Retry-After` semantics, which a
 * client may retry, rather than a 500 that says the request was malformed in some
 * unknowable way and pages somebody at three in the morning.
 *
 * Both are matched on the properties the libraries actually set rather than on `instanceof`:
 * neither type is exported for use in a `catch`, and a copy of either constructor loaded
 * from a second node_modules path would make an `instanceof` silently false.
 */
function classifyInfrastructural(exception: unknown): Normalised | undefined {
  if (!(exception instanceof Error)) return undefined;

  const type = (exception as { type?: unknown }).type;
  if (type === 'entity.too.large') {
    return normalisedFrom(
      HttpStatus.PAYLOAD_TOO_LARGE,
      'PAYLOAD_TOO_LARGE',
      message('error.http.payload_too_large'),
    );
  }

  /*
   * node-postgres's `Pool` rejects with a bare `Error` whose message is exactly this when
   * `connectionTimeoutMillis` elapses with every client checked out. There is no code, no
   * class and no flag on it — the message is the whole of the signal, which is why the match
   * is exact rather than a substring: a *different* error mentioning a timeout must not be
   * quietly downgraded from "this is a bug" to "we are busy".
   */
  if (exception.message === 'timeout exceeded when trying to connect') {
    return normalisedFrom(HttpStatus.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE', message('error.http.busy'));
  }

  return undefined;
}

/**
 * A `Normalised` built from a key, with the Thai rendering filled in for the log.
 *
 * These two are not `AppError`s — they are recognised third-party throws — so they take the
 * long way round to the same place: a key on the envelope, Thai in the log.
 */
function normalisedFrom(status: number, code: ErrorCode, serverMessage: ServerMessage): Normalised {
  return { status, code, message: renderInThai(serverMessage), serverMessage, details: undefined };
}

function messageOf(exception: HttpException): string {
  const body = exception.getResponse();
  if (typeof body === 'string') {
    return body;
  }
  if (typeof body === 'object' && body !== null && 'message' in body) {
    const { message } = body as { message: unknown };
    if (typeof message === 'string') {
      return message;
    }
    if (Array.isArray(message)) {
      return message.map(String).join('; ');
    }
  }
  return exception.message;
}

function stackOf(exception: unknown): string | undefined {
  return exception instanceof Error ? exception.stack : undefined;
}
