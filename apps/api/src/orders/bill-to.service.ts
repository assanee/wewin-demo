import { Inject, Injectable } from '@nestjs/common';
import { sql } from '@wewin/db/sql';
import type { Database } from '@wewin/db/client';
import type { OrderBillToWire } from '@wewin/contract/forfeit';

import { DRIZZLE } from '../database/database.tokens';
import { AppError } from '../common/errors/app-error';
import { message } from '../i18n';
import { ScopedOrderRepository } from './scope';
import type { Scope } from '../rbac';

const records = (result: unknown): readonly Record<string, unknown>[] =>
  (result as { rows?: readonly Record<string, unknown>[] }).rows ?? [];

/**
 * ⭐ ผู้ซื้อ — the name, address and tax id a tax document is made out to.
 *
 * The system has never held any of them. It holds a contact name, an email and a telephone
 * number, and no address anywhere — which is enough for a quotation and not for a document filed
 * with the Revenue Department.
 *
 * ── Per order, and the two independent reasons ──────────────────────────────────
 *
 * A walk-in owns their order through a `guests` row that carries nothing personal, so a table
 * keyed on the user cannot serve the customer standing at the counter — which is the exact
 * customer most likely to ask for a tax invoice on the spot. And in made-to-measure joinery the
 * party who orders and the party who is billed are often different: a landlord, a company, a
 * spouse. One order, one bill-to.
 *
 * ── What it is not ─────────────────────────────────────────────────────────────
 *
 * ⚠️ It is what the **next** document starts from, never what an issued one reads. A tax
 * document copies this block into its own frozen body at issue; editing here afterwards changes
 * nothing that has already been printed, which is the only behaviour that makes an issued
 * document evidence.
 */
@Injectable()
export class BillToService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly scoped: ScopedOrderRepository,
  ) {}

  async read(scope: Scope, orderId: string): Promise<OrderBillToWire | null> {
    const order = await this.scoped.findOrFail(scope, orderId, 'read');

    const result = await this.db.execute(sql`
      select buyer_kind, legal_name, tax_id, branch_code, address_line, postal_code, country,
             updated_at
        from order_bill_to where order_id = ${order.id}::uuid
    `);

    const row = records(result)[0];
    if (row === undefined) return null;

    return {
      buyerKind: row['buyer_kind'] === 'juristic' ? 'juristic' : 'individual',
      legalName: String(row['legal_name']),
      taxId: row['tax_id'] === null || row['tax_id'] === undefined ? null : String(row['tax_id']),
      branchCode:
        row['branch_code'] === null || row['branch_code'] === undefined
          ? null
          : String(row['branch_code']),
      addressLine: String(row['address_line']),
      postalCode:
        row['postal_code'] === null || row['postal_code'] === undefined
          ? null
          : String(row['postal_code']),
      country: String(row['country']),
      updatedAt: new Date(String(row['updated_at'])).toISOString(),
    };
  }

  /**
   * Write it, replacing whatever was there.
   *
   * ⚠️ An upsert rather than a create/update pair: there is exactly one bill-to per order by
   * primary key, and a screen that had to know whether one existed before saving would be a
   * screen that gets it wrong the first time two people have the order open.
   *
   * ⛔ No money check and no status check, deliberately. Correcting a misspelled company name
   * before the document is issued is the whole point of this table, and after it is issued this
   * table is not what the document reads. What *is* refused is by scope: `act`, so a customer
   * cannot rewrite the bill-to on their own order into somebody else's company.
   */
  async write(
    scope: Scope,
    orderId: string,
    input: Omit<OrderBillToWire, 'updatedAt'>,
    userId: string | null,
  ): Promise<OrderBillToWire> {
    const order = await this.scoped.findOrFail(scope, orderId, 'act');

    if (input.buyerKind === 'juristic' && input.taxId === null) {
      throw AppError.badRequest(message('error.billto.juristic_needs_tax_id'), {
        reason: 'juristic_needs_tax_id',
      });
    }

    await this.db.execute(sql`
      insert into order_bill_to
        (order_id, buyer_kind, legal_name, tax_id, branch_code, address_line, postal_code,
         country, updated_by_user_id)
      values (${order.id}::uuid, ${input.buyerKind}, ${input.legalName}, ${input.taxId},
              ${input.branchCode}, ${input.addressLine}, ${input.postalCode}, ${input.country},
              ${userId}::uuid)
      on conflict (order_id) do update set
        buyer_kind = excluded.buyer_kind,
        legal_name = excluded.legal_name,
        tax_id = excluded.tax_id,
        branch_code = excluded.branch_code,
        address_line = excluded.address_line,
        postal_code = excluded.postal_code,
        country = excluded.country,
        updated_by_user_id = excluded.updated_by_user_id,
        updated_at = now()
    `);

    const written = await this.read(scope, orderId);
    if (written === null) throw new Error('orders: the bill-to could not be read back');
    return written;
  }
}
