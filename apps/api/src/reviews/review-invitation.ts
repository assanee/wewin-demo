import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Database } from '@wewin/db/client';
import { REVIEW_INVITATION_DELAY_DAYS_DEFAULT } from '@wewin/db/schema';
import { sql } from '@wewin/db/sql';

import { DRIZZLE } from '../database/database.tokens';

/**
 * The review invitation — plan 9.2, plan 10.1, and **not a cron that scans and hopes**.
 *
 * ── The mechanism already exists, and it is one row of configuration ─────────────
 *
 * Plan 9.2 wants one message, N days after delivery, once. The instinct is a scheduler: a
 * table of pending invitations, a worker that wakes up and asks "who was delivered thirty
 * days ago", a `sent_at` column to stop it sending twice. Every one of those is a second
 * answer to a question the outbox already answers, and each would need its own retry, its
 * own coalescing and its own `dead`.
 *
 * The outbox does not need any of it, because `notifications.send_after` exists:
 *
 *     order_events_fan_out_notifications()   … send_after = now() + make_interval(secs => rule.coalesce_seconds)
 *     NotificationWorker.claimDue            … where status = 'pending' and send_after <= now()
 *
 * So the invitation is **one row in `notification_rules`**, and everything else is already
 * built and already tested:
 *
 *     event_type       'delivered'
 *     recipient_kind   'customer'
 *     channel          'email'
 *     template_key     'order.review_invitation.customer'
 *     coalesce_group   'review_invitation'
 *     coalesce_seconds 2592000                        -- 30 days
 *
 * ── Why that is "once", structurally rather than by a flag ───────────────────────
 *
 *   * `delivered` is **terminal**. `order_status_transitions` has no outgoing row from it —
 *     the six cancellation rows are `draft`, `awaiting_payment`, `production_confirmed`,
 *     `in_production`, `awaiting_installation` and `redesign` — so an order produces exactly
 *     one `delivered` event, ever. This is the same fact `reviews_delivered_orders_only`
 *     leans on to make the review window endless, used a second time.
 *   * `notifications_idempotency_key` is `(event_id, recipient_key, channel)` with
 *     `NULLS NOT DISTINCT`, so even a replayed fan-out produces one row.
 *   * `notifications_pending_coalesce_key` is partial on `status = 'pending'`, so the row
 *     cannot be folded into after it has been sent.
 *
 * There is no `sent` flag to forget to set, no scan, and no window in which two workers both
 * decide it is time. The delay is a column the worker already reads.
 *
 * ── ⚠️ WHY THE ROW IS NOT IN A MIGRATION IN THIS COMMIT ──────────────────────────
 *
 * Two files outside this round's ownership have to change **together**, and shipping either
 * one alone is worse than shipping neither:
 *
 *   1. `packages/db/drizzle/00XX_review_invitation.sql` — the rule row above.
 *   2. `apps/api/src/notifications/templates/templates.ts` — the Thai message under
 *      `order.review_invitation.customer`.
 *
 * Ship (1) without (2) and every delivered order queues a message the worker claims,
 * fails to render, and **retries five times before dropping into the dead queue thirty days
 * later** — plan 10.5(3)'s silent failure, with a thirty-day fuse on it, on every order the
 * company completes. `rules-coverage.pg.test.ts` exists precisely to make that impossible and
 * would go red the moment (1) landed alone, which is the mechanism working.
 *
 * Ship (2) without (1) and nothing happens at all, harmlessly.
 *
 * So this file carries the decision, the number and the *check*, and
 * `tests/reviews/invitation.pg.test.ts` proves the mechanism end to end against a rule row it
 * inserts itself — the invitation is queued, `send_after` is thirty days out, a second
 * `delivered` event is impossible, and the worker does not claim it early. What is owed to
 * another owner is two lines, not a design.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────────────
 *
 * No table, no worker, no `OnModuleInit` that inserts the rule. The last of those is the
 * tempting one and it is the wrong one: `PermissionSyncService` upserts permission codes at
 * boot because a *missing* permission fails closed, and a missing notification rule fails
 * *silent*. Inserting the rule from here would put (1) in production without (2) by a route
 * nobody reviewed, which is the exact failure the paragraph above refuses.
 */

/**
 * ⚠️ A DEFAULT, NOT A DECISION — plan 13's `รีวิว` row, and the schema's constant re-exported
 * rather than restated.
 *
 * Thirty days, because aluminium is judged after a rainy season and not after three days
 * (plan 9.2). It is imported from `@wewin/db/schema` so there is one number: a value copied
 * here would be a second answer that agrees until somebody edits one of them.
 */
export const REVIEW_INVITATION_DELAY_DAYS = REVIEW_INVITATION_DELAY_DAYS_DEFAULT;

export const REVIEW_INVITATION_DELAY_SECONDS = REVIEW_INVITATION_DELAY_DAYS * 24 * 60 * 60;

/** The event that opens the window and triggers the invitation. Terminal — see the module comment. */
export const REVIEW_INVITATION_EVENT_TYPE = 'delivered' as const;

export const REVIEW_INVITATION_TEMPLATE_KEY = 'order.review_invitation.customer';

/**
 * The folding bucket. It exists so `coalesce_seconds` is legal, and it can never fold
 * anything.
 *
 * `notification_rules_coalesce_window_sane` is `coalesce_seconds >= 0 and (coalesce_group is
 * not null or coalesce_seconds = 0)` — a delay is only expressible on a rule that also names
 * a bucket. That reads like a workaround and is not one: folding is defined per
 * `(order_id, coalesce_key, recipient_key, channel)` and only a `delivered` event produces
 * this key, of which there is exactly one per order. The bucket is a set with at most one
 * member, so "fold" and "do not fold" are the same behaviour here.
 *
 * ⚠️ If `delivered` ever stops being terminal, this stops being true — a second delivery
 * would fold into the pending invitation and bump `coalesced_count` rather than sending a
 * second one, which is *still* the behaviour plan 9.2 wants ("send once") but for a reason
 * nobody would remember. This is where that assumption is written down.
 */
export const REVIEW_INVITATION_COALESCE_GROUP = 'review_invitation';

/** The rule row, as a value, so the check below and any future migration cannot disagree. */
export interface ReviewInvitationRule {
  readonly eventType: string;
  readonly recipientKind: string;
  readonly channel: string;
  readonly templateKey: string;
  readonly coalesceGroup: string;
  readonly coalesceSeconds: number;
}

export const REVIEW_INVITATION_RULE: ReviewInvitationRule = {
  eventType: REVIEW_INVITATION_EVENT_TYPE,
  recipientKind: 'customer',
  channel: 'email',
  templateKey: REVIEW_INVITATION_TEMPLATE_KEY,
  coalesceGroup: REVIEW_INVITATION_COALESCE_GROUP,
  coalesceSeconds: REVIEW_INVITATION_DELAY_SECONDS,
};

export interface InvitationRuleReport {
  /** False only when the database could not be reached. Absence of the rule is not an error. */
  readonly ok: boolean;
  readonly present: boolean;
  readonly enabled: boolean;
  /** What the live row says, when it differs from `REVIEW_INVITATION_RULE`. */
  readonly drift: readonly string[];
  readonly error?: string;
}

/**
 * Reads the rule at boot and says, in one line, whether the invitation is actually running.
 *
 * It writes nothing. That is the difference between this and `PermissionSyncService`, and
 * the reason is in the module comment: a missing permission fails closed and a missing
 * notification rule fails silent, so the safe direction for one is to insert and for the
 * other is to report.
 *
 * The three outcomes are three different log lines on purpose, because they call for three
 * different actions:
 *
 *   absent    → the invitation is not running. `warn`, with the exact row to insert.
 *   drifted   → a row exists and disagrees with this build about the delay or the template.
 *               `warn` and name the difference: a `coalesce_seconds` somebody set to 0 while
 *               debugging is a review invitation arriving the day the installers leave.
 *   matching  → `log`, once, so `pnpm dev` says out loud that it is on and when it fires.
 *
 * An unreachable database does not stop boot, on `PermissionSyncService`'s reasoning: a
 * database that is still starting is not a reason to crash-loop, and readiness already
 * reports the outage.
 */
@Injectable()
export class ReviewInvitationCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger('ReviewInvitation');

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async onApplicationBootstrap(): Promise<void> {
    const report = await this.check();

    if (!report.ok) {
      this.logger.warn(`Could not read notification_rules; continuing to boot: ${report.error ?? 'unknown'}`);
      return;
    }

    if (!report.present) {
      this.logger.warn(
        'No review invitation rule: plan 9.2\'s invitation is NOT being sent. ' +
          `Insert into notification_rules (event_type, recipient_kind, channel, template_key, ` +
          `coalesce_group, coalesce_seconds) values ('${REVIEW_INVITATION_RULE.eventType}', ` +
          `'${REVIEW_INVITATION_RULE.recipientKind}', '${REVIEW_INVITATION_RULE.channel}', ` +
          `'${REVIEW_INVITATION_RULE.templateKey}', '${REVIEW_INVITATION_RULE.coalesceGroup}', ` +
          `${String(REVIEW_INVITATION_RULE.coalesceSeconds)}) — and add the template in the same change, ` +
          'or every delivered order queues a message nothing can render.',
      );
      return;
    }

    if (report.drift.length > 0) {
      this.logger.warn(`Review invitation rule differs from this build: ${report.drift.join('; ')}`);
      return;
    }

    this.logger.log(
      `Review invitation is on: ${REVIEW_INVITATION_RULE.templateKey} fires ` +
        `${String(REVIEW_INVITATION_DELAY_DAYS)} days after delivery` +
        (report.enabled ? '' : ' — but the rule is DISABLED, so nothing will be queued'),
    );
  }

  /** The read, separated from the logging so a test can assert the report rather than a log line. */
  async check(): Promise<InvitationRuleReport> {
    try {
      const result = await this.db.execute(sql`
        select template_key, coalesce_group, coalesce_seconds, is_enabled
          from notification_rules
         where event_type = ${REVIEW_INVITATION_RULE.eventType}
           and recipient_kind = ${REVIEW_INVITATION_RULE.recipientKind}
           and channel = ${REVIEW_INVITATION_RULE.channel}
           and template_key = ${REVIEW_INVITATION_RULE.templateKey}
      `);

      const rows = 'rows' in (result as object) ? (result as { rows: unknown }).rows : [];
      const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;

      if (row === undefined) {
        return { ok: true, present: false, enabled: false, drift: [] };
      }

      const drift: string[] = [];
      const seconds = Number(row['coalesce_seconds']);
      if (seconds !== REVIEW_INVITATION_RULE.coalesceSeconds) {
        drift.push(
          `coalesce_seconds is ${String(seconds)}, this build expects ` +
            `${String(REVIEW_INVITATION_RULE.coalesceSeconds)} (${String(REVIEW_INVITATION_DELAY_DAYS)} days)`,
        );
      }
      if (row['coalesce_group'] !== REVIEW_INVITATION_RULE.coalesceGroup) {
        drift.push(`coalesce_group is ${String(row['coalesce_group'])}`);
      }

      return { ok: true, present: true, enabled: row['is_enabled'] === true, drift };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, present: false, enabled: false, drift: [], error: message };
    }
  }
}
