import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { quoteLineWireSchema } from '../src/quote.js';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ `productId` IS A CATALOGUE PRODUCT ID, NOT A UUID.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `product_versions.product_id` is `text` and holds `awn-1`, `lvr-adj`, `sld-2p`. The wire
 * type has always said `string | null`; the schema beside it said `z.uuid()`.
 *
 * ⚠️ This heading said "a catalogue slug" until products could have an id and a slug that
 * differ. It is the **id**. The two are equal for all eighty-one seeded products, which is
 * how the wrong word survived — and a dashboard-created product has id `uoio`, slug
 * `sdfghjkl`, so a reader who believed the old wording would build the wrong URL.
 *
 * ⚠️ **The two disagreed from the day they were written, and nothing noticed for months**,
 * because no order created through the storefront had ever reached this decoder — every
 * fixture and every hand-rolled probe went in another way. The first customer to press "ขอ
 * ใบเสนอราคา" produced a payload the API sends and the dashboard refuses, and the sales team
 * saw "เนื้อหาไม่ตรงกับที่แดชบอร์ดรู้จัก" on a real quotation.
 *
 * That is the failure mode a schema has that a type does not: `z.uuid()` is a claim about
 * production data, and TypeScript cannot check it.
 */

/**
 * ⚠️ **Captured, not written.** The first version of this fixture was invented and had six
 * fields the API does not send and lacked three it does — the same mistake that put an
 * assumption-built decoder on the storefront four phases ago, made again here.
 *
 * This is the body of `GET /orders/:id/quote` for the order that produced the bug, saved as
 * it arrived. If it stops parsing, the contract changed and that is the news.
 */
const CAPTURED = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/quote.json', import.meta.url)), 'utf8'),
) as { lines: Record<string, unknown>[] };

const line = (over: Record<string, unknown> = {}) => ({ ...CAPTURED.lines[0], ...over });

describe('⭐ a real catalogue id parses', () => {
  it.each(['lvr-adj', 'awn-1', 'sld-2p', 'awn-4t'])('accepts %s', (productId) => {
    const parsed = quoteLineWireSchema.safeParse(line({ productId }));

    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('still accepts null, which a free-form line is', () => {
    /*
     * A free-form charge — delivery, installation, a credit — has no product, which is why the
     * field is nullable and the one case `z.uuid()` happened to get right.
     *
     * ⚠️ `freeform`, not `charge`. My first attempt used a word that is not in
     * `QUOTE_LINE_KINDS_WIRE` and the schema said so — which is the enum doing its job on a
     * test rather than on production data, for once.
     */
    const parsed = quoteLineWireSchema.safeParse(
      line({ productId: null, kind: 'freeform', productVersionId: null, documentHash: null, skuCode: null }),
    );

    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('⚠️ refuses an empty string, which is neither a slug nor an absence', () => {
    /*
     * Loosening `z.uuid()` to `z.string()` would accept `''`. A charge says "no product" with
     * `null`; an empty slug is a catalogue line pointing at nothing, and it would reach a
     * production sheet as a blank.
     */
    expect(quoteLineWireSchema.safeParse(line({ productId: '' })).success).toBe(false);
  });

  it('⚠️ still refuses a productVersionId that is not a uuid', () => {
    /*
     * The neighbouring field genuinely *is* one — `product_versions.id` is a `uuid` column —
     * and relaxing it along with its neighbour would be the over-correction this test exists
     * to prevent.
     */
    expect(quoteLineWireSchema.safeParse(line({ productVersionId: 'lvr-adj' })).success).toBe(false);
  });
});
