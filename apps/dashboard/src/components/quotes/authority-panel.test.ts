import { describe, expect, it } from 'vitest';

import { ceilingClaim } from './authority-panel';

/**
 * ⭐ The sentence the quote screen is allowed to say about the reader's own ceiling.
 *
 * Found in a browser, not here: an administrator granted `bootstrap_staff` a ฿5,000 margin
 * ceiling on the authority screen, and every quote with no discount on it went on saying
 * **ยังไม่มีการกำหนดเพดานอำนาจสำหรับบทบาทของคุณ**. The API was correct throughout — it simply
 * does not report a ceiling on `nothing_conceded`, because `AuthorityService.judge` returns
 * before reading the table when nothing has been conceded. The screen turned "did not say"
 * into "you have none", which is a different claim and a false one.
 *
 * No API test could have caught it, because every assertion about the wire was right: the wire
 * said `null` and meant two things. That is now fixed where it belongs — `CeilingWire` carries
 * `known` — so what these tests pin is a translation of three server answers into three
 * sentences, with no reconstruction left in the client to get wrong.
 */

describe('what the panel may claim about a ceiling', () => {
  it('reports the number whenever the API reported one', () => {
    expect(ceilingClaim({ ceiling: { known: true, thbMinor: 500_000n } })).toEqual({
      kind: 'ceiling',
      ceilingThbMinor: 500_000n,
    });

    /* ฿0 is a real ceiling — "may record a concession, may approve none of its own". */
    expect(ceilingClaim({ ceiling: { known: true, thbMinor: 0n } })).toEqual({
      kind: 'ceiling',
      ceilingThbMinor: 0n,
    });
  });

  /**
   * `known: true, thbMinor: null` is the server saying it looked and there was nothing —
   * `judge`'s `ceiling ?? null` on the `needs_approval` branch. That is a fact, and the red
   * fail-closed line is the honest rendering of it.
   */
  it('claims fail-closed only when the server says it looked and found none', () => {
    expect(ceilingClaim({ ceiling: { known: true, thbMinor: null } })).toEqual({
      kind: 'none_granted',
    });
  });

  /**
   * ⭐ The regression, and the reason the wire changed rather than this function.
   *
   * `{ known: false }` used to arrive as the same `null` as "no row", so this line rendered the
   * red "your role has no ceiling" sentence on `nothing_conceded` and `covered_by_approval` —
   * on quotes where the reader may well hold one. The first fix reconstructed the difference
   * here from `outcome`; the wire now states it, so `outcome` is not consulted at all and there
   * is no branch left to get wrong.
   */
  it('says nothing about a ceiling the API did not report', () => {
    expect(ceilingClaim({ ceiling: { known: false } })).toEqual({ kind: 'unknown' });
  });
});
