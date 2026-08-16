import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { asc, sql } from '@wewin/db/sql';
import {
  ORDER_ACTOR_KINDS,
  ORDER_EVENT_TYPES,
  ORDER_PAYLOAD_KINDS,
  ORDER_STATUSES,
  POST_FREEZE_STATUSES,
  orderStatusTransitions,
} from '@wewin/db/schema';
import {
  ORDER_ACTOR_KINDS_WIRE,
  ORDER_EVENT_TYPES_WIRE,
  ORDER_PAYLOAD_KINDS_WIRE,
  ORDER_STATUSES_WIRE,
  POST_FREEZE_STATUSES_WIRE,
} from '@wewin/contract/order';

import { isLiveOrder, NON_LIVE_ORDER_STATUSES } from '../../src/orders/live-order';
import { payloadSchemaFor } from '../../src/orders/transitions';

/**
 * Three copies of the same closed sets, and the test that stops them drifting.
 *
 * The duplication is not avoidable and pretending otherwise would be the bug. `@wewin/db` is
 * server-only by construction — a browser cannot import a Drizzle schema — so the union a
 * dashboard renders chips from *has* to be restated in `@wewin/contract`. And the definition
 * Postgres enforces is a third statement of it, in SQL, because a CHECK constraint cannot be
 * written against a TypeScript array.
 *
 * What is avoidable is finding out about a disagreement in production. A tenth status added
 * to the schema and not to the contract is a dashboard rendering a blank chip and a client
 * refusing a legal transition; a `POST_FREEZE_STATUSES` that drifts from
 * `order_status_is_post_freeze()` is a forfeit computed on the wrong side of the freeze.
 *
 * This is the same drift test `packages/db/tests/enums.test.ts` runs for the catalogue's
 * unions, one layer further out.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

/**
 * `db.execute` types a row as `Record<string, unknown>`, so the shape asked for has to be
 * assignable to one — hence the index signature beside the two columns this actually reads.
 * Snake case because these are the column names Postgres returns, not a TypeScript object.
 */
interface PostFreezeRow {
  readonly status: string;
  readonly post_freeze: boolean;
  readonly [column: string]: unknown;
}

/** The same shape for `order_status_is_live()` — see the live-obligation test below. */
interface LiveRow {
  readonly status: string;
  readonly is_live: boolean;
  readonly [column: string]: unknown;
}

describeWithPg('the closed sets agree across the three places they are declared', () => {
  let pool: Pool;
  let db: Database;

  beforeAll(() => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('states the ten statuses identically in the schema and on the wire', () => {
    /*
     * Order and all: these lists are read side by side by anybody comparing them, and two
     * lists with the same members in a different order is the shape a reviewer skims past.
     */
    expect([...ORDER_STATUSES_WIRE]).toStrictEqual([...ORDER_STATUSES]);
    expect(ORDER_STATUSES_WIRE).toHaveLength(10);
  });

  it('states the event types, actor kinds and payload kinds identically too', () => {
    expect([...ORDER_EVENT_TYPES_WIRE]).toStrictEqual([...ORDER_EVENT_TYPES]);
    expect([...ORDER_ACTOR_KINDS_WIRE]).toStrictEqual([...ORDER_ACTOR_KINDS]);
    expect([...ORDER_PAYLOAD_KINDS_WIRE]).toStrictEqual([...ORDER_PAYLOAD_KINDS]);
  });

  it('agrees with the database about which side of the freeze every status is on', async () => {
    /*
     * `order_status_is_post_freeze()` is the definition; the two TypeScript lists are
     * mirrors. Asking about all nine rather than about the five that are post-freeze is
     * deliberate — a mirror that gained a member would otherwise pass.
     */
    const answer = await db.execute<PostFreezeRow>(sql`
      select status, order_status_is_post_freeze(status) as post_freeze
        from unnest(${sql.raw(`array['${ORDER_STATUSES.join("','")}']::text[]`)}) as status
    `);

    const rows = [...answer.rows];
    expect(rows).toHaveLength(ORDER_STATUSES.length);

    for (const row of rows) {
      const wire = POST_FREEZE_STATUSES_WIRE.includes(
        row.status as (typeof POST_FREEZE_STATUSES_WIRE)[number],
      );
      const schema = POST_FREEZE_STATUSES.includes(
        row.status as (typeof POST_FREEZE_STATUSES)[number],
      );

      expect(wire, `${row.status}: contract says ${String(wire)}, Postgres says ${String(row.post_freeze)}`).toBe(
        row.post_freeze,
      );
      expect(schema, `${row.status}: schema mirror disagrees with Postgres`).toBe(row.post_freeze);
    }

    /* `cancelled` and `superseded` are on neither side, which is why `frozen_at` is a column. */
    expect(rows.filter((row) => row.post_freeze)).toHaveLength(5);
  });

  it('⭐ agrees with the database about which statuses are somebody’s live obligation', async () => {
    /*
     * ⭐ THE SECOND MIRROR, AND IT IS NEW.
     *
     * `NON_LIVE_ORDER_STATUSES` (`src/orders/live-order.ts`) used to be the *only* statement of
     * "whose debt is a debt" — its header said so, and said there was no database function to
     * drift from. `0049_write_off_live_order.sql` added `order_status_is_live()`, because a
     * write-off may not be recorded against a cancelled or superseded order and that guard belongs
     * in the database as well as in the service. The list is therefore a mirror now, and this is
     * what keeps it honest.
     *
     * The stake is not abstract. `isLiveOrder` decides whether `GET /orders` prints a ค้างชำระ
     * figure at all, `NON_LIVE_ORDER_STATUSES_SQL` decides which rows the ?payment=outstanding
     * filter and the overview's money card count, and the trigger decides which orders a debt may
     * be forgiven on. Two of those readers disagreeing means a balance a screen shows and the
     * database refuses to let anybody write off — or worse, the reverse.
     *
     * ⚠️ All nine statuses, not the three non-live ones: a mirror that *gained* a member would
     * otherwise pass. `delivered` is the member that matters most — live, and the status a
     * write-off is most often asked about — so it is also asserted by name below.
     */
    const answer = await db.execute<LiveRow>(sql`
      select status, order_status_is_live(status) as is_live
        from unnest(${sql.raw(`array['${ORDER_STATUSES.join("','")}']::text[]`)}) as status
    `);

    const rows = [...answer.rows];
    expect(rows).toHaveLength(ORDER_STATUSES.length);

    for (const row of rows) {
      expect(
        isLiveOrder(row.status as (typeof ORDER_STATUSES)[number]),
        `${row.status}: isLiveOrder says ${String(
          isLiveOrder(row.status as (typeof ORDER_STATUSES)[number]),
        )}, Postgres says ${String(row.is_live)}`,
      ).toBe(row.is_live);
    }

    /*
     * Four, and which four. Named, so a widened list fails rather than passing quietly.
     *
     * `awaiting_confirmation` joined them in 0053: an unconfirmed quotation is not a debt,
     * because nobody has been asked to pay it. That also keeps *live* and *payable* the same
     * set, which `attachable.ts` reads to refuse a slip against an order nobody was invited
     * to pay.
     */
    expect(rows.filter((row) => !row.is_live).map((row) => row.status).sort()).toEqual([
      'awaiting_confirmation',
      'cancelled',
      'draft',
      'superseded',
    ]);
    expect([...NON_LIVE_ORDER_STATUSES].sort()).toEqual([
      'awaiting_confirmation',
      'cancelled',
      'draft',
      'superseded',
    ]);
    /* ⚠️ `delivered` is live in both, which is the one `attachable.ts` and 0046 argue about. */
    expect(rows.find((row) => row.status === 'delivered')?.is_live).toBe(true);
  });
});

describeWithPg('every seeded transition is one this API can actually serve', () => {
  let pool: Pool;
  let db: Database;

  beforeAll(() => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('has a payload schema for every (payload kind, actor kind) the table can produce', async () => {
    const rows = await db
      .select()
      .from(orderStatusTransitions)
      .orderBy(asc(orderStatusTransitions.fromStatus), asc(orderStatusTransitions.toStatus));

    expect(rows.length).toBeGreaterThanOrEqual(16);

    for (const row of rows) {
      expect(ORDER_PAYLOAD_KINDS_WIRE).toContain(row.payloadKind);
      expect(ORDER_EVENT_TYPES_WIRE).toContain(row.eventType);

      for (const actorKind of row.allowedActorKinds) {
        expect(ORDER_ACTOR_KINDS_WIRE).toContain(actorKind);

        /*
         * A `payloadSchemaFor` that fell through would return `undefined` and
         * `parseTransitionBody` would then throw a TypeError at the moment a customer
         * pressed the button — the switch has no `default`, so this is what catches a
         * payload kind added by migration and not by code.
         */
        const schema = payloadSchemaFor(
          row.payloadKind,
          actorKind as (typeof ORDER_ACTOR_KINDS_WIRE)[number],
        );
        expect(schema, `${row.fromStatus} → ${row.toStatus} as ${actorKind}`).toBeDefined();

        /*
         * And every one of them is strict. This is the second of trap 4's three fixes, as a
         * property of the whole table rather than of the one schema a unit test happened to
         * pick: a body carrying a key the chosen schema does not know is refused, so choosing
         * the *wrong* schema is a 400 rather than a silent strip.
         */
        const surprising = schema.safeParse({ __not_a_field__: 1 });
        expect(surprising.success, `${row.payloadKind} accepted an unknown key`).toBe(false);
      }
    }
  });

  it('splits `cancel` at exactly the freeze, which is what trap 4 is about', async () => {
    /*
     * ⚠️ The assertion that makes plan 7.4 trap 4 checkable rather than merely described.
     *
     * The trap is a controller choosing the payload schema before it knows `from_status`.
     * The reason that is *possible* is that both cancellations end at `cancelled`; the reason
     * it is *wrong* is that the two rows differ, and they differ exactly along the freeze.
     * If a future migration adds a cancellable status and gives it the pre-freeze payload,
     * an order with money in the company's hands would be cancellable with no `fault` — and
     * nothing else in the system would notice.
     */
    const rows = await db
      .select()
      .from(orderStatusTransitions)
      .orderBy(asc(orderStatusTransitions.fromStatus));

    const cancels = rows.filter((row) => row.toStatus === 'cancelled');
    expect(cancels.length).toBeGreaterThanOrEqual(6);

    for (const row of cancels) {
      const postFreeze = POST_FREEZE_STATUSES_WIRE.includes(
        row.fromStatus as (typeof POST_FREEZE_STATUSES_WIRE)[number],
      );

      expect(row.payloadKind, `cancel from ${row.fromStatus}`).toBe(
        postFreeze ? 'cancel_post_freeze' : 'cancel_pre_freeze',
      );

      if (postFreeze) {
        /* And the field that decides the refund is *required*, not optional. */
        expect(row.requiredPayloadKeys).toContain('fault');
        expect(row.requiredPayloadKeys).toContain('reason');
      } else {
        expect(row.requiredPayloadKeys).not.toContain('fault');
      }
    }

    /* Plan 7.8 marks `redesign` as the cancellable status everybody forgets. */
    expect(cancels.map((row) => row.fromStatus)).toContain('redesign');
  });

  it('never asks for a payload key this module does not produce', async () => {
    /*
     * The database checks `required_payload_keys` on insert, which means a key the service
     * never writes is a transition that always 500s — discovered by the first customer to
     * try it. This is the list of what `orders.service.ts` writes, restated, so adding a
     * required key by migration without adding it to the service fails here instead.
     */
    const PRODUCED: Record<string, readonly string[]> = {
      none: [],
      submit: ['document_hash', 'line_count'],
      confirm_payment: ['note_th'],
      /* ⛔ `reason` is required, not optional: production released against an unpaid invoice is
         a decision somebody has to be able to defend. See 0054. */
      authorise_unpaid: ['reason'],
      cancel_pre_freeze: ['reason'],
      cancel_post_freeze: ['reason', 'fault'],
      bounce: ['reason'],
      approve_redesign: ['absorbed_delta_thb_minor', 'contracted_revision', 'approved_revision', 'note_th'],
      supersede: ['reason'],
    };

    const rows = await db.select().from(orderStatusTransitions);

    for (const row of rows) {
      const produced = PRODUCED[row.payloadKind];
      expect(produced, `no producer is recorded for payload kind ${row.payloadKind}`).toBeDefined();

      for (const key of row.requiredPayloadKeys) {
        expect(produced ?? [], `${row.fromStatus} → ${row.toStatus} requires ${key}`).toContain(key);
      }
    }
  });
});
