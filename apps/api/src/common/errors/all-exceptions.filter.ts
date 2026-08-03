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
  [HttpStatus.NOT_FOUND, 'NOT_FOUND'],
  [HttpStatus.CONFLICT, 'CONFLICT'],
  [HttpStatus.PAYLOAD_TOO_LARGE, 'PAYLOAD_TOO_LARGE'],
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
