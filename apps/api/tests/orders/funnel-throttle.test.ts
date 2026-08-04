import { describe, expect, it } from 'vitest';

import {
  ANONYMOUS_CART_LIMIT_PER_WINDOW_DEFAULT,
  ANONYMOUS_CART_WINDOW_MS,
  FixedWindowCounter,
} from '../../src/orders/funnel-throttle.middleware';

/**
 * The ceiling on the anonymous funnel — the policy, without an HTTP server and without
 * waiting an hour for a window to close.
 *
 * `POST /orders` is `AllowAnonymous` because it is the route that *mints* the principal, so
 * it is unauthenticated row creation, and until this existed there was no limit on it
 * anywhere in the application: a loop filled `guests`, `orders` and `order_events` with rows
 * `orders_block_delete()` will not let anybody remove, and two calls per iteration queued a
 * `sales_queue` notification carrying attacker-written prose.
 */
describe('the anonymous funnel ceiling', () => {
  it('admits exactly the limit and refuses the next one', () => {
    const counter = new FixedWindowCounter(3, 60_000);

    expect(counter.hit('a')).toBe(2);
    expect(counter.hit('a')).toBe(1);
    expect(counter.hit('a')).toBe(0);
    /* Negative is the refusal — the middleware's only test of it. */
    expect(counter.hit('a')).toBeLessThan(0);
  });

  it('counts each source separately, so one visitor cannot close the funnel', () => {
    const counter = new FixedWindowCounter(1, 60_000);

    expect(counter.hit('a')).toBe(0);
    expect(counter.hit('a')).toBeLessThan(0);
    /* A different address is untouched: a shared ceiling would be a denial of service. */
    expect(counter.hit('b')).toBe(0);
  });

  it('starts a fresh window once the old one has passed', async () => {
    const counter = new FixedWindowCounter(1, 5);

    expect(counter.hit('a')).toBe(0);
    expect(counter.hit('a')).toBeLessThan(0);

    await new Promise((resolve) => setTimeout(resolve, 12));
    expect(counter.hit('a'), 'the window never reopened').toBe(0);
  });

  it('ships a limit that is a documented default rather than a decision', () => {
    /*
     * Plan 13 does not ask this question, so there is no policy to point at and the number is
     * this module's own. Pinned so that a change to it is a change somebody made on purpose,
     * and so that "60 an hour" cannot quietly become "6" or "6000".
     */
    expect(ANONYMOUS_CART_LIMIT_PER_WINDOW_DEFAULT).toBe(60);
    expect(ANONYMOUS_CART_WINDOW_MS).toBe(60 * 60 * 1000);
  });
});
