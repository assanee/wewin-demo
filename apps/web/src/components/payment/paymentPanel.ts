import type { UiKey } from '../../i18n/keys';
import { describeOwedFigures, type OwedFigure } from '../../lib/payment/owedFigures';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ WHAT THE PAYMENT SCREEN SAYS, AND WHETHER IT ASKS FOR ANYTHING — decided here.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `PaymentIsland` had exactly one test standing between a customer and a bill:
 *
 *     const settled = data.outstandingThbMinor <= 0n;
 *
 * — which is false on a **cancelled** order carrying an unpaid balance, so the screen printed
 * "ยอดคงค้างทั้งหมด ฿10,354.18" in `text-lead text-lime` with the slip-upload form under it, on
 * an order the customer had cancelled and on which the company owed *them* the deposit they
 * had already paid. The links into the page were gated by status; the URL is stable and
 * bookmarkable, and a customer who had it open when staff cancelled saw the bill on refresh.
 * The upload itself was refused 409, so no money was ever taken — what was taken was the
 * customer's belief that they owed it.
 *
 * ── Why a module, and not three ternaries in the JSX ─────────────────────────
 *
 * `apps/web`'s vitest runs `environment: 'node'` and collects `*.test.ts` only, so a
 * `.test.tsx` here is silently never collected — a decision left in the markup is a decision
 * no test in this repo can reach. That is the same argument `quotationRowMoney.ts` and
 * `owedFigures.ts` were extracted on, and this is the third of the three: which figures, then
 * which sentence, then whether there is a form at all.
 *
 * ── ⚠️ `orderIsLive` is the SERVER's answer and is not re-derived here ───────
 *
 * It arrives on `PaymentInstructionsWire`, computed by `isLiveOrder()`
 * (`apps/api/src/orders/live-order.ts`) — the same predicate the order encoder and the staff
 * money card read. So this screen and the API cannot disagree about whether there is a debt,
 * which a client-side copy of the status list could not have promised. `lib/payment/payable.ts`
 * still holds such a copy, and its header says what it is: a list-only mirror for the two
 * *link* sites, which render from `GET /orders` rows and have no instructions wire to read.
 *
 * ── ⚠️ THERE WAS A SECOND BOOLEAN AND A THIRD BRANCH. BOTH HAVE GONE ─────────
 *
 * `acceptsPayment` used to arrive beside `orderIsLive`, and the middle branch below existed
 * for the one status where they disagreed: `delivered` was a live debt that could take no
 * further slip, so this screen stated the amount and withheld the form — the customer read
 * what they owed on the last screen that would ever mention it, with no way to pay it. That is
 * the owner's *"ถ้าส่งมอบไปก่อนเก็บครบ จะเก็บผ่านระบบไม่ได้อีก"*, and `0046_slips_after_delivery.sql`
 * closed it. The two booleans then answered identically on every status, so the wire carries
 * one, and a delivered order with a balance now takes the ordinary paying path: figures, and a
 * form that works.
 */

/** Everything the screen needs to decide, so the component decides nothing. */
export interface PanelInput {
  /**
   * `PaymentInstructionsWire.orderIsLive` — is this still a commitment somebody owes on?
   *
   * Only `false` for cancelled and superseded, which are the two the first branch withholds
   * every figure from.
   */
  readonly orderIsLive: boolean;
  readonly outstandingMinor: bigint;
  readonly nextDueMinor: bigint;
  /**
   * ⭐ How much of this balance the company **forgave** — `order_written_off_thb_minor()`.
   *
   * The only reason this screen needs it: it is what tells ฿0.00 owed *because the customer paid*
   * apart from ฿0.00 owed *because the company gave up*. See the third branch below.
   */
  readonly writtenOffMinor: bigint;
  /** How many accounts the organisation is offering. Zero is a real state — see below. */
  readonly accountCount: number;
}

export interface PaymentPanel {
  /**
   * The owed figures, in reading order — empty when the screen must state none.
   *
   * ⚠️ Empty is not the same as ฿0.00 and is the whole point on a dead order. A figure with a
   * "ยอดคงค้าง" label is a demand whatever its value, and the residue on a cancelled order is a
   * refund question — money the company may owe the customer. That is not something this
   * screen can act on, and printing it is how the screen came to bill a cancelled order.
   */
  readonly figures: readonly OwedFigure[];
  /** One sentence in place of a demand, or `null` when the form itself is the answer. */
  readonly noteKey: Extract<
    UiKey,
    'payment.closed' | 'payment.settled' | 'payment.writtenOff' | 'payment.account.none'
  > | null;
  /** Whether the account picker and the slip form are rendered at all. */
  readonly showsForm: boolean;
}

/**
 * What to render, from the wire and nothing else.
 *
 * ── ⚠️ DEAD BEFORE SETTLED, AND THE ORDER OF THE TWO IS THE DECISION ─────────
 *
 * A first attempt tested only "can this be paid?" and collapsed everything it answered `false`
 * for into one "payment is closed" sentence. Measured against the live database, that turned
 * out to cover three states that need different sentences:
 *
 *   cancelled / superseded             outstanding ฿10,354.18, and the company owes it BACK
 *   delivered, fully paid              outstanding ฿0 — the ordinary happy ending
 *   delivered, still owing             outstanding ฿10,354.18, and the customer owes it
 *
 * The third row is the one this round changed. It used to be stated and withheld — the amount
 * printed with no form under it, because the upload would have been refused 409 — which was
 * the last screen that money was ever mentioned on to the person who owed it, and no way to
 * pay it there. `0046_slips_after_delivery.sql` opened `delivered` to slips, so that row is now
 * an ordinary owing order and takes the ordinary owing path.
 *
 * That leaves two questions and the order between them is the decision:
 *
 *   ⓵ **not live** — nothing about the money. A cancelled order's residue is a refund, and a
 *     "ยอดคงค้าง" label is a demand whatever the number beside it. Deliberately first: an order
 *     paid in full and *then* cancelled satisfies the settled test too, and "ชำระครบแล้ว" on an
 *     order whose deposit the company is about to refund is the cruellest sentence available.
 *   ⓶ **live** — state the figures, and offer the form to whoever still owes something. The
 *     two sub-cases under it are about the money and not about the status: nothing owed says
 *     so, and an organisation with no bank accounts has nowhere to send it.
 *
 * `payment.settled` therefore serves two states, and correctly: a delivered order paid in full,
 * and an `in_production` job whose balance has been accepted. Both are true statements about a
 * live order on which nothing more is owed, which is exactly what the sentence says.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ ⓸ AND A THIRD STATE THAT `payment.settled` USED TO SWALLOW: THE WRITTEN-OFF ORDER.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Since `0048_write_off_approval.sql` an approved ขออนุมัติตัดยอดค้างทิ้ง makes the outstanding
 * fall — that is the feature — so a forgiven remainder reaches `outstandingMinor <= 0n` and, until
 * this branch existed, printed **"ออเดอร์นี้ชำระครบแล้ว"**.
 *
 * ⚠️ **That is a falsehood told to the one person who knows it is false.** They did not pay in
 * full. The company forgave the rest — after they refused to pay, or after a settlement at half,
 * or because the remainder was not worth chasing — and the screen would be telling them their
 * account is square. Three things follow from that and none of them is acceptable: a customer who
 * believes they are square disputes the company's own ledger months later *with the company's own
 * screen as evidence*; a customer who settled at half is told the discount they negotiated was
 * never needed; and a debt the company may still choose to pursue has been publicly cancelled by a
 * sentence nobody chose to say.
 *
 * ── ⚠️ THIS IS A DECISION THE OWNER MAY OVERRULE, AND IT IS WHAT WAS CHOSEN ───
 *
 * The screen states that the balance was **written off**, names the figure, and offers no form:
 *
 *     payment.writtenOff   "ยอดคงค้างส่วนที่เหลือได้รับการอนุมัติให้ตัดยอดแล้ว — ไม่มีสิ่งที่ต้องชำระเพิ่ม"
 *
 * Three properties, each chosen against a rejected alternative:
 *
 *   **it does not say paid.** No form of ชำระครบ / *settled* / *complete* appears in any of the
 *   eight catalogues for this key — `i18n/keys.ts` says so on the key itself, next to the same
 *   warning `payment.closed` already carries.
 *
 *   **it does not say why.** `reason_th` is staff-facing — *"ลูกค้าไม่ยอมจ่าย"* is a note written by
 *   one employee about a customer, and putting it on the customer's own screen is a disclosure
 *   nobody approved. The *fact* is the customer's business; the *reason* is not.
 *
 *   **it asks for nothing, and states no owed figure.** `figures` is empty here for the same
 *   reason it is empty on a cancelled order: a "ยอดคงค้าง" label is a demand whatever number is
 *   beside it, and the number is ฿0.00. The forgiven amount travels in `writtenOffMinor` for the
 *   *sentence* to name; it is not an owed figure and is not rendered as one.
 *
 * ── Position, and why it is third rather than first ──────────────────────────
 *
 * After `orderIsLive`, before `outstanding <= 0`. Cancelling still wins — an order written off and
 * *then* cancelled is a refund question, and `payment.closed` is right about it — and this must
 * come before the settled test, because a written-off order satisfies that test too and whichever
 * of the two runs first is the sentence the customer reads.
 *
 * ⚠️ `writtenOffMinor > 0n` **and** `outstandingMinor <= 0n`, not the first alone. A *partial*
 * write-off leaves a real balance — the settlement-at-half case, which is the common one — and that
 * customer still owes money and still needs the form. Branching on the write-off alone would take
 * the payment form away from somebody who is about to pay.
 */
export function describePaymentPanel(input: PanelInput): PaymentPanel {
  const { orderIsLive, outstandingMinor, nextDueMinor, writtenOffMinor, accountCount } = input;

  /* ⓵ Cancelled or superseded. No figures at any value — see `PaymentPanel.figures`. */
  if (!orderIsLive) {
    return { figures: [], noteKey: 'payment.closed', showsForm: false };
  }

  /* The figures are the shared module's choice, not this one's — `owedFigures.ts` orders them
   * and `MyQuotations` asks it the same question one click earlier. */
  const figures = describeOwedFigures(outstandingMinor, nextDueMinor);

  /*
   * ⭐ ⓸ Nothing owed *because it was forgiven*. Before the settled test — see the header.
   *
   * `figures: []` and not `figures`: there is no owed figure to state, and a ยอดคงค้าง label is a
   * demand whatever number sits beside it.
   */
  if (outstandingMinor <= 0n && writtenOffMinor > 0n) {
    return { figures: [], noteKey: 'payment.writtenOff', showsForm: false };
  }

  /* Nothing owed. `<=`, because an overpayment is a modelled state and not an error. */
  if (outstandingMinor <= 0n) {
    return { figures, noteKey: 'payment.settled', showsForm: false };
  }

  /*
   * ⚠️ No accounts, no picker, no form. `0027_organisation.sql` seeds no bank accounts at all,
   * so a fresh database reaches this on every order. The form is not rendered *disabled* — there
   * is nowhere for the money to go, so the control that would send it is unreachable.
   */
  if (accountCount === 0) {
    return { figures, noteKey: 'payment.account.none', showsForm: false };
  }

  return { figures, noteKey: null, showsForm: true };
}
