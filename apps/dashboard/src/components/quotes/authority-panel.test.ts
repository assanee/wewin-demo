import { describe, expect, it } from 'vitest';

import { ceilingClaim } from './authority-panel';

/**
 * ⭐ The sentence the quote screen is allowed to say about the reader's own ceiling.
 *
 * Found in a browser, not here: an administrator granted `bootstrap_staff` a ฿5,000 margin
 * ceiling on `/users` → อำนาจอนุมัติ, and every quote with no discount on it went on saying
 * **ยังไม่มีการกำหนดเพดานอำนาจสำหรับบทบาทของคุณ**. The API was correct throughout — it simply
 * does not report a ceiling on `nothing_conceded`, because `AuthorityService.judge` returns
 * before reading the table when nothing has been conceded. The screen turned "did not say"
 * into "you have none", which is a different claim and a false one.
 *
 * No API test could have caught it: every assertion about the wire was, and remains, right.
 */

describe('what the panel may claim about a ceiling', () => {
  it('reports the number whenever the API gave one', () => {
    expect(ceilingClaim({ ceilingThbMinor: 500_000n, outcome: 'within_authority' })).toEqual({
      kind: 'ceiling',
      ceilingThbMinor: 500_000n,
    });

    /* ฿0 is a real ceiling — "may record a concession, may approve none of its own". */
    expect(ceilingClaim({ ceilingThbMinor: 0n, outcome: 'needs_approval' })).toEqual({
      kind: 'ceiling',
      ceilingThbMinor: 0n,
    });
  });

  /**
   * The one outcome whose `null` is a fact rather than a silence: `judge` writes
   * `ceilingThbMinor: ceiling ?? null` on this branch, so a null here really is "this role
   * holds no live `authority_limits` row".
   */
  it('claims fail-closed only when the quote actually needs an approval', () => {
    expect(ceilingClaim({ ceilingThbMinor: null, outcome: 'needs_approval' })).toEqual({
      kind: 'none_granted',
    });
  });

  /**
   * ⭐ The regression. Both of these used to render the red "your role has no ceiling" line,
   * on quotes where the reader may well hold one.
   */
  it('says nothing about a ceiling the API did not report', () => {
    expect(ceilingClaim({ ceilingThbMinor: null, outcome: 'nothing_conceded' })).toEqual({
      kind: 'unknown',
    });
    expect(ceilingClaim({ ceilingThbMinor: null, outcome: 'covered_by_approval' })).toEqual({
      kind: 'unknown',
    });
  });
});
