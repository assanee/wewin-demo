import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import { requireScope } from './identity';
import type { Scope } from './scope';

/**
 * The scope the guard resolved, as a handler parameter.
 *
 * A handler that takes `@CurrentScope() scope: Scope` cannot forget to ask, and cannot
 * get a different answer from the one the guard enforced — it is the same object. It
 * throws rather than returning `public` when there is none (see `requireScope`), because
 * the scope is what a repository filters rows by and a wrong default there is a leak.
 *
 * Repositories take a `Scope` and dispatch on it with `matchScope`, so "every query
 * carries a scope" is checked by the compiler rather than by review.
 */
export const CurrentScope = createParamDecorator((_data: unknown, context: ExecutionContext): Scope =>
  requireScope(context.switchToHttp().getRequest<object>()),
);
