import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ORDER_STATUSES } from '@wewin/db/schema';

import { NON_LIVE_ORDER_STATUSES, isLiveOrder } from '../../src/orders/live-order';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Which orders are somebody's live obligation — the list, and its second reader.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `list-outstanding.pg.test.ts` proves the customer-facing half against a real database: a
 * cancelled order stops reporting a debt. It proves it for `cancelled` only, because that is
 * the state a customer can reach with one request. `superseded` needs a redesign, a successor
 * and a supersede payload to reach over HTTP, and it is the state where a wrong answer is
 * *double counting* rather than a phantom debt — the money was carried to the replacement
 * order and is already owed there.
 *
 * So the membership is pinned here, over the whole status set, where adding a tenth status
 * without classifying it shows up as a failure rather than as a silent default.
 */

/*
 * `process.cwd()`, not `__dirname` and not `import.meta.url` — the resolution
 * `tests/build-output.test.ts` explains: this package compiles to CommonJS, so `import.meta`
 * is a compile error under `tsc`, and Vitest transforms the file as ESM, where `__dirname`
 * does not exist.
 */
const source = (relative: string): string =>
  readFileSync(join(process.cwd(), relative), 'utf8');

describe('isLiveOrder', () => {
  it('answers about every status the schema has, and classifies exactly three as not live', () => {
    const notLive = ORDER_STATUSES.filter((status) => !isLiveOrder(status));

    expect([...notLive]).toStrictEqual([...NON_LIVE_ORDER_STATUSES]);
  });

  it('refuses a debt on the two finished contracts', () => {
    /*
     * `cancelled` — the residue is a refund question and belongs to `src/payments/refunds`;
     * the company may owe the customer rather than the other way round.
     * `superseded` — the money was carried to the order that replaced this one, so counting it
     * here counts it twice.
     */
    expect(isLiveOrder('cancelled')).toBe(false);
    expect(isLiveOrder('superseded')).toBe(false);
  });

  it('refuses a debt on a cart, which has agreed to owe nothing', () => {
    expect(isLiveOrder('draft')).toBe(false);
  });

  it('still calls a delivered job live, because an unpaid one is exactly the debt to chase', () => {
    /*
     * The tempting fourth member, and it would be wrong. `SLIP_ATTACHABLE_STATUSES` refuses a
     * further slip against a delivered order, which makes collecting the balance a phone call
     * — not something that stops being owed.
     */
    expect(isLiveOrder('delivered')).toBe(true);
    expect(isLiveOrder('awaiting_payment')).toBe(true);
    expect(isLiveOrder('redesign')).toBe(true);
  });
});

describe('the two readers of the list', () => {
  /*
   * ⚠️ The property that makes the fix a fix rather than a patch. The money card's total and
   * the ค้างชำระ column on the list it links to are two readers of one sentence, in two
   * languages. A `not in ('draft', 'cancelled', 'superseded')` typed out again in the
   * repository would pass every other test in this repo and drift the first time a status is
   * added — which is the failure `overview.repository.ts`'s own header is about.
   *
   * Asserted against the source, because a SQL fragment's *text* is what would carry the
   * duplicate and no runtime value of `LIVE_ORDERS` can say where its statuses came from.
   */
  it('has the overview build LIVE_ORDERS out of the shared list', () => {
    expect(source('src/overview/overview.repository.ts')).toContain(
      'const LIVE_ORDERS = sql`o.status not in (${NON_LIVE_ORDER_STATUSES_SQL})`',
    );
  });

  it('has the order encoder decide nullability from the shared predicate', () => {
    /* Not from a status list of its own, and not from `frozenAt`, which answers a different
     * question — `cancelled` is reachable from both sides of the freeze. */
    const encode = source('src/orders/encode.ts');

    expect(encode).toContain('isLiveOrder(row.status)');
    for (const status of NON_LIVE_ORDER_STATUSES) {
      expect(encode).not.toContain(`'${status}'`);
    }
  });
});
