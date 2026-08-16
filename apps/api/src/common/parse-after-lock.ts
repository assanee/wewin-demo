import type { ZodType } from 'zod';

import { AppError } from './errors/app-error';

/**
 * `ZodBodyPipe`'s parse, performed inside the transaction instead — same error, same shape.
 *
 * A pipe runs before the handler, and therefore before the order has been loaded under the
 * caller's scope. For every route that writes to a quote that ordering is wrong twice over: a
 * 400 about a malformed precondition on an order the caller cannot see is an existence oracle,
 * and on `removeLine` the *shape* of the legal body depends on the row this transaction has
 * locked — so the body cannot be judged before the lock is held.
 *
 * Shared rather than copied because `QuotesService` and `OrdersService.reissueQuote` are two
 * halves of one act: the edit and the sending of it. Two copies of this function would be two
 * sentences a customer could be shown for the same mistake, drifting apart one round at a time.
 */
export function parseAfterLock<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;

  throw AppError.badRequest('รูปแบบข้อมูลที่ส่งมาไม่ถูกต้อง', {
    source: 'body',
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map((segment) => String(segment)).join('.'),
      message: issue.message,
    })),
  });
}
