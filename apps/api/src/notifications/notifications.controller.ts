import { Controller, Get, Header, HttpCode, Param, Post, Query } from '@nestjs/common';
import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from '@wewin/contract/version';

import { ZodBodyPipe } from '../admin/zod-body.pipe';
import { AppError } from '../common/errors/app-error';
import { RequirePermissions } from '../rbac';
import {
  deadQueueQuerySchema,
  type DeadQueueQuery,
  type DeadQueueWire,
  type NotificationAttemptWire,
  type OutboxSummaryWire,
  type RetryResultWire,
} from './notifications.contract';
import { NotificationsService } from './notifications.service';

/**
 * The queue plan 10.5(3) demands.
 *
 *     GET  /admin/notifications              summary + dead + suppressed, in one response
 *     GET  /admin/notifications/summary      counts only, cheap enough for a polling badge
 *     GET  /admin/notifications/:id/attempts every attempt at one message
 *     POST /admin/notifications/:id/retry    put a dead message back on the queue
 *
 * ── Why this exists at all ───────────────────────────────────────────────────
 *
 * "A dead-lettered notification that nobody sees is worse than none, because the company
 * believes the customer was told." A `dead` status with no screen is precisely that, and so
 * is a screen nobody has a reason to open — which is why the worker also logs at `error`
 * when the count changes (see notification-worker.service.ts). The two together are the
 * feature; either alone is decoration.
 *
 * `suppressed` is in the same response and is *not* the same thing. A suppressed row was
 * never addressable — a quote submitted with no contact channel, a LINE rule with nowhere
 * to send. Retrying it would fail identically, so it has no button; what it needs is
 * somebody to get an address, which is a different job for a different person, and merging
 * the two lists would bury the retryable ones.
 *
 * ── ⚠️ PERMISSIONS: BORROWED, AND THE HONEST SPLIT IS NAMED ──────────────────
 *
 * `orders.read` to look and `orders.write` to retry. **There is no `notifications.*`
 * permission and there should be** — `src/rbac/permissions.ts` is the catalogue for the
 * whole application and is outside what this round owns, exactly as `media` found in phase
 * 4 and documented in `media-admin.controller.ts`.
 *
 * The reuse is defensible rather than merely convenient: every row in this queue is about an
 * order, the failure text can quote an order number, and anybody who may read any customer's
 * order may already see more than this endpoint shows. But it is a borrow, and the split
 * that belongs in the catalogue is `notifications.read` / `notifications.retry` — because
 * re-sending a message to a customer is a customer-facing action, and the set of people who
 * should be able to take it is not obviously the set who may edit an order.
 */

const contractVersion = (): MethodDecorator => Header(CONTRACT_VERSION_HEADER, String(CONTRACT_VERSION));

@Controller('admin/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @contractVersion()
  @RequirePermissions('orders.read')
  async deadQueue(
    // The query pipe is the body pipe: both turn an untrusted record into a typed one and
    // both report which part of the request was wrong. `metadata.type` is what distinguishes
    // them in the error, so one class covers both without losing that.
    @Query(new ZodBodyPipe(deadQueueQuerySchema)) query: DeadQueueQuery,
  ): Promise<DeadQueueWire> {
    return this.notifications.deadQueue(query.limit);
  }

  @Get('summary')
  @contractVersion()
  @RequirePermissions('orders.read')
  async summary(): Promise<OutboxSummaryWire> {
    return this.notifications.summary();
  }

  @Get(':notificationId/attempts')
  @contractVersion()
  @RequirePermissions('orders.read')
  async attempts(@Param('notificationId') notificationId: string): Promise<{
    readonly attempts: readonly NotificationAttemptWire[];
  }> {
    const attempts = await this.notifications.attempts(requireUuid(notificationId));

    /*
     * An unknown id and a message that has never been attempted both produce an empty list,
     * and they are told apart deliberately: a 404 here would require a second query for a
     * fact nobody acts on, and an empty attempt list is the correct, useful answer for a
     * `pending` message somebody is looking at. The envelope is an object rather than a bare
     * array so the response can grow a field without becoming a breaking change.
     */
    return { attempts };
  }

  @Post(':notificationId/retry')
  @HttpCode(200)
  @contractVersion()
  @RequirePermissions('orders.write')
  async retry(@Param('notificationId') notificationId: string): Promise<RetryResultWire> {
    return this.notifications.retry(requireUuid(notificationId));
  }
}

/**
 * A path parameter is a string from the network, and this one reaches a `uuid` column.
 *
 * A malformed value would otherwise arrive at Postgres as `invalid input syntax for type
 * uuid` — a 500 for what is a client mistake, and a database error message echoed to
 * whoever sent it.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: string): string {
  if (!UUID.test(value)) throw AppError.badRequest('รหัสการแจ้งเตือนไม่ถูกต้อง');
  return value;
}
