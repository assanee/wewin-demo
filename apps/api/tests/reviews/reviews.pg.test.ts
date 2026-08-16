import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';
import { products as fixtureProducts } from '@wewin/core/fixtures';
import type { Product } from '@wewin/core';
import { encodeUm } from '@wewin/contract/measure';
import type { OrderLineRequestWire, OrderWire } from '@wewin/contract/order';
import type {
  ModeratedReviewWire,
  ModerationQueueWire,
  OwnReviewWire,
  ProductReviewScheduleWire,
  ProductReviewsWire,
  ReviewableLineListWire,
} from '@wewin/contract/review';

import { REVIEW_INVITATION_RULE } from '../../src/reviews';
import { client, makeActor, type Actor, type Json } from '../orders/support/lifecycle-app';
import { bootReviewsApp, reviewsEnv, type ReviewsApp } from './support/reviews-app';
import { confirmQuotation } from '../support/confirm-quotation';

/**
 * Reviews end to end — over real HTTP, against a real Postgres, with nothing stubbed.
 *
 * Nothing here is asserted through a service call, because every property this phase is about
 * lives *between* the layers:
 *
 *   - the ownership term is a WHERE clause, and a mock has no WHERE clause;
 *   - publication is a comparison against `now()` inside a Postgres function, so a test that
 *     never issues a statement never meets the deadline that plan 9.3 turns on;
 *   - "the rating still counts when the text is hidden" is a `GROUP BY` in a view;
 *   - the invitation is a row a trigger writes inside somebody else's transaction.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);

describeWithPg('customer reviews after delivery', () => {
  let pool: Pool;
  let db: Database;
  let app: ReviewsApp;
  let call: ReturnType<typeof client>;

  let staff: Actor;
  let moderator: Actor;
  let customerA: Actor;
  let customerB: Actor;
  let line: OrderLineRequestWire;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);

    app = await bootReviewsApp(reviewsEnv(url ?? ''));
    call = client(app.baseUrl);

    staff = await makeActor(db, app, `reviews staff ${tag}`, ['orders.read', 'orders.write']);
    /*
     * ⚠️ A moderator holds `reviews.moderate` and no order permission at all. That is not
     * economy in a fixture — it is the assertion: plan 9.3's moderation authority must not
     * arrive as a side effect of being staff, and this actor proves the route works without
     * one and (below) that an order-staff actor is refused with all of them.
     */
    moderator = await makeActor(db, app, `reviews moderator ${tag}`, ['reviews.moderate']);
    customerA = await makeActor(db, app, `reviews customer A ${tag}`, []);
    customerB = await makeActor(db, app, `reviews customer B ${tag}`, []);

    line = await liveLine(call);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  /* ---------------------------------------------------------------- *
   * Getting an order to `delivered`
   * ---------------------------------------------------------------- */

  const move = (orderId: string, to: string, actor: Actor, body: unknown = {}): Promise<Json> =>
    call('POST', `/orders/${orderId}/transitions/${to}`, { token: actor.token, body });

  /** A delivered order owned by `customerA`, and the line on it. */
  const deliveredOrder = async (who: string): Promise<OrderWire> => {
    const created = await call('POST', '/orders', { token: customerA.token, body: {} });
    expect(created.status).toBe(201);
    const draft = created.body as OrderWire;

    const submitted = await move(draft.id, 'awaiting_payment', customerA, {
      contact: { email: `reviews-${who}-${tag}@probe.invalid`, name: `reviews probe ${tag}` },
      lines: [line],
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);

    /* Through the confirmation, which is where a quotation becomes payable since 0056. */
    await confirmQuotation(db, draft.id);

    for (const next of ['production_confirmed', 'in_production', 'awaiting_installation', 'delivered'] as const) {
      const moved = await move(draft.id, next, staff);
      expect(moved.status, `${next}: ${JSON.stringify(moved.body)}`).toBe(200);
    }

    return submitted.body as OrderWire;
  };

  const reviewableLines = async (actor: Actor): Promise<ReviewableLineListWire> => {
    const answer = await call('GET', '/reviews/reviewable-lines', { token: actor.token });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return answer.body as ReviewableLineListWire;
  };

  /** The one line on a freshly delivered order. */
  const lineOf = async (orderId: string): Promise<string> => {
    const found = (await reviewableLines(customerA)).items.find((item) => item.orderId === orderId);
    if (!found) throw new Error(`no reviewable line on ${orderId}`);
    return found.quoteLineId;
  };

  /* ---------------------------------------------------------------- *
   * Plan 9.1 — a review belongs to a LINE, and the purchase proves itself
   * ---------------------------------------------------------------- */

  it('lists a delivered line to the customer who bought it and to nobody else', async () => {
    const order = await deliveredOrder('list');

    const mine = await reviewableLines(customerA);
    const theLine = mine.items.find((item) => item.orderId === order.id);
    expect(theLine).toBeDefined();
    expect(theLine?.reviewId).toBeNull();
    /*
     * Plan 9.1: the configuration is known, because the line knows it. The version is the
     * *line's own* — proven in Postgres by the composite foreign key — which is what makes a
     * review read three catalogue revisions later still a review of what was sold.
     */
    expect(theLine?.productVersionId).toBe(line.productVersionId);
    expect(theLine?.productNameTh).toBeTruthy();

    /*
     * ⭐ Plan 7.4 trap 2. Not "customer B is refused" — customer B's list does not contain the
     * row at all, because the ownership term is in the query that loads it.
     */
    const theirs = await reviewableLines(customerB);
    expect(theirs.items.some((item) => item.orderId === order.id)).toBe(false);
  });

  it('refuses a review of somebody else\'s line as if it did not exist', async () => {
    const order = await deliveredOrder('cross');
    const quoteLineId = await lineOf(order.id);

    const attempt = await call('POST', '/reviews', {
      token: customerB.token,
      body: { quoteLineId, rating: 5, bodyTh: null, authorDisplayName: null },
    });

    /* 404 and not 403: two status codes are an oracle for counting the company's orders. */
    expect(attempt.status).toBe(404);

    const rows = await db.execute(sql`select count(*)::int as n from reviews where quote_line_id = ${quoteLineId}`);
    expect(count(rows)).toBe(0);
  });

  it('writes a review whose order, product version and author it never accepted on the wire', async () => {
    const order = await deliveredOrder('write');
    const quoteLineId = await lineOf(order.id);

    const written = await call('POST', '/reviews', {
      token: customerA.token,
      body: { quoteLineId, rating: 4, bodyTh: 'ผ่านฝนมาหนึ่งรอบแล้ว ไม่รั่ว', authorDisplayName: 'ส.' },
    });
    expect(written.status, JSON.stringify(written.body)).toBe(201);

    const review = written.body as OwnReviewWire;
    expect(review.orderId).toBe(order.id);
    expect(review.rating).toBe(4);
    expect(review.isPublic).toBe(false);

    /*
     * The order id and the product version came from the row the ownership-filtered query
     * returned, not from the request — there is nothing on the wire to forge.
     */
    const stored = await db.execute(sql`
      select order_id, author_user_id, author_guest_id, moderation_window_hours
        from reviews where id = ${review.id}
    `);
    const row = stored.rows[0];
    expect(row?.['order_id']).toBe(order.id);
    expect(row?.['author_user_id']).toBe(customerA.userId);
    expect(row?.['author_guest_id']).toBeNull();
    /* Plan 13's default, passed on every insert rather than inherited from DDL. */
    expect(row?.['moderation_window_hours']).toBe(72);
  });

  it('refuses a second review of the same line — one per line', async () => {
    const order = await deliveredOrder('twice');
    const quoteLineId = await lineOf(order.id);
    const body = { quoteLineId, rating: 5, bodyTh: null, authorDisplayName: null };

    expect((await call('POST', '/reviews', { token: customerA.token, body })).status).toBe(201);

    const second = await call('POST', '/reviews', { token: customerA.token, body });
    expect(second.status).toBe(409);
    expect(reasonOf(second.body)).toBe('one-review-per-line');
  });

  /**
   * Plan 9.2's window opens at `delivered`, and the API says which status it is waiting for.
   *
   * The ownership term already ran, so this caller is entitled to know the state of their own
   * order. Collapsing it into a 404 would be politeness toward an attacker who cannot reach
   * the row, paid for by a customer who cannot understand the answer.
   */
  it('refuses a review of an order that has not been delivered, and says so', async () => {
    const created = await call('POST', '/orders', { token: customerA.token, body: {} });
    const draft = created.body as OrderWire;
    const submitted = await move(draft.id, 'awaiting_payment', customerA, {
      contact: { email: `reviews-early-${tag}@probe.invalid`, name: `reviews probe ${tag}` },
      lines: [line],
    });
    expect(submitted.status).toBe(200);

    const lines = await db.execute(sql`select id from quote_lines where order_id = ${draft.id} limit 1`);
    const quoteLineId = String(lines.rows[0]?.['id'] ?? '');

    const attempt = await call('POST', '/reviews', {
      token: customerA.token,
      body: { quoteLineId, rating: 5, bodyTh: null, authorDisplayName: null },
    });
    expect(attempt.status).toBe(409);
    expect(reasonOf(attempt.body)).toBe('order-not-delivered');
  });

  /* ---------------------------------------------------------------- *
   * Plan 9.3 — the deadline publishes, and hiding does not dress the score
   * ---------------------------------------------------------------- */

  /**
   * ⭐ The SLA, and the whole reason plan 9.3 demands one.
   *
   * *An approve-before-publish queue with no SLA is one where reviews never appear*, which is
   * the failure the refund queue already has in plan 7.12. Here the passage of time is the
   * publisher: nothing runs, nothing is flipped, and a review whose window has elapsed is
   * public because `review_is_public()` says so.
   *
   * The review is inserted with `created_at` in the past rather than by waiting, which is the
   * only honest way to test a deadline in under three days. Everything else — the window, the
   * function, the view — is the shipped one.
   */
  it('publishes itself when nobody acts, with no worker and no row change', async () => {
    const order = await deliveredOrder('deadline');
    const quoteLineId = await lineOf(order.id);

    const written = await call('POST', '/reviews', {
      token: customerA.token,
      body: { quoteLineId, rating: 5, bodyTh: 'ขึ้นเองเมื่อครบกำหนด', authorDisplayName: null },
    });
    const review = (written.body as OwnReviewWire);
    expect(review.isPublic).toBe(false);

    /*
     * The clock cannot be wound forward, so the review is written in the past instead — and
     * `reviews_guard_write()` refuses to let an UPDATE move `created_at`, which is itself the
     * right behaviour and is why this is an INSERT. Nothing else is faked: the window, the
     * function and the views are the shipped ones, and **no status column is touched, because
     * there is none**.
     *
     * It needs a *second* delivered order rather than a second row on the first one, and the
     * schema is what says so twice over: `reviews_line_key` allows one review per line, and
     * the composite key `(quote_line_id, order_id)` means a row cannot borrow one order's id
     * for another order's line. Selecting straight from `quote_lines` keeps both columns from
     * the same source row, so the pair is right by construction rather than by agreement.
     */
    const elapsedOrder = await deliveredOrder('deadline-elapsed');
    const elapsedLineId = await lineOf(elapsedOrder.id);

    const past = await db.execute(sql`
      insert into reviews (order_id, quote_line_id, product_version_id, author_user_id,
                           rating, body_th, moderation_window_hours, created_at)
      select ql.order_id, ql.id, ql.product_version_id, ${customerA.userId},
             5, 'ขึ้นเองเมื่อครบกำหนด', 1, now() - interval '2 hours'
        from quote_lines ql where ql.id = ${elapsedLineId}
      returning id
    `);
    const elapsed = String(past.rows[0]?.['id'] ?? '');

    const after = await call('GET', `/reviews/${elapsed}`, { token: customerA.token });
    expect((after.body as OwnReviewWire).isPublic).toBe(true);

    /* And it is out of the moderation queue — a review that published itself cannot be put back. */
    const queue = await call('GET', '/admin/reviews/queue?limit=100', { token: moderator.token });
    expect((queue.body as ModerationQueueWire).items.some((item) => item.id === elapsed)).toBe(false);

    /* And "publish it" is now a refusal rather than a stamp on a decision nobody made. */
    const late = await call('POST', `/admin/reviews/${elapsed}/publish`, { token: moderator.token, body: {} });
    expect(late.status).toBe(409);
    expect(reasonOf(late.body)).toBe('published-by-the-deadline');
  });

  it('⭐ a hidden review leaves the pending queue, is listed under ?state=hidden, and can come back', async () => {
    /*
     * The round trip that had no screen. `review_is_moderated` is true the moment `hidden_at`
     * is set, so hiding a review dropped it out of `not review_is_moderated(...)` — the only
     * list the moderation surface had — and `POST :id/unhide` became unreachable. The button
     * was not forgotten; there was nowhere for it to be. `?state=hidden` is what gives it one.
     */
    const order = await deliveredOrder('unhide');
    const quoteLineId = await lineOf(order.id);
    const written = await call('POST', '/reviews', {
      token: customerA.token,
      body: { quoteLineId, rating: 2, bodyTh: 'ข้อความที่จะถูกซ่อนแล้วเอากลับ', authorDisplayName: null },
    });
    const review = (written.body as OwnReviewWire).id;

    const pendingBefore = await call('GET', '/admin/reviews/queue?limit=100', { token: moderator.token });
    expect((pendingBefore.body as ModerationQueueWire).items.some((item) => item.id === review)).toBe(true);

    expect(
      (await call('POST', `/admin/reviews/${review}/hide`, {
        token: moderator.token,
        body: { reason: 'off_topic', noteTh: null },
      })).status,
    ).toBe(200);

    /* ⚠️ Gone from the default queue — this is the half that used to be the whole story. */
    const pendingAfter = await call('GET', '/admin/reviews/queue?limit=100', { token: moderator.token });
    expect((pendingAfter.body as ModerationQueueWire).items.some((item) => item.id === review)).toBe(false);

    /* And present in the one a moderator can now ask for. */
    const hiddenList = await call('GET', '/admin/reviews/queue?limit=100&state=hidden', { token: moderator.token });
    expect(hiddenList.status, JSON.stringify(hiddenList.body)).toBe(200);
    expect((hiddenList.body as ModerationQueueWire).items.some((item) => item.id === review)).toBe(true);

    expect((await call('POST', `/admin/reviews/${review}/unhide`, { token: moderator.token, body: {} })).status).toBe(200);

    /* Back where it was, and out of the hidden list. */
    const pendingBack = await call('GET', '/admin/reviews/queue?limit=100', { token: moderator.token });
    expect((pendingBack.body as ModerationQueueWire).items.some((item) => item.id === review)).toBe(true);
    const hiddenAfter = await call('GET', '/admin/reviews/queue?limit=100&state=hidden', { token: moderator.token });
    expect((hiddenAfter.body as ModerationQueueWire).items.some((item) => item.id === review)).toBe(false);
  });

  it('⚠️ refuses a third state, so the queue cannot be asked for something it will not do about', async () => {
    /*
     * `published` is deliberately not a value: a public review cannot be brought back into a
     * queue, and accepting the word would imply an action that does not exist.
     */
    const refused = await call('GET', '/admin/reviews/queue?state=published', { token: moderator.token });
    expect(refused.status).toBe(400);
  });

  it('shows the queue only to a moderator — an order permission is not a moderation permission', async () => {
    /* Holding orders.read + orders.write reaches every order in the company and no review. */
    const asOrderStaff = await call('GET', '/admin/reviews/queue', { token: staff.token });
    expect(asOrderStaff.status).toBe(403);

    const asCustomer = await call('GET', '/admin/reviews/queue', { token: customerA.token });
    expect(asCustomer.status).toBe(403);

    const asModerator = await call('GET', '/admin/reviews/queue', { token: moderator.token });
    expect(asModerator.status).toBe(200);
  });

  it('orders the queue by its deadline and shows how long is left', async () => {
    const order = await deliveredOrder('queue');
    const quoteLineId = await lineOf(order.id);
    const written = await call('POST', '/reviews', {
      token: customerA.token,
      body: { quoteLineId, rating: 3, bodyTh: 'รอกลั่นกรอง', authorDisplayName: null },
    });
    const review = written.body as OwnReviewWire;

    const queue = (await call('GET', '/admin/reviews/queue', { token: moderator.token }))
      .body as ModerationQueueWire;

    const mine = queue.items.find((item) => item.id === review.id);
    expect(mine).toBeDefined();
    expect(mine?.hoursRemaining).toBeGreaterThan(71);
    expect(mine?.hoursRemaining).toBeLessThanOrEqual(72);
    /* The length of the queue is beside the page — plan 7.12's queue nobody could see growing. */
    expect(queue.total).toBeGreaterThanOrEqual(1);

    const deadlines = queue.items.map((item) => Date.parse(item.publishesAt));
    expect([...deadlines].sort((a, b) => a - b)).toStrictEqual(deadlines);
  });

  /**
   * ⭐ Plan 9.3's second bullet, which decides whether the average means anything.
   *
   * *The rating still counts toward the average even when the text is hidden* — otherwise
   * hiding becomes the tool for dressing the score. `product_review_stats` does not filter on
   * `hidden_at`, so this asserts the count does not move while `visible_count` does.
   */
  it('keeps a hidden review\'s rating in the average, and takes only its text down', async () => {
    const order = await deliveredOrder('hide');
    const quoteLineId = await lineOf(order.id);
    const productId = (await reviewableLines(customerA)).items.find(
      (item) => item.orderId === order.id,
    )?.productId;
    expect(productId).toBeTruthy();

    const written = await call('POST', '/reviews', {
      token: customerA.token,
      body: { quoteLineId, rating: 1, bodyTh: 'ข้อความที่จะถูกซ่อน', authorDisplayName: null },
    });
    const review = written.body as OwnReviewWire;
    /* Published by a person, so it is counted and visible before the hiding. */
    expect((await call('POST', `/admin/reviews/${review.id}/publish`, { token: moderator.token, body: {} })).status).toBe(200);

    const before = ((await call('GET', `/products/${productId ?? ''}/reviews`, {})).body as ProductReviewsWire).stats;
    expect(before).not.toBeNull();

    const hidden = await call('POST', `/admin/reviews/${review.id}/hide`, {
      token: moderator.token,
      body: { reason: 'off_topic', noteTh: null },
    });
    expect(hidden.status, JSON.stringify(hidden.body)).toBe(200);
    expect((hidden.body as ModeratedReviewWire).hiddenReason).toBe('off_topic');

    const after = ((await call('GET', `/products/${productId ?? ''}/reviews`, {})).body as ProductReviewsWire);

    /* ⭐ The count and the sum are unmoved. The rating goes on counting. */
    expect(after.stats?.ratingCount).toBe(before?.ratingCount);
    expect(after.stats?.ratingSum).toBe(before?.ratingSum);
    /* And the text is gone from the page. */
    expect((after.stats?.visibleCount ?? 0)).toBe((before?.visibleCount ?? 0) - 1);
    expect(after.items.some((item) => item.id === review.id)).toBe(false);
  });

  it('records a person with every hiding, and refuses `other` with no note', async () => {
    const order = await deliveredOrder('reason');
    const quoteLineId = await lineOf(order.id);
    const written = await call('POST', '/reviews', {
      token: customerA.token,
      body: { quoteLineId, rating: 2, bodyTh: 'x', authorDisplayName: null },
    });
    const review = written.body as OwnReviewWire;

    const noNote = await call('POST', `/admin/reviews/${review.id}/hide`, {
      token: moderator.token,
      body: { reason: 'other', noteTh: null },
    });
    expect(noNote.status).toBe(400);

    const withNote = await call('POST', `/admin/reviews/${review.id}/hide`, {
      token: moderator.token,
      body: { reason: 'other', noteTh: 'ลูกค้าเขียนถึงบริษัทอื่น' },
    });
    expect(withNote.status).toBe(200);

    const stored = await db.execute(sql`select hidden_by_user_id from reviews where id = ${review.id}`);
    /* The name is the session's, and there is no wire field it could have come from. */
    expect(stored.rows[0]?.['hidden_by_user_id']).toBe(moderator.userId);
  });

  /**
   * ⭐ Plan 9.3's ⓷: the rating is frozen once the review is moderated.
   *
   * This is what makes "record a reason and a person" more than paperwork — the moderator who
   * hides a two-star review cannot also make it a five. Asserted against the database rather
   * than against a route, because there is no route that could: the API has no verb for
   * changing a rating, and this proves the guard holds for the UPDATE somebody types anyway.
   */
  it('refuses a moderator who would hide and retouch in one statement', async () => {
    const order = await deliveredOrder('freeze');
    const quoteLineId = await lineOf(order.id);
    const written = await call('POST', '/reviews', {
      token: customerA.token,
      body: { quoteLineId, rating: 1, bodyTh: 'หนึ่งดาว', authorDisplayName: null },
    });
    const review = (written.body as OwnReviewWire).id;

    await call('POST', `/admin/reviews/${review}/hide`, {
      token: moderator.token,
      body: { reason: 'abusive', noteTh: null },
    });

    await expectRefused(db.execute(sql`update reviews set rating = 5 where id = ${review}`), 'rating is fixed');
  });

  it('replies once and refuses a thread', async () => {
    const order = await deliveredOrder('reply');
    const quoteLineId = await lineOf(order.id);
    const written = await call('POST', '/reviews', {
      token: customerA.token,
      body: { quoteLineId, rating: 3, bodyTh: 'บานฝืดนิดหน่อย', authorDisplayName: null },
    });
    const review = (written.body as OwnReviewWire).id;

    const first = await call('POST', `/admin/reviews/${review}/reply`, {
      token: moderator.token,
      body: { bodyTh: 'ขอบคุณครับ ทีมช่างจะติดต่อกลับ' },
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    const second = await call('POST', `/admin/reviews/${review}/reply`, {
      token: moderator.token,
      body: { bodyTh: 'อีกครั้ง' },
    });
    expect(second.status).toBe(409);
    expect(reasonOf(second.body)).toBe('one-reply-per-review');
  });

  /**
   * ⭐ Hide, never delete. There is no route, and there is no statement either.
   *
   * Both halves are asserted because they fail differently: a missing route is a 404 anybody
   * could add back in an afternoon, and the trigger is what makes the sentence true for a
   * `DELETE` typed into psql at midnight.
   */
  it('has no way to delete a review, over HTTP or in SQL', async () => {
    const order = await deliveredOrder('delete');
    const quoteLineId = await lineOf(order.id);
    const written = await call('POST', '/reviews', {
      token: customerA.token,
      body: { quoteLineId, rating: 1, bodyTh: 'จะลบไม่ได้', authorDisplayName: null },
    });
    const review = (written.body as OwnReviewWire).id;

    for (const actor of [moderator, staff, customerA]) {
      const attempt = await call('DELETE', `/admin/reviews/${review}`, { token: actor.token });
      expect(attempt.status).toBe(404);
    }

    await expectRefused(db.execute(sql`delete from reviews where id = ${review}`), 'hidden, never deleted');
  });

  /* ---------------------------------------------------------------- *
   * Plan 9.5 — the storefront read
   * ---------------------------------------------------------------- */

  /**
   * ⭐ Never an average without its count, and no block at all when there is nothing to say.
   *
   * Both are structural: `product_review_stats` exposes a sum and a count and no average, and
   * `GROUP BY` produces no row for a product nobody has reviewed. With 81 products and no
   * orders today, `stats === null` is what makes "hide the whole block" the rendering that
   * happens by accident rather than the one somebody remembers.
   */
  it('gives a never-reviewed product no stats object at all', async () => {
    const answer = await call('GET', '/products/a-product-nobody-has-reviewed/reviews', {});
    expect(answer.status).toBe(200);

    const body = answer.body as ProductReviewsWire;
    expect(body.stats).toBeNull();
    expect(body.items).toStrictEqual([]);
    /* And there is nowhere for a 0.0 ★ to come from. */
    expect(JSON.stringify(body)).not.toContain('average');
  });

  it('publishes a review early when a person decides to, with their name on it', async () => {
    const order = await deliveredOrder('early');
    const quoteLineId = await lineOf(order.id);
    const productId = (await reviewableLines(customerA)).items.find(
      (item) => item.orderId === order.id,
    )?.productId;

    const written = await call('POST', '/reviews', {
      token: customerA.token,
      body: { quoteLineId, rating: 5, bodyTh: 'ดีมาก ผ่านฝนแล้วไม่รั่ว', authorDisplayName: 'คุณ ก.' },
    });
    const review = written.body as OwnReviewWire;

    /* Not on the page yet: nobody has looked at it, which is the point of the window. */
    const before = (await call('GET', `/products/${productId ?? ''}/reviews`, {})).body as ProductReviewsWire;
    expect(before.items.some((item) => item.id === review.id)).toBe(false);

    const published = await call('POST', `/admin/reviews/${review.id}/publish`, {
      token: moderator.token,
      body: {},
    });
    expect(published.status, JSON.stringify(published.body)).toBe(200);

    const after = (await call('GET', `/products/${productId ?? ''}/reviews`, {})).body as ProductReviewsWire;
    const shown = after.items.find((item) => item.id === review.id);
    expect(shown).toBeDefined();
    expect(shown?.authorDisplayName).toBe('คุณ ก.');
    expect(shown?.contentErased).toBe(false);

    /* ⭐ And the public projection carries no person: the view does not select either column. */
    expect(JSON.stringify(shown)).not.toContain(customerA.userId);
    expect(JSON.stringify(after)).not.toContain('authorUserId');
    expect(JSON.stringify(after)).not.toContain('authorGuestId');
  });

  /**
   * ⭐ The cache trap arriving from the direction plan 8.2 does not name.
   *
   * `apps/web` runs `revalidate = false`, so a product page stands until something calls
   * `revalidateTag`. Every other writer in the system is a request that can make that call. A
   * review that publishes itself has **no writer** — no request, no row update, nothing to
   * hang it on. This endpoint is what lets the storefront schedule the revalidation instead of
   * discovering the drift.
   */
  it('says when a cached product page will change with nobody having written anything', async () => {
    const order = await deliveredOrder('schedule');
    const quoteLineId = await lineOf(order.id);
    const productId = (await reviewableLines(customerA)).items.find(
      (item) => item.orderId === order.id,
    )?.productId;

    await call('POST', '/reviews', {
      token: customerA.token,
      body: { quoteLineId, rating: 4, bodyTh: 'รอขึ้นเอง', authorDisplayName: null },
    });

    /*
     * ⚠️ And not to the public. The response enumerates every product holding an unmoderated
     * review together with a count — the moderation backlog — and `nextPublicationAt` reduces
     * to the minute a customer wrote, for any product holding one. It answered anonymously
     * until the module was mounted; both refusals below are the point of this block, not
     * setup for the assertions after them.
     */
    expect((await call('GET', '/reviews/schedule', {})).status).toBe(401);
    expect((await call('GET', '/reviews/schedule', { token: customerA.token })).status).toBe(403);

    /* Default lookahead is 24 hours and the window is 72, so this must be empty for it. */
    const soon = (await call('GET', '/reviews/schedule', { token: moderator.token }))
      .body as ProductReviewScheduleWire;
    expect(soon.entries.some((entry) => entry.productId === productId)).toBe(false);

    const later = (await call('GET', '/reviews/schedule?withinHours=96', { token: moderator.token }))
      .body as ProductReviewScheduleWire;
    const entry = later.entries.find((item) => item.productId === productId);
    expect(entry).toBeDefined();
    expect(entry?.pendingCount).toBeGreaterThanOrEqual(1);
    expect(Date.parse(entry?.nextPublicationAt ?? '')).toBeGreaterThan(Date.now());
  });

  /* ---------------------------------------------------------------- *
   * Plan 9.2 / 10.1 — the invitation is an outbox row and not a cron
   * ---------------------------------------------------------------- */

  /**
   * ⭐ The invitation, proven against the shipped outbox rather than described.
   *
   * The rule row is inserted by this test because it cannot ship from `src/reviews` — see
   * `review-invitation.ts` for why the migration and the template have to land together. What
   * is proven here is that the *design* is right and needs no new machinery:
   *
   *   - delivering an order queues exactly one invitation, written by the fan-out trigger
   *     inside the transition's own transaction;
   *   - `send_after` is thirty days out, so the worker's own due query will not claim it
   *     until then. There is no scheduler, no scan, and no `sent` flag to forget;
   *   - `delivered` is terminal, so "once" is a property of the transition table rather than
   *     of a column somebody has to maintain.
   */
  it('queues the review invitation as one outbox row, due in thirty days', async () => {
    await db.execute(sql`
      insert into notification_rules
        (event_type, recipient_kind, channel, template_key, coalesce_group, coalesce_seconds)
      values
        (${REVIEW_INVITATION_RULE.eventType}, ${REVIEW_INVITATION_RULE.recipientKind},
         ${REVIEW_INVITATION_RULE.channel}, ${REVIEW_INVITATION_RULE.templateKey},
         ${REVIEW_INVITATION_RULE.coalesceGroup}, ${REVIEW_INVITATION_RULE.coalesceSeconds})
      on conflict (event_type, recipient_kind, channel) do update
        set template_key = excluded.template_key,
            coalesce_group = excluded.coalesce_group,
            coalesce_seconds = excluded.coalesce_seconds
    `);

    const order = await deliveredOrder('invitation');

    const queued = await db.execute(sql`
      select status, send_after, coalesced_count,
             extract(epoch from (send_after - now()))::int as seconds_away
        from notifications
       where order_id = ${order.id}
         and template_key = ${REVIEW_INVITATION_RULE.templateKey}
    `);
    const rows = queued.rows;

    /* One row, not two, and not none. */
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['status']).toBe('pending');
    expect(rows[0]?.['coalesced_count']).toBe(0);

    /* Thirty days, give or take the seconds this test took. */
    const secondsAway = Number(rows[0]?.['seconds_away']);
    expect(secondsAway).toBeGreaterThan(REVIEW_INVITATION_RULE.coalesceSeconds - 120);
    expect(secondsAway).toBeLessThanOrEqual(REVIEW_INVITATION_RULE.coalesceSeconds);

    /*
     * ⭐ And the worker's own claim predicate does not reach it. This is the exact WHERE
     * clause `NotificationsRepository.claimDue` uses, so "it will not be sent today" is the
     * shipped query's answer rather than this test's arithmetic.
     */
    const due = await db.execute(sql`
      select count(*)::int as n
        from notifications
       where order_id = ${order.id}
         and template_key = ${REVIEW_INVITATION_RULE.templateKey}
         and status = 'pending'
         and send_after <= now()
    `);
    expect(count(due)).toBe(0);
  });

  /**
   * The other half of "once": there is no second `delivered` event to fire a second one.
   *
   * `delivered` is terminal in `order_status_transitions`, which is also what makes the review
   * window endless (plan 9.2). One fact, used twice, asserted here so that adding an outgoing
   * transition from `delivered` fails a test rather than sending a customer two invitations.
   */
  it('cannot deliver an order twice, which is what makes the invitation fire once', async () => {
    const order = await deliveredOrder('terminal');

    const again = await move(order.id, 'delivered', staff);
    expect(again.status).toBeGreaterThanOrEqual(400);

    const rows = await db.execute(sql`
      select count(*)::int as n from order_events
       where order_id = ${order.id} and event_type = 'delivered'
    `);
    expect(count(rows)).toBe(1);
  });
});

/**
 * The `reason` a client branches on, out of the error envelope.
 *
 * One reader, because the envelope nests it (`{ error: { code, details } }`) and five call
 * sites that each reach into it are five chances to read `body.details` — which is
 * `undefined`, and an assertion against `undefined` passes for the wrong reason exactly as
 * often as it fails for the right one.
 */
function reasonOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('error' in body)) return undefined;
  const { error } = body as { error: unknown };
  if (typeof error !== 'object' || error === null || !('details' in error)) return undefined;
  const { details } = error as { details: unknown };
  if (typeof details !== 'object' || details === null || !('reason' in details)) return undefined;
  const { reason } = details as { reason: unknown };
  return typeof reason === 'string' ? reason : undefined;
}

/**
 * A statement Postgres refused, asserted on the guard's own sentence.
 *
 * Drizzle wraps a driver error as `Failed query: …` and hangs the original on `cause`, so
 * `rejects.toThrow(/…/)` matches the wrapper and never the message the trigger wrote. Reading
 * through to the cause is what makes these assertions about the *guard* rather than about the
 * fact that something went wrong.
 */
async function expectRefused(work: Promise<unknown>, saying: string): Promise<void> {
  try {
    await work;
    expect.unreachable(`the database must refuse this: ${saying}`);
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause ?? error;
    expect(String((cause as { message?: unknown }).message ?? cause)).toContain(saying);
    expect((cause as { code?: unknown }).code).toBe('23001');
  }
}

/** `select count(*)::int as n` — one narrowing, so five call sites do not each invent one. */
function count(result: { readonly rows: readonly Record<string, unknown>[] }): number {
  return Number(result.rows[0]?.['n'] ?? -1);
}

/**
 * A line the *running* catalogue would accept, built from the published document it names.
 *
 * Lifted from `tests/orders/lifecycle.pg.test.ts` for the same reason it exists there: the
 * handle has to come from `GET /catalog/products` rather than from the fixture table, because
 * that pair is what the freeze pins and a hard-coded one is stale the first time anything
 * republishes.
 */
async function liveLine(call: ReturnType<typeof client>): Promise<OrderLineRequestWire> {
  const listed = await call('GET', '/catalog/products', {});
  if (listed.status !== 200) throw new Error(`the catalogue is not being served: ${listed.status}`);

  const wire = listed.body as {
    products: readonly { productVersionId: string; documentHash: string; product: { id: string } }[];
  };

  for (const published of wire.products) {
    const product = fixtureProducts.find((candidate: Product) => candidate.id === published.product.id);
    if (!product || !product.groups.some((group) => group.kind === 'custom')) continue;

    const selections: Record<string, string> = {};
    const measures: Record<string, ReturnType<typeof encodeUm>> = {};
    const enteredUnits: Record<string, 'cm' | 'mm'> = {};

    for (const group of product.groups) {
      if (group.kind === 'sku') selections[group.code] = group.defaultValue;
      else {
        measures[group.code] = encodeUm(group.defaultUm);
        enteredUnits[group.code] = group.unit;
      }
    }

    return {
      productVersionId: published.productVersionId,
      documentHash: published.documentHash,
      productId: product.id,
      selections,
      measures,
      enteredUnits,
      qty: 2,
    };
  }

  throw new Error('no published product with a measurement to order');
}
