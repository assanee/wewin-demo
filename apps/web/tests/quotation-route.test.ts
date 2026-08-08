import { describe, expect, it } from 'vitest';

import { quotationSource } from '../src/lib/quotation/api';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ TWO WAYS TO OPEN A QUOTATION, AND ONE OF THEM DID NOT EXIST.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The page read `?t=` and nothing else. `MyQuotations` linked to `/orders` with no token, and
 * `RequestQuotationForm` did the same — under a comment of mine asserting that "the ordinary
 * owned-order route works for it". **There was no such route.** Every customer who pressed
 * their own quotation in their own list was told the link had expired.
 *
 * So there are two, and they are for different people:
 *
 *   `?t=…`      a bearer token from an email — any device, no account, no cookie;
 *   `?order=…`  an id, opened by somebody **signed in who owns it** — the list, the success
 *               screen, and coming back next month on a different phone.
 *
 * ── ⚠️ A token beside an id must still be ignored ────────────────────────────
 *
 * `document-link.pg.test.ts` pins the API half: the order id comes out of the signature and
 * never from a parameter, because a valid signature beside an attacker-chosen id is every
 * quotation the company has issued. This is the client half of the same rule — when a token
 * is present it decides, and `order` is not even read.
 */

describe('⭐ which of the two ways this URL is', () => {
  it('reads a token when there is one', () => {
    expect(quotationSource('?t=abc.def.ghi')).toStrictEqual({ kind: 'token', token: 'abc.def.ghi' });
  });

  it('⭐ reads an order id when there is no token', () => {
    /* The path that did not exist, and the one every link in the app was using. */
    expect(quotationSource('?order=11111111-2222-4333-8444-555555555555')).toStrictEqual({
      kind: 'owned',
      orderId: '11111111-2222-4333-8444-555555555555',
    });
  });

  it('⭐ lets the token win when both are present', () => {
    /*
     * The client half of the API's rule. A holder of one valid link must not be able to point
     * it at another order by adding a parameter — and the shapes are close enough that the
     * precedence has to be asserted rather than assumed.
     */
    expect(quotationSource('?t=abc.def.ghi&order=99999999-2222-4333-8444-555555555555')).toStrictEqual(
      { kind: 'token', token: 'abc.def.ghi' },
    );
  });

  it('⚠️ refuses an order id that is not a uuid, without asking the server', () => {
    /*
     * Not politeness. It is the one value this page puts straight into a URL path, and a
     * refusal here is cheaper and quieter than a 404 the person cannot act on.
     */
    expect(quotationSource('?order=../../admin')).toStrictEqual({ kind: 'none' });
    expect(quotationSource('?order=hello')).toStrictEqual({ kind: 'none' });
  });

  it('answers `none` for a bare path', () => {
    expect(quotationSource('')).toStrictEqual({ kind: 'none' });
    expect(quotationSource('?t=')).toStrictEqual({ kind: 'none' });
  });
});
