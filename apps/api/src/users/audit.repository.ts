import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db/client';
import { adminEvents } from '@wewin/db/schema';
import type { AdminEventAction } from '@wewin/db/schema';
import { sql } from '@wewin/db/sql';

import { DRIZZLE } from '../database/database.tokens';

/**
 * A transaction handle.
 *
 * Derived from `Database['transaction']` rather than imported: `@wewin/db` exports no name
 * for it, and `slips.repository.ts` derives the same type the same way. Two derivations of
 * one type is not duplication — it is the same expression, and it stays correct when Drizzle
 * changes the shape underneath.
 */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE AUDIT ROW IS WRITTEN IN THE CHANGE'S OWN TRANSACTION.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `record` takes a **transaction handle and nothing else**, and that signature is the
 * design. A row written after the UPDATE commits is missing whenever the process dies in
 * between — the change happened, nothing recorded it, and the gap is invisible because the
 * only thing that would have reported it is the row that was never written.
 *
 * There is no `record(userId, …)` overload that opens its own transaction. Adding one would
 * make the safe path and the convenient path different paths, and the convenient one wins
 * every time somebody is in a hurry.
 *
 * ── ⚠️ The payload rule, restated where the call sites are ───────────────────
 *
 * Ids, codes and enums. **Never an address, never free text a person wrote.** These rows
 * survive erasure — `ERASURE_TREATMENTS` says `keep` for both user columns — and that is
 * only defensible while the row is about the *act* rather than about the person.
 * `admin_events_payload_is_impersonal` refuses an `@`, which catches the mistake that
 * actually happens: interpolating the identifier that was already to hand.
 */

export interface AdminEventInput {
  readonly action: AdminEventAction;
  /** From a verified token. ⚠️ Never from a request body. */
  readonly actorUserId: string;
  readonly subjectUserId?: string;
  readonly subjectGroupId?: string;
  /** Ids, codes and enums only — see the class comment and the CHECK it names. */
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface AdminEventRow {
  readonly seq: number;
  readonly action: AdminEventAction;
  readonly occurredAt: string;
  readonly actorUserId: string;
  readonly actorName: string | null;
  readonly subjectUserId: string | null;
  readonly subjectName: string | null;
  readonly subjectGroupId: string | null;
  readonly subjectGroupCode: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

@Injectable()
export class AuditRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * ⭐ Takes a `Tx`, never the `Database`.
   *
   * The type is the enforcement: a caller with no transaction in hand cannot reach this
   * method at all, so "record it afterwards" is not a shape the code can express.
   */
  async record(tx: Tx, event: AdminEventInput): Promise<void> {
    await tx.insert(adminEvents).values({
      action: event.action,
      actorUserId: event.actorUserId,
      ...(event.subjectUserId === undefined ? {} : { subjectUserId: event.subjectUserId }),
      ...(event.subjectGroupId === undefined ? {} : { subjectGroupId: event.subjectGroupId }),
      payload: event.payload ?? {},
    });
  }

  /**
   * The history, newest first.
   *
   * Names are joined in rather than stored, and that is the point of storing only ids: a
   * person renamed last week reads correctly in a row written last year, and an erased one
   * reads as a tombstone with no name — which is what erasure is supposed to look like from
   * here.
   */
  async list(filter: {
    readonly subjectUserId?: string | undefined;
    readonly limit: number;
  }): Promise<readonly AdminEventRow[]> {
    const rows = await this.db.execute<{
      seq: number;
      action: string;
      occurred_at: string;
      actor_user_id: string;
      actor_name: string | null;
      subject_user_id: string | null;
      subject_name: string | null;
      subject_group_id: string | null;
      subject_group_code: string | null;
      payload: Record<string, unknown>;
    }>(sql`
      select e.seq::int              as seq,
             e.action                as action,
             e.occurred_at::text     as occurred_at,
             e.actor_user_id::text   as actor_user_id,
             a.display_name          as actor_name,
             e.subject_user_id::text as subject_user_id,
             s.display_name          as subject_name,
             e.subject_group_id::text as subject_group_id,
             g.code                  as subject_group_code,
             e.payload               as payload
        from admin_events e
        join users a on a.id = e.actor_user_id
        left join users s on s.id = e.subject_user_id
        left join ${sql.raw('groups')} g on g.id = e.subject_group_id
       where ${filter.subjectUserId === undefined ? sql`true` : sql`e.subject_user_id = ${filter.subjectUserId}::uuid`}
       order by e.seq desc
       limit ${filter.limit}
    `);

    /*
     * ⚠️ `seq::int` and `occurred_at::text` in the SQL, not casts here. `db.execute` bypasses
     * Drizzle's parsers, so `bigserial` arrives as a *string* and a timestamp as a `Date` —
     * the trap `users.repository.ts` paid for once with `created_at.toISOString is not a
     * function`. Casting in the query is where the cast is checkable.
     */
    return rows.rows.map((row) => ({
      seq: row.seq,
      action: row.action as AdminEventAction,
      occurredAt: row.occurred_at,
      actorUserId: row.actor_user_id,
      actorName: row.actor_name,
      subjectUserId: row.subject_user_id,
      subjectName: row.subject_name,
      subjectGroupId: row.subject_group_id,
      subjectGroupCode: row.subject_group_code,
      payload: row.payload,
    }));
  }
}
