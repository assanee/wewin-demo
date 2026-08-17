import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '@wewin/db/sql';
import type { TaxDocumentSettingsWire } from '@wewin/contract/forfeit';
import type { OrganisationProfileWire } from '@wewin/contract/organisation';

import { createPgHarness } from '../support/pg-harness';
import { client, makeActor, type Json } from '../orders/support/lifecycle-app';

/**
 * ⭐ เอกสารภาษี — the switches, and the one thing they must never do.
 *
 * The owner asked for every part of this to be configurable. What that must not mean is that the
 * company's tax policy travels to every customer: `OrganisationProfileWire` is the **letterhead**,
 * read by the storefront and by anybody holding a document link, and a field added there is a
 * field published by construction. The first test below is that separation, and it is the one
 * worth keeping if the others are ever thought redundant.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];

describe.skipIf(url === undefined || url === '')('the tax-document switches', () => {
  const base = createPgHarness(url ?? '');

  const harness = async () => {
    const { app, db } = await base.harness();
    const call = client(app.baseUrl);

    const admin = await makeActor(db, app, 'taxdoc admin', ['organisation.read', 'organisation.write']);
    const reader = await makeActor(db, app, 'taxdoc reader', ['organisation.read']);

    const read = async (): Promise<TaxDocumentSettingsWire> => {
      const answer = await call('GET', '/admin/organisation/tax-documents', { token: admin.token });
      if (answer.status !== 200) throw new Error(JSON.stringify(answer.body));
      return answer.body as TaxDocumentSettingsWire;
    };

    const write = (settings: Partial<TaxDocumentSettingsWire>): Promise<Json> =>
      call('PUT', '/admin/organisation/tax-documents', {
        token: admin.token,
        body: {
          enabled: false,
          onInstalment: false,
          onDelivery: false,
          combinedReceipt: true,
          invoiceOnDemand: false,
          abbreviatedAllowed: false,
          ...settings,
        },
      });

    return { call, admin, reader, db, read, write };
  };

  afterAll(async () => {
    await base.closeOpened();
  });

  it('⛔ never appear on the letterhead the customer reads', async () => {
    /*
     * THE TEST THIS FILE EXISTS FOR. Whether this company issues a tax invoice per instalment is
     * nobody's business but its own, and `GET /admin/organisation` is not the private read it
     * looks like — the same shape reaches the storefront and every document link.
     */
    const h = await harness();
    const profile = await h.call('GET', '/admin/organisation', { token: h.admin.token });
    expect(profile.status).toBe(200);

    const keys = Object.keys(profile.body as OrganisationProfileWire);
    for (const leaked of keys) {
      expect(leaked.toLowerCase(), `${leaked} looks like a tax-document setting`).not.toContain('taxdoc');
    }
    expect(JSON.stringify(profile.body)).not.toContain('onInstalment');
    expect(JSON.stringify(profile.body)).not.toContain('abbreviatedAllowed');
  });

  it('⭐ ship every switch off — a company that has not decided must not start issuing', async () => {
    const h = await harness();
    const settings = await h.read();

    expect(settings.enabled).toBe(false);
    expect(settings.onInstalment).toBe(false);
    expect(settings.onDelivery).toBe(false);
    expect(settings.invoiceOnDemand).toBe(false);
    expect(settings.abbreviatedAllowed).toBe(false);
  });

  it('⭐ keep both 2.2 modes independent, which is what the owner asked for', async () => {
    /*
     * ⚠️ The combination the owner was warned about — delivery-only, with a deposit taken
     * earlier — is PERMITTED, because they chose it: "เปิดอิสระทั้งสองสวิตช์ ตามที่สั่งเดิม".
     * The warning belongs on the screen, not in a refusal, and this test is what stops somebody
     * later reading the warning as a rule and quietly enforcing it.
     */
    const h = await harness();

    expect((await h.write({ enabled: true, onDelivery: true })).status).toBe(200);
    expect((await h.read()).onDelivery).toBe(true);
    expect((await h.read()).onInstalment).toBe(false);

    expect((await h.write({ enabled: true, onInstalment: true, onDelivery: true })).status).toBe(200);
    const both = await h.read();
    expect(both.onInstalment && both.onDelivery).toBe(true);

    await h.write({});
  });

  it('⛔ refuse switching on with no moment chosen — on, and never issuing', async () => {
    const h = await harness();
    const refused = await h.write({ enabled: true });

    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('no_moment_chosen');

    /* And nothing moved. */
    expect((await h.read()).enabled).toBe(false);
  });

  it('🔒 a reader may look and may not flip', async () => {
    const h = await harness();

    const read = await h.call('GET', '/admin/organisation/tax-documents', { token: h.reader.token });
    expect(read.status).toBe(200);

    const refused = await h.call('PUT', '/admin/organisation/tax-documents', {
      token: h.reader.token,
      body: {
        enabled: true,
        onInstalment: true,
        onDelivery: false,
        combinedReceipt: true,
        invoiceOnDemand: false,
        abbreviatedAllowed: false,
      },
    });
    expect(refused.status).toBe(403);
  });

  it('⚠️ the columns live beside the deposit policy, which is where a settings read expects them', async () => {
    const h = await harness();
    const row = await h.db.execute(sql`
      select tax_doc_enabled, deposit_bp from organisation_profile where id = 1
    `);
    const found = ((row as { rows?: readonly Record<string, unknown>[] }).rows ?? [])[0];

    /* One row, one company, one place a person looks for "what does this company do about money". */
    expect(found).toBeDefined();
    expect(found?.['deposit_bp']).toBeDefined();
  });
});
