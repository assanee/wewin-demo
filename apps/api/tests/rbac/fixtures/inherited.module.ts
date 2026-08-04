import { Controller, Get, Module } from '@nestjs/common';

import { AllowAnonymous, RequirePermissions } from '../../../src/rbac/access';

/**
 * The most ordinary refactor there is, and the one that used to defeat the whole audit.
 *
 * Nest discovers inherited handlers — `MetadataScanner.getAllMethodNames` walks the
 * prototype chain — so both controllers below route `items`, and both route *the same
 * function object*. The registry keys records by that object, which is deliberate (it is
 * what makes the map the audit built and the map the guard reads the same map), and it
 * means a `Map` physically cannot hold two records for them.
 *
 * Before this was refused at boot, the second controller scanned silently overwrote the
 * first and both routes were served under whichever access came last: either
 * `GET /admin/items` answering 200 to a stranger, or the public catalogue demanding
 * `users.read`. The audit printed "all guarded" and the process exited 0 either way.
 *
 * A shared CRUD base class is the single most likely thing to appear in phase 4, which is
 * why this fixture exists rather than a note in a review.
 */
abstract class ListingBase {
  @Get('items')
  items(): { readonly ok: true } {
    return { ok: true };
  }
}

@Controller('shop')
@AllowAnonymous('the public catalogue')
export class PublicListingController extends ListingBase {}

@Controller('admin')
@RequirePermissions('users.read')
export class AdminListingController extends ListingBase {}

/** Both orders are the bug; this one is the order that used to leave `/admin/items` open. */
@Module({ controllers: [AdminListingController, PublicListingController] })
export class InheritedHandlerModule {}
