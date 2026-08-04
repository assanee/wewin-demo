import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../common/errors/app-error';
import { readIdentity } from '../rbac';

/**
 * A ceiling on how many carts one source may mint without identifying itself.
 *
 * ── What is unbounded without it ─────────────────────────────────────────────────
 *
 * `POST /orders` is `AllowAnonymous` for a reason that is not negotiable: it is the route
 * that *mints* the principal, and a first-time visitor has neither a session nor a guest
 * cookie. Plan section 6 calls that funnel the main path. So the endpoint is unauthenticated
 * row creation, and until this file existed there was no limit on it anywhere in the
 * application. Two consequences were demonstrated against the running API:
 *
 *   **Permanent rows, at will.** Each call writes a `guests` row, an `orders` row and an
 *   `order_events` row, and `orders_block_delete()` is deliberate about not letting them be
 *   removed once submitted. A loop fills the tables and nothing anywhere objects.
 *
 *   **The company's own inbox, as a target.** Two anonymous calls — create, then cancel with
 *   a `reason` — queue a `sales_queue` notification carrying up to two thousand characters of
 *   attacker-written prose. Ten in a loop queued ten.
 *
 * ── What this limits, and what it deliberately does not ──────────────────────────
 *
 * Only requests with **no session**. A signed-in customer is exempt: they are already
 * rate-limited by the fact of having an account, and metering them here would put a cruder
 * rule in front of one that is already precise.
 *
 * A caller carrying a *guest cookie* is metered, and that is a deliberate choice rather than
 * an oversight of where the identity is attached. `readIdentity` is written by
 * `AuthenticationMiddleware` for a session, and for a guest it is written by `RbacGuard`,
 * which runs *after* middleware — so a guest looks anonymous here. Reading the cookie
 * directly would exempt them, and exempting them would be wrong anyway: the cookie is free
 * to acquire, so "hold one cookie and loop" is the same attack with one extra request.
 *
 * It is a ceiling and not a defence against a distributed source: the key is the client
 * address, and an attacker with a thousand addresses gets a thousand buckets. That is the
 * honest limit of anything in this process, and the thing that would actually bound it —
 * a shared counter, or a proof-of-work, or an identified funnel — is a decision about the
 * funnel's conversion rate that belongs to the business rather than to this file.
 *
 * ⚠️ **The number is this module's own default.** Plan 13 does not ask this question; there
 * is no policy to point at. Sixty per hour is chosen to be far above any human shopping for
 * windows (a person configures one, perhaps three) and far below a useful mailer. Ninety
 * per hour would be as defensible. When somebody measures the real funnel, this is the line
 * to change, and it should become configuration at that point rather than staying here.
 */
export const ANONYMOUS_CART_LIMIT_PER_WINDOW_DEFAULT = 60;

/** One hour, in milliseconds. The window is fixed rather than sliding — see `hit`. */
export const ANONYMOUS_CART_WINDOW_MS = 60 * 60 * 1000;

/**
 * A fixed-window counter, in memory.
 *
 * In memory, and therefore per process: two instances behind a load balancer allow twice
 * the traffic. Stated rather than hidden, because the alternative — Redis — is a dependency
 * this application does not otherwise have, and adding one to enforce a number nobody has
 * chosen yet would be the wrong order of decisions. A per-process ceiling still turns
 * "unbounded" into "bounded", which is the whole of the change.
 *
 * Fixed rather than sliding: a sliding window needs a timestamp per hit, which is a list per
 * address, which is the memory an attacker would then fill. A fixed window costs one integer
 * per address per hour, and its known weakness — twice the limit across a boundary — does
 * not matter for a ceiling whose purpose is to make a loop stop.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * The counter, separated from the middleware so that the *policy* can be tested without an
 * HTTP server and without waiting an hour for a window to close.
 *
 * The middleware below constructs one with the defaults; a test constructs one with a limit
 * of two and a window of milliseconds. Nest never sees this class, which is deliberate — a
 * constructor with injectable-looking parameters on a middleware is a container error
 * waiting to happen (`Nest can't resolve dependencies … argument Number at index [0]`).
 */
export class FixedWindowCounter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  get windowSeconds(): number {
    return Math.ceil(this.windowMs / 1000);
  }

  get max(): number {
    return this.limit;
  }

  /** Remaining allowance after counting this request; negative means refused. */
  hit(key: string): number {
    const now = Date.now();
    const existing = this.buckets.get(key);

    if (existing === undefined || existing.resetAt <= now) {
      /*
       * Expired buckets are dropped opportunistically, on the next request from the same
       * address, rather than swept by a timer. The map is bounded by the number of distinct
       * addresses seen within one window, which is the same set the counters are about —
       * there is nothing a sweep could reclaim that a request will not.
       */
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return this.limit - 1;
    }

    existing.count += 1;
    return this.limit - existing.count;
  }
}

@Injectable()
export class FunnelThrottleMiddleware implements NestMiddleware {
  private readonly counter = new FixedWindowCounter(
    ANONYMOUS_CART_LIMIT_PER_WINDOW_DEFAULT,
    ANONYMOUS_CART_WINDOW_MS,
  );

  use(request: Request, response: Response, next: NextFunction): void {
    /*
     * A session or a guest cookie means a referent already exists. `readIdentity` is what
     * `AuthenticationMiddleware` and the guard both write, and it is read here rather than
     * the raw cookie so that "who is this" has one answer in the process.
     */
    if (readIdentity(request) !== undefined) {
      next();
      return;
    }

    const key = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    const remaining = this.counter.hit(key);

    if (remaining < 0) {
      /*
       * 429, with the window in the body. Not 403: nothing about the caller is forbidden,
       * and a customer who genuinely hits this — a shared office address, a NAT — needs to
       * be told it is temporary. `Retry-After` is in seconds, per RFC 9110.
       */
      response.setHeader('Retry-After', String(this.counter.windowSeconds));
      throw new AppError(
        'TOO_MANY_REQUESTS',
        429,
        'มีการเริ่มรายการใหม่จากที่อยู่นี้บ่อยเกินไป กรุณาลองใหม่ในภายหลัง',
        { limit: this.counter.max, windowSeconds: this.counter.windowSeconds },
      );
    }

    next();
  }
}
