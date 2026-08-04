import { Controller, Get, Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';

import { RequirePrincipal } from '../../../src/rbac/access';
import { CurrentScope } from '../../../src/rbac/current-scope.decorator';
import { describeScope, type Scope } from '../../../src/rbac/scope';
import { TestIdentityMiddleware } from './guarded.module';

/**
 * A route declared with the policy the order lifecycle needs: somebody who can own rows.
 *
 * Its own module rather than another handler on `GuardedController`, so `guard.test.ts`
 * keeps the route set it was written against — a suite that starts seeing an extra route
 * is a suite whose author has to work out whether that mattered.
 *
 * The handler returns the resolved scope, for the reason the other fixture gives: the
 * interesting failure is not "allowed when it should not be", it is "allowed as the wrong
 * principal". A guest served as `public` here would pass a status assertion and then be
 * handed somebody else's cart by the next layer.
 */
@Controller('fixture/principal')
export class PrincipalController {
  @Get()
  @RequirePrincipal()
  own(@CurrentScope() scope: Scope): { scope: string } {
    return { scope: describeScope(scope) };
  }
}

@Module({ controllers: [PrincipalController] })
export class PrincipalModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TestIdentityMiddleware).forRoutes('{*splat}');
  }
}
