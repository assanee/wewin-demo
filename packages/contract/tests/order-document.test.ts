import { describe, expect, it } from 'vitest';
import { ORDER_DOCUMENT_SCHEMA_VERSION, encodeThb, orderDocumentWireSchema, type OrderDocumentWire } from '../src/order.js';

/**
 * ⚠️ THE SILENT STRIP — why `parsed.data`, never the input, is the assertion that matters.
 *
 * `orderDocumentWireSchema` is `z.object(...)`, and `z.object` drops any key it does not
 * declare. `order.repository.ts` returns `parsed.data` on every read of `order_documents`, a
 * table a trigger freezes against UPDATE forever. So a field written into the JSON but missing
 * from the schema is not a parse error and not a log line — it is gone, permanently, the next
 * time anybody reads the row. The first test below is the only thing that would have caught
 * that failure mode before it shipped.
 */

/**
 * The smallest complete v2 document: every field `orderDocumentWireSchema` requires, at a
 * value that satisfies its own constraints, with zero lines and zero charges — both arrays
 * are unbounded-below in the schema, so an order with nothing added yet is still a legal
 * instance of the type. No literal fixture of this shape exists elsewhere in the repo (the
 * `documentSchemaVersion` sites in `apps/api/tests` are `.pg.test.ts` files that price a real
 * document through the database rather than declare one), so this is authored directly against
 * `OrderDocumentWire` and `orderDocumentWireSchema`, using the package's own `encodeThb` so the
 * money fields cannot be malformed by hand.
 */
const legacyDocument = (): OrderDocumentWire => ({
  documentSchemaVersion: ORDER_DOCUMENT_SCHEMA_VERSION,
  revision: 1,
  documentHash: 'a'.repeat(64),
  currency: 'THB',
  pinnedLocale: 'th',
  pinnedCoreVersion: '1.0.0',
  vat: { rateBp: 700, treatment: 'standard' },
  lines: [],
  charges: [],
  documentOverride: null,
  netThbMinor: encodeThb(100_000n),
  vatThbMinor: encodeThb(7_000n),
  grandTotalThbMinor: encodeThb(107_000n),
  leadTimeDays: 30,
});

describe('the pinned document carries a destination without a version bump', () => {
  it('keeps destinationCountry and taxBasis through a parse', () => {
    const parsed = orderDocumentWireSchema.safeParse({
      ...legacyDocument(),
      destinationCountry: 'SG',
      taxBasis: 'inclusive',
    });

    expect(parsed.success).toBe(true);
    /* The whole point: `parsed.data`, not the input. z.object strips what it does not
       declare, and order.repository.ts:735 returns parsed.data on every read. */
    expect(parsed.success && parsed.data.destinationCountry).toBe('SG');
    expect(parsed.success && parsed.data.taxBasis).toBe('inclusive');
  });

  it('still parses a document written before the fields existed', () => {
    const parsed = orderDocumentWireSchema.safeParse(legacyDocument());

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.destinationCountry).toBeUndefined();
    expect(parsed.success && parsed.data.taxBasis).toBeUndefined();
    expect(parsed.success && parsed.data.documentSchemaVersion).toBe(ORDER_DOCUMENT_SCHEMA_VERSION);
  });

  it('refuses a basis outside the two', () => {
    const parsed = orderDocumentWireSchema.safeParse({ ...legacyDocument(), taxBasis: 'net' });
    expect(parsed.success).toBe(false);
  });
});
