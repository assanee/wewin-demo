import { describe, expect, it } from 'vitest';

import { isReviewRating, splitReviewable, writeReviewBody, type ReviewableLine } from './reviewableLines';

const line = (over: Partial<ReviewableLine>): ReviewableLine => ({
  quoteLineId: 'l1',
  orderId: 'o1',
  orderNo: 'WW-1000',
  productId: 'hang-single',
  productNameTh: 'บานแขวน เดี่ยว',
  deliveredAt: '2026-08-01T00:00:00.000Z',
  reviewId: null,
  ...over,
});

describe('splitting what can be reviewed from what already was', () => {
  it('⚠️ keeps the reviewed lines instead of filtering them away', () => {
    /*
     * The reason this is a function and not a `.filter()` at the call site. A customer who
     * reviewed something last month and comes back looking for it must be told it is done;
     * a list that silently drops it reads as "the system lost my review".
     */
    const split = splitReviewable([
      line({ quoteLineId: 'a' }),
      line({ quoteLineId: 'b', reviewId: 'r1' }),
    ]);

    expect(split.pending.map((l) => l.quoteLineId)).toStrictEqual(['a']);
    expect(split.written.map((l) => l.quoteLineId)).toStrictEqual(['b']);
  });

  it('⭐ puts the newest delivery first in both halves', () => {
    const split = splitReviewable([
      line({ quoteLineId: 'old', deliveredAt: '2026-01-01T00:00:00.000Z' }),
      line({ quoteLineId: 'new', deliveredAt: '2026-08-01T00:00:00.000Z' }),
      line({ quoteLineId: 'mid', deliveredAt: '2026-04-01T00:00:00.000Z' }),
    ]);

    expect(split.pending.map((l) => l.quoteLineId)).toStrictEqual(['new', 'mid', 'old']);
  });

  it('does not mutate the array it was handed, which is React state', () => {
    const input = [
      line({ quoteLineId: 'old', deliveredAt: '2026-01-01T00:00:00.000Z' }),
      line({ quoteLineId: 'new', deliveredAt: '2026-08-01T00:00:00.000Z' }),
    ];
    splitReviewable(input);

    expect(input.map((l) => l.quoteLineId)).toStrictEqual(['old', 'new']);
  });

  it('answers with two empty halves for an empty list', () => {
    expect(splitReviewable([])).toStrictEqual({ pending: [], written: [] });
  });
});

describe('the body sent to POST /reviews', () => {
  it('⭐ omits blank text rather than sending an empty string', () => {
    /*
     * `optionalProse` refuses `''`, so sending it turns "five stars and no words" — the
     * commonest review there is — into a 400 the customer cannot act on.
     */
    const body = writeReviewBody('line-1', 5, '   ', '  ');

    expect(body).toStrictEqual({ quoteLineId: 'line-1', rating: 5 });
    expect('bodyTh' in body).toBe(false);
    expect('authorDisplayName' in body).toBe(false);
  });

  it('trims what was typed and keeps it when there is any', () => {
    expect(writeReviewBody('line-1', 4, '  ดีมาก  ', '  มานี  ')).toStrictEqual({
      quoteLineId: 'line-1',
      rating: 4,
      bodyTh: 'ดีมาก',
      authorDisplayName: 'มานี',
    });
  });

  it('⚠️ never sends a `token` key, which is what the invitation form does and why it 400s', () => {
    /*
     * `writeReviewRequestSchema` is a `z.strictObject`. `ReviewFormIsland` posts
     * `{ token, rating, … }` and is refused twice over: `quoteLineId` missing, `token`
     * unrecognised. This assertion is the guard against somebody "helpfully" reuniting the
     * two shapes by adding the token back here.
     */
    expect(Object.keys(writeReviewBody('line-1', 3, 'x', ''))).toStrictEqual([
      'quoteLineId',
      'rating',
      'bodyTh',
    ]);
  });
});

describe('what counts as a rating', () => {
  it('accepts one through five and nothing else', () => {
    expect([1, 2, 3, 4, 5].every(isReviewRating)).toBe(true);
    expect(isReviewRating(0)).toBe(false);
    expect(isReviewRating(6)).toBe(false);
    /* Half stars are the tempting one: `reviews_rating_range` holds a smallint. */
    expect(isReviewRating(4.5)).toBe(false);
  });
});
