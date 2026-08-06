import {
  bigint,
  char,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { guests, users } from './auth.js';
import { MEDIA_CONTENT_TYPES } from './media.js';
import { orders } from './order.js';
import { quoteLines } from './quote.js';
import { productVersions } from './versions.js';

/**
 * Customer reviews after delivery — plan section 9.
 *
 * The conventions from `order.ts`, `payment.ts` and `quote.ts` hold here and are not
 * repeated per column: closed sets are `text` + CHECK and never `pgEnum`, times are
 * `timestamptz`, comments say WHY, and a rule two concurrent writers could both step over
 * belongs in Postgres rather than in a service.
 *
 * ── A review belongs to an ORDER LINE — plan 9.1 ─────────────────────────────────
 *
 * `quote_line_id`, not `product_id`, and three things fall out of that one choice:
 *
 *   * **the purchase is provable without a verified-buyer system.** A row here cannot exist
 *     without a line, a line cannot exist without an order, and `reviews_delivered_orders_only`
 *     refuses a line whose order is not `delivered`. There is no second table saying "this
 *     person really bought it" and therefore no second table to get out of step.
 *   * **the exact configuration is known** — size, colour, glass — because the line carries
 *     `selections`, `measures` and `product_version_id`. "Reviews from people who ordered a
 *     similar size" is a WHERE clause rather than a feature.
 *   * **the rating cannot be read wrong.** Plan 9.1: two stars saying "too small" is an
 *     opinion about a size *the customer chose*. Bound to the product alone that number is
 *     unreadable forever; bound to the line it is answerable.
 *
 * The line is also what makes `product_version_id` here honest rather than a copy: the
 * composite foreign key `(quote_line_id, product_version_id)` → `quote_lines (id,
 * product_version_id)` proves that the version named here is *that line's own* version, and
 * — because a `freeform` line has a NULL `product_version_id` and therefore no key to match
 * — that the line is a `catalog` line. A delivery charge cannot be reviewed, and no trigger
 * is spent saying so. That is the trick `catalog.ts` uses against drifting denormalised
 * copies, applied to a column that would otherwise be a second answer to "what is this
 * about".
 *
 * ── There is no `product_id` column, on purpose ──────────────────────────────────
 *
 * The storefront reads `product_review_stats` (a view, in `drizzle/0020_review_guards.sql`),
 * which joins to `product_versions` and exposes `product_id` as a *derived* key. A stored
 * copy would need a third composite foreign key to stop it drifting, and would still be a
 * third place the answer lives. A view has no state to drift.
 *
 * ── The window opens at `delivered`; the invitation does not — plan 9.2 ──────────
 *
 * Aluminium is judged after a rainy season: leaks, sagging and stiff hardware show up
 * months later, not three days after installation. So reviews are accepted **indefinitely**
 * — nothing here expires, and `delivered` is terminal so the guard that opens the window
 * never closes it again — while the *invitation* fires once, N days after delivery.
 *
 * The invitation is a notification and belongs to the outbox, whose producer today is
 * `order_events` and only `order_events` (see the SEAM note at the bottom of `order.ts`).
 * Nothing in this file stubs it, and nothing here needs rewriting when it lands.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** `in ('a', 'b')` for a CHECK, built from the literal list the TypeScript union comes from. */
const inList = (values: readonly string[]) =>
  sql.raw(`(${values.map((value) => `'${value}'`).join(', ')})`);

// ─────────────────────────────────────────────────────────────────────────────
// The two numbers plan 13 says nobody has answered
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ A DEFAULT, NOT A DECISION — plan 13, the `รีวิว` row.
 *
 * Thirty days after delivery, once, because aluminium has to go through a rain (plan 9.2).
 * It is here beside the moderation window so the two travel together, and it is
 * deliberately **not** a column default anywhere: this file owns no invitation table, and a
 * `DEFAULT 30` sitting in a schema is how a placeholder becomes a fact nobody remembers
 * choosing — the reasoning `VAT_RATE_BP_DEFAULT` in `order.ts` spells out.
 */
export const REVIEW_INVITATION_DELAY_DAYS_DEFAULT = 30;

/**
 * ⚠️ A DEFAULT, NOT A DECISION — plan 13. Three days, then it publishes itself.
 *
 * Plan 9.3 is blunt about why the number exists at all: *an approve-before-publish queue
 * with no SLA is one where reviews never appear*, which is the failure the refund queue
 * already has in plan 7.12. So the deadline is not a target somebody misses, it is the
 * thing that publishes the review.
 *
 * Hours rather than days because the storable unit should be finer than the policy — a
 * company that later answers "same working day" has a number to write, and one that answers
 * "a week" does too. `reviews.moderation_window_hours` is NOT NULL with no column default,
 * so the value travels from here through the API on every insert instead of being inherited
 * from DDL by a caller that never thought about it.
 */
export const REVIEW_MODERATION_HOURS_DEFAULT = 72;

/**
 * The largest window the column will hold: 30 days.
 *
 * ⚠️ **The bound of the column, not a rule of the business** — the same distinction plan 13
 * draws for `lead_time_days`' 1,825. It exists because an unbounded window is the "no SLA"
 * failure wearing a number: set it to 87,600 and the review is buried for a decade with
 * every step of the burial individually legal. A ceiling makes that a write error rather
 * than a policy nobody notices.
 */
export const REVIEW_MODERATION_HOURS_MAX = 720;

/** 1–5. Anything finer is a precision the reader cannot supply and the writer cannot mean. */
export const REVIEW_RATING_MIN = 1;
export const REVIEW_RATING_MAX = 5;

/**
 * ⚠️ A DEFAULT VOCABULARY, NOT A DECISION — the same disclaimer `OVERRIDE_REASONS` carries.
 *
 * Plan 9.3 names three grounds — abusive, discloses another person's data, not about the
 * product — and `spam` is added because it is the one every review system meets on week
 * one. Nobody has been asked what the company's actual policy is, so this is a starting set
 * chosen to be *reportable*; adding or removing a member is a reversible migration, which
 * is the whole reason this is `text` + CHECK and not a `pgEnum`.
 *
 * `other` is not a loophole: `reviews_hidden_other_needs_a_note` demands a sentence, so the
 * vocabulary grows out of reasons somebody actually wrote rather than out of a meeting.
 */
export const REVIEW_HIDDEN_REASONS = [
  'abusive',
  'personal_data',
  'off_topic',
  'spam',
  'other',
] as const;

export type ReviewHiddenReason = (typeof REVIEW_HIDDEN_REASONS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// The review
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One customer's verdict on one window they bought.
 *
 * ── Hide, never delete, and the rating counts either way — plan 9.3 ──────────────
 *
 * This is the constraint that decides whether the average means anything or is decoration,
 * and it is three separate mechanisms rather than one, because the obvious single one does
 * not hold:
 *
 *   ⓵ **A review cannot be deleted.** `reviews_guard_write()` refuses DELETE outright, the
 *      way `order_events_append_only()` refuses it for the spine. This codebase has settled
 *      the delete-versus-flag argument twice already (plan 7.15 item 1 for users, plan
 *      7.9(ค) for quote lines) and settling it a third time the other way would make the
 *      first two arbitrary.
 *
 *   ⓶ **Hiding costs a reason and a name.** `reviews_hidden_shape` makes the three columns
 *      one fact: a review hidden with nobody attached is a score somebody edited.
 *
 *   ⓷ **The rating cannot move.** Once a review is moderated, `rating` is frozen by
 *      `reviews_guard_write()`. That is what makes ⓶ more than paperwork — the moderator
 *      who hides a two-star review cannot also make it a five, and cannot make it a zero.
 *      Together with the stats view, which does **not** filter on `hidden_at`, "hiding is
 *      not a way to dress the score" is arithmetic rather than a promise.
 *
 * There is deliberately **no `is_counted` column and no `deleted_at`**. Either one would be
 * a switch that turns the average into an editorial number, and the first person to need it
 * would find it already built.
 *
 * ── The moderation deadline is a fact the database can see — plan 9.3 ────────────
 *
 * `published_at` is nullable and usually stays NULL forever. A review is public when
 *
 *     hidden_at IS NULL
 *     AND (published_at IS NOT NULL
 *          OR created_at + moderation_window_hours <= now())
 *
 * which is `review_is_public()` in the guards migration — a function, used by the views and
 * by the freeze in `reviews_guard_write()`, so the definition exists once. **No worker
 * publishes anything.** There is no queue to drain, no cron to forget, and no state that a
 * failed job can leave a review parked in: the passage of time is the publisher. A job that
 * had to flip a `status` column would be the "reviews never appear" failure with an owner.
 *
 * `moderation_window_hours` is immutable after insert (same guard) for the reason the
 * ceiling exists: a window a moderator can extend is a window, and a review buried by
 * repeatedly extending it would be buried by a sequence of individually legal writes.
 *
 * ── One review per line ─────────────────────────────────────────────────────────
 *
 * `reviews_line_key` on `quote_line_id`. A customer does not review the same window twice —
 * and, because a line is one line, two identical windows quoted on one order are two lines
 * and get two reviews. That asymmetry is the same one `quote_lines` already argues for when
 * it refuses to merge two lines with equal `config_hash`.
 */
export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The order this line belongs to, proven rather than copied.
     *
     * Redundant against `quote_line_id` on its own and load-bearing beside it: the
     * composite FK below makes "this line is this order's" a fact Postgres checks, and
     * `reviews_delivered_orders_only` needs a column to read the parent from. `ON DELETE
     * RESTRICT` for the reason `orders.customer_user_id` gives — the order is an accounting
     * record, and a review is customer content attached to one.
     */
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onUpdate: 'cascade', onDelete: 'restrict' }),

    /** The line. Tied to `order_id` and to `product_version_id` by the two composite FKs below. */
    quoteLineId: uuid('quote_line_id').notNull(),

    /**
     * The catalogue version the customer actually bought.
     *
     * NOT NULL, and that is what makes a `freeform` line unreviewable: a delivery charge has
     * no version, so the composite FK has nothing to match and the row cannot be written.
     * It is also the pin — a review read three catalogue revisions later is still a review
     * of the product as it was sold.
     */
    productVersionId: uuid('product_version_id')
      .notNull()
      .references(() => productVersions.id, { onUpdate: 'cascade', onDelete: 'restrict' }),

    /** 1–5. Frozen once moderated; see ⓷ in the block comment. */
    rating: smallint('rating').notNull(),

    /**
     * What the customer wrote. Optional — a rating with no words is a review.
     *
     * ⚠️ **Personal data, and the reason the erasure question in this file is hard.** A
     * customer describing their own house writes things no accounting exemption covers.
     * `erase_user()` nulls this and stamps `content_erased_at`; `reviews_guard_write()`
     * permits that one UPDATE and no other once the review is public.
     */
    bodyTh: text('body_th'),

    /**
     * The name shown beside the review, as the customer chose to be credited.
     *
     * Not `users.display_name` read through a join, and the difference matters twice: a
     * customer may want "ส." rather than their full name on a public page, and a guest has
     * no account to read a name from at all. Personal data, scrubbed with `body_th`.
     */
    authorDisplayName: text('author_display_name'),

    /**
     * Who wrote it. Exactly one of the two, enforced below — the shape `order_events` uses
     * for its actor, minus the staff and system arms, because there is no such thing as a
     * review the company wrote.
     *
     * `ON DELETE RESTRICT`, like every other user reference downstream of an order: under
     * the owner's never-delete decision it can never fire, and that is the point (plan
     * 7.15 item 1). The erasure treatment is `scrub`, and the argument is written out in
     * `ERASURE_TREATMENTS` in `auth.ts` rather than here, because that constant is where a
     * reader goes looking.
     */
    authorUserId: uuid('author_user_id').references(() => users.id, {
      onUpdate: 'cascade',
      onDelete: 'restrict',
    }),
    /**
     * The anonymous visitor who wrote it.
     *
     * ⚠️ **A review written by an unclaimed guest is invisible to `erase_user()`** — there
     * is no user id to erase by, exactly as plan 7.16 says of guest orders, and the guest
     * funnel is the main funnel (plan 6). The column is here so the review is at least
     * *attributable*; it does not make it erasable, and pretending otherwise is the failure
     * this project keeps meeting.
     */
    authorGuestId: uuid('author_guest_id').references(() => guests.id, {
      onUpdate: 'cascade',
      onDelete: 'restrict',
    }),

    /**
     * When the personal content on this row was removed, and the only reason `body_th` may
     * go from prose to NULL after publication.
     *
     * The same split `payment_slips.storage_key_erased_at` makes for a slip image (plan
     * 7.6): a row whose content was erased on policy has to be distinguishable from a row
     * that never had any, or a DSAR answer cannot tell the two apart.
     */
    contentErasedAt: timestamp('content_erased_at', { withTimezone: true }),

    /** See `REVIEW_MODERATION_HOURS_DEFAULT`. No column default, and immutable after insert. */
    moderationWindowHours: integer('moderation_window_hours').notNull(),

    /**
     * When a person published it early. NULL is the ordinary case, not an error state.
     *
     * A review with `published_at IS NULL` is pending until its window elapses and public
     * for ever after. Nothing writes this column on the deadline path, because nothing runs
     * on the deadline path.
     */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedByUserId: uuid('published_by_user_id').references(() => users.id, {
      onUpdate: 'cascade',
      onDelete: 'restrict',
    }),

    /** Plan 9.3: hiding takes a person and a reason, or it does not happen. */
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
    hiddenByUserId: uuid('hidden_by_user_id').references(() => users.id, {
      onUpdate: 'cascade',
      onDelete: 'restrict',
    }),
    hiddenReason: text('hidden_reason', { enum: REVIEW_HIDDEN_REASONS }),
    hiddenNoteTh: text('hidden_note_th'),

    /**
     * The company's one reply — plan 9.3, *"one reply per review; no threads"*.
     *
     * Three columns on this row rather than a `review_replies` table, and that is the
     * enforcement: one row can hold one reply, so "no threads" needs no unique index, no
     * count, and no code. A table would make the rule a constraint somebody can relax.
     */
    replyTh: text('reply_th'),
    repliedByUserId: uuid('replied_by_user_id').references(() => users.id, {
      onUpdate: 'cascade',
      onDelete: 'restrict',
    }),
    repliedAt: timestamp('replied_at', { withTimezone: true }),

    ...timestamps,
  },
  (table) => [
    /*
     * ⓵ The line is this order's. Without it a review could name order A and line B, and
     * `reviews_delivered_orders_only` would then check the delivery status of an order the
     * review is not actually about.
     */
    foreignKey({
      name: 'reviews_line_fk',
      columns: [table.quoteLineId, table.orderId],
      foreignColumns: [quoteLines.id, quoteLines.orderId],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    /*
     * ⓶ The version is that line's own — and, by the NULL, the line is a `catalog` line.
     * The unique index this hangs off (`quote_lines_id_product_version_key`) is added by
     * hand in the guards migration: it is a constraint on somebody else's table, added for
     * this one's benefit, and drizzle-kit would have to be told about it in `quote.ts`.
     */
    foreignKey({
      name: 'reviews_line_version_fk',
      columns: [table.quoteLineId, table.productVersionId],
      foreignColumns: [quoteLines.id, quoteLines.productVersionId],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),

    /* One review per line. See the block comment. */
    unique('reviews_line_key').on(table.quoteLineId),

    check(
      'reviews_rating_range',
      sql`${table.rating} between ${sql.raw(String(REVIEW_RATING_MIN))} and ${sql.raw(String(REVIEW_RATING_MAX))}`,
    ),
    /*
     * The SLA, as the bound of the column. See `REVIEW_MODERATION_HOURS_MAX`: zero would
     * publish before anybody could look, and no ceiling is the queue that never drains.
     */
    check(
      'reviews_moderation_window_bounded',
      sql`${table.moderationWindowHours} between 1 and ${sql.raw(String(REVIEW_MODERATION_HOURS_MAX))}`,
    ),

    /* Exactly one author, and never a member of staff. See the columns. */
    check(
      'reviews_author_shape',
      sql`num_nonnulls(${table.authorUserId}, ${table.authorGuestId}) = 1`,
    ),
    /* Prose or nothing. An empty string is a field somebody's form posted, not a review. */
    check('reviews_body_not_blank', sql`${table.bodyTh} is null or btrim(${table.bodyTh}) <> ''`),
    /*
     * The erasure stamp is about content that WAS there. A stamp with prose still under it
     * would be a DSAR answer contradicted by the row it is written on.
     */
    check(
      'reviews_content_erasure_shape',
      sql`${table.contentErasedAt} is null
          or (${table.bodyTh} is null and ${table.authorDisplayName} is null)`,
    ),

    /* Three columns, one fact — the shape `guests_claim_shape` uses. Plan 9.3. */
    check(
      'reviews_hidden_shape',
      sql`num_nonnulls(${table.hiddenAt}, ${table.hiddenByUserId}, ${table.hiddenReason}) in (0, 3)`,
    ),
    check(
      'reviews_hidden_reason_known',
      sql`${table.hiddenReason} is null or ${table.hiddenReason} in ${inList(REVIEW_HIDDEN_REASONS)}`,
    ),
    /* `other` is a prompt for a sentence, not a way past the vocabulary. */
    check(
      'reviews_hidden_other_needs_a_note',
      sql`${table.hiddenReason} is distinct from 'other'
          or btrim(coalesce(${table.hiddenNoteTh}, '')) <> ''`,
    ),
    /* A note explaining a hiding that never happened is a note about nothing. */
    check(
      'reviews_hidden_note_needs_a_hiding',
      sql`${table.hiddenNoteTh} is null or ${table.hiddenAt} is not null`,
    ),

    /* Two columns, one fact: an early publication is a decision with a name on it. */
    check(
      'reviews_published_shape',
      sql`num_nonnulls(${table.publishedAt}, ${table.publishedByUserId}) in (0, 2)`,
    ),
    /* Three columns, one fact. A reply nobody wrote is the company speaking anonymously. */
    check(
      'reviews_reply_shape',
      sql`num_nonnulls(${table.replyTh}, ${table.repliedByUserId}, ${table.repliedAt}) in (0, 3)`,
    ),
    check('reviews_reply_not_blank', sql`${table.replyTh} is null or btrim(${table.replyTh}) <> ''`),

    /* Nothing happened to this review before it existed. */
    check(
      'reviews_moderation_after_creation',
      sql`(${table.publishedAt} is null or ${table.publishedAt} >= ${table.createdAt})
          and (${table.hiddenAt} is null or ${table.hiddenAt} >= ${table.createdAt})
          and (${table.repliedAt} is null or ${table.repliedAt} >= ${table.createdAt})`,
    ),

    /* The storefront's read, once the view has resolved the product. */
    index('reviews_version_idx').on(table.productVersionId, table.createdAt.desc()),
    /* The order's own reviews — the dashboard's view of one customer's delivery. */
    index('reviews_order_idx').on(table.orderId),
    /*
     * ⚠️ The moderation queue, and it is deliberately NOT partial on `published_at is null`.
     *
     * The queue is "still inside its window", which is a comparison against `now()` and
     * therefore not something a partial index predicate may contain. Indexing `created_at`
     * over unhidden, unpublished rows is what the queue reads; the window arithmetic is a
     * filter on top of a range scan that is already small.
     */
    index('reviews_moderation_queue_idx')
      .on(table.createdAt)
      .where(sql`published_at is null and hidden_at is null`),
    /* Reviews by a person, which is the read an erasure and a DSAR both make. */
    index('reviews_author_idx')
      .on(table.authorUserId)
      .where(sql`author_user_id is not null`),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// The photographs — plan 9.4
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A picture the customer took of their own window.
 *
 * ── 📍 The GPS problem, and what a database can actually check ───────────────────
 *
 * Plan 9.4 puts it in one sentence: *the customer photographs their own window, and
 * publishing the file publishes their home address.* A phone JPEG carries EXIF GPS by
 * default, so a pipeline that stores the upload verbatim publishes coordinates with every
 * review, and nothing about the resulting page looks wrong.
 *
 * **Postgres cannot read the bytes, so it cannot verify that EXIF is gone.** What it can
 * verify is that the bytes it holds are not the bytes that arrived:
 *
 *     source_checksum_sha256  SHA-256 of what the customer uploaded
 *     checksum_sha256         SHA-256 of what is stored
 *     review_photos_bytes_were_rewritten   CHECK (the two differ)
 *
 * That refuses the commonest and worst implementation — *stream the upload straight to
 * object storage* — as a write error on the row that did it, rather than as a privacy
 * incident discovered by a customer. It is honest about its limit and the limit is stated
 * here rather than implied: **a stripper that re-encodes and forgets to drop the GPS tag
 * passes this check.** `strip_recipe` is the other half — it names the pipeline and its
 * version, so when a stripper turns out to have had a bug, the rows it produced are a WHERE
 * clause rather than an archaeology project. The same reasoning as
 * `order_documents.pin_schema_version`, and plan 4.5's list of payloads whose version and
 * content drifted apart in silence.
 *
 * ── A photo can go while the rating stays — plan 9.4(2) ──────────────────────────
 *
 * Two mechanisms, because they answer two different requests:
 *
 *   * **DELETE is allowed here**, and it is the only place in this file where it is. The
 *     review survives, so the rating survives, so the average is unchanged. That is the
 *     same split plan 7.6 already made for slip images — *delete the image, keep the row
 *     that reconciles the statement* — and it is why the picture is a child row rather than
 *     a column on `reviews`.
 *   * **`storage_key` is nullable and clearable**, for a retention sweep that wants to drop
 *     the bytes while keeping the record that a photo existed and was removed.
 *
 * ── Not `media_objects`, and the reason is a bug in that table's design for this use ─
 *
 * `media_objects` deduplicates by checksum — two uploads of the same bytes converge on one
 * row — which is right for a catalogue of 81 product photographs and wrong here in a way
 * plan 7.16 already flags: purging one person's image can purge another's. Customer uploads
 * therefore get their own storage keys, are never deduplicated, and are never served from
 * the public `/media/<id>` route. There is deliberately **no unique index on
 * `checksum_sha256`**.
 */
export const reviewPhotos = pgTable(
  'review_photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reviewId: uuid('review_id')
      .notNull()
      .references(() => reviews.id, { onUpdate: 'cascade', onDelete: 'cascade' }),
    /** Display order, 1-based, unique per review. Dense-ness is nobody's business here. */
    seq: integer('seq').notNull(),

    /**
     * The private object-storage key. Read through a short-lived audited URL, never public.
     *
     * Nullable and clearable — see the block comment. Unique because two rows pointing at
     * one object would make the deletion of either a deletion of both, which is the same
     * argument `media_objects.storage_key` makes and the reason that column is unique too.
     */
    storageKey: text('storage_key').unique(),
    storageKeyErasedAt: timestamp('storage_key_erased_at', { withTimezone: true }),

    /** Decided by reading the bytes, never from the upload's header. See `media.ts`. */
    contentType: text('content_type', { enum: MEDIA_CONTENT_TYPES }).notNull(),
    byteSize: bigint('byte_size', { mode: 'bigint' }).notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),

    /** Of the STORED bytes — i.e. after stripping. */
    checksumSha256: char('checksum_sha256', { length: 64 }).notNull(),
    /** Of the RECEIVED bytes. The pair is the EXIF guard; see the block comment. */
    sourceChecksumSha256: char('source_checksum_sha256', { length: 64 }).notNull(),
    /** Which stripper produced the stored bytes, and which version of it. */
    stripRecipe: text('strip_recipe').notNull(),

    /** Accessibility, and the one column an editor may change afterwards — `media.ts`'s rule. */
    altTextTh: text('alt_text_th'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('review_photos_review_seq_key').on(table.reviewId, table.seq),
    check('review_photos_seq_positive', sql`${table.seq} >= 1`),
    check(
      'review_photos_content_type_supported',
      sql`${table.contentType} in ${inList(MEDIA_CONTENT_TYPES)}`,
    ),
    check('review_photos_byte_size_positive', sql`${table.byteSize} > 0`),
    check('review_photos_dimensions_positive', sql`${table.width} > 0 and ${table.height} > 0`),
    check('review_photos_checksum_hex', sql`${table.checksumSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'review_photos_source_checksum_hex',
      sql`${table.sourceChecksumSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    /*
     * 📍 THE ONE THAT MATTERS. Equal checksums mean the stored bytes are the uploaded bytes,
     * which for a phone JPEG means the customer's coordinates are in object storage. See the
     * block comment for exactly how much this proves and how much it does not.
     */
    check(
      'review_photos_bytes_were_rewritten',
      sql`${table.checksumSha256} <> ${table.sourceChecksumSha256}`,
    ),
    /* A recipe nobody named is a recipe nobody can find the rows of afterwards. */
    check('review_photos_strip_recipe_present', sql`btrim(${table.stripRecipe}) <> ''`),
    /* The same shape `payment_slips_erasure_shape` uses: the stamp means the bytes are gone. */
    check(
      'review_photos_erasure_shape',
      sql`${table.storageKeyErasedAt} is null or ${table.storageKey} is null`,
    ),
    index('review_photos_review_idx').on(table.reviewId, table.seq),
  ],
);
