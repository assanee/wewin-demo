import { AppError } from '../common/errors/app-error';

/**
 * Constraint names, translated into answers.
 *
 * Same arrangement and the same reason as `orders/pg-errors.ts`, `quotes/pg-errors.ts` and
 * `payments/slips/slip-errors.ts`: the database is the enforcement and this file is the
 * *message*. Every rule below is checked by Postgres whether or not the service checked it
 * first — a `DELETE FROM reviews` typed into psql at midnight is refused by the same
 * trigger — so nothing here may be read as the guard. What it buys is that a rule arrives as
 * a 409 a client can act on rather than as a 500 with a SQLSTATE in it.
 *
 * ── Two of these can only fire on a race, and that is why they are here ──────────
 *
 * `reviews_line_key` and the reply's conditional UPDATE are both checked by the service
 * first, and both are still translated: two browser tabs, or a customer double-tapping a
 * button on a phone with a slow network, produce two requests that each pass the check and
 * one that loses the insert. Without a translation the loser gets a 500 and a support call;
 * with one it gets "you have already reviewed this window", which is true and is what
 * happened.
 */

interface PgError {
  readonly code: string;
  readonly constraint?: string;
  readonly message?: string;
}

function asPgError(error: unknown): PgError | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const candidate = error as { code: unknown; constraint?: unknown; message?: unknown };
  if (typeof candidate.code !== 'string') return undefined;

  return {
    code: candidate.code,
    ...(typeof candidate.constraint === 'string' ? { constraint: candidate.constraint } : {}),
    ...(typeof candidate.message === 'string' ? { message: candidate.message } : {}),
  };
}

/**
 * `23505` unique violation, `23514` check violation, `23503` foreign key, `23001` restrict —
 * which is what every `RAISE … USING ERRCODE = 'restrict_violation'` in the guards arrives as.
 *
 * Anything not named here is re-thrown untouched. A translator with a fallback message is a
 * translator that turns an unrecognised database error into a plausible sentence, and a
 * plausible sentence is what stops anybody investigating.
 */
export function translateReviewError(error: unknown): unknown {
  const pg = asPgError(error);
  if (pg === undefined) return error;

  const named = pg.constraint === undefined ? undefined : BY_CONSTRAINT[pg.constraint];
  if (named !== undefined) return named();

  /*
   * The guards raise with a message and no constraint name — a trigger has none to report —
   * so these are matched on the text the function itself wrote. Fragile by nature, which is
   * why each is anchored on a phrase that exists to be matched and why the fallback is to
   * re-throw rather than to guess.
   */
  if (pg.code === '23001' && pg.message !== undefined) {
    if (pg.message.includes('is hidden, never deleted')) {
      return AppError.conflict(
        'รีวิวถูกซ่อนได้ แต่ลบไม่ได้ — คะแนนยังนับในค่าเฉลี่ยเสมอ',
        { reason: 'reviews-are-hidden-never-deleted' },
      );
    }
    if (pg.message.includes('was removed from order')) {
      return AppError.conflict(
        'รายการนี้ถูกนำออกจากคำสั่งซื้อระหว่างการแก้แบบ จึงไม่มีสินค้าที่ส่งมอบให้รีวิว',
        { reason: 'line-removed-in-redesign' },
      );
    }
    if (pg.message.includes('is erased')) {
      return AppError.conflict('บัญชีนี้ถูกลบข้อมูลแล้ว จึงเผยแพร่เนื้อหาใหม่ไม่ได้', {
        reason: 'author-erased',
      });
    }
    if (pg.message.includes('has already been moderated')) {
      return AppError.conflict(
        'รีวิวนี้ผ่านการกลั่นกรองแล้ว จึงเพิ่มรูปไม่ได้ — รูปที่เพิ่มหลังจากนี้จะไม่มีใครได้ตรวจ',
        { reason: 'photos-close-when-moderation-settles' },
      );
    }
    if (pg.message.includes('the rating is fixed')) {
      return AppError.conflict('คะแนนถูกตรึงแล้วหลังผ่านการกลั่นกรอง', { reason: 'rating-frozen' });
    }
    if (pg.message.includes('what was published cannot be rewritten')) {
      return AppError.conflict('ข้อความที่เผยแพร่แล้วแก้ไขไม่ได้', { reason: 'published-text-frozen' });
    }
    /*
     * `order_child_require_status` — the review's order is not `delivered`. The service
     * checks this first and gives a better message; this is the race, and the race is real:
     * a review submitted while an order is being delivered blocks on `FOR SHARE` and
     * re-reads (trap 6), so it can genuinely arrive here.
     */
    if (pg.message.includes('delivered')) {
      return AppError.conflict('รีวิวได้เมื่อคำสั่งซื้อถูกส่งมอบแล้วเท่านั้น', {
        reason: 'order-not-delivered',
      });
    }
  }

  return error;
}

const BY_CONSTRAINT: Readonly<Record<string, () => AppError>> = {
  /** One review per line — plan 9.1's unit, and the thing two tabs both try to write. */
  reviews_line_key: () =>
    AppError.conflict('รายการนี้ถูกรีวิวไปแล้ว — หนึ่งรายการต่อหนึ่งรีวิว', {
      reason: 'one-review-per-line',
    }),

  /** The composite FK to `(id, product_version_id)`: a `freeform` line has no version to match. */
  reviews_line_version_fk: () =>
    AppError.conflict('รายการนี้ไม่ใช่สินค้าในแคตตาล็อก จึงรีวิวไม่ได้ (เช่น ค่าขนส่งหรือค่าบริการ)', {
      reason: 'freeform-line-is-not-reviewable',
    }),

  reviews_line_fk: () =>
    AppError.conflict('รายการที่ระบุไม่ได้อยู่ในคำสั่งซื้อนี้', { reason: 'line-not-in-order' }),

  reviews_rating_range: () =>
    AppError.badRequest('คะแนนต้องเป็นจำนวนเต็ม 1 ถึง 5', { reason: 'rating-out-of-range' }),

  reviews_body_not_blank: () =>
    AppError.badRequest('ข้อความรีวิวต้องไม่เป็นช่องว่าง', { reason: 'blank-body' }),

  reviews_hidden_other_needs_a_note: () =>
    AppError.badRequest('เหตุผล "อื่นๆ" ต้องระบุรายละเอียดกำกับ', { reason: 'other-needs-a-note' }),

  reviews_hidden_shape: () =>
    AppError.conflict('การซ่อนรีวิวต้องบันทึกทั้งเหตุผลและผู้กด', { reason: 'hiding-needs-a-reason-and-a-person' }),

  reviews_moderation_window_bounded: () =>
    AppError.badRequest('ระยะเวลากลั่นกรองอยู่นอกช่วงที่ระบบรับได้', { reason: 'moderation-window-out-of-range' }),

  /**
   * 📍 The EXIF guard. Reached only if something wrote a row without going through
   * `prepareReviewPhoto`, which refuses this case with a message about the file — so if a
   * client ever sees *this* sentence, the pipeline was bypassed and that is the bug.
   */
  review_photos_bytes_were_rewritten: () =>
    AppError.conflict(
      'ระบบยืนยันไม่ได้ว่ารูปถูกเขียนใหม่เพื่อลบข้อมูลตำแหน่ง (GPS) จึงไม่บันทึกรูปนี้',
      { reason: 'stored-bytes-equal-uploaded-bytes' },
    ),

  review_photos_review_seq_key: () =>
    AppError.conflict('อัปโหลดรูปพร้อมกันหลายไฟล์เกินไป กรุณาลองใหม่อีกครั้ง', {
      reason: 'photo-seq-race',
    }),

  review_photos_strip_recipe_present: () =>
    AppError.conflict('บันทึกรูปไม่ได้: ไม่มีชื่อกระบวนการล้างข้อมูลแฝงกำกับไว้', {
      reason: 'strip-recipe-missing',
    }),
};
