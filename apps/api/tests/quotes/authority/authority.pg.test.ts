import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { eq, sql } from '@wewin/db/sql';
import { authorityLimits, groups, quoteLines, quoteOverrides, userGroups } from '@wewin/db/schema';
import type { OrderLineRequestWire, OrderWire } from '@wewin/contract/order';

/*
 * ⚠️ Imported from the files and not from `src/quotes/authority` — `src/quotes/authority.ts`
 * exists as well, and Node resolves a sibling `.ts` before a directory's `index.ts`, so the
 * short specifier silently reaches the other file. Reported; the two cannot both keep the name.
 */
import { AuthorityService } from '../../../src/quotes/authority/authority.service';
import type { AuthorityTx } from '../../../src/quotes/authority/authority.repository';
import { userScope, type Scope } from '../../../src/rbac';
import {
  client,
  liveLine,
  makeActor,
  submittedOrder,
  type Actor,
  type Json,
} from '../../payments/support/payments-app';
import { authorityEnv, bootAuthorityApp, type AuthorityApp } from './support/authority-app';
import { purgeAuthorityLimits } from '../support/authority-reset';

/**
 * Who may reduce what the customer pays — over real HTTP, against a real Postgres.
 *
 * Every property here lives *between* the layers, which is why none of it is asserted through a
 * service call alone:
 *
 *   - the concession is measured from `quote_lines` and `quote_overrides` in the same
 *     transaction as the gate, so a suite that handed the service a number would be testing a
 *     number it chose;
 *   - the two-person rule is a CHECK on the row *and* a refusal in the service, and only one of
 *     those is reachable from a unit test;
 *   - "fail closed" is a claim about a table with **no rows in it**, which cannot be observed
 *     anywhere except against a migrated database.
 *
 * ── The order under test is a real one ───────────────────────────────────────────
 *
 * Priced by the application, from the published catalogue, through `submit_for_payment` — the
 * only path that pins `grand_total_thb_minor`, writes the instalment schedule and produces the
 * `order_documents` row an approval has a foreign key to. A fabricated order would be a
 * document this suite invented, and every figure below would be about that invention.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);

/**
 * A 16-character hex string — the width `quote_lines_config_hash_is_hex` demands.
 *
 * It was 64 here and in the column, both copied from `order_documents.document_hash`, while the
 * value the column is named after (`@wewin/core/hash`'s `configHash`) is a 64-**bit** FNV-1a and
 * sixteen characters wide. The column could not hold it; `0017_quote_promise_freeze.sql` narrowed
 * the column, and this fixture with it.
 */
const configHash = (seed: string): string =>
  seed.padEnd(16, '0').slice(0, 16).replace(/[^0-9a-f]/gu, 'a');

describeWithPg('authority — who may reduce what the customer pays', () => {
  let pool: Pool;
  let db: Database;
  let app: AuthorityApp;
  let call: ReturnType<typeof client>;
  let line: OrderLineRequestWire;
  let service: AuthorityService;

  /** Sales: may edit a quote and ask for an approval. Holds no authority row, ever. */
  let sales: Actor;
  /** The approver. Given a ceiling only in the tests that are about having one. */
  let approver: Actor;
  /** Group administration — the only role that may write a ceiling. */
  let owner: Actor;
  let customer: Actor;

  let approverGroupId: string;
  let salesGroupId: string;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);

    app = await bootAuthorityApp(authorityEnv(url ?? ''));
    call = client(app.baseUrl);
    service = app.app.get(AuthorityService);

    customer = await makeActor(db, app, `authority customer ${tag}`, []);
    /*
     * ⚠️ Sales holds `quotes.approve` **on purpose**, and only in this suite.
     *
     * The two-person rule is `approvals_decider_is_not_requester`, and a test in which the
     * requester is stopped by a missing *permission* proves nothing about it. So the fixture
     * gives sales the decision permission and lets the CHECK be the thing that refuses — which
     * is the mutation-worthy assertion. In a real deployment `quotes.approve` is granted to
     * nobody at boot and is a second, independent line in front of the same door.
     */
    sales = await makeActor(db, app, `authority sales ${tag}`, [
      'quotes.read',
      'quotes.write',
      'quotes.approve',
    ]);
    /*
   * ⚠️ `quotes.approve` and NOT `quotes.write`, and the split is the point.
   *
   * Deciding was behind `quotes.write` for one round — the permission every salesperson holds —
   * so the permission system did not separate the approver from the requester at all, and what
   * stood between two colleagues rubber-stamping each other was the two-person CHECK plus a
   * ceiling table that ships empty. It is now its own code, granted to nobody at boot, and this
   * actor is the one place in the suite that holds it.
   */
  approver = await makeActor(db, app, `authority approver ${tag}`, [
    'quotes.read',
    'quotes.write',
    'quotes.approve',
  ]);
    owner = await makeActor(db, app, `authority owner ${tag}`, [
      'groups.read',
      'groups.write',
      'quotes.read',
    ]);

    approverGroupId = await groupIdOf(approver.userId);
    salesGroupId = await groupIdOf(sales.userId);

    line = await liveLine(call);
  }, 60_000);

  afterAll(async () => {
    /* Leave the ceiling table exactly as it was found: empty is the assertion of another test. */
    await purgeAuthorityLimits(db, approverGroupId);
    await purgeAuthorityLimits(db, salesGroupId);
    await app.close();
    await pool.end();
  });

  /* ---------------------------------------------------------------- *
   * Fixtures — quote rows, written directly because 5c's editor is another file
   * ---------------------------------------------------------------- */

  async function groupIdOf(userId: string): Promise<string> {
    const [row] = await db
      .select({ groupId: userGroups.groupId })
      .from(userGroups)
      .where(eq(userGroups.userId, userId));
    if (row === undefined) throw new Error('fixture actor has no group');
    return row.groupId;
  }

  const quote = async (who: string): Promise<OrderWire> =>
    submittedOrder(call, customer, line, {
      email: `authority-${who}-${tag}@probe.invalid`,
      name: `authority probe ${tag}`,
    });

  /**
   * A free-form line, which is the honest fixture for this suite.
   *
   * A delivery charge and a goodwill credit are exactly the rows plan 7.9(ค) puts in the "แถวใหม่"
   * box, they need no catalogue version, and — the part that matters — a `line_total` override
   * against one is measured by precisely the same code path as an override against a configured
   * product. What a catalog line would add is a `product_version_id`, which this module never
   * reads.
   */
  /**
   * The next free display position on this order.
   *
   * `MAX(seq) + 1`, because a submitted order is no longer an empty shell: since 5c wired the
   * submit seam, `OrdersService.submit` adopts the browser cart into `quote_lines`, so every
   * order this suite creates already owns seq 1. A fixture that hardcoded its own numbering
   * collided with `quote_lines_order_seq_key` the moment that landed.
   */
  async function nextSeq(orderId: string): Promise<number> {
    const [row] = await db
      .select({ highest: sql<number | null>`max(${quoteLines.seq})` })
      .from(quoteLines)
      .where(eq(quoteLines.orderId, orderId));
    return (row?.highest ?? 0) + 1;
  }

  async function addFreeformLine(
    orderId: string,
    seq: number,
    chargeThbMinor: bigint,
    taxable = true,
  ): Promise<string> {
    const [row] = await db
      .insert(quoteLines)
      .values({
        orderId,
        seq: await nextSeq(orderId),
        kind: 'freeform',
        qty: 1,
        chargeTotalThbMinor: chargeThbMinor,
        isVatApplicable: taxable,
        customerDescriptionTh: `รายการทดสอบ ${seq}`,
      })
      .returning({ id: quoteLines.id });

    if (row === undefined) throw new Error('fixture line insert returned nothing');
    return row.id;
  }

  /** A configured line, so the catalog path is exercised at least once. */
  async function addCatalogLine(
    orderId: string,
    seq: number,
    computedThbMinor: bigint,
  ): Promise<string> {
    const [row] = await db
      .insert(quoteLines)
      .values({
        orderId,
        seq: await nextSeq(orderId),
        kind: 'catalog',
        productVersionId: line.productVersionId,
        skuCode: `PROBE-${seq}`,
        selections: line.selections,
        measures: line.measures,
        configHash: configHash(`c${seq}${tag}`),
        qty: 1,
        computedTotalThbMinor: computedThbMinor,
        customerDescriptionTh: `บานทดสอบ ${seq}`,
      })
      .returning({ id: quoteLines.id });

    if (row === undefined) throw new Error('fixture line insert returned nothing');
    return row.id;
  }

  async function overrideLine(
    orderId: string,
    quoteLineId: string,
    computedThbMinor: bigint,
    overrideThbMinor: bigint,
  ): Promise<string> {
    const [row] = await db
      .insert(quoteOverrides)
      .values({
        orderId,
        quoteLineId,
        anchor: 'line_total',
        computedThbMinor,
        overrideThbMinor,
        enteredAs: 'line_total',
        enteredValueText: String(overrideThbMinor / 100n),
        reasonCode: 'volume',
        setByUserId: sales.userId,
      })
      .returning({ id: quoteOverrides.id });

    if (row === undefined) throw new Error('fixture override insert returned nothing');
    return row.id;
  }

  const scopeOf = (actor: Actor, groupIds: readonly string[]): Scope =>
    userScope({
      userId: actor.userId,
      sessionId: randomUUID(),
      groupIds,
      permissions: new Set(['quotes.read', 'quotes.write'] as const),
    });

  const body = <T>(response: Json): T => response.body as T;

  /* ---------------------------------------------------------------- *
   * Plan 13 — the table is empty, and the smoke path still runs
   * ---------------------------------------------------------------- */

  describe('fail closed, with nothing seeded', () => {
    /**
     * The assertion that makes "fail closed" a fact rather than a comment.
     *
     * `packages/db` already asserts the table ships empty; this asserts the *application* does
     * not fill it in at boot. A "reasonable default" seeded by a service on start-up would be
     * plan 13's exact failure — a placeholder wearing the costume of an answer — and it would
     * be invisible to a schema test.
     */
    it('has no authority row for any group the application created', async () => {
      const rows = await db.select({ groupId: authorityLimits.groupId }).from(authorityLimits);
      const seededForOurRoles = rows.filter(
        (row) => row.groupId === approverGroupId || row.groupId === salesGroupId,
      );

      expect(seededForOurRoles).toEqual([]);
    });

    it('says so on the wire, so a dashboard renders a sentence and not an empty table', async () => {
      const listed = await call('GET', '/quotes/authority/limits', { token: owner.token });

      expect(listed.status).toBe(200);
      const wire = body<{ limits: readonly unknown[]; isFailClosed: boolean }>(listed);
      expect(wire.isFailClosed).toBe(wire.limits.length === 0);
    });

    /**
     * ⭐ PLAN 13'S SMOKE PATH, AND THE REASON FAIL-CLOSED IS SURVIVABLE.
     *
     * *"ต้องมีเส้นทาง smoke ที่ผ่านได้โดยไม่ต้องอนุมัติ"*. A real submitted order, no overrides, no
     * approval row, no authority row anywhere — and the gate lets it through. Fail-closed bites
     * only when somebody actually reduces what the customer pays.
     *
     * ⚠️ The one caveat, recorded here because it is a live conflict inside plan 13 itself: the
     * smoke path in the plan says *"มัดจำ 30%"*, and the `cashflow` floor the plan documents is
     * payment in full — so a 30% deposit **is** a 70% cashflow concession. This passes today
     * because the only schedule author is the pay-in-full preset. The day a route can author a
     * 30% deposit, this test is where the collision shows up.
     */
    it('lets a real submitted order through with no approval and no authority row', async () => {
      const order = await quote('smoke');

      const assessed = await call('GET', `/quotes/authority/orders/${order.id}`, {
        token: sales.token,
      });

      expect(assessed.status).toBe(200);
      const wire = body<{
        allowed: boolean;
        margin: { concessionThbMinor: string; outcome: string };
        cashflow: { concessionThbMinor: string; outcome: string };
      }>(assessed);

      expect(wire.margin.concessionThbMinor).toBe('0');
      expect(wire.cashflow.concessionThbMinor).toBe('0');
      expect(wire.margin.outcome).toBe('nothing_conceded');
      expect(wire.cashflow.outcome).toBe('nothing_conceded');
      expect(wire.allowed).toBe(true);

      /* And the gate the submit path calls agrees, which is the half a screen cannot prove. */
      await expect(
        db.transaction(async (tx) =>
          service.gate(tx as AuthorityTx, { orderId: order.id, scope: scopeOf(sales, [salesGroupId]) }),
        ),
      ).resolves.toMatchObject({ allowed: true });
    });
  });

  /* ---------------------------------------------------------------- *
   * The document level, which is the hole per-row evaluation leaves
   * ---------------------------------------------------------------- */

  describe('measured across the document', () => {
    /**
     * Ten lines at 10% each, against the running application.
     *
     * The pure test proves the arithmetic; this proves the arithmetic is fed by the rows. A
     * per-row gate would answer "fine" ten times and let a 22% document out of the building.
     */
    it('adds ten small discounts into one figure nobody approved', async () => {
      const order = await quote('ten-lines');

      const charge = 100_000n;
      for (let seq = 1; seq <= 10; seq += 1) {
        const lineId = await addFreeformLine(order.id, seq, charge);
        await overrideLine(order.id, lineId, charge, (charge * 9n) / 10n);
      }

      const assessed = await call('GET', `/quotes/authority/orders/${order.id}`, {
        token: sales.token,
      });

      const wire = body<{
        allowed: boolean;
        margin: { concessionThbMinor: string; outcome: string; sources: readonly unknown[] };
      }>(assessed);

      /* ฿100 off each line, grossed to ฿107, ten times. */
      expect(wire.margin.concessionThbMinor).toBe('107000');
      expect(wire.margin.sources).toHaveLength(10);
      expect(wire.margin.outcome).toBe('needs_approval');
      expect(wire.allowed).toBe(false);
    });

    it('counts a negative free-form line, and a positive one not at all', async () => {
      const order = await quote('goodwill');
      await addFreeformLine(order.id, 1, 200_000n);
      await addFreeformLine(order.id, 2, -50_000n);

      const assessed = await call('GET', `/quotes/authority/orders/${order.id}`, {
        token: sales.token,
      });
      const wire = body<{ margin: { concessionThbMinor: string; sources: readonly { kind: string }[] } }>(
        assessed,
      );

      expect(wire.margin.sources.map((source) => source.kind)).toEqual(['negative_charge_line']);
      expect(wire.margin.concessionThbMinor).toBe('53500');
    });

    /**
     * A revoked override is history, and history is not conceded twice.
     *
     * Plan 7.9's own example: confirming a price after the catalogue moved is a *revocation*,
     * not a new override equal to today's figure. A measurement that read superseded rows would
     * charge the salesperson for every price they ever withdrew.
     */
    it('stops counting an override once it has been revoked', async () => {
      const order = await quote('revoked');
      const lineId = await addFreeformLine(order.id, 1, 100_000n);
      const overrideId = await overrideLine(order.id, lineId, 100_000n, 50_000n);

      const before = await call('GET', `/quotes/authority/orders/${order.id}`, { token: sales.token });
      expect(body<{ margin: { concessionThbMinor: string } }>(before).margin.concessionThbMinor).toBe(
        '53500',
      );

      await db
        .update(quoteOverrides)
        .set({
          supersededAt: new Date(),
          supersededByUserId: sales.userId,
          supersessionReason: 'revoked',
        })
        .where(eq(quoteOverrides.id, overrideId));

      const after = await call('GET', `/quotes/authority/orders/${order.id}`, { token: sales.token });
      const wire = body<{ allowed: boolean; margin: { concessionThbMinor: string } }>(after);

      expect(wire.margin.concessionThbMinor).toBe('0');
      expect(wire.allowed).toBe(true);
    });

    /** A removed line is not on the quote, so it concedes nothing — including a credit line. */
    it('stops counting a credit line once it is removed from the quote', async () => {
      const order = await quote('removed-credit');
      const lineId = await addFreeformLine(order.id, 1, -50_000n);

      const before = await call('GET', `/quotes/authority/orders/${order.id}`, { token: sales.token });
      expect(body<{ margin: { concessionThbMinor: string } }>(before).margin.concessionThbMinor).toBe(
        '53500',
      );

      await db
        .update(quoteLines)
        .set({ removedAt: new Date(), removedByUserId: sales.userId })
        .where(eq(quoteLines.id, lineId));

      const after = await call('GET', `/quotes/authority/orders/${order.id}`, { token: sales.token });
      expect(body<{ margin: { concessionThbMinor: string } }>(after).margin.concessionThbMinor).toBe(
        '0',
      );
    });

    it('reads a catalog line the same way it reads a free-form one', async () => {
      const order = await quote('catalog');
      const lineId = await addCatalogLine(order.id, 1, 500_000n);
      await overrideLine(order.id, lineId, 500_000n, 400_000n);

      const assessed = await call('GET', `/quotes/authority/orders/${order.id}`, {
        token: sales.token,
      });
      const wire = body<{ margin: { concessionThbMinor: string } }>(assessed);

      expect(wire.margin.concessionThbMinor).toBe('107000');
    });

    /**
     * The ordinary case the whole feature is for: a salesperson with a ceiling, under it.
     *
     * No approval row, nobody's afternoon interrupted, and the quote goes out. If this needed
     * an approval the feature would be a tax on every discount, which is the failure mode plan
     * 7.13 warns about when it says eight approval gates kill the one control that means
     * something.
     */
    it('lets a salesperson concede within their own ceiling, with no approval at all', async () => {
      const order = await quote('within-ceiling');
      const lineId = await addFreeformLine(order.id, 1, 1_000_000n);
      await overrideLine(order.id, lineId, 1_000_000n, 900_000n);

      await call('PUT', '/quotes/authority/limits', {
        token: owner.token,
        body: { groupId: salesGroupId, dimension: 'margin', maxConcessionThbMinor: '500000' },
      });

      const assessed = await call('GET', `/quotes/authority/orders/${order.id}`, {
        token: sales.token,
      });
      const wire = body<{
        allowed: boolean;
        margin: { outcome: string; ceilingThbMinor: string; concessionThbMinor: string };
      }>(assessed);

      expect(wire.margin.concessionThbMinor).toBe('107000');
      expect(wire.margin.outcome).toBe('within_authority');
      expect(wire.margin.ceilingThbMinor).toBe('500000');
      expect(wire.allowed).toBe(true);

      await expect(
        db.transaction(async (tx) =>
          service.gate(tx as AuthorityTx, { orderId: order.id, scope: scopeOf(sales, [salesGroupId]) }),
        ),
      ).resolves.toMatchObject({ allowed: true });

      /*
       * And the same ceiling, one satang too small, is the other half of the same rule: having
       * an authority row is not the same as having enough of one.
       */
      await call('PUT', '/quotes/authority/limits', {
        token: owner.token,
        body: { groupId: salesGroupId, dimension: 'margin', maxConcessionThbMinor: '106999' },
      });

      const tooSmall = await call('GET', `/quotes/authority/orders/${order.id}`, {
        token: sales.token,
      });
      const narrowed = body<{ allowed: boolean; margin: { outcome: string; ceilingThbMinor: string } }>(
        tooSmall,
      );

      expect(narrowed.margin.outcome).toBe('needs_approval');
      expect(narrowed.margin.ceilingThbMinor).toBe('106999');
      expect(narrowed.allowed).toBe(false);

      await purgeAuthorityLimits(db, salesGroupId);
    });

    /** The gate refuses, and it refuses inside the transaction the submit path hands it. */
    it('refuses to let a quote past the gate when nobody has the authority', async () => {
      const order = await quote('gate-refuses');
      const lineId = await addFreeformLine(order.id, 1, 100_000n);
      await overrideLine(order.id, lineId, 100_000n, 1n);

      await expect(
        db.transaction(async (tx) =>
          service.gate(tx as AuthorityTx, { orderId: order.id, scope: scopeOf(sales, [salesGroupId]) }),
        ),
      ).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    });
  });

  /* ---------------------------------------------------------------- *
   * Asking, and answering
   * ---------------------------------------------------------------- */

  describe('the approver’s inbox', () => {
    const conceding = async (who: string): Promise<OrderWire> => {
      const order = await quote(who);
      const lineId = await addFreeformLine(order.id, 1, 100_000n);
      await overrideLine(order.id, lineId, 100_000n, 50_000n);
      return order;
    };

    it('measures the concession itself and refuses to take one from the body', async () => {
      const order = await conceding('measures');

      const withAmount = await call('POST', '/quotes/approvals', {
        token: sales.token,
        body: {
          orderId: order.id,
          dimension: 'margin',
          reasonTh: 'ลูกค้าเก่า',
          concessionThbMinor: '1',
        },
      });
      expect(withAmount.status).toBe(400);

      const asked = await call('POST', '/quotes/approvals', {
        token: sales.token,
        body: { orderId: order.id, dimension: 'margin', reasonTh: 'ลูกค้าเก่า ขอลดราคา' },
      });

      expect(asked.status).toBe(201);
      /* ฿500 off a taxable line is ฿535 the customer does not transfer. */
      expect(body<{ concessionThbMinor: string }>(asked).concessionThbMinor).toBe('53500');
      expect(body<{ status: string }>(asked).status).toBe('pending');
    });

    it('shows what is waiting, oldest first, and what the quote concedes now', async () => {
      const order = await conceding('inbox');
      const asked = await call('POST', '/quotes/approvals', {
        token: sales.token,
        body: { orderId: order.id, dimension: 'margin', reasonTh: 'รอผู้มีอำนาจอนุมัติ' },
      });
      const approvalId = body<{ id: string }>(asked).id;

      const queue = await call('GET', '/quotes/approvals?status=pending', { token: approver.token });
      expect(queue.status).toBe(200);
      expect(
        body<{ approvals: readonly { id: string }[] }>(queue).approvals.map((row) => row.id),
      ).toContain(approvalId);

      /* Sales keeps editing after asking. The approver must see the number that is true now. */
      const second = await addFreeformLine(order.id, 2, 100_000n);
      await overrideLine(order.id, second, 100_000n, 0n);

      const detail = await call(`GET`, `/quotes/approvals/${approvalId}`, { token: approver.token });
      const wire = body<{
        approval: { concessionThbMinor: string };
        liveConcession: { hasMovedSinceRequest: boolean; margin: { concessionThbMinor: string } };
      }>(detail);

      expect(wire.approval.concessionThbMinor).toBe('53500');
      expect(wire.liveConcession.margin.concessionThbMinor).toBe('160500');
      expect(wire.liveConcession.hasMovedSinceRequest).toBe(true);
    });

    /** Asking is not being answered. A pending row must not let the quote out of the building. */
    it('does not let a request that is merely waiting count as an approval', async () => {
      const order = await conceding('still-waiting');
      const asked = await call('POST', '/quotes/approvals', {
        token: sales.token,
        body: { orderId: order.id, dimension: 'margin', reasonTh: 'ยังรออนุมัติ' },
      });
      const approvalId = body<{ id: string }>(asked).id;

      const assessed = await call('GET', `/quotes/authority/orders/${order.id}`, {
        token: sales.token,
      });
      const wire = body<{ allowed: boolean; margin: { outcome: string; approvalId: string } }>(
        assessed,
      );

      expect(wire.margin.outcome).toBe('needs_approval');
      expect(wire.allowed).toBe(false);
      /* And the screen can link to the request the salesperson already made, rather than a second one. */
      expect(wire.margin.approvalId).toBe(approvalId);
    });

    it('refuses a request on a quote that concedes nothing', async () => {
      const order = await quote('nothing-to-approve');

      const asked = await call('POST', '/quotes/approvals', {
        token: sales.token,
        body: { orderId: order.id, dimension: 'margin', reasonTh: 'ไม่มีอะไรลด' },
      });

      expect(asked.status).toBe(409);
    });
  });

  /* ---------------------------------------------------------------- *
   * The two rules that stand in front of an approval
   * ---------------------------------------------------------------- */

  describe('deciding', () => {
    const askedFor = async (who: string, overrideTo: bigint): Promise<string> => {
      const order = await quote(who);
      const lineId = await addFreeformLine(order.id, 1, 1_000_000n);
      await overrideLine(order.id, lineId, 1_000_000n, overrideTo);

      const asked = await call('POST', '/quotes/approvals', {
        token: sales.token,
        body: { orderId: order.id, dimension: 'margin', reasonTh: `คำขอ ${who}` },
      });
      if (asked.status !== 201) throw new Error(`could not ask: ${JSON.stringify(asked.body)}`);
      return body<{ id: string }>(asked).id;
    };

    const grantCeiling = async (groupId: string, ceilingThbMinor: string): Promise<Json> =>
      call('PUT', '/quotes/authority/limits', {
        token: owner.token,
        body: { groupId, dimension: 'margin', maxConcessionThbMinor: ceilingThbMinor, noteTh: 'ทดสอบ' },
      });

    const revokeCeiling = async (groupId: string): Promise<void> => {
      await purgeAuthorityLimits(db, groupId);
    };

    it('refuses the requester as their own approver — the rule that already existed', async () => {
      const approvalId = await askedFor('self', 900_000n);
      await grantCeiling(salesGroupId, '100000000');

      const decided = await call('POST', `/quotes/approvals/${approvalId}/decision`, {
        token: sales.token,
        body: { decision: 'approved' },
      });

      /* 409 from the two-person CHECK — not 403, which would mean a permission stopped it. */
      expect(decided.status).toBe(409);
      await revokeCeiling(salesGroupId);
    });

    /**
     * ⭐ THE CLAUSE THAT KEEPS FAIL-CLOSED HONEST.
     *
     * Without it, `authority_limits` is decorative: anybody holding the decision permission
     * could approve any figure on a database with no ceilings in it, and plan 13's
     * *"ยังไม่มีแถว = ยังลดราคาไม่ได้"* would be a comment above a table nothing reads.
     */
    it('refuses an approver whose role carries no ceiling at all', async () => {
      const approvalId = await askedFor('no-ceiling', 900_000n);

      const decided = await call('POST', `/quotes/approvals/${approvalId}/decision`, {
        token: approver.token,
        body: { decision: 'approved' },
      });

      expect(decided.status).toBe(403);
    });

    it('refuses an approver whose ceiling is smaller than what was asked', async () => {
      const approvalId = await askedFor('over-ceiling', 0n);
      await grantCeiling(approverGroupId, '1000');

      const decided = await call('POST', `/quotes/approvals/${approvalId}/decision`, {
        token: approver.token,
        body: { decision: 'approved' },
      });

      expect(decided.status).toBe(403);
      expect(body<{ error: { details: { ceilingThbMinor: string } } }>(decided).error.details.ceilingThbMinor).toBe('1000');
      await revokeCeiling(approverGroupId);
    });

    it('lets a covered concession through, and then the quote may go to the customer', async () => {
      const order = await quote('covered');
      const lineId = await addFreeformLine(order.id, 1, 1_000_000n);
      await overrideLine(order.id, lineId, 1_000_000n, 900_000n);

      const asked = await call('POST', '/quotes/approvals', {
        token: sales.token,
        body: { orderId: order.id, dimension: 'margin', reasonTh: 'ส่วนลดตามที่ตกลง' },
      });
      const approvalId = body<{ id: string }>(asked).id;

      await grantCeiling(approverGroupId, '20000000');

      const decided = await call('POST', `/quotes/approvals/${approvalId}/decision`, {
        token: approver.token,
        body: { decision: 'approved' },
      });
      expect(decided.status).toBe(200);
      expect(body<{ status: string }>(decided).status).toBe('approved');

      const assessed = await call('GET', `/quotes/authority/orders/${order.id}`, {
        token: sales.token,
      });
      const wire = body<{ allowed: boolean; margin: { outcome: string; approvalId: string } }>(assessed);

      expect(wire.margin.outcome).toBe('covered_by_approval');
      expect(wire.margin.approvalId).toBe(approvalId);
      expect(wire.allowed).toBe(true);

      /* And the gate agrees — the same measurement, not a second one. */
      await expect(
        db.transaction(async (tx) =>
          service.gate(tx as AuthorityTx, { orderId: order.id, scope: scopeOf(sales, [salesGroupId]) }),
        ),
      ).resolves.toMatchObject({ allowed: true });

      /* A second answer to one question is refused. */
      const again = await call('POST', `/quotes/approvals/${approvalId}/decision`, {
        token: approver.token,
        body: { decision: 'rejected', noteTh: 'เปลี่ยนใจ' },
      });
      expect(again.status).toBe(409);
      /*
       * The details matter and are asserted for a specific reason: two mechanisms refuse this —
       * the service's status check and the `status = 'pending'` in the UPDATE's WHERE — and a
       * test that only read the 409 would be evidence for neither. Only the service's refusal
       * can name who decided it first.
       */
      expect(
        body<{ error: { details: { status: string; decidedByUserId: string } } }>(again).error.details,
      ).toMatchObject({ status: 'approved', decidedByUserId: approver.userId });

      await revokeCeiling(approverGroupId);
    });

    /**
     * An approval says *"up to ฿X on this order"*, and ฿X is a number for a reason.
     *
     * Without the comparison, an approval of ฿535 would license every later figure on the same
     * order — which is the shape of the attack: ask for something small, get it signed, then
     * keep editing. The document moving past what was approved puts it back in the queue.
     */
    it('stops covering the quote once the concession grows past what was approved', async () => {
      const order = await quote('outgrown');
      const first = await addFreeformLine(order.id, 1, 1_000_000n);
      await overrideLine(order.id, first, 1_000_000n, 900_000n);

      const asked = await call('POST', '/quotes/approvals', {
        token: sales.token,
        body: { orderId: order.id, dimension: 'margin', reasonTh: 'ส่วนลดรอบแรก' },
      });
      const approvalId = body<{ id: string }>(asked).id;

      await grantCeiling(approverGroupId, '20000000');
      const decided = await call('POST', `/quotes/approvals/${approvalId}/decision`, {
        token: approver.token,
        body: { decision: 'approved' },
      });
      expect(decided.status).toBe(200);

      const second = await addFreeformLine(order.id, 2, 1_000_000n);
      await overrideLine(order.id, second, 1_000_000n, 0n);

      const assessed = await call('GET', `/quotes/authority/orders/${order.id}`, {
        token: sales.token,
      });
      const wire = body<{ allowed: boolean; margin: { outcome: string } }>(assessed);

      expect(wire.margin.outcome).toBe('needs_approval');
      expect(wire.allowed).toBe(false);

      await revokeCeiling(approverGroupId);
    });

    /**
     * Two roles is the larger of two authorities, never their total.
     *
     * A sum would make group membership a way of manufacturing authority nobody granted:
     * ฿1,000 here plus ฿2,000 there is a ฿3,000 ceiling that appears in no row and that nobody
     * would find by reading the table.
     */
    it('takes the largest ceiling of the roles a person is in, and not their sum', async () => {
      const [second] = await db
        .insert(groups)
        .values({ code: `authority_second_${tag}`, nameTh: 'กลุ่มที่สอง' })
        .returning({ id: groups.id });
      if (second === undefined) throw new Error('fixture group insert returned nothing');

      await db.insert(userGroups).values({ userId: approver.userId, groupId: second.id });
      await grantCeiling(approverGroupId, '100000');
      await grantCeiling(second.id, '200000');

      /* ฿2,675 conceded: above the larger of the two ceilings (฿2,000) and below their sum (฿3,000). */
      const tooBig = await askedFor('two-groups-over', 750_000n);
      const refused = await call('POST', `/quotes/approvals/${tooBig}/decision`, {
        token: approver.token,
        body: { decision: 'approved' },
      });
      expect(refused.status).toBe(403);
      expect(
        body<{ error: { details: { ceilingThbMinor: string } } }>(refused).error.details
          .ceilingThbMinor,
      ).toBe('200000');

      /* ฿1,070 conceded: under the larger ceiling, so the larger one is genuinely in effect. */
      const withinLarger = await askedFor('two-groups-within', 900_000n);
      const allowed = await call('POST', `/quotes/approvals/${withinLarger}/decision`, {
        token: approver.token,
        body: { decision: 'approved' },
      });
      expect(allowed.status).toBe(200);

      await purgeAuthorityLimits(db, second.id);
      await revokeCeiling(approverGroupId);
      await db.delete(userGroups).where(eq(userGroups.groupId, second.id));
      await db.delete(groups).where(eq(groups.id, second.id));
    });

    it('needs no ceiling to say no, but needs a sentence', async () => {
      const approvalId = await askedFor('rejected', 0n);

      const bare = await call('POST', `/quotes/approvals/${approvalId}/decision`, {
        token: approver.token,
        body: { decision: 'rejected' },
      });
      expect(bare.status).toBe(422);

      const rejected = await call('POST', `/quotes/approvals/${approvalId}/decision`, {
        token: approver.token,
        body: { decision: 'rejected', noteTh: 'ลดมากเกินไป กรุณาทบทวน' },
      });
      expect(rejected.status).toBe(200);
      expect(body<{ status: string }>(rejected).status).toBe('rejected');
    });

    /**
     * The database is the backstop, and it is a different mechanism from the service.
     *
     * A test that only drove the API would prove the refusal *usual*, not true: this issues the
     * UPDATE the service refuses to issue and shows the CHECK still there.
     */
    it('is refused by the row itself, not only by the service', async () => {
      const approvalId = await askedFor('check', 0n);

      await expect(
        db.execute(sql`
          update approvals
             set status = 'approved',
                 decided_by_user_id = requested_by_user_id,
                 decided_at = now()
           where id = ${approvalId}::uuid
        `),
      ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23514' }) });
    });
  });

  /* ---------------------------------------------------------------- *
   * Who may write the ceilings
   * ---------------------------------------------------------------- */

  describe('granting authority', () => {
    it('is group administration, not quote editing', async () => {
      const asSales = await call('PUT', '/quotes/authority/limits', {
        token: sales.token,
        body: { groupId: salesGroupId, dimension: 'margin', maxConcessionThbMinor: '99999999' },
      });

      expect(asSales.status).toBe(403);
    });

    it('records who granted it, and lets it be taken away again', async () => {
      const granted = await call('PUT', '/quotes/authority/limits', {
        token: owner.token,
        body: { groupId: approverGroupId, dimension: 'cashflow', maxConcessionThbMinor: '0' },
      });
      expect(granted.status).toBe(200);

      const wire = body<{
        limits: readonly { groupId: string; dimension: string; maxConcessionThbMinor: string; grantedByUserId: string }[];
        isFailClosed: boolean;
      }>(granted);
      const row = wire.limits.find(
        (limit) => limit.groupId === approverGroupId && limit.dimension === 'cashflow',
      );

      /* Zero is a real ceiling and is not the same as no row — the schema says the difference lives here. */
      expect(row?.maxConcessionThbMinor).toBe('0');
      expect(row?.grantedByUserId).toBe(owner.userId);
      expect(wire.isFailClosed).toBe(false);

      const removed = await call(
        'DELETE',
        `/quotes/authority/limits/${approverGroupId}/cashflow`,
        { token: owner.token },
      );
      expect(removed.status).toBe(200);
      expect(
        body<{ limits: readonly { groupId: string; dimension: string }[] }>(removed).limits.some(
          (limit) => limit.groupId === approverGroupId && limit.dimension === 'cashflow',
        ),
      ).toBe(false);
    });
  });
});
