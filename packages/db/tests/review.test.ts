import { beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { CURRENCIES } from '@wewin/core/money';
import { LENGTH_UNITS } from '@wewin/core/units';
import { products as coreProducts } from '@wewin/core/fixtures';
import type { Database } from '../src/client.js';
import {
  ERASURE_TREATMENTS,
  REVIEW_HIDDEN_REASONS,
  REVIEW_INVITATION_DELAY_DAYS_DEFAULT,
  REVIEW_MODERATION_HOURS_DEFAULT,
  REVIEW_MODERATION_HOURS_MAX,
  guests,
  orderDocuments,
  orderEvents,
  orderStatusTransitions,
  orders,
  productVersions,
  products,
  quoteLines,
  reviewPhotos,
  reviews,
  userPreferences,
  users,
} from '../src/schema/index.js';
import { toDocument } from '../src/compile.js';
import { documentHash } from '../src/hash.js';
import { PG, connect, describeDb, errorCode } from './support/db.js';

/**
 * Phase 7: reviews after delivery, and the per-user profile.
 *
 * Every block below is written so that **removing the guard makes it fail**, and every one
 * was mutation-tested against a scratch database built from the migrations — comment the
 * constraint or the conjunct out of `drizzle/0019_reviews.sql` or `drizzle/0020_review_guards.sql`,
 * run this file, watch it go red, put it back. The results, including the guards that turned
 * out to have no independent evidence, are reported with the phase.
 *
 * ⚠️ Two assertions in this file are about a *shape rather than a refusal*, and they are
 * marked where they appear. `product_review_stats` having no `avg` column and
 * `published_reviews` having no author column are properties nothing can violate at runtime;
 * they are asserted against `information_schema` so that adding one is a failing test rather
 * than a code review nobody had.
 *
 * ── Why the message is asserted and not only the SQLSTATE ───────────────────────
 *
 * `reviews_guard_write()` raises `restrict_violation` from six different places. Asserting
 * 23001 alone would let a mutation of one conjunct pass because a different conjunct refused
 * the same statement for a different reason — which is exactly what the mutation run of
 * `users_erasure_is_earned()` caught in phase 5b (plan 7.14(ก) finding 6b). Naming the
 * sentence is what makes each conjunct separately observable.
 *
 * Rows are not cleaned up: a delivered order cannot be deleted and a review cannot either,
 * and a teardown able to remove them would contradict the schema it is testing.
 * `tests/globalSetup.ts` drops the whole database instead.
 */

const tag = randomUUID().slice(0, 8);
const HOUR_MS = 60 * 60 * 1000;

/** Plan 4.4's worked example, as every other suite here uses it. */
const NET = 879100n;
const VAT = 61537n;
const GRAND = 940637n;
const DEPOSIT = 282191n;

let db: Database;
let staff: string;
let moderator: string;
let sharedProduct: { productId: string; versionId: string };

const messagesOf = (error: unknown): string[] => {
  const found: string[] = [];
  let current: unknown = error;

  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    if ('message' in current) {
      const { message } = current as { message: unknown };
      if (typeof message === 'string') found.push(message);
    }
    current = 'cause' in current ? (current as { cause: unknown }).cause : undefined;
  }

  return found;
};

const caughtOf = (operation: Promise<unknown>): Promise<unknown> =>
  operation.then(
    () => undefined,
    (error: unknown) => error,
  );

const expectViolation = async (
  operation: Promise<unknown>,
  code: (typeof PG)[keyof typeof PG],
): Promise<void> => {
  const caught = await caughtOf(operation);
  expect(errorCode(caught), `expected SQLSTATE ${code}, got: ${String(caught)}`).toBe(code);
};

/** 23514, *and* the constraint that raised it — so a mutation cannot be masked by a neighbour. */
const expectCheck = async (operation: Promise<unknown>, constraint: string): Promise<void> => {
  const caught = await caughtOf(operation);
  expect(errorCode(caught), `expected SQLSTATE 23514, got: ${String(caught)}`).toBe(
    PG.checkViolation,
  );
  expect(
    messagesOf(caught).join(' | '),
    `expected the violation to name "${constraint}"`,
  ).toContain(constraint);
};

/** 23001, *and* the sentence the trigger raised. See the block comment. */
const expectRefusal = async (operation: Promise<unknown>, fragment: string): Promise<void> => {
  const caught = await caughtOf(operation);
  expect(errorCode(caught), `expected SQLSTATE 23001, got: ${String(caught)}`).toBe(
    PG.restrictViolation,
  );
  expect(
    messagesOf(caught).join(' | '),
    `expected a refusal mentioning "${fragment}"`,
  ).toContain(fragment);
};

const createUser = async (name: string): Promise<string> => {
  const [user] = await db.insert(users).values({ displayName: name }).returning({ id: users.id });
  if (!user) throw new Error('could not create a user');
  return user.id;
};

const createGuest = async (): Promise<string> => {
  const [guest] = await db.insert(guests).values({}).returning({ id: guests.id });
  if (!guest) throw new Error('could not create a guest');
  return guest.id;
};

/**
 * A product of this test's own, with one published version.
 *
 * Per-test products rather than the seeded catalogue, because `product_review_stats`
 * aggregates by product: two tests sharing one product would each be asserting against the
 * other's reviews, and the file would pass or fail depending on the order it ran in. That is
 * the order dependence `tests/globalSetup.ts` was written to stop happening again.
 *
 * The document is the fixture's, because nothing here reads inside it — the view joins
 * `product_versions.product_id`, the column.
 */
const createProduct = async (label: string): Promise<{ productId: string; versionId: string }> => {
  const source = coreProducts[0];
  if (!source) throw new Error('the catalogue fixture is empty');

  const productId = `review-${tag}-${label}`;
  await db.insert(products).values({
    id: productId,
    slug: productId,
    skuPrefix: productId.toUpperCase().replace(/-/g, ''),
    categoryId: source.categoryId,
    nameTh: 'หน้าต่างทดสอบรีวิว',
    summaryTh: 'ทดสอบ',
    heroImage: '/products/probe.svg',
    leadTimeMinDays: 1,
    leadTimeMaxDays: 2,
    pricePerSqmMinor: 220_000n,
    minBillableSqUm: 1_000_000_000_000n,
    elevation: source.elevation,
  });

  const document = toDocument(source);
  const [version] = await db
    .insert(productVersions)
    .values({
      productId,
      version: 1,
      status: 'published',
      publishedAt: new Date(),
      document,
      documentHash: documentHash(document),
    })
    .returning({ id: productVersions.id });
  if (!version) throw new Error('could not publish a version');

  return { productId, versionId: version.id };
};

type Delivered = {
  orderId: string;
  guestId: string;
  lineId: string;
  freeformLineId: string;
  versionId: string;
  productId: string;
};

/** One transition, the way the API has to make it — lock first, read the row, then write. */
const move = async (orderId: string, to: string): Promise<void> => {
  await db.transaction(async (tx) => {
    const [order] = await tx
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, orderId))
      .for('update');
    if (!order) throw new Error('order not found');

    const [transition] = await tx
      .select()
      .from(orderStatusTransitions)
      .where(
        and(
          eq(orderStatusTransitions.fromStatus, order.status),
          eq(orderStatusTransitions.toStatus, to as 'delivered'),
        ),
      );
    if (!transition) throw new Error(`no transition from ${order.status} to ${to}`);

    const eventId = randomUUID();
    await tx.insert(orderEvents).values({
      id: eventId,
      orderId,
      eventType: transition.eventType,
      fromStatus: order.status,
      toStatus: to as 'delivered',
      actorKind: 'staff',
      actorUserId: staff,
    });
    await tx
      .update(orders)
      .set({ status: to as 'delivered', statusEventId: eventId })
      .where(eq(orders.id, orderId));
  });
};

/** Submit: one transaction, one status move, one frozen document. */
const submitOrder = async (orderId: string, guestId: string): Promise<void> => {
  const submitEvent = randomUUID();

  await db.transaction(async (tx) => {
    await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).for('update');

    await tx.insert(orderEvents).values({
      id: submitEvent,
      orderId,
      eventType: 'submitted_for_payment',
      fromStatus: 'draft',
      toStatus: 'awaiting_payment',
      actorKind: 'guest',
      actorGuestId: guestId,
    });

    const [document] = await tx
      .insert(orderDocuments)
      .values({
        orderId,
        revision: 1,
        document: { lines: [] },
        documentHash: randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
        pinnedCoreVersion: '1.0.0',
        pinnedVatRateBp: 700,
        pinnedVatTreatment: 'standard',
        pinnedLocale: 'th',
        netThbMinor: NET,
        vatThbMinor: VAT,
        grandTotalThbMinor: GRAND,
        createdByEventId: submitEvent,
      })
      .returning({ id: orderDocuments.id });
    if (!document) throw new Error('could not pin a document');

    await tx
      .update(orders)
      .set({
        status: 'awaiting_payment',
        statusEventId: submitEvent,
        // The database clock, not this process one: the freeze trigger stamps frozen_at
        // with now(), orders_frozen_after_submitted compares the two, and a Node timestamp
        // makes that a race against container clock skew. See order.repository.ts.
        submittedAt: sql`now()`,
        orderNo: sql`'WW-' || nextval('order_no_seq')`,
        documentId: document.id,
        netThbMinor: NET,
        vatThbMinor: VAT,
        grandTotalThbMinor: GRAND,
        scheduledDepositThbMinor: DEPOSIT,
      })
      .where(eq(orders.id, orderId));
  });
};

/**
 * An order carried all the way to `delivered`, with one catalog line and one free-form line.
 *
 * The free-form line is created every time rather than on request, because it is the fixture
 * for "a delivery charge cannot be reviewed" and a fixture that only exists in the test that
 * needs it is one nothing else can notice the absence of.
 */
const deliverOrder = async (
  options: { product?: { productId: string; versionId: string }; removeLine?: boolean } = {},
): Promise<Delivered> => {
  const product = options.product ?? sharedProduct;
  const guestId = await createGuest();
  const orderId = randomUUID();
  const createdEvent = randomUUID();

  await db.transaction(async (tx) => {
    await tx.insert(orders).values({
      id: orderId,
      statusEventId: createdEvent,
      guestId,
      contactEmail: `review-${randomUUID().slice(0, 8)}@example.test`,
    });
    await tx.insert(orderEvents).values({
      id: createdEvent,
      orderId,
      eventType: 'created',
      toStatus: 'draft',
      actorKind: 'guest',
      actorGuestId: guestId,
    });
  });

  const [line] = await db
    .insert(quoteLines)
    .values({
      orderId,
      seq: 1,
      kind: 'catalog',
      productVersionId: product.versionId,
      skuCode: 'WW-CSW-T6-CLR',
      selections: { glass: 't6', colour: 'clr' },
      measures: { width: '1200000', height: '1500000' },
      configHash: 'a'.repeat(16),
      qty: 1,
      computedTotalThbMinor: NET,
      customerDescriptionTh: 'หน้าต่างบานเลื่อน ห้องนอน 1',
    })
    .returning({ id: quoteLines.id });
  if (!line) throw new Error('could not add a catalog line');

  const [freeform] = await db
    .insert(quoteLines)
    .values({
      orderId,
      seq: 90,
      kind: 'freeform',
      chargeTotalThbMinor: 200_000n,
      customerDescriptionTh: 'ค่าขนส่งและติดตั้ง',
    })
    .returning({ id: quoteLines.id });
  if (!freeform) throw new Error('could not add a free-form line');

  await submitOrder(orderId, guestId);

  if (options.removeLine === true) {
    // Soft removal, the only kind a submitted order allows, while the quote is still
    // editable. The order then goes on to be delivered *without* that window.
    await db
      .update(quoteLines)
      .set({ removedAt: new Date(), removedByUserId: staff })
      .where(eq(quoteLines.id, line.id));
  }

  for (const to of ['production_confirmed', 'in_production', 'awaiting_installation', 'delivered']) {
    await move(orderId, to);
  }

  return {
    orderId,
    guestId,
    lineId: line.id,
    freeformLineId: freeform.id,
    versionId: product.versionId,
    productId: product.productId,
  };
};

type ReviewOptions = {
  rating?: number;
  bodyTh?: string | null;
  authorUserId?: string | null;
  authorGuestId?: string | null;
  windowHours?: number;
  createdAt?: Date;
  displayName?: string | null;
};

const addReview = async (order: Delivered, options: ReviewOptions = {}): Promise<string> => {
  const [row] = await db
    .insert(reviews)
    .values({
      orderId: order.orderId,
      quoteLineId: order.lineId,
      productVersionId: order.versionId,
      rating: options.rating ?? 5,
      bodyTh: options.bodyTh === undefined ? 'บานเลื่อนแน่นดี ผ่านหน้าฝนแล้วไม่รั่ว' : options.bodyTh,
      authorDisplayName: options.displayName === undefined ? 'คุณสมชาย' : options.displayName,
      authorUserId: options.authorUserId ?? null,
      authorGuestId:
        options.authorUserId === undefined || options.authorUserId === null
          ? (options.authorGuestId ?? order.guestId)
          : null,
      moderationWindowHours: options.windowHours ?? REVIEW_MODERATION_HOURS_DEFAULT,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    })
    .returning({ id: reviews.id });
  if (!row) throw new Error('could not write a review');
  return row.id;
};

/** A review that is already public: written in the past, with a window that has elapsed. */
const addPublicReview = async (order: Delivered, options: ReviewOptions = {}): Promise<string> =>
  addReview(order, {
    ...options,
    windowHours: options.windowHours ?? 1,
    createdAt: options.createdAt ?? new Date(Date.now() - 5 * HOUR_MS),
  });

const addPhoto = async (
  reviewId: string,
  options: { seq?: number; source?: string; stored?: string } = {},
): Promise<string> => {
  const stored = options.stored ?? randomUUID().replace(/-/g, '').padEnd(64, 'a').slice(0, 64);
  const source = options.source ?? randomUUID().replace(/-/g, '').padEnd(64, 'b').slice(0, 64);

  const [photo] = await db
    .insert(reviewPhotos)
    .values({
      reviewId,
      seq: options.seq ?? 1,
      storageKey: `review-photos/${randomUUID()}.jpg`,
      contentType: 'image/jpeg',
      byteSize: 240_000n,
      width: 1600,
      height: 1200,
      checksumSha256: stored,
      sourceChecksumSha256: source,
      stripRecipe: 'sharp-rotate-nometa@1',
      altTextTh: 'หน้าต่างที่ติดตั้งแล้ว',
    })
    .returning({ id: reviewPhotos.id });
  if (!photo) throw new Error('could not attach a photo');
  return photo.id;
};

/** A moderator publishing early — the one write that settles moderation without waiting. */
const publish = async (reviewId: string): Promise<void> => {
  await db
    .update(reviews)
    .set({ publishedAt: new Date(), publishedByUserId: moderator })
    .where(eq(reviews.id, reviewId));
};

type Stats = {
  rating_count: string;
  rating_sum: string;
  visible_count: string;
  visible_with_text_count: string;
};

const statsFor = async (productId: string): Promise<Stats | undefined> => {
  const rows = await db.execute<Stats>(sql`
    select rating_count::text, rating_sum::text, visible_count::text, visible_with_text_count::text
      from product_review_stats where product_id = ${productId}
  `);
  return rows.rows[0];
};

const isPublic = async (reviewId: string): Promise<boolean> => {
  const rows = await db.execute<{ ok: boolean }>(sql`
    select review_is_public(r) as ok from reviews r where r.id = ${reviewId}
  `);
  return rows.rows[0]?.ok === true;
};

beforeAll(async () => {
  db = await connect();
  staff = await createUser(`staff ${tag}`);
  moderator = await createUser(`moderator ${tag}`);
  sharedProduct = await createProduct('shared');
});

// ─────────────────────────────────────────────────────────────────────────────
// A review belongs to an order line — plan 9.1
// ─────────────────────────────────────────────────────────────────────────────

describeDb('a review belongs to a line, and the line proves the purchase', () => {
  it('accepts a review on a line of a delivered order', async () => {
    const order = await deliverOrder({ product: await createProduct('happy') });
    const reviewId = await addPublicReview(order, { rating: 4 });

    const [row] = await db
      .select({ rating: reviews.rating, orderId: reviews.orderId })
      .from(reviews)
      .where(eq(reviews.id, reviewId));

    expect(row?.rating).toBe(4);
    expect(row?.orderId).toBe(order.orderId);
    expect(await isPublic(reviewId)).toBe(true);
  });

  /**
   * ⚠️ THE WINDOW. Mutation: drop `reviews_delivered_orders_only` and this goes green for
   * every status — a customer could review a window that has not been made yet.
   *
   * Every pre-delivery status is walked, not just one, because the guard takes its list from
   * `TG_ARGV` and a mutation that widened the list rather than removing the trigger would
   * otherwise be invisible.
   */
  it('refuses a review on an order that has not been delivered', async () => {
    const product = await createProduct('early');
    const guestId = await createGuest();
    const orderId = randomUUID();
    const createdEvent = randomUUID();

    await db.transaction(async (tx) => {
      await tx.insert(orders).values({
        id: orderId,
        statusEventId: createdEvent,
        guestId,
        contactEmail: `early-${tag}@example.test`,
      });
      await tx.insert(orderEvents).values({
        id: createdEvent,
        orderId,
        eventType: 'created',
        toStatus: 'draft',
        actorKind: 'guest',
        actorGuestId: guestId,
      });
    });

    const [line] = await db
      .insert(quoteLines)
      .values({
        orderId,
        seq: 1,
        kind: 'catalog',
        productVersionId: product.versionId,
        skuCode: 'WW-CSW-T6-CLR',
        selections: { glass: 't6' },
        measures: { width: '1200000' },
        configHash: 'c'.repeat(16),
        computedTotalThbMinor: NET,
      })
      .returning({ id: quoteLines.id });
    if (!line) throw new Error('could not add a line');

    const attempt = (): Promise<unknown> =>
      db.insert(reviews).values({
        orderId,
        quoteLineId: line.id,
        productVersionId: product.versionId,
        rating: 5,
        authorGuestId: guestId,
        moderationWindowHours: REVIEW_MODERATION_HOURS_DEFAULT,
      });

    await expectRefusal(attempt(), 'reviews cannot be written against order');

    await submitOrder(orderId, guestId);
    await expectRefusal(attempt(), 'reviews cannot be written against order');

    // …and it is still refused at every station on the way, including the last one before
    // handover. `awaiting_installation` is the interesting one: the window exists, it is on
    // a lorry, and it has not been judged by anybody yet.
    for (const to of ['production_confirmed', 'in_production', 'awaiting_installation']) {
      await move(orderId, to);
      await expectRefusal(attempt(), 'reviews cannot be written against order');
    }

    await move(orderId, 'delivered');
    await expect(attempt()).resolves.toBeDefined();
  });

  /**
   * A delivery charge cannot be reviewed, and no trigger says so — plan 9.1.
   *
   * Mutation: drop `reviews_line_version_fk`. The insert then succeeds and a two-star
   * "installers were late" lands on the average of a *product*, which is the exact
   * misreading plan 9.1 spends its whole section on.
   */
  it('refuses a review of a free-form line, by referential integrity alone', async () => {
    const order = await deliverOrder();

    await expectViolation(
      db.insert(reviews).values({
        orderId: order.orderId,
        quoteLineId: order.freeformLineId,
        productVersionId: order.versionId,
        rating: 2,
        authorGuestId: order.guestId,
        moderationWindowHours: REVIEW_MODERATION_HOURS_DEFAULT,
      }),
      PG.foreignKeyViolation,
    );
  });

  /** Same foreign key, from the other side: the version has to be the one that line bought. */
  it('refuses a review that names a version the line did not carry', async () => {
    const order = await deliverOrder();
    const other = await createProduct('other-version');

    await expectViolation(
      db.insert(reviews).values({
        orderId: order.orderId,
        quoteLineId: order.lineId,
        productVersionId: other.versionId,
        rating: 5,
        authorGuestId: order.guestId,
        moderationWindowHours: REVIEW_MODERATION_HOURS_DEFAULT,
      }),
      PG.foreignKeyViolation,
    );
  });

  /** Mutation: drop `reviews_line_fk`. A review then attaches to one order and cites another's line. */
  it('refuses a review whose line belongs to a different order', async () => {
    const mine = await deliverOrder();
    const theirs = await deliverOrder();

    await expectViolation(
      db.insert(reviews).values({
        orderId: mine.orderId,
        quoteLineId: theirs.lineId,
        productVersionId: theirs.versionId,
        rating: 5,
        authorGuestId: mine.guestId,
        moderationWindowHours: REVIEW_MODERATION_HOURS_DEFAULT,
      }),
      PG.foreignKeyViolation,
    );
  });

  /**
   * Mutation: delete the `line.removed_at` block from `reviews_guard_write()`.
   *
   * A frozen order the factory bounced can lose a line in `redesign` and then be delivered
   * without it. The composite foreign key cannot see that — the row is still there — so this
   * is the one part of "there was something to review" that had to be a trigger.
   */
  it('refuses a review of a line that was removed before delivery', async () => {
    const order = await deliverOrder({ removeLine: true });

    await expectRefusal(
      db.insert(reviews).values({
        orderId: order.orderId,
        quoteLineId: order.lineId,
        productVersionId: order.versionId,
        rating: 5,
        authorGuestId: order.guestId,
        moderationWindowHours: REVIEW_MODERATION_HOURS_DEFAULT,
      }),
      'nothing was delivered to review',
    );
  });

  /** Mutation: drop `reviews_line_key`. A customer can then review one window five times. */
  it('accepts one review per line and refuses the second', async () => {
    const order = await deliverOrder();
    await addReview(order);

    await expectViolation(
      db.insert(reviews).values({
        orderId: order.orderId,
        quoteLineId: order.lineId,
        productVersionId: order.versionId,
        rating: 1,
        authorGuestId: order.guestId,
        moderationWindowHours: REVIEW_MODERATION_HOURS_DEFAULT,
      }),
      PG.uniqueViolation,
    );
  });

  /**
   * Plan 9.2: *reviews are accepted indefinitely.* The window opens at `delivered` and there
   * is no expiry column anywhere — which is only true for ever because `delivered` is
   * terminal. A `delivered → …` transition row added later would make the guard that opens
   * the window into one that can close it, and this is the assertion that notices.
   */
  it('cannot have the window closed on it, because delivered is terminal', async () => {
    const out = await db
      .select({ to: orderStatusTransitions.toStatus })
      .from(orderStatusTransitions)
      .where(eq(orderStatusTransitions.fromStatus, 'delivered'));

    expect(out, 'a transition out of delivered would let the review window close').toStrictEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The moderation deadline is a fact, not a job's promise — plan 9.3
// ─────────────────────────────────────────────────────────────────────────────

describeDb('moderation has a deadline, and the deadline is arithmetic', () => {
  it('holds a fresh review back, and counts it in nothing', async () => {
    const product = await createProduct('pending');
    const order = await deliverOrder({ product });
    const reviewId = await addReview(order, { windowHours: REVIEW_MODERATION_HOURS_DEFAULT });

    expect(await isPublic(reviewId)).toBe(false);
    // Not merely invisible — not counted either. A pending review has not been moderated,
    // and an average that moved before anybody looked would be the other failure.
    expect(await statsFor(product.productId)).toBeUndefined();
  });

  /**
   * ⭐ THE ONE THAT MATTERS. Nothing ran. No worker, no cron, no UPDATE.
   *
   * Mutation: delete the `created_at + make_interval(...) <= now()` disjunct from
   * `review_is_moderated()`. The review then stays invisible for ever unless somebody
   * remembers to press a button, which is plan 9.3's *"an approve-before-publish queue with
   * no SLA is one where reviews never appear"* — the same failure as the refund queue in
   * plan 7.12, shipped on purpose.
   */
  it('publishes a review by the passage of time, with nobody acting', async () => {
    const product = await createProduct('elapsed');
    const order = await deliverOrder({ product });
    const reviewId = await addReview(order, {
      rating: 3,
      windowHours: 1,
      createdAt: new Date(Date.now() - 2 * HOUR_MS),
    });

    const [row] = await db
      .select({ publishedAt: reviews.publishedAt, publishedBy: reviews.publishedByUserId })
      .from(reviews)
      .where(eq(reviews.id, reviewId));

    // Nothing wrote these, and that is the design: there is no status column to flip.
    expect(row?.publishedAt).toBeNull();
    expect(row?.publishedBy).toBeNull();

    expect(await isPublic(reviewId)).toBe(true);
    expect((await statsFor(product.productId))?.rating_count).toBe('1');
  });

  it('lets a moderator publish before the deadline', async () => {
    const product = await createProduct('early-publish');
    const order = await deliverOrder({ product });
    const reviewId = await addReview(order, { windowHours: REVIEW_MODERATION_HOURS_MAX });

    expect(await isPublic(reviewId)).toBe(false);

    await db
      .update(reviews)
      .set({ publishedAt: new Date(), publishedByUserId: moderator })
      .where(eq(reviews.id, reviewId));

    expect(await isPublic(reviewId)).toBe(true);
  });

  /**
   * ⚠️ Mutation: delete the `moderation_window_hours` block from `reviews_guard_write()`.
   *
   * Without it, burying a review is a sequence of individually legal writes — extend the
   * window today, extend it again next week — and every step passes the CHECK that bounds a
   * single value. That is the "no SLA" failure wearing a number.
   */
  it('will not let the moderation window be extended after the fact', async () => {
    const order = await deliverOrder();
    const reviewId = await addReview(order, { windowHours: 2 });

    await expectRefusal(
      db.update(reviews).set({ moderationWindowHours: 720 }).where(eq(reviews.id, reviewId)),
      'the moderation window is fixed at',
    );
  });

  /** Mutation: drop `reviews_moderation_window_bounded`. Both ends matter and both are walked. */
  it('refuses a window of zero and a window past the ceiling', async () => {
    const order = await deliverOrder();

    for (const hours of [0, REVIEW_MODERATION_HOURS_MAX + 1]) {
      await expectCheck(
        db.insert(reviews).values({
          orderId: order.orderId,
          quoteLineId: order.lineId,
          productVersionId: order.versionId,
          rating: 5,
          authorGuestId: order.guestId,
          moderationWindowHours: hours,
        }),
        'reviews_moderation_window_bounded',
      );
    }
  });

  /**
   * `product_review_schedule` is the answer to plan 8.2 trap 1 arriving from the one
   * direction the plan does not name: a review that publishes itself has no writer, so there
   * is no request anywhere to hang `revalidateTag('product:' + id)` on.
   *
   * Mutation: drop the view. There is then no way for a page cached with `revalidate = false`
   * to learn that its average is about to change on its own.
   */
  it('says when the next silent publication will happen, so a cached page can be told', async () => {
    const product = await createProduct('schedule');
    const order = await deliverOrder({ product });
    await addReview(order, { windowHours: 5 });

    const rows = await db.execute<{ pending_count: string; next_publication_at: string }>(sql`
      select pending_count::text, next_publication_at::text
        from product_review_schedule where product_id = ${product.productId}
    `);

    expect(rows.rows[0]?.pending_count).toBe('1');
    expect(new Date(rows.rows[0]?.next_publication_at ?? 0).getTime()).toBeGreaterThan(Date.now());

    // And once it is public it drops off the schedule, so polling this costs nothing on the
    // 81 products that have no reviews at all.
    const settled = await createProduct('schedule-settled');
    await addPublicReview(await deliverOrder({ product: settled }));
    const after = await db.execute(
      sql`select 1 from product_review_schedule where product_id = ${settled.productId}`,
    );
    expect(after.rows).toHaveLength(0);
  });

  it("ships plan 13's two review defaults, and marks them as defaults", () => {
    expect(REVIEW_MODERATION_HOURS_DEFAULT).toBe(72);
    expect(REVIEW_INVITATION_DELAY_DAYS_DEFAULT).toBe(30);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Hide, never delete — and the rating counts either way — plan 9.3
// ─────────────────────────────────────────────────────────────────────────────

describeDb('the company may hide, never delete, and the rating counts either way', () => {
  /** Mutation: delete the DELETE branch from `reviews_guard_write()`. */
  it('refuses to delete a review', async () => {
    const order = await deliverOrder();
    const reviewId = await addPublicReview(order, { rating: 1 });

    await expectRefusal(
      db.delete(reviews).where(eq(reviews.id, reviewId)),
      'is hidden, never deleted',
    );

    const [row] = await db.select({ id: reviews.id }).from(reviews).where(eq(reviews.id, reviewId));
    expect(row?.id).toBe(reviewId);
  });

  /** Mutation: drop `reviews_hidden_shape`. Hiding then costs nothing and names nobody. */
  it('refuses a hiding with no person and no reason on it', async () => {
    const order = await deliverOrder();
    const reviewId = await addPublicReview(order);

    await expectCheck(
      db.update(reviews).set({ hiddenAt: new Date() }).where(eq(reviews.id, reviewId)),
      'reviews_hidden_shape',
    );
    await expectCheck(
      db
        .update(reviews)
        .set({ hiddenAt: new Date(), hiddenByUserId: moderator })
        .where(eq(reviews.id, reviewId)),
      'reviews_hidden_shape',
    );

    await expect(
      db
        .update(reviews)
        .set({ hiddenAt: new Date(), hiddenByUserId: moderator, hiddenReason: 'off_topic' })
        .where(eq(reviews.id, reviewId)),
    ).resolves.toBeDefined();
  });

  /** Mutation: drop `reviews_hidden_other_needs_a_note`. The vocabulary then has a hole in it. */
  it("refuses 'other' with no sentence under it", async () => {
    const order = await deliverOrder();
    const reviewId = await addPublicReview(order);

    await expectCheck(
      db
        .update(reviews)
        .set({ hiddenAt: new Date(), hiddenByUserId: moderator, hiddenReason: 'other' })
        .where(eq(reviews.id, reviewId)),
      'reviews_hidden_other_needs_a_note',
    );

    await expect(
      db
        .update(reviews)
        .set({
          hiddenAt: new Date(),
          hiddenByUserId: moderator,
          hiddenReason: 'other',
          hiddenNoteTh: 'อ้างชื่อพนักงานติดตั้งโดยไม่ได้รับอนุญาต',
        })
        .where(eq(reviews.id, reviewId)),
    ).resolves.toBeDefined();
  });

  it('knows only the reasons the vocabulary names', async () => {
    const order = await deliverOrder();
    const reviewId = await addPublicReview(order);

    await expectCheck(
      db.execute(sql`
        update reviews set hidden_at = now(), hidden_by_user_id = ${moderator}::uuid,
                           hidden_reason = 'bad_for_business'
         where id = ${reviewId}::uuid
      `),
      'reviews_hidden_reason_known',
    );

    expect([...REVIEW_HIDDEN_REASONS]).toStrictEqual([
      'abusive',
      'personal_data',
      'off_topic',
      'spam',
      'other',
    ]);
  });

  /**
   * ⭐⭐ THE ONE THE WHOLE SECTION TURNS ON — plan 9.3.
   *
   * Mutation: add `AND r.hidden_at IS NULL` to `product_review_stats`' WHERE clause, which is
   * the "obvious" definition and the one that turns hiding into a tool for dressing the
   * score. This goes red on `rating_count` and on `rating_sum`; nothing else in the file
   * notices, which is why it is a test of its own.
   */
  it('goes on counting a hidden rating in the average', async () => {
    const product = await createProduct('hidden-counts');
    const kept = await deliverOrder({ product });
    const buried = await deliverOrder({ product });

    await addPublicReview(kept, { rating: 5 });
    const bad = await addPublicReview(buried, { rating: 1 });

    const before = await statsFor(product.productId);
    expect(before?.rating_count).toBe('2');
    expect(before?.rating_sum).toBe('6');

    await db
      .update(reviews)
      .set({ hiddenAt: new Date(), hiddenByUserId: moderator, hiddenReason: 'abusive' })
      .where(eq(reviews.id, bad));

    const after = await statsFor(product.productId);
    // The text is down…
    expect(await isPublic(bad)).toBe(false);
    expect(after?.visible_count).toBe('1');
    // …and the one star is still in the average. 6/2, not 5/1.
    expect(after?.rating_count).toBe('2');
    expect(after?.rating_sum).toBe('6');
  });

  /**
   * And the other half of the same sentence, which is what makes "record a reason" more than
   * paperwork: the moderator who hides a one-star review cannot also make it a five.
   *
   * Mutation: delete the `NEW.rating <> OLD.rating` block from `reviews_guard_write()`.
   */
  it('will not let a moderated rating be edited by anybody, for any reason', async () => {
    const order = await deliverOrder();
    const reviewId = await addPublicReview(order, { rating: 1 });

    await expectRefusal(
      db.update(reviews).set({ rating: 5 }).where(eq(reviews.id, reviewId)),
      'the rating is fixed once the review has been moderated',
    );

    // Not even together with a legitimate hiding, which is the shape somebody would actually
    // write: one UPDATE that hides the review and tidies the number on the way past.
    await expectRefusal(
      db
        .update(reviews)
        .set({ rating: 5, hiddenAt: new Date(), hiddenByUserId: moderator, hiddenReason: 'abusive' })
        .where(eq(reviews.id, reviewId)),
      'the rating is fixed once the review has been moderated',
    );
  });

  /** Mutation: delete the `body_th` block. A reply then answers a review that can be rewritten. */
  it('will not let published prose be rewritten', async () => {
    const order = await deliverOrder();
    const reviewId = await addPublicReview(order);

    await expectRefusal(
      db.update(reviews).set({ bodyTh: 'จริงๆ แล้วดีมาก' }).where(eq(reviews.id, reviewId)),
      'what was published cannot be rewritten',
    );
  });

  /**
   * The counterpart, and it is here so the freeze above is known to be *conditional*.
   *
   * A review still inside its window has not been shown to anybody, so the author fixing a
   * typo is a correction rather than a rewrite. A blanket freeze would read the same in the
   * migration and would be a different product.
   */
  it('lets a review be corrected while it is still inside its window', async () => {
    const order = await deliverOrder();
    const reviewId = await addReview(order, { rating: 4, windowHours: 720 });

    await expect(
      db
        .update(reviews)
        .set({ rating: 3, bodyTh: 'แก้คำผิด: บานล่างฝืดนิดหน่อย' })
        .where(eq(reviews.id, reviewId)),
    ).resolves.toBeDefined();
  });

  it('refuses to re-point a review at another line or another author', async () => {
    const order = await deliverOrder();
    const elsewhere = await deliverOrder();
    const reviewId = await addPublicReview(order);

    await expectRefusal(
      db
        .update(reviews)
        .set({ quoteLineId: elsewhere.lineId, orderId: elsewhere.orderId })
        .where(eq(reviews.id, reviewId)),
      'cannot be re-pointed or re-attributed',
    );
    await expectRefusal(
      db.update(reviews).set({ authorUserId: moderator }).where(eq(reviews.id, reviewId)),
      'cannot be re-pointed or re-attributed',
    );
  });

  /** One reply, and "no threads" is enforced by there being one row to hold one. */
  it('holds exactly one reply, without a table to count', async () => {
    const order = await deliverOrder();
    const reviewId = await addPublicReview(order, { rating: 2 });

    await expectCheck(
      db.update(reviews).set({ replyTh: 'ขออภัยครับ' }).where(eq(reviews.id, reviewId)),
      'reviews_reply_shape',
    );

    await expect(
      db
        .update(reviews)
        .set({ replyTh: 'ขออภัยครับ ทีมช่างจะติดต่อกลับ', repliedByUserId: staff, repliedAt: new Date() })
        .where(eq(reviews.id, reviewId)),
    ).resolves.toBeDefined();

    const columns = await db.execute<{ n: string }>(sql`
      select count(*)::text as n from information_schema.tables
       where table_schema = 'public' and table_name in ('review_replies', 'review_comments')
    `);
    expect(columns.rows[0]?.n, 'a replies table would be a thread with extra steps').toBe('0');
  });

  it('refuses a rating outside one to five', async () => {
    const order = await deliverOrder();

    for (const rating of [0, 6]) {
      await expectCheck(
        db.insert(reviews).values({
          orderId: order.orderId,
          quoteLineId: order.lineId,
          productVersionId: order.versionId,
          rating,
          authorGuestId: order.guestId,
          moderationWindowHours: REVIEW_MODERATION_HOURS_DEFAULT,
        }),
        'reviews_rating_range',
      );
    }
  });

  it('refuses a review with no author and one with two', async () => {
    const order = await deliverOrder();
    const author = await createUser(`author ${tag}`);

    await expectCheck(
      db.insert(reviews).values({
        orderId: order.orderId,
        quoteLineId: order.lineId,
        productVersionId: order.versionId,
        rating: 5,
        moderationWindowHours: REVIEW_MODERATION_HOURS_DEFAULT,
      }),
      'reviews_author_shape',
    );
    await expectCheck(
      db.insert(reviews).values({
        orderId: order.orderId,
        quoteLineId: order.lineId,
        productVersionId: order.versionId,
        rating: 5,
        authorUserId: author,
        authorGuestId: order.guestId,
        moderationWindowHours: REVIEW_MODERATION_HOURS_DEFAULT,
      }),
      'reviews_author_shape',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The average, its count, and the 81 pages with nothing on them — plan 9.5
// ─────────────────────────────────────────────────────────────────────────────

describeDb('an average is never shown without its count', () => {
  /**
   * ⚠️ A SHAPE ASSERTION, NOT A REFUSAL — see the file's block comment.
   *
   * Plan 9.5: *never show an average without its count* — "5.0 ★" from one review reads as
   * advertising. A view exposing `avg_rating` would make the honest rendering the one that
   * remembers a second column. Exposing the sum and the count instead means a caller has to
   * divide, and to divide it has to be holding the count.
   *
   * Mutation: add `avg(r.rating) AS avg_rating` to the view and this goes red.
   */
  it('exposes a sum and a count and no average at all', async () => {
    const columns = await db.execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'product_review_stats'
       order by column_name
    `);
    const names = columns.rows.map((row) => row.column_name);

    expect(names).toContain('rating_sum');
    expect(names).toContain('rating_count');
    expect(
      names.filter((name) => /avg|average|mean|score|stars/.test(name)),
      'a caller could then render an average without ever holding the count',
    ).toStrictEqual([]);
  });

  /**
   * Plan 9.5's ⚠️: 81 products, no orders, and *"ยังไม่มีรีวิว"* printed on every page is
   * worse than silence. There is no row to render a zero from.
   *
   * Mutation: replace `GROUP BY` with a LEFT JOIN from `products`, which is how somebody
   * would "fix" the missing rows, and the storefront starts printing an empty state on 81
   * pages.
   */
  it('has no row at all for a product nobody has reviewed', async () => {
    const quiet = await createProduct('quiet');
    await deliverOrder({ product: quiet });

    expect(await statsFor(quiet.productId)).toBeUndefined();
  });

  /**
   * ⭐ Mutation: add `author_user_id` back to `published_reviews`.
   *
   * The public projection cannot be joined back to a person, so the query that renders a
   * review page has nothing to leak even if somebody adds a join to it later. Plan 9.4's
   * whole worry is a review page publishing more about the customer than they meant to.
   */
  it('publishes no way to identify the author', async () => {
    const columns = await db.execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'published_reviews'
    `);
    const names = columns.rows.map((row) => row.column_name);

    expect(names).toContain('author_display_name');
    expect(names.filter((name) => /user_id|guest_id/.test(name))).toStrictEqual([]);
  });

  /** Mutation: drop `review_is_public(r)` from the view's WHERE clause. Both halves go red. */
  it('shows neither a pending review nor a hidden one', async () => {
    const product = await createProduct('projection');
    const pendingOrder = await deliverOrder({ product });
    const hiddenOrder = await deliverOrder({ product });
    const liveOrder = await deliverOrder({ product });

    await addReview(pendingOrder, { bodyTh: 'ยังไม่ผ่านการกลั่นกรอง', windowHours: 720 });
    const hidden = await addPublicReview(hiddenOrder, { bodyTh: 'ข้อความที่ถูกซ่อน' });
    await addPublicReview(liveOrder, { bodyTh: 'ข้อความที่เผยแพร่' });

    await db
      .update(reviews)
      .set({ hiddenAt: new Date(), hiddenByUserId: moderator, hiddenReason: 'personal_data' })
      .where(eq(reviews.id, hidden));

    const rows = await db.execute<{ body_th: string; public_since: string }>(sql`
      select body_th, public_since::text from published_reviews where product_id = ${product.productId}
    `);

    expect(rows.rows.map((row) => row.body_th)).toStrictEqual(['ข้อความที่เผยแพร่']);
    // `public_since` is the moment the window elapsed, not `created_at`: a page showing the
    // creation date would tell the reader the review had been up five hours longer than it had.
    expect(rows.rows[0]?.public_since).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The photographs — plan 9.4
// ─────────────────────────────────────────────────────────────────────────────

describeDb('a photograph of a customer’s own house', () => {
  /**
   * 📍 ⭐ Mutation: drop `review_photos_bytes_were_rewritten`.
   *
   * Equal checksums mean the stored bytes are the uploaded bytes, which for a phone JPEG
   * means the customer's coordinates are sitting in object storage and about to be served.
   * This is the commonest and worst implementation — stream the upload straight through —
   * and it becomes a write error on the row that did it.
   *
   * ⚠️ What it does NOT prove is written on the table in review.ts: a stripper that
   * re-encodes and forgets the GPS tag passes. `strip_recipe` is the other half.
   */
  it('refuses a photo whose stored bytes are the bytes that arrived', async () => {
    const order = await deliverOrder();
    const reviewId = await addReview(order);
    const same = 'd'.repeat(64);

    await expectCheck(
      db.insert(reviewPhotos).values({
        reviewId,
        seq: 1,
        storageKey: `review-photos/${randomUUID()}.jpg`,
        contentType: 'image/jpeg',
        byteSize: 240_000n,
        width: 1600,
        height: 1200,
        checksumSha256: same,
        sourceChecksumSha256: same,
        stripRecipe: 'passthrough',
      }),
      'review_photos_bytes_were_rewritten',
    );
  });

  it('refuses a photo that names no stripper', async () => {
    const order = await deliverOrder();
    const reviewId = await addReview(order);

    await expectCheck(
      db.insert(reviewPhotos).values({
        reviewId,
        seq: 1,
        contentType: 'image/jpeg',
        byteSize: 1n,
        width: 1,
        height: 1,
        checksumSha256: 'a'.repeat(64),
        sourceChecksumSha256: 'b'.repeat(64),
        stripRecipe: '   ',
      }),
      'review_photos_strip_recipe_present',
    );
  });

  /**
   * ⭐ Plan 9.4(2), and the reason a photo is a child row rather than a column.
   *
   * Mutation: change the DELETE branch of `review_photos_guard_write()` to refuse. The only
   * way left to remove a picture of somebody's house is to remove the review, which is the
   * one thing plan 9.3 forbids — so the two requirements would be in direct contradiction.
   */
  it('lets a photo be deleted while the review and its rating survive', async () => {
    const product = await createProduct('photo-delete');
    const order = await deliverOrder({ product });
    // Attached while the review is still inside its window — that is the only time a photo
    // may be added, and it is asserted in its own test below.
    const reviewId = await addReview(order, { rating: 4, windowHours: 720 });
    const photoId = await addPhoto(reviewId);
    await publish(reviewId);

    const before = await statsFor(product.productId);
    expect(before?.rating_sum).toBe('4');

    await expect(db.delete(reviewPhotos).where(eq(reviewPhotos.id, photoId))).resolves.toBeDefined();

    expect(
      await db.select().from(reviewPhotos).where(eq(reviewPhotos.id, photoId)),
    ).toHaveLength(0);
    const after = await statsFor(product.productId);
    expect(after?.rating_sum).toBe('4');
    expect(after?.rating_count).toBe('1');
  });

  /**
   * The retention sweep's half: the bytes go, the row stays saying a photo existed.
   *
   * Mutation: delete the `storage_key` block from `review_photos_guard_write()` — the sweep
   * becomes reversible by pointing the row back at the same object.
   */
  it('lets the bytes be cleared with a stamp, and refuses every other move', async () => {
    const order = await deliverOrder();
    const reviewId = await addReview(order);
    const photoId = await addPhoto(reviewId);

    await expectRefusal(
      db
        .update(reviewPhotos)
        .set({ storageKey: `review-photos/${randomUUID()}.jpg` })
        .where(eq(reviewPhotos.id, photoId)),
      'the only move storage_key has is to NULL',
    );

    // Clearing it without saying that is what happened is refused by the same trigger, and
    // the *direction* is what it is enforcing: the bytes may go, quietly is not one of the
    // ways they may go. `review_photos_erasure_shape` is the CHECK behind it and has its own
    // test below, because a BEFORE trigger fires first and would otherwise mask it for ever.
    await expectRefusal(
      db.update(reviewPhotos).set({ storageKey: null }).where(eq(reviewPhotos.id, photoId)),
      'the only move storage_key has is to NULL',
    );

    await expect(
      db
        .update(reviewPhotos)
        .set({ storageKey: null, storageKeyErasedAt: new Date() })
        .where(eq(reviewPhotos.id, photoId)),
    ).resolves.toBeDefined();
  });

  /**
   * ⚠️ The CHECK behind the trigger, tested on INSERT because that is the only statement where
   * it is not masked. Found the same way `users_erased_has_no_name` was in phase 5b: the
   * trigger refuses every UPDATE that would reach it, so dropping the constraint left the
   * suite green until a test went at it from an angle the trigger does not cover.
   *
   * Mutation: drop `review_photos_erasure_shape`.
   */
  it('refuses a photo that claims its bytes were erased while still holding a key', async () => {
    const order = await deliverOrder();
    const reviewId = await addReview(order);

    await expectCheck(
      db.insert(reviewPhotos).values({
        reviewId,
        seq: 1,
        storageKey: `review-photos/${randomUUID()}.jpg`,
        storageKeyErasedAt: new Date(),
        contentType: 'image/jpeg',
        byteSize: 1n,
        width: 1,
        height: 1,
        checksumSha256: 'a'.repeat(64),
        sourceChecksumSha256: 'b'.repeat(64),
        stripRecipe: 'sharp-rotate-nometa@1',
      }),
      'review_photos_erasure_shape',
    );
  });

  /** Mutation: delete the identity block. A published page then shows bytes nobody moderated. */
  it('refuses to re-point a photo at different bytes', async () => {
    const order = await deliverOrder();
    const reviewId = await addReview(order);
    const photoId = await addPhoto(reviewId);

    await expectRefusal(
      db
        .update(reviewPhotos)
        .set({ checksumSha256: 'f'.repeat(64) })
        .where(eq(reviewPhotos.id, photoId)),
      'identifies a fixed sequence of bytes',
    );

    // Alt text is the one editable column — `media.ts`'s rule, and its reason.
    await expect(
      db.update(reviewPhotos).set({ altTextTh: 'มุมมองจากในบ้าน' }).where(eq(reviewPhotos.id, photoId)),
    ).resolves.toBeDefined();
  });

  /**
   * Mutation: delete the `review_is_moderated(parent)` block from the insert branch.
   *
   * Otherwise the moderation window is a control over prose only: post something bland, wait
   * three days, then attach whatever you like to a page that is already public.
   */
  it('refuses a photo attached after moderation has settled', async () => {
    const order = await deliverOrder();
    const reviewId = await addPublicReview(order);

    await expectRefusal(addPhoto(reviewId), 'has already been moderated');
  });

  it('does not deduplicate two customers’ photographs', async () => {
    const first = await addReview(await deliverOrder());
    const second = await addReview(await deliverOrder());
    const shared = 'e'.repeat(64);

    await addPhoto(first, { stored: shared });
    // Same bytes, two rows. `media_objects` would converge them, and purging one person's
    // image would then purge another's — plan 7.16 names that trap for the catalogue table.
    await expect(addPhoto(second, { stored: shared })).resolves.toBeTruthy();

    const indexes = await db.execute<{ n: string }>(sql`
      select count(*)::text as n from pg_indexes
       where tablename = 'review_photos' and indexdef ilike '%unique%' and indexdef ilike '%checksum_sha256%'
    `);
    expect(indexes.rows[0]?.n, 'deduplicating customer uploads makes one erasure destroy another').toBe('0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Erasure — plan 7.16, and the decision this phase had to make
// ─────────────────────────────────────────────────────────────────────────────

const close = (userId: string): Promise<unknown> =>
  db.execute(sql`select close_user(${userId}::uuid)`);

const erase = (userId: string): Promise<unknown> =>
  db.execute(
    sql`select erase_user(${userId}::uuid, null::uuid, 'self_service', 'PDPA s.33 right to erasure')`,
  );

describeDb('what an erasure does to a review', () => {
  /**
   * ⭐ The decision, exercised rather than argued: the photographs and the prose go, the
   * rating stays.
   *
   * Two mutations, and each turns exactly one assertion red:
   *   * delete the `DELETE FROM review_photos` statement in `erase_user()` — the picture of
   *     somebody's house survives their request to be forgotten;
   *   * delete the `UPDATE reviews SET body_th = NULL …` statement — the paragraph does.
   *
   * And one that must NOT be added: deleting the review, or its rating, would let erasure do
   * what plan 9.3 spends three mechanisms forbidding hiding from doing.
   */
  it('deletes the photographs, scrubs the prose, and keeps the rating', async () => {
    const product = await createProduct('erasure');
    const order = await deliverOrder({ product });
    const author = await createUser(`ผู้รีวิว ${tag}`);

    const reviewId = await addReview(order, {
      rating: 2,
      bodyTh: 'บ้านผมอยู่ซอยเดียวกับร้าน บานล่างฝืด',
      displayName: 'สมชาย ก.',
      authorUserId: author,
      windowHours: 720,
    });
    await addPhoto(reviewId);
    await publish(reviewId);

    expect((await statsFor(product.productId))?.rating_sum).toBe('2');

    await close(author);
    await erase(author);

    const [row] = await db
      .select({
        rating: reviews.rating,
        bodyTh: reviews.bodyTh,
        displayName: reviews.authorDisplayName,
        authorUserId: reviews.authorUserId,
        contentErasedAt: reviews.contentErasedAt,
      })
      .from(reviews)
      .where(eq(reviews.id, reviewId));

    expect(row?.bodyTh, 'the prose survived an erasure').toBeNull();
    expect(row?.displayName, 'the name survived an erasure').toBeNull();
    expect(row?.contentErasedAt, 'nothing recorded that the content was erased').not.toBeNull();

    expect(
      await db.select().from(reviewPhotos).where(eq(reviewPhotos.reviewId, reviewId)),
      'a photograph of the customer’s house survived their erasure',
    ).toHaveLength(0);

    // Kept, deliberately, and both halves are the decision: the rating so that an erasure
    // cannot move a published average, and the uuid because it names a tombstone and is the
    // only handle a better erasure could use to find this row again.
    expect(row?.rating).toBe(2);
    expect(row?.authorUserId).toBe(author);
    expect((await statsFor(product.productId))?.rating_sum).toBe('2');
  });

  /**
   * The scrub is a *shape*, not a privileged path. `reviews_guard_write()` cannot see who is
   * calling and does not try — so the erasure is available to anybody writing exactly that
   * UPDATE, and every other route to changing published prose is closed, including that one
   * used twice.
   *
   * Mutation: replace the `erasing` predicate with `TRUE` and the first two assertions go
   * green, which is the whole freeze gone.
   */
  it('permits exactly the erasure shape and nothing adjacent to it', async () => {
    const order = await deliverOrder();
    const reviewId = await addPublicReview(order, { bodyTh: 'ข้อความ', displayName: 'ก.' });

    // The prose without the stamp: a quiet edit wearing the erasure's clothes.
    await expectRefusal(
      db.update(reviews).set({ bodyTh: null }).where(eq(reviews.id, reviewId)),
      'what was published cannot be rewritten',
    );
    // The stamp without the prose going: a DSAR answer contradicted by its own row.
    await expectCheck(
      db.update(reviews).set({ contentErasedAt: new Date() }).where(eq(reviews.id, reviewId)),
      'reviews_content_erasure_shape',
    );

    await expect(
      db
        .update(reviews)
        .set({ bodyTh: null, authorDisplayName: null, contentErasedAt: new Date() })
        .where(eq(reviews.id, reviewId)),
    ).resolves.toBeDefined();

    // And once, not twice: the record of an erasure is not something a later write may move.
    await expectRefusal(
      db.update(reviews).set({ contentErasedAt: new Date() }).where(eq(reviews.id, reviewId)),
      'the record of a content erasure cannot be rewritten',
    );
  });

  /**
   * ⭐ Mutation: drop the `reviews_refuse_erased_author` trigger.
   *
   * Unlike the six credential guards 0009 wrote against a caller that does not exist, this
   * one has a reachable caller today: a review invitation is a tokenised link in an email,
   * not a session, so an erased customer with the mail still in their inbox can follow it.
   * Without the trigger, "forget me" is followed by that person publishing a paragraph and a
   * photograph of their house.
   */
  it('refuses a new review from a tombstone', async () => {
    const order = await deliverOrder();
    const author = await createUser(`กลับมา ${tag}`);

    await close(author);
    await erase(author);

    await expectRefusal(
      db.insert(reviews).values({
        orderId: order.orderId,
        quoteLineId: order.lineId,
        productVersionId: order.versionId,
        rating: 5,
        authorUserId: author,
        moderationWindowHours: REVIEW_MODERATION_HOURS_DEFAULT,
      }),
      'nothing may be published under that account',
    );
  });

  /**
   * ⚠️ THE BLINDNESS, ASSERTED SO THAT IT IS DOCUMENTED IN CODE AND NOT ONLY IN A COMMENT.
   *
   * A review written by a guest who never signed in has no `users` row to erase by, and the
   * anonymous funnel is the main funnel (plan 6). This is the same gap plan 7.16 names for
   * guest orders, and it is a gap in the *unit of erasure* — the account, not the person —
   * which is a decision the owner has not made. If somebody later makes `erase_user()` reach
   * guests, this test is where they find out they have changed the answer.
   */
  it('cannot reach a review written by a guest who never signed in', async () => {
    const order = await deliverOrder();
    const claimant = await createUser(`ผู้อ้างสิทธิ์ ${tag}`);
    const reviewId = await addPublicReview(order, { bodyTh: 'เขียนโดยผู้เยี่ยมชม' });

    await close(claimant);
    await erase(claimant);

    const [row] = await db
      .select({ bodyTh: reviews.bodyTh, guestId: reviews.authorGuestId })
      .from(reviews)
      .where(eq(reviews.id, reviewId));

    expect(row?.guestId).toBe(order.guestId);
    expect(
      row?.bodyTh,
      'if this is now null, the unit of erasure has changed and plan 7.16 item 4 needs rewriting',
    ).toBe('เขียนโดยผู้เยี่ยมชม');
  });

  it('names a treatment for every one of the five new references to users', () => {
    expect(ERASURE_TREATMENTS['reviews.author_user_id']).toBe('scrub');
    expect(ERASURE_TREATMENTS['reviews.hidden_by_user_id']).toBe('keep');
    expect(ERASURE_TREATMENTS['reviews.published_by_user_id']).toBe('keep');
    expect(ERASURE_TREATMENTS['reviews.replied_by_user_id']).toBe('keep');
    expect(ERASURE_TREATMENTS['user_preferences.user_id']).toBe('delete');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The ordinary shape checks — added because the mutation run said so
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ EVERY TEST IN THIS BLOCK EXISTS BECAUSE A MUTATION RUN CAME BACK GREEN.
 *
 * The six constraints below were written with the tables and were then dropped one at a time
 * against a scratch database — and the whole suite stayed green for all six. They are not
 * interesting rules; they are the ordinary "a field somebody's form posted is not a value"
 * kind. That is exactly why they had no evidence: nothing else in the file goes at them, so
 * a later migration could have removed any of them and nothing would have said a word.
 *
 * Written down as a block rather than scattered, so the next person can see what the house
 * rule actually bought: six guards that were claimed and are now shown.
 */
describeDb('the shape checks nothing else was exercising', () => {
  /** Mutation: drop `reviews_body_not_blank`. */
  it('refuses a review body that is only whitespace', async () => {
    const order = await deliverOrder();

    await expectCheck(
      db.insert(reviews).values({
        orderId: order.orderId,
        quoteLineId: order.lineId,
        productVersionId: order.versionId,
        rating: 5,
        bodyTh: '   ',
        authorGuestId: order.guestId,
        moderationWindowHours: REVIEW_MODERATION_HOURS_DEFAULT,
      }),
      'reviews_body_not_blank',
    );
  });

  /** Mutation: drop `reviews_reply_not_blank`. A reply of nothing is worse than none. */
  it('refuses a reply that is only whitespace', async () => {
    const order = await deliverOrder();
    const reviewId = await addPublicReview(order);

    await expectCheck(
      db
        .update(reviews)
        .set({ replyTh: '  ', repliedByUserId: staff, repliedAt: new Date() })
        .where(eq(reviews.id, reviewId)),
      'reviews_reply_not_blank',
    );
  });

  /** Mutation: drop `reviews_hidden_note_needs_a_hiding`. */
  it('refuses a moderation note attached to no hiding at all', async () => {
    const order = await deliverOrder();
    const reviewId = await addPublicReview(order);

    await expectCheck(
      db.update(reviews).set({ hiddenNoteTh: 'คุยกับลูกค้าแล้ว' }).where(eq(reviews.id, reviewId)),
      'reviews_hidden_note_needs_a_hiding',
    );
  });

  /**
   * Mutation: drop `reviews_published_shape`.
   *
   * An early publication is a decision, and a decision with nobody's name on it is the same
   * hole `reviews_hidden_shape` closes at the other end of the same choice.
   */
  it('refuses an early publication with nobody behind it', async () => {
    const order = await deliverOrder();
    const reviewId = await addReview(order, { windowHours: 720 });

    await expectCheck(
      db.update(reviews).set({ publishedAt: new Date() }).where(eq(reviews.id, reviewId)),
      'reviews_published_shape',
    );
  });

  /** Mutation: drop `reviews_moderation_after_creation`. */
  it('refuses a hiding dated before the review was written', async () => {
    const order = await deliverOrder();
    const reviewId = await addPublicReview(order);

    await expectCheck(
      db
        .update(reviews)
        .set({
          hiddenAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
          hiddenByUserId: moderator,
          hiddenReason: 'spam',
        })
        .where(eq(reviews.id, reviewId)),
      'reviews_moderation_after_creation',
    );
  });

  /**
   * Mutation: drop `review_photos_content_type_supported`.
   *
   * Raw SQL on purpose: drizzle's `{ enum }` narrows TypeScript and narrows nothing in
   * Postgres, so a typed insert cannot express the value the CHECK exists to refuse — the
   * lesson `forfeit_policy_rules` learned the hard way in phase 5b. `image/svg+xml` is the
   * one that matters: it is XML that can carry script, served from this company's origin.
   */
  it('refuses a photo content type that is not an image the server will serve', async () => {
    const order = await deliverOrder();
    const reviewId = await addReview(order);

    await expectCheck(
      db.execute(sql`
        insert into review_photos
          (review_id, seq, content_type, byte_size, width, height,
           checksum_sha256, source_checksum_sha256, strip_recipe)
        values (${reviewId}::uuid, 1, 'image/svg+xml', 1, 1, 1,
                ${'a'.repeat(64)}, ${'b'.repeat(64)}, 'sharp-rotate-nometa@1')
      `),
      'review_photos_content_type_supported',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The profile — sections 4.1, 4.2 and 8.2 trap 3
// ─────────────────────────────────────────────────────────────────────────────

describeDb('a preference is presentation and can never be anything else', () => {
  /**
   * ⭐ A SHAPE ASSERTION. Plan 4.1/4.2: the canonical value never moves, and a preference
   * must not become a fourth way to change a stored number.
   *
   * There is no quantity in this table for a preference to be applied to. Mutation: add a
   * `bigint` to `user_preferences` — a "preferred rounding", a "default width" — and this
   * goes red before anybody has to notice what it would be multiplied into.
   */
  it('holds no money and no length for a preference to be applied to', async () => {
    const columns = await db.execute<{ column_name: string; data_type: string }>(sql`
      select column_name, data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'user_preferences'
    `);

    expect(
      columns.rows.filter((row) =>
        ['bigint', 'numeric', 'integer', 'smallint', 'double precision', 'real'].includes(
          row.data_type,
        ),
      ),
    ).toStrictEqual([]);
  });

  /**
   * ⭐ And nothing may reference it, so a preference cannot become a term of a contract.
   *
   * `order_documents.pinned_locale` is where a language becomes part of a document, frozen
   * at `submit_for_payment` (plan 10.6 and 7.13). A foreign key from any pinned row to this
   * table would mean a reprint came out in whatever language the customer prefers *today*,
   * which is a document nobody can cite.
   */
  it('is referenced by nothing at all', async () => {
    const referrers = await db.execute<{ ref: string }>(sql`
      select tc.table_name || '.' || kcu.column_name as ref
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
        join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
       where tc.constraint_type = 'FOREIGN KEY' and ccu.table_name = 'user_preferences'
    `);

    expect(referrers.rows.map((row) => row.ref)).toStrictEqual([]);
  });

  it('stores a locale, a currency and a unit, and nothing else', async () => {
    const person = await createUser(`ผู้ใช้ ${tag}`);

    await db
      .insert(userPreferences)
      .values({ userId: person, preferredLocale: 'my', displayCurrency: 'MYR', displayLengthUnit: 'in' });

    const [row] = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, person));

    expect(row?.preferredLocale).toBe('my');
    expect(row?.displayCurrency).toBe('MYR');
    expect(row?.displayLengthUnit).toBe('in');
  });

  /**
   * The drift test, and the reason a CHECK built from an import is safe where a hand-copied
   * list is not: the constraint is baked into the migration, so if `@wewin/core` grows a
   * tenth currency the DDL and the union stop agreeing silently. This is what
   * `tests/enums.test.ts` does for the catalogue's unions.
   */
  it('knows exactly the currencies and units core knows', async () => {
    const definitions = await db.execute<{ conname: string; definition: string }>(sql`
      select conname, pg_get_constraintdef(oid) as definition
        from pg_constraint
       where conname in ('user_preferences_currency_known', 'user_preferences_length_unit_known')
    `);

    const currency = definitions.rows.find((row) => row.conname.includes('currency'))?.definition ?? '';
    const unit = definitions.rows.find((row) => row.conname.includes('length_unit'))?.definition ?? '';

    for (const code of CURRENCIES) expect(currency, `currency ${code}`).toContain(`'${code}'`);
    for (const value of LENGTH_UNITS) expect(unit, `unit ${value}`).toContain(`'${value}'`);

    // And nothing beyond them: a tenth quoted literal in either constraint is a member
    // somebody added to Postgres and not to core.
    expect((currency.match(/'[^']+'/g) ?? []).length).toBe(CURRENCIES.length);
    expect((unit.match(/'[^']+'/g) ?? []).length).toBe(LENGTH_UNITS.length);
  });

  it('refuses a currency and a unit core does not know', async () => {
    const person = await createUser(`ผู้ใช้แปลก ${tag}`);

    await expectCheck(
      db.execute(sql`
        insert into user_preferences (user_id, display_currency) values (${person}::uuid, 'GBP')
      `),
      'user_preferences_currency_known',
    );
    await expectCheck(
      db.execute(sql`
        insert into user_preferences (user_id, display_length_unit) values (${person}::uuid, 'yd')
      `),
      'user_preferences_length_unit_known',
    );
  });

  /**
   * ⚠️ REPORTED, NOT CLAIMED: this is a *shape* check and not a membership one, and it is a
   * deliberate gap. `packages/db` cannot import `@wewin/i18n`, so an enumeration of the eight
   * locales here would be a fourth copy with no drift test able to see it — which this
   * repository calls a guard with no evidence. Membership is the API's zod schema.
   */
  it('refuses a locale that is not shaped like one, and accepts one that is not offered', async () => {
    const person = await createUser(`ผู้ใช้ภาษา ${tag}`);

    await expectCheck(
      db.execute(sql`
        insert into user_preferences (user_id, preferred_locale) values (${person}::uuid, 'Thai please')
      `),
      'user_preferences_locale_shape',
    );

    // `ja` is not one of the eight, and it is stored. Said out loud rather than pretended
    // otherwise: this column does not know which locales exist.
    await expect(
      db.insert(userPreferences).values({ userId: person, preferredLocale: 'ja' }),
    ).resolves.toBeDefined();
  });

  it('refuses a row that prefers nothing', async () => {
    const person = await createUser(`ผู้ใช้ว่าง ${tag}`);

    await expectCheck(
      db.insert(userPreferences).values({ userId: person }),
      'user_preferences_says_something',
    );
  });

  /** Mutation: drop the `user_preferences_refuse_erased_user` trigger. */
  it('cannot be attached to a tombstone', async () => {
    const person = await createUser(`ผู้ใช้ที่ถูกลบ ${tag}`);
    await close(person);
    await erase(person);

    await expectViolation(
      db.insert(userPreferences).values({ userId: person, preferredLocale: 'en' }),
      PG.restrictViolation,
    );
  });

  /**
   * ⭐ `delete`, and both halves of what that word means here.
   *
   * Mutation A: remove the `DELETE FROM user_preferences` statement from `erase_user()` — the
   * erasure then fails outright, because the survivor check refuses the `erased` status while
   * the row is there. That is the point of adding it to the union.
   *
   * Mutation B: remove the `user_preferences` branch from `users_erasure_is_earned()` — the
   * erasure succeeds either way and the guard is silent, which is the state the generic
   * coverage test in `tests/erasure.test.ts` cannot detect because it runs after
   * `erase_user()` has returned.
   */
  it('is deleted by an erasure, and the erasure is refused while it survives', async () => {
    const person = await createUser(`ผู้ใช้มีค่าตั้ง ${tag}`);
    await db
      .insert(userPreferences)
      .values({ userId: person, preferredLocale: 'de', displayCurrency: 'EUR' });

    await close(person);

    // The half a scrub could forget: a hand-written `erased` with the row still there.
    await expectRefusal(
      db.execute(sql`
        do $$
        begin
          insert into user_erasure_requests (user_id, channel, legal_basis, completed_at, write_txid)
          values (${sql.raw(`'${person}'`)}::uuid, 'self_service', 'PDPA s.33', now(), pg_current_xact_id()::text);
          delete from auth_tokens where user_id = ${sql.raw(`'${person}'`)}::uuid;
          delete from user_emails where user_id = ${sql.raw(`'${person}'`)}::uuid;
          delete from provider_identities where user_id = ${sql.raw(`'${person}'`)}::uuid;
          delete from password_credentials where user_id = ${sql.raw(`'${person}'`)}::uuid;
          delete from sessions where user_id = ${sql.raw(`'${person}'`)}::uuid;
          update users set status = 'erased', erased_at = now(), display_name = null
           where id = ${sql.raw(`'${person}'`)}::uuid;
        end $$;
      `),
      'user_preferences',
    );

    await erase(person);

    expect(
      await db.select().from(userPreferences).where(eq(userPreferences.userId, person)),
    ).toHaveLength(0);
  });
});
