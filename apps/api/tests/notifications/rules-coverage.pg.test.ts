import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DELIBERATELY_SILENT_EVENTS,
  ORDER_EVENT_TYPES,
  isDeliberatelySilent,
} from '../../src/notifications/event-coverage';
import { FALLBACK_LOCALE, SUPPORTED_LOCALES } from '../../src/notifications/locale';
import { hasTemplate, templateKeys } from '../../src/notifications/templates/templates';

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

  it('can render every enabled rule in the fallback language', () => {
    const missing = rules
      .filter((candidate) => candidate.is_enabled)
      .filter((rule) => !hasTemplate(FALLBACK_LOCALE, rule.template_key))
      .map((rule) => rule.template_key);

    // ⓶. A migration that adds a rule ahead of the deploy that adds its template fails here
    // rather than in production, where it would be a permanently dead message of one kind.
    //
    // 6a: `FALLBACK_LOCALE` rather than a loop over `SUPPORTED_LOCALES`, and that is not a
    // weakening. The loop asserted completeness in every supported language, which was
    // trivially true while there was one; with eight it would demand ~96 translations that
    // plan 10.6 names as a translator's job. What actually protects delivery is that the
    // *fallback* is complete — `resolveRenderLocale` sends every untranslated message here —
    // and that is what is asserted. The direction the loop could not see is the next test.
    expect(missing, `rules naming a template this build cannot render: ${missing.join(', ')}`).toStrictEqual([]);
  });

  it('has no template in any language that no rule asks for', () => {
    // The other direction, and it is new. A partial catalogue is now a supported state, so
    // a translator's typo — `order.deliverd.customer` in the German catalogue — would sit
    // there rendering nothing, forever, with the fallback quietly covering for it. Nothing
    // before this round could have noticed.
    const wanted = new Set(rules.map((rule) => rule.template_key));
    const orphans: string[] = [];

    for (const locale of SUPPORTED_LOCALES) {
      for (const key of templateKeys(locale)) {
        if (!wanted.has(key)) orphans.push(`${key} (${locale})`);
      }
    }

    expect(orphans, `templates no rule names: ${orphans.join(', ')}`).toStrictEqual([]);
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

    /*
     * ⭐ And the reminder, which is the one somebody would be most tempted to coalesce, since
     * it is the only rule whose event a *person* can produce twice in a row on purpose.
     *
     * It must not be. Coalescing folds two messages into one and increments a counter; every
     * reminder is a separate deliberate act by a member of staff, so folding two of them
     * silently discards one somebody chose to send — and the person who pressed the button
     * would see nothing to tell them so. The protection against a double-press is a **refusal
     * at the ask** (`BALANCE_REMINDER_COOLDOWN_HOURS_DEFAULT`), which answers 409 with a
     * sentence naming when the next one may go.
     */
    expect(byKey.get('balance_reminded/customer')?.coalesce_group).toBeNull();
    expect(byKey.get('balance_reminded/customer')?.coalesce_seconds).toBe(0);
  });

  it('⭐ tells the customer about the balance, and tells nobody internally', () => {
    /*
     * 0050's one rule, asserted by name in both directions.
     *
     * The internal queue exists so that nobody has to notice something on their own — an
     * objection arriving, a bounce from the factory. A reminder was sent by a member of staff
     * who was looking at the order at the time, so a `sales_queue` row here would be an email
     * telling somebody a thing they had just done. The spine row is the record, on the screen
     * they pressed the button on.
     */
    const reminders = rules.filter((rule) => rule.event_type === 'balance_reminded');

    expect(reminders.map((rule) => rule.recipient_kind)).toStrictEqual(['customer']);
    expect(reminders[0]?.template_key).toBe('order.balance_reminded.customer');
    expect(reminders[0]?.channel).toBe('email');
    expect(reminders[0]?.is_enabled).toBe(true);
  });

  it('⭐ can render the balance reminder in every one of the eight languages', () => {
    /*
     * ⚠️ The one rule this is asserted for, and the assertion above about the *fallback* is
     * still what protects delivery for the other fourteen. The reminder is different because
     * its content is a **number**: a customer who reads only Burmese can act on a figure beside
     * a label they recognise, and cannot act on eleven lines of Thai about money they owe. Plan
     * 10.6's ~96-message bottleneck is untouched — this is one message, written eight times,
     * shipped through the per-template resolution that exists precisely so it can be.
     *
     * ⛔ Rendered with a real amount, because without one the template refuses by design and a
     * loop that passed no money would assert the opposite of what it means to.
     */
    for (const locale of SUPPORTED_LOCALES) {
      expect(hasTemplate(locale, 'order.balance_reminded.customer'), locale).toBe(true);
    }
  });

  it('ships email only, because plan 13’s channel question is unanswered', () => {
    // LINE is what Thai customers read (plan 10.2) and costs per push. Enabling it is a row
    // here plus a recipient resolution in the fan-out — this assertion is what makes that a
    // deliberate change rather than one that happens quietly.
    expect([...new Set(rules.filter((rule) => rule.is_enabled).map((rule) => rule.channel))]).toStrictEqual(['email']);
  });
});
