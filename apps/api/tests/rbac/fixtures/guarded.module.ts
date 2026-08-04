import {
  Controller,
  Get,
  Injectable,
  Module,
  type MiddlewareConsumer,
  type NestMiddleware,
  type NestModule,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { AllowAnonymous, RequireAuthenticated, RequirePermissions } from '../../../src/rbac/access';
import { CurrentScope } from '../../../src/rbac/current-scope.decorator';
import { attachIdentity } from '../../../src/rbac/identity';
import { describeScope, type Scope } from '../../../src/rbac/scope';

/**
 * A controller that says what each of its routes requires — one per policy.
 *
 * Every handler returns the scope the guard resolved rather than a fixed body, so a test
 * can assert not just "allowed" but "allowed *as whom*". A route that let a guest through
 * as if they were public would pass a status-code assertion and fail these.
 */
@Controller('fixture')
export class GuardedController {
  @Get('anonymous')
  @AllowAnonymous('stands in for the published catalogue: the funnel starts before sign-in')
  anonymous(@CurrentScope() scope: Scope): { scope: string } {
    return { scope: describeScope(scope) };
  }

  @Get('signed-in')
  @RequireAuthenticated()
  signedIn(@CurrentScope() scope: Scope): { scope: string } {
    return { scope: describeScope(scope) };
  }

  @Get('orders')
  @RequirePermissions('orders.read')
  orders(@CurrentScope() scope: Scope): { scope: string } {
    return { scope: describeScope(scope) };
  }

  @Get('refunds')
  @RequirePermissions('orders.read', 'orders.refund')
  refunds(@CurrentScope() scope: Scope): { scope: string } {
    return { scope: describeScope(scope) };
  }
}

/**
 * The authentication module, in one middleware.
 *
 * This is the whole seam: something validates a session and calls `attachIdentity` before
 * the guard runs. Here the "session" is a header, because this suite is about what the
 * guard does with an identity and not about how one is proven — but the call it makes is
 * the call apps/api/src/auth will make, which is what keeps the seam honest.
 */
export const TEST_USER_HEADER = 'x-test-user';
export const TEST_SESSION_ID = '11111111-1111-4111-8111-111111111111';

@Injectable()
export class TestIdentityMiddleware implements NestMiddleware {
  use(request: Request, _response: Response, next: NextFunction): void {
    const header = request.headers[TEST_USER_HEADER];
    const userId = Array.isArray(header) ? header[0] : header;
    if (userId !== undefined && userId.length > 0) {
      attachIdentity(request, { kind: 'user', userId, sessionId: TEST_SESSION_ID });
    }
    next();
  }
}

@Module({ controllers: [GuardedController] })
export class GuardedModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TestIdentityMiddleware).forRoutes('{*splat}');
  }
}
