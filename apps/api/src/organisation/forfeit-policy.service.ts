import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type {
  ForfeitCellWire,
  ForfeitPolicyWire,
  PublishForfeitPolicyRequestWire,
} from '@wewin/contract/forfeit';
import type { OrderStatusWire } from '@wewin/contract/order';

import { AppError } from '../common/errors/app-error';
import { message } from '../i18n';
import { ForfeitPolicyRepository } from './forfeit-policy.repository';

/**
 * ⭐ อัตราริบมัดจำ — the one screen that decides what a cancellation costs.
 *
 * The rates shipped as 0 bp in every cell, deliberately: plan 13's rule is that every unanswered
 * number has defined behaviour on day one, and "the customer gets everything back" is the answer
 * that cannot cheat anybody while nobody has decided. This is where somebody decides.
 *
 * ── The two cells nobody may type into, and why they are the server's to refuse ──
 *
 *   `fault = 'company'`        `forfeit_policy_rules_company_fault_forfeits_nothing`. The
 *                              company's own mistake never costs the customer money — it is not
 *                              a default, it is a CHECK, and a screen offering the box would be
 *                              offering a 400.
 *
 *   `production_confirmed`     `forfeit_policy_rules_freeze_point_forfeits_nothing`. The order is
 *                              frozen there but **nothing has been cut yet** — plan 7.8. Cutting
 *                              starts at `in_production`, which is the first row where a forfeit
 *                              is about a cost somebody actually incurred.
 *
 * Both are relayed to the screen as locked cells with the reason attached, rather than left out:
 * a row that vanishes reads as an oversight, and somebody eventually asks for it to be added.
 */
@Injectable()
export class ForfeitPolicyService {
  constructor(private readonly policies: ForfeitPolicyRepository) {}

  /** The policy in force, as the screen shows it. */
  async current(): Promise<ForfeitPolicyWire> {
    const effective = await this.policies.effective();

    /*
     * ⛔ Not an empty screen. Without an effective policy no order can be submitted at all —
     * `pinsForSubmit` refuses with `no_effective_forfeit_policy` — so this is a broken
     * installation rather than a state to render, and saying so is more use than a blank table.
     */
    if (effective === undefined) {
      throw AppError.conflict(message('error.forfeit.no_effective_policy'), {
        reason: 'no_effective_forfeit_policy',
      });
    }

    return {
      code: effective.code,
      descriptionTh: effective.descriptionTh,
      effectiveFrom: effective.effectiveFrom.toISOString(),
      cells: effective.cells.map((cell): ForfeitCellWire => {
        const locked = lockOf(cell.fromStatus, cell.fault);
        return {
          fromStatus: cell.fromStatus as OrderStatusWire,
          fault: cell.fault === 'company' ? 'company' : 'customer',
          forfeitBp: cell.forfeitBp,
          editable: locked === null,
          whyLockedTh: locked,
        };
      }),
    };
  }

  /**
   * Publish a new version — the only way a rate ever changes.
   *
   * ⚠️ Every cell is written, not only the ones sent: the completeness trigger demands the full
   * grid, and the half the screen cannot edit is the same 0 in every policy that will ever
   * exist. A request that names a locked cell is refused rather than ignored, because silently
   * dropping a number somebody typed is how a screen comes to disagree with the database about
   * what was saved.
   */
  async publish(request: PublishForfeitPolicyRequestWire): Promise<ForfeitPolicyWire> {
    const cancellable = await this.policies.cancellableStatuses();

    const sent = new Map<string, number>();
    for (const cell of request.cells) {
      if (!cancellable.includes(cell.fromStatus)) {
        throw AppError.badRequest(message('error.forfeit.status_not_cancellable'), {
          reason: 'status_not_cancellable',
          fromStatus: cell.fromStatus,
        });
      }

      const locked = lockOf(cell.fromStatus, 'customer');
      if (locked !== null && cell.forfeitBp !== 0) {
        throw AppError.badRequest(message('error.forfeit.cell_is_locked'), {
          reason: 'cell_is_locked',
          fromStatus: cell.fromStatus,
        });
      }

      if (sent.has(cell.fromStatus)) {
        throw AppError.badRequest(message('error.forfeit.cell_sent_twice'), {
          reason: 'cell_sent_twice',
          fromStatus: cell.fromStatus,
        });
      }

      sent.set(cell.fromStatus, cell.forfeitBp);
    }

    /*
     * ⚠️ A cell nobody sent keeps 0 rather than the current policy's figure. Publishing is
     * writing a whole policy, not patching one: a screen that sent five of six rows and got the
     * sixth silently carried over from a version somebody else published would be a policy no
     * single person has ever read in full.
     */
    const cells = cancellable.flatMap((fromStatus) => [
      { fromStatus, fault: 'customer', forfeitBp: sent.get(fromStatus) ?? 0 },
      { fromStatus, fault: 'company', forfeitBp: 0 },
    ]);

    /*
     * The code is generated rather than typed. It is a key — `^[a-z][a-z0-9_]*$`, unique, and
     * referenced by every order pinned to this version — and what a person has to say about the
     * policy belongs in `descriptionTh`, which is prose and can be rewritten in a later version.
     *
     * ⚠️ THE SUFFIX IS NOT DECORATION. The first version of this line stamped to the second,
     * and `forfeit_policies_code_unique` then turned a second publish inside the same second
     * into a 500 — which is one impatient double-click, or two people in the settings screen at
     * once. A test publishing twice in a row found it immediately; a person would have found it
     * on the day two of them were arguing about the rate.
     */
    const stamp = new Date().toISOString().replace(/[-:T.]/gu, '').slice(0, 17);
    await this.policies.publish({
      code: `policy_${stamp}${randomUUID().replace(/-/gu, '').slice(0, 6)}`,
      descriptionTh: request.descriptionTh,
      cells,
    });

    return this.current();
  }
}

/**
 * Why this cell cannot be typed into, or `null` when it can.
 *
 * The sentences are Thai and say the *reason* rather than "locked": somebody looking at a
 * greyed box wants to know whether it is a rule or an oversight, and the difference is the
 * whole content of these two lines.
 */
function lockOf(fromStatus: string, fault: string): string | null {
  if (fault === 'company') {
    return 'ความผิดของบริษัทไม่ริบเงินลูกค้า — เป็นข้อบังคับในฐานข้อมูล แก้ไม่ได้';
  }
  if (fromStatus === 'production_confirmed') {
    return 'ยืนยันผลิตแล้วแต่ยังไม่ได้ตัดอะลูมิเนียม — ค่าใช้จ่ายจริงเริ่มที่ "กำลังผลิต"';
  }
  return null;
}
