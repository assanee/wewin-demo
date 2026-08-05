import { describe, expect, it } from 'vitest';

import { faultOnEvent } from '../../../src/payments/refunds/refunds.repository';

/**
 * 🔒 `fault` decides how much money goes back, so it is read from the spine and from nowhere else.
 *
 * Plan 7.8: *"`fault` ห้ามรับจาก request body — มันตัดสินว่าลูกค้าได้เงินคืนเท่าไร"*. 5a derives it
 * at the moment of cancellation, from the actor and from an **unresolved** bounce, and writes it
 * onto an append-only row. This module reads that row and has no parameter through which a caller
 * could supply it — `refunds.pg.test.ts` proves the end-to-end half of that, with a company-fault
 * cancellation forfeiting nothing where an identical customer-fault one forfeits half.
 *
 * ── Why this file exists at all ──────────────────────────────────────────────────
 *
 * One branch of `faultOnEvent` is unreachable over HTTP. `order_events.payload` is `jsonb NOT
 * NULL` and `order_events_guard_insert()` refuses a `cancelled` event whose payload does not
 * carry `reason`, which only an object satisfies — so a mutation of the non-object branch stayed
 * **green through every end-to-end test in this phase**, which is the definition of a guard with
 * no evidence behind it. The function is exported so the branch has some.
 *
 * The direction of every default below is the whole subject: unrecognised must never mean
 * `'company'`, because `'company'` is the value that forfeits nothing and refunds everything.
 */
describe('fault comes off the spine, and unrecognised means the customer', () => {
  it('reads the value 5a recorded', () => {
    expect(faultOnEvent({ reason: 'โรงงานทำไม่ได้', fault: 'company' })).toBe('company');
    expect(faultOnEvent({ reason: 'เปลี่ยนใจ', fault: 'customer' })).toBe('customer');
  });

  /* A pre-freeze cancellation carries `{reason}` and nothing else — `cancel_pre_freeze`. */
  it('treats a payload with no `fault` key as the customer’s', () => {
    expect(faultOnEvent({ reason: 'เปลี่ยนใจ' })).toBe('customer');
    expect(faultOnEvent({})).toBe('customer');
  });

  /* Anything that is not the literal `'company'`. Not a parse that throws — the two cases
   * (absent, and present-but-unrecognised) have the same correct answer. */
  it('treats an unrecognised value as the customer’s', () => {
    expect(faultOnEvent({ fault: 'COMPANY' })).toBe('customer');
    expect(faultOnEvent({ fault: 'both' })).toBe('customer');
    expect(faultOnEvent({ fault: true })).toBe('customer');
    expect(faultOnEvent({ fault: 1 })).toBe('customer');
    expect(faultOnEvent({ fault: null })).toBe('customer');
    expect(faultOnEvent({ fault: { kind: 'company' } })).toBe('customer');
  });

  /** The unreachable branch. `'null'::jsonb` and `'"x"'::jsonb` are both valid jsonb. */
  it('treats a payload that is not an object as the customer’s', () => {
    expect(faultOnEvent(null)).toBe('customer');
    expect(faultOnEvent(undefined)).toBe('customer');
    expect(faultOnEvent('company')).toBe('customer');
    expect(faultOnEvent(42)).toBe('customer');
    expect(faultOnEvent(['company'])).toBe('customer');
  });

  /*
   * `Object.hasOwn` semantics rather than `in`: a payload carrying `__proto__` must not be able to
   * reach a key lookup through the prototype chain. `JsonBodyMiddleware` rejects `__proto__` on
   * every request (5a's finding 5), and this is the second lock on the one field where it would
   * be worth the most.
   */
  it('cannot be told the fault through the prototype chain', () => {
    const hostile = JSON.parse('{"reason":"ok","__proto__":{"fault":"company"}}') as unknown;
    expect(faultOnEvent(hostile)).toBe('customer');
  });
});
