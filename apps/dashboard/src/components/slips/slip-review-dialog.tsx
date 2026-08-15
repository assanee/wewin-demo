'use client';

import { useEffect, useState } from 'react';
import { formatBaht } from '@wewin/core/format';
import { AlertTriangle, ExternalLink, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { apiUrl } from '@/lib/api/config';
import { failureMessage } from '@/lib/api/errors';
import { useSession } from '@/lib/auth/session';
import { allocationPlan, readSatang, satangField } from './allocation-plan';
import { MIN_REASON_LENGTH, selfReviewState } from './no-slip';
import { acceptSlip, getReview, mintImageUrl, rejectSlip, type SlipReview } from './slip-api';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ A TWO-COLUMN COMPARISON, NOT A CONFIRM BUTTON — plan 7.6.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `acceptSlipRequestSchema` requires allocations and has no "just accept it" shape, and the
 * contract says why in as many words: *"a request body that could be empty is a confirm
 * button however the screen in front of it is drawn."* So this dialog puts what the customer
 * transferred beside what the schedule expects, and the reviewer says where every satang
 * goes before the button turns on.
 *
 * ── The three things a reviewer is actually deciding ─────────────────────────
 *
 *   ⓵ **Is the money real?** The image, beside the amount. `POST .../image-grant` mints a
 *     short-lived path because the bytes are served anonymously off an unguessable grant —
 *     an `<img>` tag cannot carry an `Authorization` header, so the permission check happens
 *     at the mint, where a session exists.
 *
 *   ⓶ **Who paid?** ⚠️ `payerName` arrives on the *customer's own* create-slip body and
 *     nothing ever compared it to the picture. 5b red team RT-2: a mule account named on the
 *     slip and named again on the refund request reads as "the original account", with no
 *     reason required and absent from the different-account report. Attesting it here is the
 *     control. Leaving it blank is allowed and leaves the payer unverified — which
 *     `deriveOriginalAccount` treats as `no`, failing closed into the customer's
 *     inconvenience rather than into somebody else's bank account.
 *
 *   ⓷ **Where does it go?** The allocations, seeded from the server's suggestion and edited
 *     freely. `allocation-plan.ts` holds the arithmetic and is tested without a browser.
 *
 * ── ⚠️ Two things about the type on this dialog ──────────────────────────────
 *
 * **The two amount figures came down from `text-2xl` to `text-xl`.** 24px *is* `type-focal`, and
 * a figure at the focal size is the primary statement of whatever it is inside, whatever the
 * layout intended — the same correction `overview-screen.tsx` made to its money. Here there were
 * two of them, tying with each other for a rank only one thing can hold. They also lost the
 * `rounded-lg border p-4` boxes around them: the comparison is made by putting the two numbers
 * side by side, and a ring around each said they were separate subjects.
 *
 * **The four sub-headings are `type-body font-medium`, not `type-section`, and that is a
 * compromise rather than a preference.** `DialogTitle` in `ui/dialog.tsx` is `text-base` — the
 * 16px the scale otherwise abolished — so a `type-section` heading inside this dialog would come
 * out *larger than the dialog's own title*. `ui/**` is not this pass's to change; it is the
 * one-line lever the README leaves to the owner, exactly like `CardTitle`. Until it is pulled,
 * these stay a named body size instead of an inverted hierarchy.
 */

const at = (iso: string): string =>
  new Date(iso).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly review: SlipReview }
  | { readonly status: 'failed'; readonly problem: string };

export function SlipReviewDialog({
  slipId,
  onClose,
  onDone,
}: {
  readonly slipId: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [payerName, setPayerName] = useState('');
  const [payerLast4, setPayerLast4] = useState('');
  const [noteTh, setNoteTh] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [reasonTh, setReasonTh] = useState('');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [selfReviewReasonTh, setSelfReviewReasonTh] = useState('');
  const [busy, setBusy] = useState(false);
  const { can } = useSession();

  useEffect(() => {
    let live = true;

    void (async () => {
      try {
        const review = await getReview(slipId);
        if (!live) return;

        setState({ status: 'ready', review });
        /*
         * Seeded from the server's suggestion, which is *offered and never applied*. The
         * reviewer starts from a plan that balances rather than from empty boxes, and every
         * figure stays editable — the suggestion is a convenience, not a decision.
         */
        setAmounts(
          Object.fromEntries(
            (review.suggestedAllocations ?? []).map((allocation) => [
              allocation.instalmentId,
              satangField(allocation.amountThbMinor),
            ]),
          ),
        );
        setPayerName(review.slip.payerName ?? '');
        setPayerLast4(review.slip.payerAccountLast4 ?? '');
      } catch (error) {
        if (live) setState({ status: 'failed', problem: failureMessage(error) });
      }
    })();

    return () => {
      live = false;
    };
  }, [slipId]);

  const review = state.status === 'ready' ? state.review : null;

  /*
   * 🔒 Whether this reviewer is about to do both halves.
   *
   * ⚠️ **`viewerIsSubmitter` is read off the wire and is not derived from the session here.** The
   * server computes it with `slip_submitter_user_ids()` — the function the refusal itself calls —
   * which counts the guest cart this reviewer later claimed as the same person. Comparing
   * `session.principal.userId` to `slip.submittedByUserId` is what this line used to do, and on
   * that funnel it concluded `not_mine`, showed no declaration box, and left the reviewer with a
   * 403 asking for a reason the screen had nowhere to type.
   *
   * What is still local, and must be: `holdsBypass`. That is a permission the session already
   * carries, and it decides only whether this screen says "find a colleague" or "write down why".
   * `SlipsService.accept` demands the permission *and* the reason, and
   * `payment_slips_guard_write()` refuses the write when the column is null whatever this screen
   * concluded — none of this is the control.
   */
  const selfReview = selfReviewState({
    viewerIsSubmitter: review?.viewerIsSubmitter ?? false,
    holdsBypass: can('payments.self_review_slip'),
  });

  const declarationMissing =
    selfReview.kind === 'must_declare' && selfReviewReasonTh.trim().length < MIN_REASON_LENGTH;
  const reviewBlocked = selfReview.kind === 'blocked';

  const drafts =
    review === null
      ? []
      : review.instalments.map((instalment) => {
          const parsed = readSatang(amounts[instalment.id] ?? '');
          return {
            instalmentId: instalment.id,
            amountThbMinor: parsed.ok ? parsed.value : 0n,
          };
        });

  const plan =
    review === null
      ? null
      : allocationPlan(
          review.slip.amountThbMinor,
          review.money.outstandingThbMinor,
          drafts,
        );

  const typo =
    review !== null &&
    review.instalments.some((instalment) => {
      const text = (amounts[instalment.id] ?? '').trim();
      return text !== '' && !readSatang(text).ok;
    });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>ตรวจสลิป</DialogTitle>
          <DialogDescription>
            {review === null
              ? 'กำลังโหลด'
              : `ออเดอร์ ${review.order.orderNo ?? review.order.id.slice(0, 8)} · ${review.order.contactName ?? 'ไม่ระบุชื่อ'}`}
          </DialogDescription>
        </DialogHeader>

        {state.status === 'loading' && <Skeleton className="h-96 w-full" />}

        {state.status === 'failed' && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>เปิดสลิปนี้ไม่ได้</AlertTitle>
            <AlertDescription>{state.problem}</AlertDescription>
          </Alert>
        )}

        {review !== null && plan !== null && (
          <div className="flex flex-col gap-6">
            {/* ── ⓵ The comparison the whole screen is named after ────────── */}
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <p className="text-muted-foreground type-caption">ลูกค้าโอนมา</p>
                <p className="text-xl leading-tight font-semibold tabular-nums">
                  {formatBaht(review.slip.amountThbMinor)}
                </p>
                <p className="text-muted-foreground type-caption">
                  แจ้งว่าโอนเมื่อ {at(review.slip.transferredAt)}
                  {review.slip.bankReference === null ? '' : ` · อ้างอิง ${review.slip.bankReference}`}
                </p>
                {/*
                 * F2's fix: `received_bank_account_id` used to be write-only — persisted on
                 * every slip a customer submits through the picker, surfaced on no read path
                 * at all. This is the reconciliation screen the column exists for, so the
                 * `null` case (a slip from before the column, or an account since deleted) is
                 * said out loud rather than left blank — an older slip genuinely does not know.
                 */}
                <p className="text-muted-foreground type-caption">
                  เข้าบัญชี{' '}
                  {review.slip.receivedBankAccount === null
                    ? 'ไม่ทราบ — สลิปนี้บันทึกไว้ก่อนมีข้อมูลนี้'
                    : `${review.slip.receivedBankAccount.bankCode} · ${review.slip.receivedBankAccount.accountName}`}
                </p>
              </div>

              <div className="flex flex-col gap-1">
                <p className="text-muted-foreground type-caption">งวดถัดไปต้องการ</p>
                <p className="text-xl leading-tight font-semibold tabular-nums">
                  {review.comparison.expectedNextDueThbMinor === null
                    ? '—'
                    : formatBaht(review.comparison.expectedNextDueThbMinor)}
                </p>
                <p className="text-muted-foreground type-caption">
                  ค้างทั้งออเดอร์ {formatBaht(review.money.outstandingThbMinor)}
                </p>
              </div>
            </div>

            {/*
             * ⚠️ Two numbers about money that are not the same kind of thing.
             *
             * `0011_payment_guards.sql`: paid is cash that arrived, settled is what the
             * instalments were credited, and they differ the first time a bank fee is written
             * off. "Which one a screen means has to be said out loud, every time."
             */}
            <dl className="text-muted-foreground type-caption grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
              <div>
                <dt>เงินสดที่เข้ามาแล้ว</dt>
                <dd className="text-foreground tabular-nums">{formatBaht(review.money.paidThbMinor)}</dd>
              </div>
              <div>
                <dt>ตัดงวดไปแล้ว</dt>
                <dd className="text-foreground tabular-nums">
                  {formatBaht(review.money.settledThbMinor)}
                </dd>
              </div>
              <div>
                <dt>ถือไว้เป็นมัดจำ</dt>
                <dd className="text-foreground tabular-nums">{formatBaht(review.money.heldThbMinor)}</dd>
              </div>
              <div>
                <dt>ตัดถึงงวดที่</dt>
                <dd className="text-foreground tabular-nums">
                  {review.money.settledThroughSeq ?? '—'}
                </dd>
              </div>
            </dl>

            {/* ── ⓶ The image ─────────────────────────────────────────────── */}
            <div className="flex flex-col gap-2">
              <p className="type-body font-medium">ภาพสลิป</p>
              {review.slip.noSlipReasonTh !== null ? (
                /*
                 * ⭐ THE FIRST OF THE TWO REASONS THAT MUST BE UNMISSABLE.
                 *
                 * An `Alert` and not a muted line, deliberately: this is the reviewer's *only*
                 * evidence. On an ordinary slip they compare a photograph against a figure; here
                 * there is no left-hand column, and the sentence a colleague typed is the whole
                 * of what they are being asked to รับรอง.
                 */
                <Alert>
                  <ShieldAlert />
                  <AlertTitle>ไม่มีสลิป — เจ้าหน้าที่บันทึกรายการนี้</AlertTitle>
                  {/*
                    ⚠️ Two blocks, not two spans. These are two different voices — the first is
                    the sentence a colleague typed, the second is this screen instructing the
                    reviewer — and as adjacent inline spans they rendered with no separator at
                    all: `…รายการเดินบัญชีวันที่ 15 ส.ค.ไม่มีภาพให้เทียบ — รับรองรายการนี้…`, one
                    run-on sentence in a box whose whole job is to be read carefully.

                    It got worse the more carefully a colleague wrote: a longer reason swallows
                    more of the instruction before the eye reaches it. Seen only by opening the
                    dialog — the strings are separate constants and every test that touches them
                    checks one at a time, so nothing here was ever wrong to a test.
                  */}
                  <AlertDescription className="flex flex-col gap-1.5">
                    <span className="text-foreground">
                      <span className="text-muted-foreground">เหตุผลที่บันทึกไว้: </span>
                      {review.slip.noSlipReasonTh}
                    </span>
                    <span>
                      ไม่มีภาพให้เทียบ — รับรองรายการนี้ก็ต่อเมื่อยืนยันได้จากทางอื่น เช่น รายการเดินบัญชีของธนาคาร
                    </span>
                  </AlertDescription>
                </Alert>
              ) : !review.slip.hasImage ? (
                <p className="text-muted-foreground type-body">
                  ไม่มีภาพแนบมา
                  {review.slip.imageErasedAt === null
                    ? ''
                    : ` — ถูกลบตามคำขอ PDPA เมื่อ ${at(review.slip.imageErasedAt)}`}
                </p>
              ) : imageUrl === null ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  onClick={() => {
                    void (async () => {
                      try {
                        setImageUrl(await mintImageUrl(review.slip.id));
                      } catch (error) {
                        toast.error(failureMessage(error));
                      }
                    })();
                  }}
                >
                  <ExternalLink /> เปิดภาพ
                </Button>
              ) : (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={apiUrl(imageUrl)}
                  alt="ภาพสลิปโอนเงิน"
                  className="border-border max-h-96 w-fit rounded-lg border object-contain"
                />
              )}
            </div>

            {/* ── ⓷ Who paid ──────────────────────────────────────────────── */}
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <p className="type-body font-medium">ผู้โอน — อ่านจากภาพ</p>
                {!review.slip.payerVerified && review.slip.payerName !== null && (
                  <p className="text-muted-foreground type-caption inline-flex items-center gap-1.5">
                    <ShieldAlert className="size-3.5" />
                    ค่านี้ลูกค้าเป็นคนกรอกเอง ยังไม่มีใครเทียบกับภาพ — แก้ให้ตรงกับสลิปก่อนอนุมัติ
                  </p>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="payer-name">ชื่อบัญชีผู้โอน</Label>
                  <Input
                    id="payer-name"
                    value={payerName}
                    maxLength={200}
                    onChange={(event) => setPayerName(event.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="payer-last4">เลขท้ายบัญชี</Label>
                  <Input
                    id="payer-last4"
                    value={payerLast4}
                    inputMode="numeric"
                    maxLength={4}
                    placeholder="4 หลัก"
                    onChange={(event) => setPayerLast4(event.target.value.replace(/\D/gu, ''))}
                  />
                </div>
              </div>

              <p className="text-muted-foreground type-caption">
                เว้นว่างได้ — ระบบจะถือว่ายังไม่ยืนยันผู้โอน และตอนคืนเงินจะไม่นับว่าเป็นบัญชีเดิม
              </p>
            </div>

            {/* ── ⓸ Where it goes ─────────────────────────────────────────── */}
            <div className="flex flex-col gap-3">
              <p className="type-body font-medium">ตัดเข้างวดไหน</p>

              {review.unallocatableReasonTh !== null && (
                <Alert>
                  <AlertTriangle />
                  <AlertDescription>{review.unallocatableReasonTh}</AlertDescription>
                </Alert>
              )}

              <div className="flex flex-col gap-2">
                {review.instalments.map((instalment) => (
                  <div
                    key={instalment.id}
                    className="grid grid-cols-[3rem_1fr_9rem] items-center gap-3"
                  >
                    <span className="text-muted-foreground type-caption font-mono">
                      งวด {instalment.seq}
                    </span>
                    <span className="type-body">
                      ค้าง {formatBaht(instalment.remainingThbMinor)}
                      <span className="text-muted-foreground">
                        {' '}
                        จาก {formatBaht(instalment.dueThbMinor)}
                      </span>
                      {instalment.gatesEntryTo !== null && (
                        <span className="text-muted-foreground type-caption ml-2">
                          · เปิดทางไป {instalment.gatesEntryTo}
                        </span>
                      )}
                    </span>
                    <Input
                      value={amounts[instalment.id] ?? ''}
                      inputMode="decimal"
                      placeholder="0.00"
                      disabled={instalment.isSettled}
                      className="text-right tabular-nums"
                      onChange={(event) =>
                        setAmounts((current) => ({ ...current, [instalment.id]: event.target.value }))
                      }
                    />
                  </div>
                ))}
              </div>

              {/*
               * A running total belongs on a rule, not in a box. The dashed rectangle around it
               * was the third bordered thing in this dialog; `border-t` is the shape a total has
               * had on a piece of paper for four hundred years and says the same thing with one
               * edge instead of four.
               */}
              <div className="border-border type-body flex items-center justify-between border-t pt-3">
                <span>ตัดไปแล้ว</span>
                <span className="font-medium tabular-nums">
                  {formatBaht(plan.allocated)} / {formatBaht(review.slip.amountThbMinor)}
                </span>
              </div>

              {typo && <p className="text-destructive type-caption">มีช่องที่กรอกเป็นตัวเลขไม่ได้</p>}

              {plan.state === 'short' && !typo && (
                <p className="text-destructive type-caption">
                  ยังเหลือ {formatBaht(-plan.differenceThbMinor)} ที่ยังไม่ได้ตัดเข้างวดใด —
                  ถ้าอนุมัติแบบนี้ เงินก้อนนั้นจะค้างอยู่โดยไม่มีงวดไหนรู้จัก
                </p>
              )}

              {plan.state === 'over' && plan.acknowledgement !== null && (
                <Alert>
                  <AlertTitle>โอนเกินมา {formatBaht(plan.acknowledgement)}</AlertTitle>
                  <AlertDescription>
                    ออเดอร์นี้รับได้แค่ {formatBaht(review.money.outstandingThbMinor)} —
                    ส่วนเกินจะถูกรับไว้เป็นเงินรับล่วงหน้าที่ยังไม่ตัดงวดใด และบันทึกยอดไว้ตรงตัว
                  </AlertDescription>
                </Alert>
              )}
            </div>

            {/*
             * ⭐ THE SECOND REASON THAT MUST BE UNMISSABLE — 🔒 the declared bypass.
             *
             * `blocked` is the ordinary answer and the one that keeps the two-person rule: this
             * person entered the slip, holds no `payments.self_review_slip`, and the buttons below
             * are disabled with the remedy named — *ต้องให้อีกคนรับรอง* — instead of a 403 after
             * they have typed a whole allocation plan.
             *
             * `must_declare` is the owner's chosen exception. The box is required, the permanence
             * is stated under it, and both the API and `payment_slips_guard_write()` refuse the
             * write without it — so this is the screen catching up with the rule, never granting
             * it.
             */}
            {selfReview.kind !== 'not_mine' && (
              <Alert variant={reviewBlocked ? 'destructive' : 'default'}>
                <ShieldAlert />
                <AlertTitle>คุณเป็นผู้บันทึกรายการนี้เอง</AlertTitle>
                <AlertDescription>{selfReview.messageTh}</AlertDescription>
              </Alert>
            )}

            {selfReview.kind === 'must_declare' && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="self-review">เหตุผลที่รับรองรายการของตัวเอง</Label>
                <Textarea
                  id="self-review"
                  rows={2}
                  maxLength={2000}
                  value={selfReviewReasonTh}
                  placeholder="เช่น วันหยุดมีพนักงานคนเดียว ลูกค้าต้องการใบเสร็จวันนี้"
                  onChange={(event) => setSelfReviewReasonTh(event.target.value)}
                />
                <span
                  className={
                    declarationMissing
                      ? 'text-destructive type-caption'
                      : 'text-muted-foreground type-caption'
                  }
                >
                  จำเป็นต้องกรอก อย่างน้อย {MIN_REASON_LENGTH} ตัวอักษร —
                  เหตุผลนี้จะถูกเก็บไว้ถาวรและปรากฏในรายการตรวจสอบย้อนหลัง
                </span>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="note">บันทึกของผู้ตรวจ (ไม่บังคับ)</Label>
              <Textarea
                id="note"
                rows={2}
                maxLength={2000}
                value={noteTh}
                onChange={(event) => setNoteTh(event.target.value)}
              />
            </div>

            {rejecting && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="reason">เหตุผลที่ปฏิเสธ</Label>
                <Textarea
                  id="reason"
                  rows={2}
                  maxLength={2000}
                  value={reasonTh}
                  onChange={(event) => setReasonTh(event.target.value)}
                />
                <span className="text-muted-foreground type-caption">
                  ลูกค้าจะเห็นข้อความนี้ — บอกให้ชัดว่าต้องทำอะไรต่อ
                </span>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="destructive"
            disabled={
              busy ||
              review === null ||
              reviewBlocked ||
              declarationMissing ||
              (rejecting && reasonTh.trim().length < 3)
            }
            onClick={() => {
              if (!rejecting) {
                setRejecting(true);
                return;
              }
              setBusy(true);
              void (async () => {
                try {
                  /*
                   * The rule covers rejection too: a person who could refuse their own entry could
                   * clear their own mistake off the queue before anybody saw it, which is the same
                   * control failing in the quieter direction.
                   */
                  await rejectSlip(
                    slipId,
                    reasonTh,
                    selfReview.kind === 'must_declare' ? selfReviewReasonTh.trim() : undefined,
                  );
                  toast.success('ปฏิเสธสลิปแล้ว');
                  onDone();
                } catch (error) {
                  toast.error(failureMessage(error));
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            {rejecting ? 'ยืนยันการปฏิเสธ' : 'ปฏิเสธสลิป'}
          </Button>

          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              ปิด
            </Button>
            <Button
              disabled={
                busy ||
                plan === null ||
                typo ||
                rejecting ||
                plan.state === 'short' ||
                reviewBlocked ||
                declarationMissing
              }
              onClick={() => {
                if (plan === null) return;
                setBusy(true);

                const last4 = payerLast4.trim();
                const name = payerName.trim();

                void (async () => {
                  try {
                    await acceptSlip(slipId, {
                      allocations: plan.sendable,
                      ...(noteTh.trim() === '' ? {} : { noteTh: noteTh.trim() }),
                      /*
                       * Both or neither. The schema is a `strictObject` requiring name *and*
                       * four digits, so a half-filled attestation is a 422 — and, more to the
                       * point, half an attestation is not one.
                       */
                      ...(name !== '' && /^\d{4}$/u.test(last4)
                        ? { payer: { name, accountLast4: last4 } }
                        : {}),
                      ...(plan.acknowledgement === null
                        ? {}
                        : {
                            acknowledgeOverpaymentThbMinor: {
                              unit: 'THB.satang' as const,
                              digits: plan.acknowledgement.toString(),
                            },
                          }),
                      /*
                       * 🔒 Sent only when this really is a self-review. The API drops a reason
                       * supplied against somebody else's slip rather than writing it, because a
                       * self-review marker on a slip two people handled correctly is the audit
                       * lying in the direction nobody would think to check — but not sending it
                       * at all is one fewer thing depending on that.
                       */
                      ...(selfReview.kind === 'must_declare'
                        ? { selfReviewReasonTh: selfReviewReasonTh.trim() }
                        : {}),
                    });
                    toast.success('รับสลิปแล้ว — เงินถูกตัดเข้างวดเรียบร้อย');
                    onDone();
                  } catch (error) {
                    toast.error(failureMessage(error));
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              รับสลิป
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
