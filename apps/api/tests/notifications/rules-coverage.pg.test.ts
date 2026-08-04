import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DELIBERATELY_SILENT_EVENTS,
  ORDER_EVENT_TYPES,
  isDeliberatelySilent,
} from '../../src/notifications/event-coverage';
import { SUPPORTED_LOCALES } from '../../src/notifications/locale';
import { hasTemplate } from '../../src/notifications/templates/templates';

/**
 * The two silences that look exactly like a working system.
 *
 * The brief for this module is "make it impossible to have a state change that nobody was
 * told about". The database half is structural and already done: the fan-out is a trigger on
 * `order_events`, in the transaction that appended the event, and `notifications_guard_insert()`
 * refuses any row that did not come from it. Nothing can commit a transition and skip the
 * outbox.
 *
 * But *structure cannot notice an absence*. Two of them:
 *
 *   ⓵ an event type with no rule. The trigger fires, finds nothing to do, and returns. No
 *     error, no dead row, no queue — just a customer who was never told. This is the silence
 *     that arrives with the next migration that adds an event type.
 *
 *   ⓶ a rule whose template this build cannot render. The trigger queues a row, the worker
 *     claims it and cannot render it. That one at least ends in the dead queue, which is why
 *     it is the less dangerous of the two — but it ends there for every message of that kind,
 *     silently, from the moment a migration runs ahead of a deploy.
 *
 * Both are cross-checks between two sources that cannot referee themselves: the code's list
 * of event types and templates, against the database's list of rules. That is why this test
 * needs Postgres and why it does not live beside the pure template test.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

interface RuleRow {
  readonly event_type: string;
  readonly recipient_kind: string;
  readonly channel: string;
  readonly template_key: string;
  readonly is_enabled: boolean;
  readonly coalesce_group: string | null;
  readonly coalesce_seconds: number;
}

describeWithPg('notification rules cover every event, and this build can render every rule', () => {
  let pool: Pool;
  let db: Database;
  let rules: readonly RuleRow[];

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);

    const result = await db.execute(sql`
      select event_type, recipient_kind, channel, template_key, is_enabled, coalesce_group, coalesce_seconds
        from notification_rules
       order by event_type, recipient_kind, channel
    `);
    rules = (result as unknown as { rows: RuleRow[] }).rows;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('has a rule for every event type, or a written reason for the silence', () => {
    const withRules = new Set(rules.filter((rule) => rule.is_enabled).map((rule) => rule.event_type));

    const silent = ORDER_EVENT_TYPES.filter(
      (eventType) => !withRules.has(eventType) && !isDeliberatelySilent(eventType),
    );

    /*
     * ⓵. If this fails, the answer is *not* to add a line to `DELIBERATELY_SILENT_EVENTS`
     * without thinking: the question it is asking is "who should hear about this?", and plan
     * 10.3 is a table of exactly that. SEAM 5b's four payment event types will fail here the
     * day they are added, which is the intended behaviour.
     */
    expect(silent, `event types with no notification rule and no recorded reason: ${silent.join(', ')}`).toStrictEqual(
      [],
    );
  });

  it('records a reason for each event it stays silent about', () => {
    for (const [eventType, reason] of Object.entries(DELIBERATELY_SILENT_EVENTS)) {
      // A reason is the review surface. "created: ''" is the same silence with a tick beside it.
      expect(reason, eventType).toBeDefined();
      expect((reason ?? '').length, eventType).toBeGreaterThan(20);
      expect(ORDER_EVENT_TYPES).toContain(eventType);
    }
  });

  it('can render every enabled rule, in every locale it may be asked for', () => {
    const missing: string[] = [];

    for (const rule of rules.filter((candidate) => candidate.is_enabled)) {
      for (const locale of SUPPORTED_LOCALES) {
        if (!hasTemplate(locale, rule.template_key)) missing.push(`${rule.template_key} (${locale})`);
      }
    }

    // ⓶. A migration that adds a rule ahead of the deploy that adds its template fails here
    // rather than in production, where it would be a permanently dead message of one kind.
    expect(missing, `rules naming a template this build cannot render: ${missing.join(', ')}`).toStrictEqual([]);
  });

  it('names an event type this build knows, on every rule', () => {
    // The other direction: a rule for an event type this build has never heard of is a
    // rollback (release N+1 added the type, N is running) and must not be a boot failure —
    // but it must be visible, because a rule that can never match is a message nobody gets.
    const unknown = rules
      .map((rule) => rule.event_type)
      .filter((eventType) => !(ORDER_EVENT_TYPES as readonly string[]).includes(eventType));

    expect(unknown).toStrictEqual([]);
  });

  it('keeps the plan 10.3 red line coalesced and everything else not', () => {
    const byKey = new Map(rules.map((rule) => [`${rule.event_type}/${rule.recipient_kind}`, rule]));

    /*
     * Plan 10.5(2) folds by *meaning*, not by time: five quote edits in ten minutes are one
     * conversation, and five deliveries are five deliveries. A delivery notice that swallowed
     * the previous delivery notice would be a lost fact, not a saved message — so this
     * asserts the shape of the policy, not merely that some rows have a group.
     */
    expect(byKey.get('quote_revised/customer')?.coalesce_group).toBe('quote_revised');
    // ⚠️ 600 seconds is plan 13's default, not a decision.
    expect(byKey.get('quote_revised/customer')?.coalesce_seconds).toBe(600);

    expect(byKey.get('delivered/customer')?.coalesce_group).toBeNull();
    expect(byKey.get('payment_confirmed/customer')?.coalesce_group).toBeNull();
    expect(byKey.get('cancelled/customer')?.coalesce_group).toBeNull();
  });

  it('ships email only, because plan 13’s channel question is unanswered', () => {
    // LINE is what Thai customers read (plan 10.2) and costs per push. Enabling it is a row
    // here plus a recipient resolution in the fan-out — this assertion is what makes that a
    // deliberate change rather than one that happens quietly.
    expect([...new Set(rules.filter((rule) => rule.is_enabled).map((rule) => rule.channel))]).toStrictEqual(['email']);
  });
});
