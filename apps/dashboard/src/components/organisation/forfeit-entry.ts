import { parsePercentBp, percentTextOf } from '@/lib/percent';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * อัตราริบมัดจำ — what a person typed into one cell of the forfeit policy.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ **0 is a real answer here, and that is the whole difference from the deposit box.** A
 * deposit of 0% is a mistake with a fix; a forfeit of 0% means "if this customer cancels at this
 * stage, they get everything back", which is what the system shipped with and what most rows
 * will keep. The reading is shared (`lib/percent.ts`) and the sentences are not.
 *
 * ⚠️ An empty box is also 0 rather than a refusal — a person filling in the two rows they care
 * about should not have to type zeros into the four they do not. `blankIsZero` says so out loud
 * at the one call site that matters, so nobody later reads it as a leniency.
 */

export type ForfeitEntry =
  | { readonly ok: true; readonly bp: number }
  | { readonly ok: false; readonly messageTh: string };

export function parseForfeitPercent(raw: string): ForfeitEntry {
  const reading = parsePercentBp(raw);

  if (!reading.ok) {
    /* ⭐ Blank is zero — see the header. */
    if (reading.kind === 'empty') return { ok: true, bp: 0 };
    if (reading.kind === 'precision') {
      return { ok: false, messageTh: 'ละเอียดได้ถึงทศนิยม 2 ตำแหน่งเท่านั้น เช่น 12.50' };
    }
    return { ok: false, messageTh: 'กรอกเป็นตัวเลขเปอร์เซ็นต์ เช่น 50 หรือเว้นว่างไว้ถ้าไม่ริบ' };
  }

  if (reading.bp > 10_000) {
    return { ok: false, messageTh: 'ริบเกิน 100% ของยอดมัดจำไม่ได้' };
  }

  return { ok: true, bp: reading.bp };
}

/** `5000` → `'50'`, and `0` → `''` so an unset row reads as empty rather than as a typed zero. */
export function forfeitPercentText(bp: number): string {
  return bp === 0 ? '' : percentTextOf(bp);
}

/**
 * The Thai for each status, in the order work moves through them.
 *
 * ⚠️ A **display order**, not a list of which statuses exist: the cells come from the server,
 * which reads them out of `order_status_transitions`. A status here with no cell renders
 * nothing, and a cell whose status is missing here falls back to its code — the same bargain
 * `statusLabel` makes, and for the same reason.
 */
export const FORFEIT_STATUS_ORDER: readonly string[] = [
  'draft',
  'awaiting_confirmation',
  'awaiting_payment',
  'production_confirmed',
  'in_production',
  'awaiting_installation',
  'redesign',
];

/** What a person is being asked about: the moment the customer walks away. */
export const FORFEIT_STATUS_TH: Readonly<Record<string, string>> = {
  draft: 'ยกเลิกตอนยังเป็นตะกร้า',
  awaiting_confirmation: 'ยกเลิกตอนรอเรายืนยัน',
  awaiting_payment: 'ยกเลิกตอนรอลูกค้าชำระ',
  production_confirmed: 'ยกเลิกหลังยืนยันผลิต',
  in_production: 'ยกเลิกตอนกำลังผลิต',
  awaiting_installation: 'ยกเลิกตอนรอติดตั้ง',
  redesign: 'ยกเลิกตอนขอแก้แบบ',
};

/** Sort the server's cells for the screen, unknown statuses last and in a stable order. */
export function inDisplayOrder<T extends { readonly fromStatus: string }>(
  cells: readonly T[],
): readonly T[] {
  const rank = (status: string): number => {
    const at = FORFEIT_STATUS_ORDER.indexOf(status);
    return at === -1 ? FORFEIT_STATUS_ORDER.length : at;
  };

  return [...cells].sort((left, right) => {
    const byRank = rank(left.fromStatus) - rank(right.fromStatus);
    return byRank === 0 ? left.fromStatus.localeCompare(right.fromStatus) : byRank;
  });
}
