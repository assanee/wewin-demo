import { readSatang, type MoneyBody } from './allocation-plan';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ A PAYMENT NOBODY PHOTOGRAPHED — what the screens say about it, and when.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The owner's ask: *"เจ้าหน้าที่สามารถปิดยอดการชำระได้โดยไม่มีการยืนยันสลิป แต่ต้องระบุเหตุผล"*,
 * accepted on the condition *"ต้องสามารถตรวจสอบย้อนหลังได้"*. Two reasons therefore have to be
 * unmissable on the screens: **why there is no slip**, and — when one person did both halves —
 * **why they did both halves**.
 *
 * No React here on purpose. Everything below is the part that is right or wrong: which of three
 * states an image-less slip is in, whether a form may be submitted, and what the request body
 * looks like. `apps/dashboard`'s vitest is `environment: 'node'` and a `.test.tsx` is silently
 * never collected, so the testable part is deliberately not in the component.
 *
 * ── ⚠️ THREE STATES, NOT TWO, AND `hasImage` DISTINGUISHES ONLY TWO OF THEM ───
 *
 *     photographed        `hasImage`
 *     erased for PDPA     no image, `imageErasedAt` set — an ordinary customer slip whose
 *                         picture a retention decision destroyed. NOT an evidence-free entry.
 *     recorded by staff   no image, `noSlipReasonTh` set — the one this feature creates.
 *
 * A screen that keyed off `!hasImage` would put the audit marker on the middle row, which is the
 * marker meaning the opposite of the truth. `payment_slips_evidence_exists` is the CHECK that
 * makes those three exhaustive; this function is the reading of it.
 */

export type SlipEvidence = 'image' | 'erased' | 'recorded';

export interface EvidenceFacts {
  readonly hasImage: boolean;
  readonly imageErasedAt: string | null;
  readonly noSlipReasonTh: string | null;
}

/**
 * Which of the three a slip is in.
 *
 * `noSlipReasonTh` is tested **first**. A staff-recorded payment can in principle also carry an
 * erasure stamp one day (nothing erases what was never stored today, but nothing forbids the
 * columns coexisting either), and when the two disagree the fact that matters to an auditor is
 * that a person entered this without evidence.
 */
export function slipEvidence(slip: EvidenceFacts): SlipEvidence {
  if (slip.noSlipReasonTh !== null) return 'recorded';
  if (slip.hasImage) return 'image';
  return 'erased';
}

/** The one-line label for a queue cell or a table row. Never invents vocabulary — `สลิป` is the word. */
export function evidenceLabelTh(slip: EvidenceFacts): string {
  switch (slipEvidence(slip)) {
    case 'image':
      return 'มีสลิป';
    case 'recorded':
      return 'ไม่มีสลิป — เจ้าหน้าที่บันทึก';
    case 'erased':
      return 'สลิปถูกลบตาม PDPA';
  }
}

/* ────────────────────────────────────────────────────────────────────────────── *
 * The recording form
 * ────────────────────────────────────────────────────────────────────────────── */

/**
 * The shortest reason this screen will send.
 *
 * The same ten `recordSlipRequestSchema` enforces, restated here so the refusal is a sentence
 * under the box rather than a 400 after a round trip. The duplication is the deliberate kind:
 * the server's copy is the one that decides, this one is the one that explains.
 */
export const MIN_REASON_LENGTH = 10;

export interface RecordFormFields {
  readonly orderId: string;
  /** As typed, in baht — `readSatang` decides whether it is a number. */
  readonly amount: string;
  /** `datetime-local`, i.e. `2026-08-14T09:30`, in the browser's own zone. */
  readonly transferredAtLocal: string;
  readonly noSlipReasonTh: string;
  readonly bankReference: string;
  readonly payerName: string;
  readonly payerAccountLast4: string;
}

export interface RecordFormBody {
  readonly orderId: string;
  readonly amountThbMinor: MoneyBody;
  readonly transferredAt: string;
  readonly noSlipReasonTh: string;
  readonly bankReference?: string;
  readonly payerName?: string;
  readonly payerAccountLast4?: string;
}

export type RecordFormResult =
  | { readonly ok: true; readonly body: RecordFormBody }
  | { readonly ok: false; readonly problemsTh: readonly string[] };

/**
 * The form, checked and turned into a request — or every reason it cannot be.
 *
 * ⚠️ **Every problem, not the first.** A person keying a telephoned transfer has four fields to
 * get right and a form that reveals one mistake per submission is a form they will send four
 * times. The order below is the reading order of the dialog, so the messages line up with the
 * boxes.
 *
 * ⚠️ The amount is `bigint` satang from `readSatang` and never a `number`. There is no version of
 * a float in a money path that is worth the convenience — `allocation-plan.ts` argues it at
 * length and this is the same money.
 */
export function recordFormBody(fields: RecordFormFields, now: Date): RecordFormResult {
  const problemsTh: string[] = [];

  const amount = readSatang(fields.amount.trim());
  if (!amount.ok || amount.value <= 0n) {
    problemsTh.push('ยอดเงินต้องเป็นตัวเลขที่มากกว่าศูนย์');
  }

  const transferredAt = new Date(fields.transferredAtLocal);
  if (fields.transferredAtLocal.trim() === '' || Number.isNaN(transferredAt.getTime())) {
    problemsTh.push('ต้องระบุวันและเวลาที่ลูกค้าโอนเงิน');
  } else if (transferredAt.getTime() > now.getTime()) {
    /*
     * The server allows two minutes of clock skew (`TRANSFER_CLOCK_SKEW_MS`) and this allows
     * none, deliberately: a person typing a time cannot be a minute out by accident the way a
     * device clock can, and the wider window exists for machines rather than for this box.
     */
    problemsTh.push('เวลาที่โอนอยู่ในอนาคต — ตรวจสอบอีกครั้ง');
  }

  const reason = fields.noSlipReasonTh.trim();
  if (reason.length < MIN_REASON_LENGTH) {
    problemsTh.push(
      `ต้องระบุเหตุผลที่ไม่มีสลิป อย่างน้อย ${String(MIN_REASON_LENGTH)} ตัวอักษร — เหตุผลนี้จะถูกเก็บไว้ถาวรเพื่อการตรวจสอบย้อนหลัง`,
    );
  }

  const last4 = fields.payerAccountLast4.trim();
  if (last4 !== '' && !/^\d{4}$/u.test(last4)) {
    problemsTh.push('เลขท้ายบัญชีต้องเป็นตัวเลขสี่หลัก');
  }

  if (problemsTh.length > 0 || !amount.ok) return { ok: false, problemsTh };

  const bankReference = fields.bankReference.trim();
  const payerName = fields.payerName.trim();

  return {
    ok: true,
    body: {
      orderId: fields.orderId,
      amountThbMinor: { unit: 'THB.satang', digits: amount.value.toString() },
      transferredAt: transferredAt.toISOString(),
      noSlipReasonTh: reason,
      ...(bankReference === '' ? {} : { bankReference }),
      ...(payerName === '' ? {} : { payerName }),
      ...(last4 === '' ? {} : { payerAccountLast4: last4 }),
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────── *
 * The declared bypass of the two-person rule
 * ────────────────────────────────────────────────────────────────────────────── */

export interface SelfReviewFacts {
  /**
   * 🔒 `SlipReviewWire.viewerIsSubmitter` — **the server's answer, carried, not recomputed.**
   *
   * There is no user id in this shape on purpose. Comparing the session to
   * `slip.submittedByUserId` is the inference this function used to make, and it is not the rule:
   * `slip_submitter_user_ids()` also resolves the guest cart the reviewer later claimed, and that
   * cart's slip carries `null` in the column. `false` while the review is still loading, which
   * says nothing about a screen that has no buttons on it yet.
   */
  readonly viewerIsSubmitter: boolean;
  readonly holdsBypass: boolean;
}

export type SelfReviewState =
  /** Somebody else entered it. The ordinary case, and no declaration is involved. */
  | { readonly kind: 'not_mine' }
  /** They entered it and may not review it. The screen says so and disables the buttons. */
  | { readonly kind: 'blocked'; readonly messageTh: string }
  /** They entered it and may review it — once they have written down why. */
  | { readonly kind: 'must_declare'; readonly messageTh: string };

/**
 * 🔒 What the review dialog must say before it lets one person do both halves.
 *
 * ⚠️ **This is presentation, and it is not the control.** `SlipsService.accept` demands the
 * permission *and* the reason, and `payment_slips_guard_write()` refuses the write when the
 * column is null whatever the application decided. What this buys is that the person finds out
 * before they have typed a full allocation plan, and that the `blocked` case names the remedy —
 * "find a colleague" — instead of a 403.
 *
 * ⚠️ **It no longer decides whose slip this is, and that is the fix.** It used to, by comparing
 * the session to `slip.submittedByUserId`, and it was blind to the half of the rule that matters
 * most: `slip_submitter_user_ids()` resolves a guest cart later signed into an account to the
 * same person, and that cart's slip has `null` in the column. So on the *main* funnel the
 * reviewer's own slip read as somebody else's — `not_mine`, no warning, and no declaration
 * textarea. Pressing รับรอง then got a 403 `self_review_needs_reason` naming a field that was not
 * on the screen, and the review could not be completed through the UI at all. Failing closed, and
 * still a dead end.
 *
 * The fact now arrives on the wire (`SlipReviewWire.viewerIsSubmitter`) computed by the same SQL
 * function the refusal uses — the argument that put `orderIsLive` on `PaymentInstructionsWire`
 * rather than shipping a status for every client to interpret with its own copy of the list.
 */
export function selfReviewState(facts: SelfReviewFacts): SelfReviewState {
  if (!facts.viewerIsSubmitter) {
    return { kind: 'not_mine' };
  }

  if (!facts.holdsBypass) {
    return {
      kind: 'blocked',
      messageTh:
        'คุณเป็นผู้บันทึกรายการนี้เอง จึงตรวจเองไม่ได้ — ต้องให้อีกคนรับรอง',
    };
  }

  return {
    kind: 'must_declare',
    messageTh:
      'คุณเป็นผู้บันทึกรายการนี้เอง ถ้าจะรับรองเองต้องระบุเหตุผลที่ต้องทำทั้งสองขั้นตอนคนเดียว — เหตุผลนี้จะถูกเก็บไว้ถาวรเพื่อการตรวจสอบย้อนหลัง',
  };
}
