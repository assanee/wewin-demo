import { Inject, Injectable } from '@nestjs/common';
import { sql } from '@wewin/db/sql';
import type { Database } from '@wewin/db/client';

import { DRIZZLE } from '../database/database.tokens';

/** The rows this repository reads and writes, before anything decides what they mean. */
export interface ForfeitPolicyRow {
  readonly code: string;
  readonly descriptionTh: string;
  readonly effectiveFrom: Date;
  readonly cells: readonly { readonly fromStatus: string; readonly fault: string; readonly forfeitBp: number }[];
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const records = (result: unknown): readonly Record<string, unknown>[] =>
  (result as { rows?: readonly Record<string, unknown>[] }).rows ?? [];

/**
 * ⭐ อัตราริบมัดจำ — reading the policy in force, and publishing the next one.
 *
 * ── Why there is no update ──────────────────────────────────────────────────────
 *
 * An order pins `forfeit_policy_id` at submit (`LifecycleRepository.pinForfeitPolicy`, and
 * `LedgerRepository.effectiveForfeitPolicy`'s note says why). Editing a live policy in place
 * would therefore change what a customer gets back on a contract they had already agreed to —
 * silently, months later, on the one screen where somebody is already unhappy. So this class
 * can create a version and cannot amend one, and that is the whole of its design.
 */
@Injectable()
export class ForfeitPolicyRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Which statuses a cancellation may leave from — **read from the transitions table**.
   *
   * Not a list in TypeScript, because `assert_forfeit_policy_complete()` derives the same set
   * the same way: a policy is complete when it prices every `(from_status, fault)` the table
   * says a cancellation can happen at. A second list here would disagree with that assertion
   * the first time a status became cancellable, and the disagreement would arrive as a
   * `restrict_violation` at publish time with no screen able to explain it.
   */
  async cancellableStatuses(tx?: Tx): Promise<readonly string[]> {
    const result = await (tx ?? this.db).execute(sql`
      select distinct from_status from order_status_transitions where to_status = 'cancelled'
    `);
    return records(result).map((row) => String(row['from_status']));
  }

  /** The policy a cancellation happening now would be priced by, with all of its cells. */
  async effective(tx?: Tx): Promise<ForfeitPolicyRow | undefined> {
    const executor = tx ?? this.db;

    /*
     * ⚠️ The same ordering `LedgerRepository.effectiveForfeitPolicy` uses, because they must
     * answer with the same policy — this screen exists to show what that code will read.
     */
    const found = await executor.execute(sql`
      select id::text as id, code, description_th, effective_from
        from forfeit_policies
       where effective_from is not null and effective_from <= now()
       order by effective_from desc, code asc
       limit 1
    `);

    const policy = records(found)[0];
    if (policy === undefined) return undefined;

    const cells = await executor.execute(sql`
      select from_status, fault, forfeit_bp
        from forfeit_policy_rules
       where policy_id = ${String(policy['id'])}::uuid
       order by from_status, fault
    `);

    return {
      code: String(policy['code']),
      descriptionTh: String(policy['description_th']),
      effectiveFrom: new Date(String(policy['effective_from'])),
      cells: records(cells).map((row) => ({
        fromStatus: String(row['from_status']),
        fault: String(row['fault']),
        forfeitBp: Number(row['forfeit_bp']),
      })),
    };
  }

  /**
   * Write a new version, effective immediately, in one transaction.
   *
   * ⚠️ **One transaction is a requirement and not a tidiness.** `forfeit_policies_complete` is a
   * DEFERRABLE INITIALLY DEFERRED constraint trigger: the policy row and every one of its cells
   * have to arrive together or the trigger refuses at commit. Writing the policy first and the
   * cells afterwards, in two statements from a service, is precisely the shape it forbids.
   *
   * ⚠️ **`effective_from` is nudged past the newest existing one.** `effectiveForfeitPolicy`
   * throws — deliberately — when two policies share an instant, because which applies is not a
   * question it may answer by sorting. `now()` is the transaction's clock and two publishes
   * inside one microsecond are unlikely rather than impossible; taking `max + 1µs` makes the
   * ordering total by construction instead of by luck.
   */
  async publish(input: {
    readonly code: string;
    readonly descriptionTh: string;
    readonly cells: readonly { readonly fromStatus: string; readonly fault: string; readonly forfeitBp: number }[];
  }): Promise<{ readonly code: string }> {
    return this.db.transaction(async (tx) => {
      const created = await tx.execute(sql`
        insert into forfeit_policies (code, description_th, effective_from)
        values (
          ${input.code},
          ${input.descriptionTh},
          greatest(now(), coalesce(
            (select max(effective_from) from forfeit_policies) + interval '1 microsecond',
            now()
          ))
        )
        returning id::text as id, code
      `);

      const policy = records(created)[0];
      if (policy === undefined) throw new Error('organisation: the forfeit policy was not written');
      const policyId = String(policy['id']);

      for (const cell of input.cells) {
        await tx.execute(sql`
          insert into forfeit_policy_rules (policy_id, from_status, fault, forfeit_bp)
          values (${policyId}::uuid, ${cell.fromStatus}, ${cell.fault}, ${cell.forfeitBp})
        `);
      }

      return { code: String(policy['code']) };
    });
  }
}
