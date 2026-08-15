'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { AlertTriangle, Clock, Eye, EyeOff, ImageOff, Star } from 'lucide-react';
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
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { apiUrl } from '@/lib/api/config';
import { failureMessage } from '@/lib/api/errors';
import { HIDDEN_REASONS, hideBody, hideIsReady, reasonLabel, type HiddenReason } from './hide-reason';
import { URGENT_HOURS, hoursLeft, reviewFocus } from './review-focus';
import {
  hideReview,
  listQueue,
  publishReview,
  replyToReview,
  unhideReview,
  type QueueItem,
} from './review-api';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Reviews inside their moderation window.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ **Doing nothing is a decision here, and it is the default one.** A review goes public
 * when its window elapses — `publishesAt` — so this queue is not a list of things waiting
 * for approval, it is a list of things about to happen. `hoursRemaining` is therefore the
 * first thing on every card, and the list is ordered by it.
 *
 * ── The three moves ──────────────────────────────────────────────────────────
 *
 *   **เผยแพร่เลย**  stop the clock: I have read it and it is fine. Not "make it visible" —
 *                  it was going to be visible anyway — but "the window no longer matters".
 *   **ซ่อน**        ⭐ costs a reason, and `other` costs a sentence. The moderator's *name*
 *                  is taken from the session and never sent: plan 9.3, because a moderator
 *                  naming somebody else is the failure that requirement exists to stop.
 *   **ตอบกลับ**     one reply per review, so it is a create and never an edit.
 *
 * Hiding does not delete. `hidden_at` is a column and the stats view does not filter on it,
 * which is what makes "hiding is not editing the score" true rather than merely claimed.
 *
 * ── ⭐ The clock leads, and it did not used to ────────────────────────────────
 *
 * The paragraph above has claimed since it was written that `hoursRemaining` is *"the first thing
 * on every card"*. It was not. It rendered as a `text-xs` span pushed into the **top-right
 * corner**, lighter and smaller than the product name on the left, on a screen whose loudest
 * elements were N identical `Card` borders — one per review, from a single `<Card>` literal
 * inside `.map()`, each with two more bordered photo tiles inside it. The file's stated intent
 * was not true of its output, which is the sort of thing only counting catches.
 *
 * So: **the countdown is now the first column of every row**, at `text-xl` where the borders used
 * to be, and the cards are a `divide-y` list — one hairline between items instead of four edges
 * around each. `reviewFocus` states the thing the list is evidence for at `type-focal` above it.
 *
 * ⚠️ **Urgency is carried by weight and position, not by colour.** The clock used to turn
 * `text-destructive` under twelve hours. The list is sorted soonest-first, so the most urgent
 * review is already the top row; red was a third statement of a fact the order and the number
 * both already made, and this pass takes hierarchy out of colour everywhere it can. What is left
 * is `font-semibold` on the urgent ones and `text-muted-foreground` on the rest — the same
 * styled-*down* idiom `overview-screen.tsx`'s `QueueRow` uses for an idle queue.
 */

const at = (iso: string): string =>
  new Date(iso).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly items: readonly QueueItem[]; readonly total: number }
  | { readonly status: 'failed'; readonly problem: string };

export function ReviewQueue() {
  /*
   * ⭐ `tab` added when เลิกซ่อน got a screen.
   *
   * `POST :id/unhide` and `unhideReview` both existed with no caller, and the reason was not
   * a forgotten button: the queue is `not review_is_moderated(...)`, which is false the
   * moment `hidden_at` is set, so hiding a review removed it from the only list there was.
   * A moderator who hid the wrong one had no way back through any screen, and
   * `app/api/revalidate/route.ts` claimed in a comment that this screen already called
   * unhide — which nothing ever had.
   */
  const [tab, setTab] = useState<'pending' | 'hidden'>('pending');
  const [state, setState] = useState<State>({ status: 'loading' });
  const [hiding, setHiding] = useState<QueueItem | null>(null);
  const [replying, setReplying] = useState<QueueItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function reload(which: 'pending' | 'hidden' = tab): Promise<void> {
    try {
      const queue = await listQueue(which);
      setState({ status: 'ready', items: queue.items, total: queue.total });
    } catch (error) {
      setState({ status: 'failed', problem: failureMessage(error) });
    }
  }

  useEffect(() => {
    void reload(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `reload` closes over `tab` already
  }, [tab]);

  if (state.status === 'loading') return <Skeleton className="h-64 w-full" />;

  if (state.status === 'failed') {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>โหลดคิวรีวิวไม่สำเร็จ</AlertTitle>
        <AlertDescription>{state.problem}</AlertDescription>
      </Alert>
    );
  }

  const focus = reviewFocus(state.items);

  /*
   * Soonest first: the clock is the only ordering that matters on this screen.
   *
   * ⚠️ The spread is load-bearing here, unlike the one `overview-focus.ts` deleted — `sort`
   * mutates, and `state.items` is the array held in React state. Sorting it in place would
   * reorder the rendered list behind React's back.
   */
  const ordered = [...state.items].sort((a, b) => a.hoursRemaining - b.hoursRemaining);

  return (
    <div className="flex flex-col gap-6">
      {/*
       * ⭐ THE PRIMARY THING. On the page ground, no border, type doing the work.
       *
       * Rendered when the queue is empty too — "ไม่มีรีวิวที่กำลังจะเผยแพร่เอง" is the answer to
       * the question this screen exists to answer, and it used to be a centred line inside a Card.
       */}
      <section className="flex flex-col gap-1">
        <p className="type-focal text-balance">{focus.headlineTh}</p>
        {focus.detailTh === null ? null : (
          <p className="text-muted-foreground type-body">{focus.detailTh}</p>
        )}
        {state.total > state.items.length && (
          <p className="text-muted-foreground type-caption">
            แสดง {state.items.length} จาก {state.total} รายการ
          </p>
        )}
      </section>

      {/*
        Two buttons rather than a Tabs component: there are exactly two states a moderator can
        act on, and the third — published — is deliberately absent because a public review
        cannot be brought back into a queue.
      */}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={tab === 'pending' ? 'default' : 'outline'}
          onClick={() => setTab('pending')}
        >
          รอตัดสิน
        </Button>
        <Button
          size="sm"
          variant={tab === 'hidden' ? 'default' : 'outline'}
          onClick={() => setTab('hidden')}
        >
          <EyeOff /> ที่ซ่อนไว้
        </Button>
      </div>

      {/*
       * One hairline between reviews, where there used to be a `Card` around each of them. Every
       * one of those borders said "this is a separate item" about a list that is visibly a list.
       */}
      <ul className="divide-border/60 flex flex-col divide-y">
        {ordered.map((item) => {
          const urgent = item.hoursRemaining <= URGENT_HOURS;

          return (
            <li key={item.id} className="flex flex-col gap-4 py-5 first:pt-0 last:pb-0 sm:flex-row">
              {/*
               * ⭐ THE CLOCK, FIRST — in the DOM and on the screen. Not a status chip: nothing
               * here is pending approval, it is pending *publication*, and this number is how
               * long somebody has to disagree. A fixed width gives every countdown the same left
               * edge, so a column of them can be compared without being read.
               */}
              <div className="flex shrink-0 flex-col sm:w-40">
                <span
                  className={`text-xl leading-tight tabular-nums ${
                    urgent ? 'font-semibold' : 'text-muted-foreground'
                  }`}
                >
                  อีก {hoursLeft(item.hoursRemaining)} ชม.
                </span>
                {/*
                 * The verb stays on the row, at caption size. "อีก 5 ชม." on its own is a
                 * countdown to nothing in particular; เผยแพร่เอง is what happens at zero, and it
                 * happens whether or not anybody is looking at this screen.
                 */}
                <span className="text-muted-foreground type-caption inline-flex items-center gap-1">
                  <Clock className="size-3" aria-hidden />
                  เผยแพร่เอง {at(item.publishesAt)}
                </span>
              </div>

              <div className="flex min-w-0 flex-1 flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex" aria-label={`${String(item.rating)} ดาว`}>
                      {[1, 2, 3, 4, 5].map((star) => (
                        <Star
                          key={star}
                          className={
                            star <= item.rating ? 'size-4 fill-current' : 'text-muted-foreground/30 size-4'
                          }
                        />
                      ))}
                    </span>
                    <span className="type-body font-medium">{item.productNameTh}</span>
                  </div>
                  <span className="text-muted-foreground type-caption">
                    {item.authorDisplayName ?? 'ไม่ระบุชื่อ'} ·{' '}
                    <Link
                      href={`/orders/${item.orderId}` as Route}
                      className="focus-visible:outline-ring rounded hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                    >
                      {item.orderNo ?? item.orderId.slice(0, 8)}
                    </Link>{' '}
                    · เขียนเมื่อ {at(item.createdAt)}
                  </span>
                </div>

                {item.bodyTh !== null && <p className="type-body whitespace-pre-wrap">{item.bodyTh}</p>}

                {item.photos.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {item.photos.map((photo, index) =>
                      photo.path === null ? (
                        /*
                         * The row survived and the bytes did not — an erasure or a retention
                         * sweep. Rendering the gap is plan 9.4(2): the record that a photo
                         * existed is itself the thing being kept.
                         *
                         * ⚠️ This one keeps its border while the photograph beside it lost one:
                         * here the dashed rectangle *is* the content — it is the shape of the
                         * thing that is missing. A border around a photograph is chrome around
                         * something that already has an edge.
                         */
                        <div
                          key={index}
                          className="border-border text-muted-foreground type-caption flex size-24 flex-col items-center justify-center gap-1 rounded border border-dashed"
                        >
                          <ImageOff className="size-4" />
                          ภาพถูกลบแล้ว
                        </div>
                      ) : (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          key={index}
                          src={apiUrl(photo.path)}
                          alt={photo.altTextTh ?? 'ภาพจากรีวิว'}
                          className="size-24 rounded object-cover"
                        />
                      ),
                    )}
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  {tab === 'hidden' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === item.id}
                      onClick={() => {
                        setBusyId(item.id);
                        void (async () => {
                          try {
                            await unhideReview(item.id);
                            toast.success('เลิกซ่อนแล้ว — กลับเข้าคิวรอตัดสินตามเดิม');
                            await reload();
                          } catch (error) {
                            toast.error(failureMessage(error));
                          } finally {
                            setBusyId(null);
                          }
                        })();
                      }}
                    >
                      <Eye /> เลิกซ่อน
                    </Button>
                  ) : null}
                  {/*
                    ⚠️ Not rendered rather than styled away. A `hidden` class leaves the button
                    in the tab order and reachable by keyboard, so "เผยแพร่เลย" on a review a
                    moderator has taken down would still be one Tab and one Enter away.
                  */}
                  {tab === 'pending' && (
                    <>
                      <Button
                        size="sm"
                        disabled={busyId === item.id}
                        onClick={() => {
                          setBusyId(item.id);
                          void (async () => {
                            try {
                              await publishReview(item.id);
                              toast.success('เผยแพร่แล้ว');
                              await reload();
                            } catch (error) {
                              toast.error(failureMessage(error));
                            } finally {
                              setBusyId(null);
                            }
                          })();
                        }}
                      >
                        เผยแพร่เลย
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busyId === item.id}
                        onClick={() => setHiding(item)}
                      >
                        <EyeOff /> ซ่อน
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === item.id}
                        onClick={() => setReplying(item)}
                      >
                        ตอบกลับ
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {hiding !== null && (
        <HideDialog
          item={hiding}
          onClose={() => setHiding(null)}
          onDone={() => {
            setHiding(null);
            void reload();
          }}
        />
      )}

      {replying !== null && (
        <ReplyDialog
          item={replying}
          onClose={() => setReplying(null)}
          onDone={() => {
            setReplying(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

/** ⭐ A reason always; a sentence when the reason is `other`. See `hide-reason.ts`. */
function HideDialog({
  item,
  onClose,
  onDone,
}: {
  readonly item: QueueItem;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const [reason, setReason] = useState<HiddenReason>('abusive');
  const [noteTh, setNoteTh] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>ซ่อนรีวิวนี้</DialogTitle>
          <DialogDescription>
            ชื่อของคุณจะถูกบันทึกไว้กับการซ่อน — และคะแนนของรีวิวยังนับในค่าเฉลี่ยเหมือนเดิม
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            {HIDDEN_REASONS.map((option) => (
              <Button
                key={option}
                size="sm"
                variant={reason === option ? 'default' : 'outline'}
                onClick={() => setReason(option)}
              >
                {reasonLabel(option)}
              </Button>
            ))}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="hide-note">
              {reason === 'other' ? 'เหตุผล (บังคับเมื่อเลือก “อื่นๆ”)' : 'บันทึกเพิ่มเติม (ไม่บังคับ)'}
            </Label>
            <Textarea
              id="hide-note"
              rows={3}
              maxLength={2000}
              value={noteTh}
              onChange={(event) => setNoteTh(event.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </Button>
          <Button
            variant="destructive"
            disabled={busy || !hideIsReady(reason, noteTh)}
            onClick={() => {
              setBusy(true);
              void (async () => {
                try {
                  await hideReview(item.id, hideBody(reason, noteTh));
                  toast.success('ซ่อนรีวิวแล้ว');
                  onDone();
                } catch (error) {
                  toast.error(failureMessage(error));
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            ซ่อน
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One reply per review — the API treats this as a create, so there is no edit path. */
function ReplyDialog({
  item,
  onClose,
  onDone,
}: {
  readonly item: QueueItem;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const [bodyTh, setBodyTh] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>ตอบกลับรีวิว</DialogTitle>
          <DialogDescription>ตอบได้ครั้งเดียวต่อรีวิว — แก้ไขทีหลังไม่ได้</DialogDescription>
        </DialogHeader>

        <Textarea
          rows={5}
          maxLength={2000}
          value={bodyTh}
          placeholder="ขอบคุณที่ให้ความเห็น…"
          onChange={(event) => setBodyTh(event.target.value)}
        />

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </Button>
          <Button
            disabled={busy || bodyTh.trim() === ''}
            onClick={() => {
              setBusy(true);
              void (async () => {
                try {
                  await replyToReview(item.id, bodyTh);
                  toast.success('ตอบกลับแล้ว');
                  onDone();
                } catch (error) {
                  toast.error(failureMessage(error));
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            ส่งคำตอบ
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
