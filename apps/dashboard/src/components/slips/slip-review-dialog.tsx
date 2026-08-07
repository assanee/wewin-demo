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
import { allocationPlan, readSatang, satangField } from './allocation-plan';
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
  const [busy, setBusy] = useState(false);

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
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="border-border rounded-lg border p-4">
                <p className="text-muted-foreground text-xs">ลูกค้าโอนมา</p>
                <p className="text-2xl font-semibold tabular-nums">
                  {formatBaht(review.slip.amountThbMinor)}
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  แจ้งว่าโอนเมื่อ {at(review.slip.transferredAt)}
                  {review.slip.bankReference === null ? '' : ` · อ้างอิง ${review.slip.bankReference}`}
                </p>
              </div>

              <div className="border-border rounded-lg border p-4">
                <p className="text-muted-foreground text-xs">งวดถัดไปต้องการ</p>
                <p className="text-2xl font-semibold tabular-nums">
                  {review.comparison.expectedNextDueThbMinor === null
                    ? '—'
                    : formatBaht(review.comparison.expectedNextDueThbMinor)}
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
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
            <dl className="text-muted-foreground grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
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
              <p className="text-sm font-medium">ภาพสลิป</p>
              {!review.slip.hasImage ? (
                <p className="text-muted-foreground text-sm">
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
                <p className="text-sm font-medium">ผู้โอน — อ่านจากภาพ</p>
                {!review.slip.payerVerified && review.slip.payerName !== null && (
                  <p className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
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

              <p className="text-muted-foreground text-xs">
                เว้นว่างได้ — ระบบจะถือว่ายังไม่ยืนยันผู้โอน และตอนคืนเงินจะไม่นับว่าเป็นบัญชีเดิม
              </p>
            </div>

            {/* ── ⓸ Where it goes ─────────────────────────────────────────── */}
            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium">ตัดเข้างวดไหน</p>

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
                    <span className="text-muted-foreground font-mono text-xs">
                      งวด {instalment.seq}
                    </span>
                    <span className="text-sm">
                      ค้าง {formatBaht(instalment.remainingThbMinor)}
                      <span className="text-muted-foreground">
                        {' '}
                        จาก {formatBaht(instalment.dueThbMinor)}
                      </span>
                      {instalment.gatesEntryTo !== null && (
                        <span className="text-muted-foreground ml-2 text-xs">
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

              <div className="border-border flex items-center justify-between rounded-lg border border-dashed px-4 py-3 text-sm">
                <span>ตัดไปแล้ว</span>
                <span className="tabular-nums">
                  {formatBaht(plan.allocated)} / {formatBaht(review.slip.amountThbMinor)}
                </span>
              </div>

              {typo && <p className="text-destructive text-xs">มีช่องที่กรอกเป็นตัวเลขไม่ได้</p>}

              {plan.state === 'short' && !typo && (
                <p className="text-destructive text-xs">
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
                <span className="text-muted-foreground text-xs">
                  ลูกค้าจะเห็นข้อความนี้ — บอกให้ชัดว่าต้องทำอะไรต่อ
                </span>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="destructive"
            disabled={busy || review === null || (rejecting && reasonTh.trim().length < 3)}
            onClick={() => {
              if (!rejecting) {
                setRejecting(true);
                return;
              }
              setBusy(true);
              void (async () => {
                try {
                  await rejectSlip(slipId, reasonTh);
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
                busy || plan === null || typo || rejecting || plan.state === 'short'
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
