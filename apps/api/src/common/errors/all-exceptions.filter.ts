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
import { getRequestId } from '../request-id';
import { AppError, type ErrorCode, type ErrorEnvelope, type JsonValue } from './app-error';

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
  readonly message: string;
  readonly details: JsonValue | undefined;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpException');

  constructor(@Inject(ENV) private readonly env: Env) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const { status, code, message, details } = this.normalise(exception);

    /*
     * 5xx is our bug and gets the stack; 4xx is the caller's and would otherwise fill the
     * log with noise anyone can generate by typing a wrong URL.
     */
    if (status >= 500) {
      this.logger.error(`${request.method} ${request.url} -> ${status} ${code}: ${message}`, stackOf(exception));
    } else {
      this.logger.debug(`${request.method} ${request.url} -> ${status} ${code}: ${message}`);
    }

    const envelope: ErrorEnvelope = {
      error: {
        code,
        message,
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
      return { status: exception.status, code: exception.code, message: exception.message, details: exception.details };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = CODE_BY_STATUS.get(status) ?? (status >= 500 ? 'INTERNAL' : 'BAD_REQUEST');
      return { status, code, message: messageOf(exception), details: undefined };
    }

    const infrastructural = classifyInfrastructural(exception);
    if (infrastructural) return infrastructural;

    /*
     * An unrecognised throw is a bug in this service. Its message may name a table, a
     * column or a connection string, so outside development the client gets nothing but
     * the request id — which is enough to find the logged stack.
     */
    const message =
      this.env.NODE_ENV === 'development'
        ? `${exception instanceof Error ? exception.message : String(exception)}`
        : 'Internal server error.';
    return { status: 500, code: 'INTERNAL', message, details: undefined };
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
    return {
      status: HttpStatus.PAYLOAD_TOO_LARGE,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'ข้อมูลที่ส่งมามีขนาดใหญ่เกินกว่าที่ระบบรับได้',
      details: undefined,
    };
  }

  /*
   * node-postgres's `Pool` rejects with a bare `Error` whose message is exactly this when
   * `connectionTimeoutMillis` elapses with every client checked out. There is no code, no
   * class and no flag on it — the message is the whole of the signal, which is why the match
   * is exact rather than a substring: a *different* error mentioning a timeout must not be
   * quietly downgraded from "this is a bug" to "we are busy".
   */
  if (exception.message === 'timeout exceeded when trying to connect') {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'SERVICE_UNAVAILABLE',
      message: 'ระบบกำลังมีคำขอพร้อมกันจำนวนมาก กรุณาลองใหม่อีกครั้ง',
      details: undefined,
    };
  }

  return undefined;
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
