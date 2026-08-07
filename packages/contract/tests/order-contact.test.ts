import { describe, expect, it } from 'vitest';

import { orderContactRequestSchema } from '../src/order.js';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ A CHANNEL, NOT AN ADDRESS.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Plan 10.2's rule is that a quote nobody can be written to is useless, and it was
 * implemented as "an email address" because email was the only channel there was. Thai
 * customers frequently have no address they use, so the rule is now "at least one of an
 * address and a telephone number".
 *
 * ⚠️ **This file exists because relaxing the database was not enough.** The CHECK was moved
 * to email-or-phone and a phone-only submit still failed — with a 400 from zod, in a schema
 * two packages away from the constraint. Two statements of one rule, and only one of them
 * was changed.
 *
 * So the contract states it too, and these tests are what keeps the two agreeing.
 *
 * ── ⭐ The number is canonical or it is refused ──────────────────────────────
 *
 * `orders_contact_phone_e164` and `user_phones_number_e164` demand the same E.164 string, so
 * a contact number and a username are comparable. A schema that accepted `081-234-5678` here
 * would produce a row the database refuses — a 500 where a sentence belongs.
 */

const ok = (value: unknown) => orderContactRequestSchema.safeParse(value);

describe('⭐ at least one channel, and either will do', () => {
  it('accepts an address alone, as it always did', () => {
    expect(ok({ email: 'somchai@example.test' }).success).toBe(true);
  });

  it('⭐ accepts a telephone number alone', () => {
    /*
     * The whole point. This was a 400 until the schema caught up with the CHECK, and the
     * failure looked like a client bug rather than a rule stated in two places.
     */
    const parsed = ok({ phone: '+66812345678', name: 'สมชาย' });

    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('accepts both', () => {
    expect(ok({ email: 'somchai@example.test', phone: '+66812345678' }).success).toBe(true);
  });

  it('⭐ refuses a contact with neither', () => {
    /*
     * The rule the relaxation must not lose. An order nobody can be reached about is what
     * plan 10.2 is entirely about, and "no email" must not have quietly become "no channel".
     */
    expect(ok({ name: 'สมชาย' }).success).toBe(false);
    expect(ok({}).success).toBe(false);
  });
});

describe('⚠️ the number is stored the one way the database will accept', () => {
  it.each(['081-234-5678', '0812345678', '+66 81 234 5678', '66812345678'])(
    'refuses %s, which is the same number spelled another way',
    (written) => {
      /*
       * Refused rather than normalised **here**. The contract is shared with browsers and a
       * transform in it would mean the storefront and the API each held an opinion about what
       * a number is; `@wewin/core/phone` is the single one, and the client calls it before it
       * sends. A refusal names the problem where the person can fix it.
       */
      expect(ok({ phone: written }).success).toBe(false);
    },
  );

  it('accepts the canonical form', () => {
    expect(ok({ phone: '+66812345678' }).success).toBe(true);
    expect(ok({ phone: '+6561234567' }).success).toBe(true);
  });
});

describe('the address rules are unchanged', () => {
  it('lower-cases on the way in', () => {
    const parsed = orderContactRequestSchema.parse({ email: 'Somchai@Example.TEST' });

    expect(parsed.email).toBe('somchai@example.test');
  });

  it('still refuses something that is not an address', () => {
    expect(ok({ email: 'somchai' }).success).toBe(false);
  });
});
