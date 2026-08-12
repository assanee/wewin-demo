'use client';

import { useEffect, useState, type ReactElement } from 'react';

import { acceptsPayment } from '../../lib/payment/payable';
import { localeHref } from '../../lib/routing';
import { reviewsApiBaseUrl } from '../../lib/reviews/api';
import type { Session } from '../../lib/auth/account';
import { useLocale } from '../../state/localeContext';

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
 */

interface QuotationRow {
  readonly id: string;
  readonly orderNo: string | null;
  readonly status: string;
  readonly submittedAt: string | null;
  readonly totalMinor: bigint | null;
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
      },
    ];
  });
}

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
      {quotations.map((row) => (
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
            <span className="numeric text-small text-chalk-2">
              {row.totalMinor === null ? '' : f.baht(row.totalMinor)}
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
            */}
            {acceptsPayment(row.status) ? (
              <a
                className="text-small text-lime underline"
                href={`${localeHref(locale, '/payment')}?order=${row.id}`}
              >
                {t('payment.action')}
              </a>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
