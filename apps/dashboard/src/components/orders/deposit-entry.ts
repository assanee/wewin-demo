import { parsePercentBp, percentTextOf } from '@/lib/percent';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * What a person typed into the deposit box, turned into basis points.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The owner asked staff to be able to set the deposit while a quotation is still being
 * negotiated — *"การระบุยอดมัดจำ"*. The API takes basis points (3 000 is 30%), and nobody types
 * basis points, so this is where the two vocabularies meet.
 *
 * ⚠️ The *reading* is `lib/percent.ts`, shared with the forfeit-rate screen; the **sentences are
 * this file's**, and that split is the point. Both screens parse a percentage identically and
 * give opposite advice about zero: a deposit of 0 is a policy mistake with a fix, and a forfeit
 * of 0 is the normal, generous answer. One shared message would have to be vague enough to cover
 * both, which is how "invalid" gets written.
 *
 * ⚠️ It parses a **percentage**, never an amount — the API's decision showing through rather
 * than a shortcut here: a share follows the price when the quotation is edited, where a typed
 * amount would stay put and quietly become a different share of a different total.
 *
 * ⚠️ Nothing here is money arithmetic. It does not multiply the total, does not round satang,
 * and does not preview what the customer will be asked for — the server does all three.
 */

export type DepositEntry =
  | { readonly ok: true; readonly bp: number }
  | { readonly ok: false; readonly messageTh: string };

/** `'30'`, `'30%'`, `'30.5 %'`, `'๓๐'` — whatever the keyboard produced. */
export function parseDepositPercent(raw: string): DepositEntry {
  const reading = parsePercentBp(raw);

  if (!reading.ok) {
    if (reading.kind === 'empty') return { ok: false, messageTh: 'กรอกเปอร์เซ็นต์มัดจำ เช่น 30' };
    if (reading.kind === 'precision') {
      return { ok: false, messageTh: 'ละเอียดได้ถึงทศนิยม 2 ตำแหน่งเท่านั้น เช่น 30.25' };
    }
    return { ok: false, messageTh: 'กรอกเป็นตัวเลขเปอร์เซ็นต์เท่านั้น เช่น 30 หรือ 30.5' };
  }

  if (reading.bp < 1) {
    return { ok: false, messageTh: 'มัดจำต้องมากกว่า 0% — ถ้าไม่เก็บมัดจำ ให้ตั้ง 100% แล้วเก็บทีเดียว' };
  }
  if (reading.bp > 10_000) return { ok: false, messageTh: 'มัดจำเกิน 100% ไม่ได้' };

  return { ok: true, bp: reading.bp };
}

/** Basis points as a person reads them back: `3000` → `'30%'`, `3025` → `'30.25%'`. */
export function formatDepositPercent(bp: number): string {
  return `${percentTextOf(bp)}%`;
}

/**
 * ⭐ Whether the deposit may still be chosen — the client's copy of the API's first refusal.
 *
 * ⚠️ A copy, and it is allowed to be one only because it decides what to *draw*, never what is
 * permitted: the API refuses the write itself (`error.deposit.not_editable`), and money closes
 * it there through `assertNoMoney` — a fact this screen cannot see and must not try to guess.
 * What it buys is a person not being offered a box that would answer 409.
 */
export function mayEditDeposit(status: string): boolean {
  return status === 'awaiting_confirmation' || status === 'awaiting_payment';
}
