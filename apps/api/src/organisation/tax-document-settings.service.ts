import { Inject, Injectable } from '@nestjs/common';
import { sql } from '@wewin/db/sql';
import type { Database } from '@wewin/db/client';
import type { TaxDocumentSettingsWire } from '@wewin/contract/forfeit';

import { DRIZZLE } from '../database/database.tokens';
import { AppError } from '../common/errors/app-error';
import { message } from '../i18n';

const records = (result: unknown): readonly Record<string, unknown>[] =>
  (result as { rows?: readonly Record<string, unknown>[] }).rows ?? [];

/**
 * ⭐ เอกสารภาษี — whether and how this company issues tax documents.
 *
 * ── Why this is not part of the organisation profile ────────────────────────────
 *
 * `OrganisationProfileWire` is the **letterhead**: the storefront reads it, and so does anybody
 * holding a document link, because a quotation has to print the seller's name and address.
 * Whether this company issues a tax invoice per instalment is nobody's business but its own, and
 * a field added to that wire is a field published to every customer by construction. So the
 * columns share a table with the profile — they are the same company's settings, with the same
 * one-row guarantee and the same change log — and they travel on a wire of their own behind
 * `organisation.read`.
 *
 * ── The one refusal, and why it is here rather than in a CHECK ───────────────────
 *
 * ⛔ `onInstalment` and `onDelivery` are independent, at the owner's explicit instruction. They
 * were told that `onDelivery` alone can under-declare output VAT when a deposit was taken before
 * delivery — the tax point on that money has already passed — and answered *"เปิดอิสระทั้งสอง
 * สวิตช์ ตามที่สั่งเดิม"*. So the combination is permitted and the screen carries the warning.
 *
 * What is refused is switching the master on with **neither** moment chosen: that is a company
 * that has turned on tax documents and told the system never to issue one, which is indis-
 * tinguishable at every later screen from a company that has not turned them on at all.
 */
@Injectable()
export class TaxDocumentSettingsService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async read(): Promise<TaxDocumentSettingsWire> {
    const result = await this.db.execute(sql`
      select tax_doc_enabled, tax_doc_on_instalment, tax_doc_on_delivery,
             tax_doc_combined_receipt, tax_doc_invoice_on_demand, tax_doc_abbreviated_allowed
        from organisation_profile where id = 1
    `);

    const row = records(result)[0];
    if (row === undefined) {
      throw AppError.notFound(message('error.organisation.profile_missing'));
    }

    return {
      enabled: row['tax_doc_enabled'] === true,
      onInstalment: row['tax_doc_on_instalment'] === true,
      onDelivery: row['tax_doc_on_delivery'] === true,
      combinedReceipt: row['tax_doc_combined_receipt'] === true,
      invoiceOnDemand: row['tax_doc_invoice_on_demand'] === true,
      abbreviatedAllowed: row['tax_doc_abbreviated_allowed'] === true,
    };
  }

  async write(settings: TaxDocumentSettingsWire): Promise<TaxDocumentSettingsWire> {
    if (settings.enabled && !settings.onInstalment && !settings.onDelivery) {
      throw AppError.badRequest(message('error.taxdoc.no_moment_chosen'), {
        reason: 'no_moment_chosen',
      });
    }

    await this.db.execute(sql`
      update organisation_profile
         set tax_doc_enabled = ${settings.enabled},
             tax_doc_on_instalment = ${settings.onInstalment},
             tax_doc_on_delivery = ${settings.onDelivery},
             tax_doc_combined_receipt = ${settings.combinedReceipt},
             tax_doc_invoice_on_demand = ${settings.invoiceOnDemand},
             tax_doc_abbreviated_allowed = ${settings.abbreviatedAllowed},
             updated_at = now()
       where id = 1
    `);

    return this.read();
  }
}
