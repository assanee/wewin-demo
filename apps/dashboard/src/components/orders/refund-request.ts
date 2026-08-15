/**
 * ⭐ ขอคืนเงิน — when the button may be offered, and what it sends.
 *
 * ── The queue could only ever be empty ───────────────────────────────────────────
 *
 * `refund-api.ts` had three functions — `listRefunds`, `decideRefund`, `disburseRefund` — and
 * no fourth. `POST /payments/refunds`, the one that *raises* a request, had no caller in
 * either app. Staff could approve a refund and pay it out; nobody could ask for one. The
 * คืนเงิน screen was a queue with no way in.
 *
 * ── The three refusals, learned by asking the server rather than by reading hopefully ──
 *
 * `refunds.service.ts` answers 409 for each of these, so the button is offered only when none
 * of them holds:
 *
 *   1. **The order must be cancelled.** *"คืนเงินได้เฉพาะออร์เดอร์ที่ถูกยกเลิกแล้วเท่านั้น — เงินของ
 *      ออร์เดอร์ที่ออกใบใหม่แทนจะถูกยกไปยังใบใหม่ ไม่ใช่คืน"*. Money on a live order is not spare:
 *      it is the deposit holding the production slot.
 *   2. **It must still hold money.** *"ออร์เดอร์นี้ไม่มีเงินคงเหลือที่จะคืน"*.
 *   3. **One open request at a time.** *"ออร์เดอร์นี้มีคำขอคืนเงินที่ยังไม่จบอยู่แล้ว"*.
 *
 * ── Two more the client cannot pre-check, and deliberately does not try ──────────
 *
 *   4. **Money in and money out must be different people.** *"ผู้ที่ตรวจรับสลิปของออร์เดอร์นี้ขอ
 *      คืนเงินเองไม่ได้ — เงินเข้าและเงินออกต้องเป็นคนละคน"*. This screen does not know who
 *      accepted the slips, and asking would be a second copy of a rule the server owns.
 *   5. **No verified source account means the payee is mandatory.** *"ไม่มีบัญชีต้นทางที่ตรวจแล้ว
 *      บนออร์เดอร์นี้ — ต้องระบุบัญชีปลายทางพร้อมเหตุผล"*. True of any order paid through
 *      บันทึกการชำระโดยไม่มีสลิป: there is no slip, so there is no account to send it back to.
 *
 * Both surface as the server's own Thai sentence inside the dialog, which is the right place
 * for a refusal the person can act on — pick another colleague, or fill in the account.
 *
 * The first three were found by calling the endpoint against a delivered order and reading
 * what came back; the last two by pressing the button and reading what came back. Designing the screen first and discovering the rule afterwards is how the ทิ้งฉบับร่าง
 * button in this same round shipped a sentence describing an outcome the system refuses to
 * produce.
 */

export type RefundAvailability =
  | { readonly kind: 'available'; readonly heldThbMinor: bigint }
  /** Live, superseded, or a cart: the money is not free to send back. */
  | { readonly kind: 'notCancelled' }
  | { readonly kind: 'nothingHeld' }
  | { readonly kind: 'pending' };

export function refundAvailability(facts: {
  readonly status: string;
  /**
   * What the company is still holding, from `OrderWire.heldThbMinor`.
   *
   * ⚠️ Null on every status but `cancelled` — the wire states it nowhere else, deliberately —
   * so a null here is "not applicable", never "zero".
   */
  readonly heldThbMinor: bigint | null;
  /** True when this order already has a refund that is neither disbursed nor refused. */
  readonly hasOpenRefund: boolean;
}): RefundAvailability {
  if (facts.status !== 'cancelled') return { kind: 'notCancelled' };

  /*
   * Asked before the balance: an order with both an open request and money held must read
   * `pending`, or the screen offers a button whose only outcome is
   * "ออร์เดอร์นี้มีคำขอคืนเงินที่ยังไม่จบอยู่แล้ว".
   */
  if (facts.hasOpenRefund) return { kind: 'pending' };

  const held = facts.heldThbMinor;
  /* `<= 0n` and not `=== 0n`: a forfeit can take the figure to zero from either direction. */
  if (held === null || held <= 0n) return { kind: 'nothingHeld' };

  return { kind: 'available', heldThbMinor: held };
}

export interface RefundPayee {
  readonly name: string;
  readonly bankCode: string;
  readonly accountLast4: string;
}

export type RefundFormResult =
  | { readonly ok: true; readonly body: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * The body for `POST /payments/refunds`.
 *
 * ⚠️ **The amount is not on the form, and that is the design rather than an omission.** The
 * server derives what is owed back from the order's own ledger; a figure typed here would be a
 * second opinion about how much money the company holds, and the one that reached the customer
 * would be whichever screen happened to be open.
 *
 * ⚠️ `payee` is all-or-nothing. `payeeSchema` is a `strictObject` needing name, bank and last
 * four together, so a half-filled account is a 400 nobody can act on. Either all three are
 * given — meaning "send it somewhere other than where it came from" — or the key is left off
 * and the money goes back the way it arrived.
 */
export function refundFormBody(fields: {
  readonly payee: RefundPayee | null;
  readonly reasonTh: string;
}): RefundFormResult {
  const problems: string[] = [];
  const reason = fields.reasonTh.trim();
  const payee = fields.payee;

  if (payee !== null) {
    if (payee.name.trim() === '') problems.push('ต้องระบุชื่อบัญชีผู้รับเงิน');
    if (payee.bankCode.trim() === '') problems.push('ต้องเลือกธนาคาร');
    if (!/^[0-9]{4}$/u.test(payee.accountLast4.trim())) {
      problems.push('เลขท้ายบัญชีต้องเป็นตัวเลข 4 หลัก');
    }
    /*
     * The server asks for a reason only when the payee differs from the original account, and
     * this screen cannot tell whether it does. So it asks whenever an account is typed at all:
     * being asked once too often costs a sentence, not being asked costs a 409 after the fact.
     */
    if (reason === '') problems.push('ต้องระบุเหตุผลเมื่อคืนเข้าบัญชีอื่น');
  }

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    body: {
      ...(payee === null
        ? {}
        : {
            payee: {
              name: payee.name.trim(),
              bankCode: payee.bankCode.trim(),
              accountLast4: payee.accountLast4.trim(),
            },
          }),
      ...(reason === '' ? {} : { reasonTh: reason }),
    },
  };
}
