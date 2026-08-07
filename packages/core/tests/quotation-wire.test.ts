import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { pinnedDocumentFrom, printableQuotation } from '../src/quotation.js';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ AGAINST A RESPONSE THE RUNNING API ACTUALLY PRODUCED.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `fixtures/linked-quotation.json` was **captured**, not written. It is the body of
 * `GET /orders/documents/{token}` for a real order submitted through the real funnel, saved
 * byte for byte.
 *
 * ⚠️ That is the whole point of this file, and it exists because of a specific failure. The
 * storefront's first decoder was written from an assumption about the shape — money as
 * digits, lines carrying an `options` array — and its unit tests were written against a
 * fixture built from the same assumption. Seventeen tests passed. The page failed on the
 * first real payload, because money is `{unit: 'THB.satang', digits}` and there is no
 * `options` field at all: the labels live under `price.lines[].label.params`.
 *
 * A test whose fixture and whose subject share an author's misunderstanding cannot find it.
 * So the fixture here has one author and it is the API.
 *
 * ── Refreshing it ────────────────────────────────────────────────────────────
 *
 * Submit an order and save the link response over this file. If the contents change, the
 * change *is* a contract change and this test going red is the intended way to hear about it.
 */

const WIRE = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/linked-quotation.json', import.meta.url)), 'utf8'),
) as { orderNo: string; contactName: string; submittedAt: string; document: Record<string, unknown> };

const context = {
  orderNo: WIRE.orderNo,
  contactName: WIRE.contactName,
  submittedAt: WIRE.submittedAt,
};

describe('⭐ the captured response decodes', () => {
  it('reads the tagged money as satang', () => {
    const pinned = pinnedDocumentFrom(WIRE.document, context);

    expect(pinned.grandTotalThbMinor).toBeTypeOf('bigint');
    expect(pinned.grandTotalThbMinor).toBe(pinned.netThbMinor + pinned.vatThbMinor);
    expect(pinned.grandTotalThbMinor).toBeGreaterThan(0n);
  });

  it('⭐ its lines add up to its own net total', () => {
    /*
     * The check a customer does with a calculator, done here. It is also what would notice a
     * decoder that read the wrong field for a line — the totals would still look plausible
     * and would no longer foot.
     */
    const pinned = pinnedDocumentFrom(WIRE.document, context);
    const lines = pinned.lines.reduce((total, line) => total + line.netMinor, 0n);
    const charges = pinned.charges.reduce((total, charge) => total + charge.amountMinor, 0n);

    expect(lines + charges).toBe(pinned.netThbMinor);
  });

  it('carries the pinned locale off the wire', () => {
    expect(pinnedDocumentFrom(WIRE.document, context).pinnedLocale).toBe('th');
  });

  it('⚠️ takes the measures as millimetres, not raw micrometres', () => {
    /*
     * `3200000` is what the wire holds and `3,200 mm` is what a person reads. A decoder that
     * passed the digits through would print a number a thousand times too large on a document
     * a workshop cuts aluminium from.
     */
    const [line] = pinnedDocumentFrom(WIRE.document, context).lines;

    expect(Object.values(line?.measures ?? {}).join(' ')).toMatch(/mm/u);
    expect(Object.values(line?.measures ?? {}).join(' ')).not.toContain('3200000');
  });
});

describe('⭐ and renders', () => {
  it('produces a total a customer could transfer', () => {
    const rendered = printableQuotation(pinnedDocumentFrom(WIRE.document, context));

    expect(rendered.grandTotalText).toMatch(/^฿[\d,]+\.\d{2}$/u);
    expect(rendered.lines.length).toBeGreaterThan(0);
  });

  it('⭐ prints no warehouse codes in the option labels', () => {
    /*
     * `CLR`, `SG`, `T5`, `NS0` are what `selections` holds. A quotation carrying them is not a
     * specification a customer can check, and this is what fails if somebody ever "fixes" the
     * missing labels by falling back to the codes.
     *
     * ⚠️ It is also the assertion that documents a real gap: a zero-delta option produces no
     * price line, so it carries no Thai and is simply absent from the list. The API should pin
     * a label for every selection at submit — see `pinnedOptions`.
     */
    const [line] = printableQuotation(pinnedDocumentFrom(WIRE.document, context)).lines;

    expect(line?.detail.join(' ')).not.toMatch(/\b(CLR|SG|T5|NS0|DW)\b/u);
  });

  it('heads the document with the order number and the customer', () => {
    const rendered = printableQuotation(pinnedDocumentFrom(WIRE.document, context));

    expect(rendered.orderNoText).toBe(WIRE.orderNo);
    expect(rendered.contactName).toBe(WIRE.contactName);
    /* `th` renders a Buddhist year through ICU — 2569, not 2026. */
    expect(rendered.submittedAtText).toContain('2569');
  });
});

describe('⚠️ money it cannot read is a throw, never a zero', () => {
  it.each(['netThbMinor', 'vatThbMinor', 'grandTotalThbMinor'])('refuses a missing %s', (field) => {
    /*
     * A quotation for ฿0.00 is indistinguishable on paper from a real one, and the customer
     * transfers the printed figure. The caller turns this into a refusal the page can show.
     */
    const document = { ...WIRE.document };
    delete document[field];

    expect(() => pinnedDocumentFrom(document, context)).toThrow();
  });

  it('refuses money in the wrong unit', () => {
    /*
     * The unit is **checked**. `{unit: 'THB', digits: '8230'}` would decode to 8,230 satang —
     * ฿82.30 for an ฿8,230 quotation — and every figure on the page would be plausible.
     */
    const document = { ...WIRE.document, grandTotalThbMinor: { unit: 'THB', digits: '8230' } };

    expect(() => pinnedDocumentFrom(document, context)).toThrow();
  });
});
