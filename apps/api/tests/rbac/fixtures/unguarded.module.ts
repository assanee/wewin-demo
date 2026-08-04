import { Controller, Get, Module, Post } from '@nestjs/common';

import { AllowAnonymous } from '../../../src/rbac/access';

/**
 * The mistake, written down.
 *
 * A controller where somebody added a second endpoint next to a decorated one and did not
 * decorate it. This is what the boot audit exists to catch, and the reason the fixture has
 * a *pair* of routes rather than a single naked one: an audit that only fired on a
 * controller with no decorators anywhere would miss the case that actually happens, which
 * is one forgotten handler among several correct ones.
 */
@Controller('fixture')
export class HalfGuardedController {
  @Get('declared')
  @AllowAnonymous('this one was remembered')
  declared(): { ok: true } {
    return { ok: true };
  }

  @Post('forgotten')
  forgotten(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [HalfGuardedController] })
export class UnguardedModule {}

/** Nothing on it at all — the same failure, reached the other way. */
@Controller('bare')
export class BareController {
  @Get()
  index(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [BareController] })
export class BareModule {}
