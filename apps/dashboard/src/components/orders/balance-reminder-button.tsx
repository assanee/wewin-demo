'use client';

import { useState } from 'react';
import { BellRing } from 'lucide-react';
import { toast } from 'sonner';

import { formatBaht } from '@wewin/core/format';

import { Button } from '@/components/ui/button';
import { useSession } from '@/lib/auth/session';
import { failureMessage } from '@/lib/api/errors';
import { sendBalanceReminder } from './order-api';
import { reminderAvailability, reminderOutcome, type SpineEvent } from './balance-reminder';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ แจ้งเตือนยอดค้างชำระ — beside ค้างชำระ, where the figure it is about already is.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The one thing five rounds of payment work never did: ask the customer. `record-payment-dialog.tsx`
 * and `write-off-dialog.tsx` both argue why a control about a balance belongs on the money card
 * rather than on a screen of its own, and the argument is the same here — the person deciding
 * whether to chase ฿5,529.60 is reading ยอดรวม, มัดจำตามสัญญา and ค้างชำระ to decide it.
 *
 * ── ⚠️ NO DIALOG, and that is a decision ─────────────────────────────────────
 *
 * The two buttons above this one open a form, because they take an amount and a reason that only
 * a person can supply. This one takes **nothing**: the amount is `order_outstanding_thb_minor()`,
 * the recipient is the order's contact, the language is the recipient's and the wording is
 * `notification_rules`'. A dialog would be a form with no fields — a confirmation step whose only
 * content is a sentence the button label already says.
 *
 * What replaces it is that the button **states the figure it is about to quote** and the toast
 * afterwards states what actually happened, which is the pair of facts a confirmation dialog
 * would have carried anyway.
 *
 * ── ⚠️ EVERY DECISION IS IN `balance-reminder.ts` ────────────────────────────
 *
 * `apps/dashboard`'s vitest is `environment: 'node'`, so a `.test.tsx` is **silently never
 * collected**. Whether the button appears, what the cooldown sentence says and how a suppressed
 * fan-out reads are all in the `.ts` beside this, where `balance-reminder.test.ts` can reach
 * them. What is here is layout and the fetch.
 */
export function BalanceReminderButton({
  orderId,
  outstandingThbMinor,
  events,
  onReminded,
}: {
  readonly orderId: string;
  /** ค้างชำระ, straight off the order — Postgres's fold, never arithmetic done here. */
  readonly outstandingThbMinor: bigint | null;
  /** The spine this page already loaded. The cooldown is read from it — there is no column. */
  readonly events: readonly SpineEvent[];
  readonly onReminded: () => void;
}) {
  const { can } = useSession();
  const [busy, setBusy] = useState(false);

  /*
   * ⚠️ The three codes the route declares. `orders.read` is not redundant beside `orders.write`:
   * `order-reach.ts` widens a staff caller to every order only when they hold both, so a holder
   * of `orders.write` alone gets 404 rather than 403 — a failure that reads like a missing order.
   *
   * Hiding the button is not authorisation (`lib/auth/permissions.ts` says so in as many words);
   * the API demands all three whatever this renders.
   */
  if (!can('orders.read', 'orders.write', 'payments.read')) return null;

  const availability = reminderAvailability({ outstandingThbMinor, events, now: new Date() });

  /*
   * ⚠️ Nothing at all when nothing is owed — not a disabled button. A greyed control under a
   * ฿0.00 balance invites somebody to work out what is wrong with an order that has nothing wrong
   * with it. Same call `writeOffAvailability` makes.
   */
  if (availability.kind === 'nothingOwed') return null;

  if (availability.kind === 'remindedRecently') {
    /*
     * ⚠️ This state *does* speak, unlike the one above. A missing button with no explanation
     * reads as a permission problem; that the customer was chased this morning is a fact the
     * person looking at this screen needs whether or not they were going to press anything.
     */
    return (
      <p className="text-muted-foreground type-caption">
        แจ้งเตือนยอดค้างชำระไปแล้วเมื่อ {at(availability.lastAt)} — แจ้งซ้ำได้อีกครั้งหลัง{' '}
        {at(availability.nextAllowedAt)}
      </p>
    );
  }

  const send = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await sendBalanceReminder(orderId);
      const outcome = reminderOutcome(result);

      /*
       * ⚠️ `toast.warning` and not `toast.success` when nothing was queued. A green tick over a
       * message the outbox had nowhere to send is the exact belief this whole response shape
       * exists to prevent.
       */
      const show = outcome.delivered ? toast.success : toast.warning;
      show(outcome.titleTh, outcome.detailTh === null ? undefined : { description: outcome.detailTh });

      /* Reload either way: the spine gained a row, and the rail is where it has to appear. */
      onReminded();
    } catch (error) {
      /* The server's sentence — it knows things this screen cannot, starting with the balance. */
      toast.error(failureMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      className="w-fit"
      disabled={busy}
      onClick={() => void send()}
    >
      <BellRing data-icon="inline-start" />
      {/* The figure it is about to quote, so the press is informed without a dialog to confirm it. */}
      แจ้งเตือนยอดค้างชำระ {formatBaht(availability.outstandingThbMinor)}
    </Button>
  );
}

/** The same rendering every timestamp on the order screen gets. */
const at = (date: Date): string =>
  date.toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
