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
 * ── ⚠️ `acceptsPayment` is the SERVER's answer and is not re-derived here ────
 *
 * It arrives on `PaymentInstructionsWire`, computed from `SLIP_ATTACHABLE_STATUSES`
 * (`apps/api/src/payments/slips/attachable.ts`) — the very list that raises the 409 and
 * mirrors the `payment_slips_live_orders_only` trigger. So this screen and the endpoint that
 * would refuse the upload cannot disagree, which a fourth client-side copy of the status list
 * could not have promised. `lib/payment/payable.ts` still holds such a copy, and its header
 * now says what it is: a list-only mirror for the two *link* sites, which render from
 * `GET /orders` rows and have no instructions wire to read.
 */

/** Everything the screen needs to decide, so the component decides nothing. */
export interface PanelInput {
  /** `PaymentInstructionsWire.acceptsPayment` — can this order still receive a payment? */
  readonly acceptsPayment: boolean;
  /**
   * `PaymentInstructionsWire.orderIsLive` — is this still a live commitment?
   *
   * Only `false` for cancelled and superseded. `delivered` is live and does not accept payment,
   * and that single disagreement is what the third branch below is for.
   */
  readonly orderIsLive: boolean;
  readonly outstandingMinor: bigint;
  readonly nextDueMinor: bigint;
  /** How many accounts the organisation is offering. Zero is a real state — see below. */
  readonly accountCount: number;
}

export interface PaymentPanel {
  /**
   * The owed figures, in reading order — empty when the screen must state none.
   *
   * ⚠️ Empty is not the same as ฿0.00 and is the whole point on a closed order. A figure with
   * a "ยอดคงค้าง" label is a demand whatever its value; the residue on a cancelled order is a
   * refund question, and the residue on a delivered one is a phone call. Neither is something
   * this screen can act on, and printing it is how the screen came to bill a cancelled order.
   */
  readonly figures: readonly OwedFigure[];
  /** One sentence in place of a demand, or `null` when the form itself is the answer. */
  readonly noteKey: Extract<
    UiKey,
    'payment.closed' | 'payment.closedOwing' | 'payment.settled' | 'payment.account.none'
  > | null;
  /** Whether the account picker and the slip form are rendered at all. */
  readonly showsForm: boolean;
}

/**
 * What to render, from the wire and nothing else.
 *
 * ── ⚠️ DEAD BEFORE CLOSED BEFORE SETTLED, AND THE ORDER IS THE DECISION ──────
 *
 * A first attempt tested only `acceptsPayment` and collapsed everything it answered `false` for
 * into one "payment is closed" sentence. Measured against the live database, that turned out to
 * cover three states that need three different sentences:
 *
 *   cancelled / superseded             outstanding ฿10,354.18, and the company owes it BACK
 *   delivered, fully paid              outstanding ฿0 — the ordinary happy ending
 *   delivered, still owing             outstanding ฿10,354.18, and the customer owes it
 *
 * The first version told the finished customer their order was "closed to payment" instead of
 * "ชำระครบแล้ว", and told the owing one nothing at all — no figure, no amount, on the last
 * screen where that money is ever mentioned to the person who owes it (`delivered` has no
 * transition out and is absent from `SLIP_ATTACHABLE_STATUSES`). Silence there is not caution;
 * it is the company's receivable disappearing from the only place its debtor could see it.
 *
 * So the order of the tests below is the decision, and each branch earns its place:
 *
 *   ⓵ not live — nothing about the money. A cancelled order's residue is a refund, and a
 *     "ยอดคงค้าง" label is a demand whatever the number beside it. This is the branch the whole
 *     pair of booleans was added to protect, and it stays first.
 *   ⓶ live but closed to payment — `delivered`. State the money honestly and offer no form:
 *     paid in full says so, and a balance is named with the amount and a way to settle it.
 *   ⓷ open to payment — untouched from before, form and all.
 *
 * `payment.settled` therefore serves two states now, and correctly: a delivered order paid in
 * full, and an `in_production` job whose balance has been accepted. Both are true statements
 * about a live order on which nothing more is owed, which is exactly what the sentence says.
 */
export function describePaymentPanel(input: PanelInput): PaymentPanel {
  const { acceptsPayment, orderIsLive, outstandingMinor, nextDueMinor, accountCount } = input;

  /*
   * ⓵ Cancelled or superseded. No figures at any value — see `PaymentPanel.figures`.
   * Deliberately before the settled test: an order paid in full and *then* cancelled satisfies
   * both, and "ชำระครบแล้ว" on an order whose deposit the company is about to refund is the
   * cruelest sentence available.
   */
  if (!orderIsLive) {
    return { figures: [], noteKey: 'payment.closed', showsForm: false };
  }

  /*
   * ⓶ Live, and this screen can take no more slips — `delivered`, the only status where the two
   * booleans disagree. The figures are stated because the debt is real; the form is withheld
   * because the upload route would refuse it 409 anyway, and a form that cannot succeed is worse
   * than no form.
   */
  if (!acceptsPayment) {
    const figures = describeOwedFigures(outstandingMinor, nextDueMinor);
    return outstandingMinor <= 0n
      ? { figures, noteKey: 'payment.settled', showsForm: false }
      : { figures, noteKey: 'payment.closedOwing', showsForm: false };
  }

  /* The figures are the shared module's choice, not this one's — `owedFigures.ts` orders them
   * and `MyQuotations` asks it the same question one click earlier. */
  const figures = describeOwedFigures(outstandingMinor, nextDueMinor);

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
