'use client';

import { useEffect, useState, type ReactElement } from 'react';

import { acceptsPayment } from '../../lib/payment/payable';
import { localeHref } from '../../lib/routing';
import { reviewsApiBaseUrl } from '../../lib/reviews/api';
import type { Session } from '../../lib/auth/account';
import { useLocale } from '../../state/localeContext';
import { describeRowMoney, type Emphasis } from './quotationRowMoney';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE REASON FOR HAVING AN ACCOUNT AT ALL.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Requiring a sign-in before a quotation buys exactly one thing, and this is it: the customer
 * can come back — on a different device, months later, without the email — and find what they
 * were quoted.
 *
 * ⚠️ `GET /orders` is scoped by `ownershipFilter`, which is a term in the query rather than a
 * check on the result. This list therefore cannot show somebody else's order even if this
 * component asked for one; the worst a bug here can do is show too little.
 *
 * ── Money, read but not recomputed ───────────────────────────────────────────
 *
 * `grandTotalThbMinor` arrives as `{unit: 'THB.satang', digits}` — the opaque wire the API
 * uses everywhere. Read as `bigint` and formatted, never parsed as a number: a float in a
 * money path is a rounding decision hiding between the database and the page.
 *
 * ⭐ **Three money fields now, and all three are read rather than derived.**
 * `outstandingThbMinor` (everything still owed) and `nextDueThbMinor` (the remainder of the
 * first unsettled instalment) are folds computed by Postgres and shipped as columns of the
 * same `GET /orders` statement — fifty rows are still one query. Nothing here subtracts one
 * figure from another; `quotationRowMoney.ts` only chooses which of them a row prints.
 */

interface QuotationRow {
  readonly id: string;
  readonly orderNo: string | null;
  readonly status: string;
  readonly submittedAt: string | null;
  readonly totalMinor: bigint | null;
  readonly outstandingMinor: bigint | null;
  readonly nextDueMinor: bigint | null;
  /** ⭐ 0048's third fold — how much of this balance was forgiven. See `RowFigures`. */
  readonly writtenOffMinor: bigint | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Satang out of the tagged wire; `null` for a cart, which has no total yet. */
function satang(value: unknown): bigint | null {
  if (!isRecord(value) || value['unit'] !== 'THB.satang') return null;
  const digits = value['digits'];
  return typeof digits === 'string' && /^-?\d+$/u.test(digits) ? BigInt(digits) : null;
}

function decode(body: unknown): readonly QuotationRow[] | null {
  if (!isRecord(body) || !Array.isArray(body['orders'])) return null;

  return body['orders'].flatMap((raw) => {
    if (!isRecord(raw) || typeof raw['id'] !== 'string') return [];
    return [
      {
        id: raw['id'],
        orderNo: typeof raw['orderNo'] === 'string' ? raw['orderNo'] : null,
        status: typeof raw['status'] === 'string' ? raw['status'] : 'unknown',
        submittedAt: typeof raw['submittedAt'] === 'string' ? raw['submittedAt'] : null,
        totalMinor: satang(raw['grandTotalThbMinor']),
        /*
         * ⚠️ A missing field decodes to `null`, exactly as an explicitly-null one does, and
         * that is the behaviour this list wants rather than a hazard: an API one version
         * behind sends neither fold, and `describeRowMoney` degrades such a row to the total
         * alone. The opposite reading — defaulting an absent field to `0n` — would print
         * "paid in full" over an unpaid order and take the payment link away with it.
         *
         * (`lib/payment/api.ts` makes the *other* choice for the payment screen, where a
         * missing `nextDueThbMinor` fails the whole decode: there the figure is what a form
         * charges, and a screen with no number is safer than one with a wrong number. Here
         * it is a row in a list, and losing it entirely would lose the door to that screen.)
         */
        outstandingMinor: satang(raw['outstandingThbMinor']),
        nextDueMinor: satang(raw['nextDueThbMinor']),
        /*
         * ⭐ ⓸ How much of this balance the company forgave — 0048's third fold. `null` on an API
         * a version behind, which `describeRowMoney` reads as *nothing forgiven*: the fail-closed
         * direction, because the alternative is a row that claims a debt was written off when the
         * bundle simply could not tell.
         */
        writtenOffMinor: satang(raw['writtenOffThbMinor']),
      },
    ];
  });
}

/**
 * How prominently a figure is printed, as a table rather than as a ternary in `className`.
 *
 * ⚠️ Not a style preference — `scripts/check-tokens.mjs` reads every string literal inside a
 * `className={…}` expression and requires each one to produce CSS. A written
 * `emphasis === 'lead' ? … : …` puts the *comparison operand* in that list, and the build
 * fails reporting `lead` as a utility that styles nothing. The scanner also reads any `const`
 * whose name contains "class", so the two token lists below are still checked here.
 *
 * The classes themselves are the file's neighbours': `text-body`/`text-chalk` is the order
 * number's own weight beside it, `text-caption`/`text-chalk-2` is the supporting line used
 * across the quotation page. Nothing new is introduced — the palette and the scale are wiped
 * down to the project's own tokens and a stray `text-sm` fails the build, not the tests.
 */
const AMOUNT_CLASS: Readonly<Record<Emphasis, string>> = {
  lead: 'text-body text-chalk',
  quiet: 'text-caption text-chalk-2',
};

type Phase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly rows: readonly QuotationRow[] };

export function MyQuotations({
  session,
  /**
   * ⚠️ Bumped by the caller when an order is submitted, and the reason is a bug this had.
   *
   * The list loaded once on mount and a quotation created *on the same page* did not appear —
   * the customer pressed the button, was told "WW-1008", and read "ยังไม่มีใบเสนอราคา"
   * underneath it. Nothing was wrong with the data; the list simply did not know.
   *
   * A number rather than a callback because that is what a `useEffect` dependency can compare.
   */
  reloadKey = 0,
}: {
  readonly session: Session;
  readonly reloadKey?: number;
}): ReactElement {
  const { t, locale, f } = useLocale();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const base = reviewsApiBaseUrl();

    if (base === null) {
      setPhase({ kind: 'failed' });
      return;
    }

    void fetch(`${base}/orders?limit=50`, {
      credentials: 'include',
      headers: { accept: 'application/json', authorization: `Bearer ${session.accessToken}` },
      /* Somebody's own order list has no business in a shared cache. */
      cache: 'no-store',
    })
      .then(async (response) => (response.ok ? decode(await response.json()) : null))
      .catch(() => null)
      .then((rows) => {
        if (cancelled) return;
        setPhase(rows === null ? { kind: 'failed' } : { kind: 'ready', rows });
      });

    return () => {
      cancelled = true;
    };
  }, [reloadKey, session.accessToken]);

  if (phase.kind === 'loading') {
    return <p className="text-small text-chalk-2">{t('account.checking')}</p>;
  }

  if (phase.kind === 'failed') {
    return <p className="text-small text-chalk-2">{t('account.problem.unreachable')}</p>;
  }

  /*
   * ⚠️ Only submitted orders. A draft is a cart the API happens to be holding — it has no
   * number, no pinned document and no total — and listing it as a quotation would offer the
   * customer a document that does not exist.
   */
  const quotations = phase.rows.filter((row) => row.submittedAt !== null);

  if (quotations.length === 0) {
    return <p className="text-small text-chalk-2">{t('account.noQuotations')}</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {quotations.map((row) => {
        /*
         * ⭐ WHICH ORDER OWES WHAT — the figures this list existed without.
         *
         * The row used to print the grand total and nothing else, which answers "what was I
         * quoted" and not "what do I owe": a customer who had paid a deposit read the same
         * ฿14,400.00 they read before paying it. Both questions are now answered, by two
         * folds the database computed, and *which* of them a row prints is decided in
         * `quotationRowMoney.ts` — with its reasons, and with tests, because a decision left
         * in this file could not have either (`environment: 'node'`; a `.test.tsx` here is
         * silently never collected).
         */
        const money = describeRowMoney(row);

        return (
          <li key={row.id} className="flex items-baseline justify-between gap-3 border-b border-line py-2">
            {/*
              ⚠️ `?order=` — the owned path, which needs a session and did not exist until the
              browser found that every link here was refused. It was `/orders` bare, so no link
              in this list named which quotation it was about.
            */}
            <a
              className="text-body text-chalk underline"
              href={`${localeHref(locale, '/orders')}?order=${row.id}`}
            >
              {row.orderNo ?? row.id.slice(0, 8)}
            </a>
            <span className="flex items-baseline gap-3">
              {/*
                The money block, and the only part of this row that stacks.

                ⚠️ `items-baseline` on the `<li>` aligns a flex child by the baseline of its
                *first* line, so the prominent figure still sits on the row's baseline beside
                the order number and the action — the supporting line hangs below it rather
                than pushing anything. `items-end` because these are numerals in a column and
                a right edge is what makes two amounts comparable at a glance.

                ⚠️ `f.bahtExact`, not `f.baht`: whole baht is right for a price on a browsing
                page and wrong for a figure somebody is about to transfer (see `format.ts`).
                These two are what the payment screen states and prefills to the satang, one
                click away, and ฿4,320 here against ฿4,320.00 there is the same figure spelled
                two ways at the moment a customer is checking they match.
              */}
              <span className="flex flex-col items-end">
                {money.figures.map((figure) => (
                  <span key={figure.labelKey ?? 'total'} className={AMOUNT_CLASS[figure.emphasis]}>
                    {figure.labelKey === null ? null : `${t(figure.labelKey)} `}
                    <span className="numeric">{f.bahtExact(figure.amountMinor)}</span>
                  </span>
                ))}
                {/*
                  ⚠️ Nothing owed says so in words, in the payment screen's own sentence
                  (`payment.settled` — "ออเดอร์นี้ชำระครบแล้ว"), beside the quiet total. A row
                  that simply dropped its figures would read as a row that failed to load.
                */}
                {money.noteKey === null ? null : (
                  <span className="text-caption text-chalk-2">{t(money.noteKey)}</span>
                )}
              </span>
              {/*
                ⭐ THE DOOR FOR SOMEBODY WHO CLOSED THE TAB — task: payment entry points.

                This list is the second entry point and it is the one that matters more, because
                of who needs it. A customer who still has the quotation open has the button on
                it; a customer coming back the next day has neither the tab nor, in most cases,
                the email — `AccountScreen`'s own header records why this page exists at all
                ("a screen reachable only by typing a URL is a screen nobody uses"), and the
                cart cannot hold the door because submitting empties it.

                ⚠️ It is *this* page and not `/orders`, which despite the name is the quotation
                document itself — one order, opened with `?order=` or a token. There is no
                customer-facing order *list* other than this section, so this is the only place
                a returning customer can be offered a choice of orders to pay.

                ⚠️ Two links per row, so the row needs the amount and both actions to stay on
                one baseline — hence the wrapping `<span>` rather than a third `<li>` child,
                which would have spread the row across the full width with the total marooned
                in the middle.

                The same `acceptsPayment` the quotation page reads, from the same module, so
                "delivered" hides the action in both places or in neither. `status` was already
                decoded here and, like `QuotationIsland`'s, had no reader until now.

                ⭐ `&& money.owes` — the gap `payable.ts` used to document, now closed.

                `acceptsPayment` answers from the status alone, and the status of an order paid
                in full while still `in_production` is payable: the customer was offered
                "ชำระเงิน" on a bill they had already settled, arrived at the payment screen and
                were told `payment.settled` by the one layer that could see the money. The
                outstanding fold is on this row now, so the door closes where it is drawn.

                ⚠️ The status half stays in `payable.ts` rather than moving in beside the money.
                That list is a mirror of `SLIP_ATTACHABLE_STATUSES` and of the
                `payment_slips_live_orders_only` trigger, and `tests/payment-entry.test.ts`
                reads the API's own source to compare them character for character — and reads
                *this* file for the literal `acceptsPayment(row.status)` call. Two conditions,
                two owners: what the server will accept, and whether anything is left to pay.
              */}
              {acceptsPayment(row.status) && money.owes ? (
                <a
                  className="text-small text-lime underline"
                  href={`${localeHref(locale, '/payment')}?order=${row.id}`}
                >
                  {t('payment.action')}
                </a>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
