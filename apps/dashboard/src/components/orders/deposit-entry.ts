/**
 * ─────────────────────────────────────────────────────────────────────────────
 * What a person typed into the deposit box, turned into basis points.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The owner asked staff to be able to set the deposit while a quotation is still being
 * negotiated — *"การระบุยอดมัดจำ"*. The API takes basis points (3 000 is 30%), and nobody types
 * basis points, so this is the one place the two vocabularies meet.
 *
 * ⚠️ It parses a **percentage**, never an amount, and that is the API's decision showing through
 * rather than a shortcut here: a share follows the price when the quotation is edited, where a
 * typed amount would stay put and quietly become a different share of a different total.
 *
 * ⚠️ Nothing here is money arithmetic. It does not multiply the total, does not round satang,
 * and does not preview what the customer will be asked for — the server does all three, and a
 * second implementation of it on a screen is how two figures come to describe one contract.
 * What this file produces is an integer between 1 and 10 000, or a sentence saying why not.
 */

export type DepositEntry =
  | { readonly ok: true; readonly bp: number }
  | { readonly ok: false; readonly messageTh: string };

/**
 * `'30'`, `'30%'`, `'30.5 %'`, `'๓๐'` — whatever the keyboard produced.
 *
 * Thai digits are accepted because the keyboard on a Thai phone produces them and a form that
 * refuses them refuses the person, not the input. Everything else is refused with a sentence
 * that says what was wrong, because "invalid" tells somebody nothing they can act on.
 */
export function parseDepositPercent(raw: string): DepositEntry {
  const typed = raw.trim().replace(/%$/u, '').trim();
  if (typed === '') return { ok: false, messageTh: 'กรอกเปอร์เซ็นต์มัดจำ เช่น 30' };

  /* Thai digits to Arabic, in one pass, before anything looks at the shape. */
  const normalised = typed.replace(/[๐-๙]/gu, (digit) => String(digit.charCodeAt(0) - 0x0e50));

  if (!/^\d+(\.\d+)?$/u.test(normalised)) {
    return { ok: false, messageTh: 'กรอกเป็นตัวเลขเปอร์เซ็นต์เท่านั้น เช่น 30 หรือ 30.5' };
  }

  /*
   * ⚠️ Two decimal places is the limit, and it is the *contract's* limit rather than a
   * preference: a basis point is one hundredth of a percent, so 30.555% is a number this API
   * cannot carry. Rounding it silently would send a figure nobody typed.
   */
  const [, fraction = ''] = normalised.split('.');
  if (fraction.length > 2) {
    return { ok: false, messageTh: 'ละเอียดได้ถึงทศนิยม 2 ตำแหน่งเท่านั้น เช่น 30.25' };
  }

  const bp = Math.round(Number(normalised) * 100);

  if (bp < 1) return { ok: false, messageTh: 'มัดจำต้องมากกว่า 0% — ถ้าไม่เก็บมัดจำ ให้ตั้ง 100% แล้วเก็บทีเดียว' };
  if (bp > 10_000) return { ok: false, messageTh: 'มัดจำเกิน 100% ไม่ได้' };

  return { ok: true, bp };
}

/** Basis points as a person reads them back: `3000` → `'30%'`, `3025` → `'30.25%'`. */
export function formatDepositPercent(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const fraction = bp % 100;
  if (fraction === 0) return `${String(whole)}%`;
  return `${String(whole)}.${String(fraction).padStart(2, '0').replace(/0$/u, '')}%`;
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
