import { describe, expect, it } from 'vitest';

import type { QuoteLine } from '@wewin/core';

import { contactToWire, linesToSubmit, type CatalogRef } from '../src/lib/quote/submit';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ A CART IS NOT A SUBMITTABLE ORDER UNTIL THE CATALOGUE SAYS SO.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The storefront's catalogue is **compiled into the bundle**. A cart line therefore knows its
 * `productId`, its selections and its measurements, and knows nothing at all about
 * `productVersionId` or `documentHash` — the two fields `POST /orders/:id/transitions/…`
 * requires, because the price is computed against the *published* document and its hash is
 * verified on the way in.
 *
 * So submitting means asking the live catalogue what is published *now* and pairing it with
 * what the customer configured *then*. Which is where the interesting failures live:
 *
 *   ⓵ a product the bundle knows and the catalogue no longer publishes;
 *   ⓶ a catalogue that answers, but for a different set of products than the cart holds.
 *
 * ⚠️ **Both are refusals, never substitutions.** Pairing a cart line with whatever version
 * happens to be published today is how a customer is quoted for a window they did not
 * configure — the price would be recomputed server-side against a document whose options may
 * have been renamed, repriced or removed, and the only thing that would notice is the
 * customer, on paper, later.
 */

const line = (productId: string, overrides: Partial<QuoteLine> = {}): QuoteLine =>
  ({
    lineId: `line-${productId}`,
    productId,
    nickname: 'หน้าต่างห้องนอน',
    skuCode: 'AWN1-SG-CLR-T5-NS0',
    selections: { profile_color: 'SG', glass_color: 'CLR' },
    measures: { width: 3_200_000n, height: 1_600_000n },
    enteredUnits: { width: 'mm', height: 'mm' },
    qty: 2,
    priceSnapshot: {} as QuoteLine['priceSnapshot'],
    configHash: 'abc',
    addedAt: '2026-08-08T00:00:00.000Z',
    warnings: [],
    ...overrides,
  }) as QuoteLine;

const refs = (...ids: string[]): readonly CatalogRef[] =>
  ids.map((id) => ({
    productId: id,
    productVersionId: `version-of-${id}`,
    documentHash: `hash-of-${id}`,
  }));

describe('⭐ every line is paired with the version it will be priced against', () => {
  it('carries the live version and hash onto each line', () => {
    const result = linesToSubmit([line('awn-1'), line('sld-2')], refs('awn-1', 'sld-2'));

    expect(result.ok).toBe(true);
    expect(result.ok && result.lines[0]?.productVersionId).toBe('version-of-awn-1');
    expect(result.ok && result.lines[1]?.documentHash).toBe('hash-of-sld-2');
  });

  it('⭐ sends measurements as tagged micrometres, not as numbers', () => {
    /*
     * `{unit: 'um', digits: '3200000'}`. A plain `3200000` is refused by the API's schema, and
     * a float would be a rounding decision in a field that decides how aluminium is cut. This
     * is the shape `encodeUm` produces and the one `packages/db` stores.
     */
    const result = linesToSubmit([line('awn-1')], refs('awn-1'));

    expect(result.ok && result.lines[0]?.measures['width']).toStrictEqual({
      unit: 'um',
      digits: '3200000',
    });
  });

  it('⚠️ carries the unit each measurement was typed in', () => {
    /*
     * Not decoration: the server judges the step warning on the grid the customer was working
     * to (plan 4.1). Dropping it makes a window measured in inches warned about on the 5 mm
     * grid, which is a warning about a number nobody typed.
     */
    const result = linesToSubmit(
      [line('awn-1', { enteredUnits: { width: 'in', height: 'in' } })],
      refs('awn-1'),
    );

    expect(result.ok && result.lines[0]?.enteredUnits).toStrictEqual({ width: 'in', height: 'in' });
  });

  it('keeps the cart’s order, because the quotation is read in it', () => {
    const result = linesToSubmit([line('sld-2'), line('awn-1')], refs('awn-1', 'sld-2'));

    expect(result.ok && result.lines.map((l) => l.productId)).toStrictEqual(['sld-2', 'awn-1']);
  });
});

describe('⭐ a line the catalogue no longer publishes is a refusal', () => {
  it('names the products it could not place', () => {
    /*
     * ⓵. The bundle was built when `sld-2` was published; it has since been withdrawn. The
     * customer has to be told *which* line, because the only thing they can do is remove it.
     */
    const result = linesToSubmit([line('awn-1'), line('sld-2')], refs('awn-1'));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.unavailable).toStrictEqual(['sld-2']);
  });

  it('⭐ refuses rather than substituting a different version', () => {
    /*
     * ⓶, and the reason this function returns a union instead of filtering. Quietly dropping
     * the unplaceable line would submit an order for *part* of the cart at a total the
     * customer never saw; pairing it with some other published product would quote them for a
     * window they did not configure. Both are silent, and both reach the customer on paper.
     */
    const result = linesToSubmit([line('sld-2')], refs('awn-1'));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.unavailable).toStrictEqual(['sld-2']);
  });

  it('⚠️ refuses an empty cart', () => {
    /* `submitOrderRequestSchema` requires at least one line; a clearer refusal is cheaper. */
    expect(linesToSubmit([], refs('awn-1')).ok).toBe(false);
  });

  it('lists each missing product once, however many lines want it', () => {
    const result = linesToSubmit([line('sld-2'), line('sld-2')], refs('awn-1'));

    expect(!result.ok && result.unavailable).toStrictEqual(['sld-2']);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE CONTACT, IN THE ONE SHAPE THE DATABASE WILL ACCEPT.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Three rules, each stated in a place this function cannot reach and each enforced there:
 *
 *   `orders_submitted_has_a_contact_channel` — an address or a number, at least one;
 *   `orders_contact_phone_e164` — the number canonical, or the row is refused;
 *   `orders_contact_email_lowercase` — the address lower-cased, same.
 *
 * ⚠️ Restating them here is not duplication for its own sake. A value that reaches the API
 * violating a CHECK arrives back as a 500 and a sentence nobody can act on; refused here, it
 * is a field with a message next to it while the person is still looking at the form.
 */

describe('⭐ the contact needs a name and one channel', () => {
  const draft = (
    over: Partial<{ name: string; email: string; phone: string; destinationCountry: string }> = {},
  ) => contactToWire({ name: 'สมหญิง ใจดี', email: '', phone: '', destinationCountry: 'TH', ...over }, 'th');

  it('accepts a number alone', () => {
    const result = draft({ phone: '081-234-5678' });

    expect(result.ok).toBe(true);
    expect(result.ok && result.contact.phone).toBe('+66812345678');
    expect(result.ok && result.contact.email).toBeUndefined();
  });

  it('accepts an address alone, lower-cased', () => {
    const result = draft({ email: 'Somying@Example.TEST' });

    expect(result.ok && result.contact.email).toBe('somying@example.test');
  });

  it('⭐ refuses when there is neither', () => {
    expect(draft().ok).toBe(false);
    expect(!draft().ok && draft().ok === false && (draft() as { problem: string }).problem).toBe(
      'no-channel',
    );
  });

  it('⭐ refuses a number it cannot canonicalise, rather than sending it', () => {
    /*
     * `08123` would reach `orders_contact_phone_e164` and come back a 500. Named here, it is a
     * message beside the field.
     */
    const result = draft({ phone: '08123' });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.problem).toBe('bad-phone');
  });

  it('needs a name', () => {
    expect(draft({ name: '   ', phone: '081-234-5678' }).ok).toBe(false);
  });

  it('carries the reading language, which the document pins', () => {
    /* Plan 10.6: the locale is frozen at submit, so it has to be the one they were reading. */
    const result = contactToWire(
      { name: 'Somying', email: 'a@b.test', phone: '', destinationCountry: 'TH' },
      'en',
    );

    expect(result.ok && result.contact.locale).toBe('en');
  });

  it('⭐ carries the destination the picker held, whatever it was — the same round trip as locale', () => {
    const result = draft({ phone: '081-234-5678', destinationCountry: 'SG' });

    expect(result.ok && result.contact.destinationCountry).toBe('SG');
  });
});
