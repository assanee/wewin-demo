import { describe, expect, it } from 'vitest';

import {
  HIDDEN_REASONS,
  hideBody,
  hideIsReady,
  reasonLabel,
} from '../src/components/reviews/hide-reason';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ HIDING A REVIEW COSTS A REASON AND A NAME — plan 9.3.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The name comes from the session and is never sent: *"a moderator naming somebody else is
 * the failure the whole recorded-person requirement exists to stop."* So the only thing this
 * screen decides is the reason, and the one rule around it.
 *
 * ⚠️ **`other` is not a loophole.** `hideReviewRequestSchema` refines it — reason `other`
 * with a null note is refused — and `reviews_hidden_other_needs_a_note` refuses it again in
 * Postgres. A screen that allowed the button would teach that rule through a 422, which is
 * the worst place to learn that a hidden review needs an explanation: after the moderator
 * has already decided to hide it and moved on.
 *
 * The second rule is quieter. `noteTh` is `optionalProse`, meaning **null** and not `''` —
 * an empty string is a note that says nothing, recorded as though somebody wrote one.
 */

describe('the vocabulary', () => {
  it('offers the five reasons the API accepts, each in Thai', () => {
    expect(HIDDEN_REASONS).toHaveLength(5);

    for (const reason of HIDDEN_REASONS) {
      expect(reasonLabel(reason), `${reason} has no Thai label`).toMatch(/[฀-๿]/);
    }
  });
});

describe('⭐ other needs a note', () => {
  it('is not ready with other and nothing written', () => {
    expect(hideIsReady('other', '')).toBe(false);
    expect(hideIsReady('other', '    ')).toBe(false);
  });

  it('is ready with other once something is written', () => {
    expect(hideIsReady('other', 'ลูกค้าขอให้ถอดออกทางโทรศัพท์')).toBe(true);
  });

  it('is ready for the four named reasons with no note at all', () => {
    for (const reason of HIDDEN_REASONS.filter((entry) => entry !== 'other')) {
      expect(hideIsReady(reason, ''), `${reason} demanded a note it should not`).toBe(true);
    }
  });
});

describe('⚠️ the body sends null, never an empty string', () => {
  it('omits the note when nobody wrote one', () => {
    /*
     * `optionalProse` is `null`-shaped. Sending `''` would store a note that says nothing
     * against a hidden review — indistinguishable, later, from a moderator who explained
     * themselves and was ignored.
     */
    expect(hideBody('spam', '   ')).toStrictEqual({ reason: 'spam', noteTh: null });
  });

  it('trims what somebody did write', () => {
    expect(hideBody('other', '  ซ้ำกับรีวิวก่อนหน้า  ')).toStrictEqual({
      reason: 'other',
      noteTh: 'ซ้ำกับรีวิวก่อนหน้า',
    });
  });

  it('keeps a note on a named reason, because context is worth having', () => {
    expect(hideBody('personal_data', 'มีเบอร์โทรของช่างอยู่ในเนื้อรีวิว')).toStrictEqual({
      reason: 'personal_data',
      noteTh: 'มีเบอร์โทรของช่างอยู่ในเนื้อรีวิว',
    });
  });
});
