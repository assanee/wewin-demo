import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { ZodError, type ZodType } from 'zod';

import { AppError, type JsonValue } from '../common/errors/app-error';

/**
 * The one place an untrusted body becomes a typed one.
 *
 * `@wewin/contract` owns what a request may look like, and this is how a Nest handler
 * consumes that: `@Body(new ZodBodyPipe(createProductRequestSchema))`. It is deliberately
 * not `ValidationPipe` with class-validator — the shapes are already defined once, in zod,
 * in a package that web and dashboard also read, and a second decorator-based definition
 * on DTO classes would be a second answer to "what is a valid request" that only apps/api
 * can see.
 *
 * A failure is 400 and not 422: the body did not parse, so there is no request to have an
 * opinion about. 422 is reserved here for a well-formed request that would produce an
 * invalid *catalogue* — the distinction a dashboard needs to decide between "fix this
 * field" and "this combination is not allowed".
 *
 * The issue list is trimmed to path and message. A `ZodError` carries the input it
 * rejected, and echoing that back means the whole product document arrives inside an error
 * body, in a log, at whatever level errors are logged.
 */
@Injectable()
export class ZodBodyPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, metadata: ArgumentMetadata): T {
    const parsed = this.schema.safeParse(value);
    if (parsed.success) return parsed.data;

    throw AppError.badRequest('รูปแบบข้อมูลที่ส่งมาไม่ถูกต้อง', {
      // `body`, `query`, `param` — which part of the request was wrong, without which a
      // client with several validated arguments has to guess.
      source: metadata.type,
      issues: issuesOf(parsed.error),
    });
  }
}

function issuesOf(error: ZodError): JsonValue {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.'),
    message: issue.message,
  }));
}
