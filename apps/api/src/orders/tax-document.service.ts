import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from '@wewin/db/sql';
import type { Database } from '@wewin/db/client';
import { canonicalJson } from '@wewin/db/hash';
import type {
  TaxDocumentBodyWire,
  TaxDocumentKindWire,
  TaxDocumentPartyWire,
  TaxDocumentSubjectWire,
  TaxDocumentWire,
} from '@wewin/contract/forfeit';

import { DRIZZLE } from '../database/database.tokens';
import { AppError } from '../common/errors/app-error';
import { message } from '../i18n';
import { postgresErrorOf } from './pg-errors';
import { ScopedOrderRepository } from './scope';
import type { Scope } from '../rbac';

const records = (result: unknown): readonly Record<string, unknown>[] =>
  (result as { rows?: readonly Record<string, unknown>[] }).rows ?? [];

const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

/** Which series a kind is numbered in. The sixth hand-maintained list; the tests walk it. */
const SERIES_OF: Record<TaxDocumentKindWire, string> = {
  invoice: 'INV',
  tax_invoice: 'TAX',
  abbreviated_tax_invoice: 'ABB',
  receipt: 'RCP',
  tax_invoice_receipt: 'TRC',
  credit_note: 'CN',
};

/** Which switch permits a kind. `credit_note` is permitted whenever the feature is on at all. */
const REQUIRES_SETTING: Partial<Record<TaxDocumentKindWire, string>> = {
  invoice: 'tax_doc_invoice_on_demand',
  abbreviated_tax_invoice: 'tax_doc_abbreviated_allowed',
};

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ออกเอกสารภาษี — raising a numbered document, and striking one out.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── What makes this different from every other write in this codebase ──────────
 *
 * An issued document is evidence. `tax_documents_freeze()` compares every column on UPDATE and
 * permits exactly one change — issued → voided — so there is no correcting a mistake here. The
 * only remedy is a credit note and a new number. That single fact decides the shape of this
 * service: everything is checked BEFORE the insert, and the insert is the last thing that
 * happens.
 *
 * ── Three rules that are not here ──────────────────────────────────────────────
 *
 * ⚠️ The same supply may not be tax-invoiced twice. That is three partial unique indexes in
 * 0060, not a query in this file, because the owner asked for both issuing modes to be
 * switchable independently and a service check would be a race between two people pressing at
 * once. This service catches 23505 and translates it; it does not try to prevent it.
 *
 * ⚠️ The number does not skip. `next_document_no()` takes a counter ROW `FOR UPDATE` rather
 * than calling `nextval`, so a rolled-back issue gives its number back. Everything below runs
 * in one transaction for that reason alone.
 *
 * ⚠️ Nothing here decides anything about tax. Which moments produce documents, whether a
 * receipt and a tax invoice are one page or two, whether an abbreviated invoice is allowed at
 * all — six switches in ข้อมูลบริษัท, set by the company with their bookkeeper.
 */
@Injectable()
export class TaxDocumentService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly scoped: ScopedOrderRepository,
  ) {}

  async list(scope: Scope, orderId: string): Promise<readonly TaxDocumentWire[]> {
    const order = await this.scoped.findOrFail(scope, orderId, 'read');

    const result = await this.db.execute(sql`
      select id::text, kind, status, document_no, issued_at, voided_at, void_reason_th,
             instalment_id::text, net_thb_minor::text, vat_thb_minor::text,
             grand_total_thb_minor::text, document
        from tax_documents
       where order_id = ${order.id}::uuid
       order by issued_at, document_no
    `);

    return records(result).map((row) => ({
      id: String(row['id']),
      kind: String(row['kind']) as TaxDocumentKindWire,
      status: row['status'] === 'voided' ? 'voided' : 'issued',
      documentNo: String(row['document_no']),
      issuedAt: new Date(String(row['issued_at'])).toISOString(),
      voidedAt: row['voided_at'] == null ? null : new Date(String(row['voided_at'])).toISOString(),
      voidReasonTh: text(row['void_reason_th']),
      instalmentId: text(row['instalment_id']),
      netThbMinor: String(row['net_thb_minor']),
      vatThbMinor: String(row['vat_thb_minor']),
      grandTotalThbMinor: String(row['grand_total_thb_minor']),
      body: row['document'] as TaxDocumentBodyWire,
    }));
  }

  /**
   * ⭐ Raise one.
   *
   * ⚠️ `issuedAt` is read back from the row rather than stamped here, and `documentNo` comes
   * from the database function rather than being built in TypeScript. Both are facts the
   * database owns; a service that guesses either produces a document that disagrees with the
   * series it claims to belong to.
   */
  async issue(
    scope: Scope,
    orderId: string,
    input: { readonly kind: TaxDocumentKindWire; readonly instalmentId: string | null },
  ): Promise<TaxDocumentWire> {
    const order = await this.scoped.findOrFail(scope, orderId, 'act');

    return this.db.transaction(async (tx) => {
      const one = async (statement: ReturnType<typeof sql>): Promise<Record<string, unknown>> =>
        records(await tx.execute(statement))[0] ?? {};

      const settings = await one(sql`
        select tax_doc_enabled, tax_doc_invoice_on_demand, tax_doc_abbreviated_allowed
          from organisation_profile where id = 1
      `);

      if (settings['tax_doc_enabled'] !== true) {
        throw new AppError('VALIDATION_FAILED', 422, message('error.taxdoc.disabled'));
      }

      const gate = REQUIRES_SETTING[input.kind];
      if (gate !== undefined && settings[gate] !== true) {
        throw new AppError('VALIDATION_FAILED', 422, message('error.taxdoc.kind_not_permitted'));
      }

      /*
       * ⛔ A credit note reduces a document that exists. `tax_documents_credit_note_cites`
       * refuses one without `replaces_document_id`, and there is no way for this endpoint to
       * supply it — `void()` is what raises credit notes, because striking out and crediting are
       * one act, not two a caller might do half of.
       */
      if (input.kind === 'credit_note') {
        throw new AppError('VALIDATION_FAILED', 422, message('error.taxdoc.credit_note_via_void'));
      }

      const body = await this.buildBody(tx, {
        orderId: order.id,
        kind: input.kind,
        instalmentId: input.instalmentId,
      });

      return this.write(tx, {
        orderId: order.id,
        kind: input.kind,
        instalmentId: input.instalmentId,
        body,
        actorUserId: scope.kind === 'user' ? scope.userId : null,
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * What goes on the page
   * ------------------------------------------------------------------ */

  /**
   * ⚠️ Reads the *frozen quotation*, not the live order, for lines and totals.
   *
   * A tax document raised three weeks after delivery must show what was agreed, not what the
   * catalogue says today. `order_documents` is already the frozen copy of that agreement, so
   * this reads the latest revision of it and copies forward — which also means a document
   * cannot be raised on an order that never had a quotation, and that refusal is correct.
   */
  private async buildBody(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    input: {
      readonly orderId: string;
      readonly kind: TaxDocumentKindWire;
      readonly instalmentId: string | null;
    },
  ): Promise<Omit<TaxDocumentBodyWire, 'documentNo' | 'issuedAt' | 'documentHash'>> {
    const rows = (statement: ReturnType<typeof sql>) => tx.execute(statement).then(records);

    const seller = (await rows(sql`
      select legal_name_th, tax_id, address_th from organisation_profile where id = 1
    `))[0];

    if (seller === undefined || text(seller['legal_name_th']) === null) {
      throw new AppError('VALIDATION_FAILED', 422, message('error.taxdoc.no_seller_profile'));
    }

    const quotation = (await rows(sql`
      select document, pinned_vat_rate_bp, pinned_vat_treatment,
             net_thb_minor::text, vat_thb_minor::text, grand_total_thb_minor::text
        from order_documents
       where order_id = ${input.orderId}::uuid
       order by revision desc
       limit 1
    `))[0];

    if (quotation === undefined) {
      throw new AppError('VALIDATION_FAILED', 422, message('error.taxdoc.no_quotation'));
    }

    const orderRow = (await rows(sql`
      select order_no from orders where id = ${input.orderId}::uuid
    `))[0];

    const buyer = await this.buyerBlock(tx, input.orderId, input.kind);
    const { subject, net, vat, grand } = await this.subjectAndMoney(tx, input, quotation);

    return {
      bodySchemaVersion: 1,
      kind: input.kind,
      orderNo: text(orderRow?.['order_no']),
      seller: {
        legalName: String(seller['legal_name_th']),
        taxId: text(seller['tax_id']),
        /* The company's own branch. Null is สำนักงานใหญ่, which is what this company is. */
        branchCode: null,
        addressLine: String(seller['address_th'] ?? ''),
        postalCode: null,
        country: 'TH',
      },
      buyer,
      subject,
      lines: this.linesFrom(quotation['document']),
      vat: {
        rateBp: Number(quotation['pinned_vat_rate_bp']),
        treatment: String(quotation['pinned_vat_treatment']),
      },
      netThbMinor: net,
      vatThbMinor: vat,
      grandTotalThbMinor: grand,
      citesDocumentNo: null,
      reasonTh: null,
    };
  }

  /**
   * ⛔ Every kind but one needs a buyer.
   *
   * ใบกำกับภาษีอย่างย่อ is the exception by design — it is the over-the-counter form and carries
   * no buyer name or address at all. For every other kind, issuing without a bill-to block would
   * produce a numbered document the buyer cannot use and nobody can correct.
   */
  private async buyerBlock(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    orderId: string,
    kind: TaxDocumentKindWire,
  ): Promise<TaxDocumentPartyWire | null> {
    if (kind === 'abbreviated_tax_invoice') return null;

    const row = records(
      await tx.execute(sql`
        select buyer_kind, legal_name, tax_id, branch_code, address_line, postal_code, country
          from order_bill_to where order_id = ${orderId}::uuid
      `),
    )[0];

    if (row === undefined) {
      throw new AppError('VALIDATION_FAILED', 422, message('error.taxdoc.no_bill_to'));
    }

    return {
      legalName: String(row['legal_name']),
      taxId: text(row['tax_id']),
      branchCode: text(row['branch_code']),
      addressLine: String(row['address_line']),
      postalCode: text(row['postal_code']),
      country: String(row['country'] ?? 'TH'),
    };
  }

  /**
   * What money this document covers, and how it is described.
   *
   * ⚠️ An instalment document carries the instalment's own VAT split, computed from the same
   * proportion the instalment bears to the order — not re-derived from a rate, which would
   * round differently and leave the sum of the instalment documents disagreeing with the order
   * total by a satang.
   */
  private async subjectAndMoney(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    input: { readonly orderId: string; readonly instalmentId: string | null },
    quotation: Record<string, unknown>,
  ): Promise<{
    readonly subject: TaxDocumentSubjectWire;
    readonly net: string;
    readonly vat: string;
    readonly grand: string;
  }> {
    const orderGrand = BigInt(String(quotation['grand_total_thb_minor']));
    const orderVat = BigInt(String(quotation['vat_thb_minor']));
    const orderNet = BigInt(String(quotation['net_thb_minor']));

    if (input.instalmentId === null) {
      return {
        subject: { kind: 'whole_order' },
        net: orderNet.toString(),
        vat: orderVat.toString(),
        grand: orderGrand.toString(),
      };
    }

    const instalment = records(
      await tx.execute(sql`
        select seq, due_thb_minor::text
          from order_instalments
         where id = ${input.instalmentId}::uuid and order_id = ${input.orderId}::uuid
      `),
    )[0];

    if (instalment === undefined) {
      throw new AppError('NOT_FOUND', 404, message('error.taxdoc.instalment_unknown'));
    }

    const due = BigInt(String(instalment['due_thb_minor']));
    /*
     * ⚠️ VAT apportioned by the instalment's share of the order, then the net is the remainder.
     * Deriving the net first and the VAT from the rate would round twice and let a two-instalment
     * order's documents foot to one satang more than the order.
     */
    const vat = orderGrand === 0n ? 0n : (due * orderVat) / orderGrand;

    return {
      subject: {
        kind: 'instalment',
        instalmentNo: Number(instalment['seq']),
        labelTh: `งวดที่ ${String(instalment['seq'])}`,
      },
      net: (due - vat).toString(),
      vat: vat.toString(),
      grand: due.toString(),
    };
  }

  /** The quotation's lines, as a page prints them. Absent or malformed is one summary line. */
  private linesFrom(document: unknown): TaxDocumentBodyWire['lines'] {
    const lines = (document as { lines?: readonly Record<string, unknown>[] } | null)?.lines;
    if (!Array.isArray(lines)) return [];

    return lines.map((line) => ({
      descriptionTh: String(line['titleTh'] ?? line['descriptionTh'] ?? ''),
      quantity: Number(line['quantity'] ?? 1),
      unitThbMinor: String(line['unitThbMinor'] ?? '0'),
      amountThbMinor: String(line['amountThbMinor'] ?? line['lineTotalThbMinor'] ?? '0'),
    }));
  }

  /* ------------------------------------------------------------------ *
   * The insert
   * ------------------------------------------------------------------ */

  private async write(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    input: {
      readonly orderId: string;
      readonly kind: TaxDocumentKindWire;
      readonly instalmentId: string | null;
      readonly body: Omit<TaxDocumentBodyWire, 'documentNo' | 'issuedAt' | 'documentHash'>;
      readonly actorUserId: string | null;
      readonly replacesDocumentId?: string;
      readonly citesDocumentNo?: string;
      readonly reasonTh?: string;
    },
  ): Promise<TaxDocumentWire> {
    const numbered = records(
      await tx.execute(sql`select * from next_document_no(${SERIES_OF[input.kind]}, now())`),
    )[0];

    if (numbered === undefined) {
      throw new AppError('VALIDATION_FAILED', 422, message('error.taxdoc.no_series'));
    }

    const documentNo = String(numbered['document_no']);
    const issuedAt = new Date().toISOString();

    /*
     * ⚠️ The event first, then the document that cites it — `created_by_event_id` is NOT NULL,
     * and 0062 put that event on the order's own timeline so a numbered document is never a
     * thing that happened silently.
     */
    const eventId = randomUUID();
    await tx.execute(sql`
      insert into order_events (id, order_id, event_type, actor_kind, actor_user_id, payload)
      values (${eventId}::uuid, ${input.orderId}::uuid, 'tax_document_issued', 'staff',
              ${input.actorUserId}::uuid,
              ${JSON.stringify({ document_no: documentNo, document_kind: input.kind })}::jsonb)
    `);

    const body = withHash({
      ...input.body,
      documentNo,
      issuedAt,
      citesDocumentNo: input.citesDocumentNo ?? null,
      reasonTh: input.reasonTh ?? null,
      documentHash: '',
    });

    const inserted = await tx
      .execute(sql`
        insert into tax_documents
          (kind, order_id, instalment_id, replaces_document_id, series_code, series_year,
           series_seq, document_no, document, document_hash, pinned_locale, pinned_vat_rate_bp,
           pinned_vat_treatment, net_thb_minor, vat_thb_minor, grand_total_thb_minor,
           issued_by_user_id, created_by_event_id)
        values (${input.kind}, ${input.orderId}::uuid,
                ${input.instalmentId}::uuid, ${input.replacesDocumentId ?? null}::uuid,
                ${String(numbered['series_code'])}, ${Number(numbered['series_year'])},
                ${Number(numbered['series_seq'])}, ${documentNo},
                ${JSON.stringify(body)}::jsonb, ${body.documentHash},
                'th', ${body.vat.rateBp}, ${body.vat.treatment},
                ${body.netThbMinor}::bigint, ${body.vatThbMinor}::bigint,
                ${body.grandTotalThbMinor}::bigint,
                ${input.actorUserId}::uuid, ${eventId}::uuid)
        returning id::text, issued_at
      `)
      .catch((cause: unknown) => {
        /*
         * ⛔ 23505 here is one of the three partial unique indexes: this supply already has a
         * document of this kind. Translated rather than surfaced, because "duplicate key value
         * violates unique constraint" tells the person at the counter nothing they can act on.
         */
        /*
         * ⚠️ Read off `.cause`, never off `String(cause)`. Drizzle rethrows as a
         * `DrizzleQueryError` that carries no `code` of its own and whose message does not
         * contain the SQLSTATE either — the first draft here matched on the string and turned
         * every duplicate into a 500, which is exactly what `pg-errors.ts` was written about.
         */
        if (postgresErrorOf(cause)?.code === '23505') {
          throw new AppError('CONFLICT', 409, message('error.taxdoc.already_issued'));
        }
        throw cause;
      });

    const row = records(inserted)[0] ?? {};

    return {
      id: String(row['id']),
      kind: input.kind,
      status: 'issued',
      documentNo,
      issuedAt: new Date(String(row['issued_at'] ?? issuedAt)).toISOString(),
      voidedAt: null,
      voidReasonTh: null,
      instalmentId: input.instalmentId,
      netThbMinor: body.netThbMinor,
      vatThbMinor: body.vatThbMinor,
      grandTotalThbMinor: body.grandTotalThbMinor,
      body,
    };
  }
}

/**
 * The hash over everything but itself.
 *
 * ⚠️ Canonicalised first, for the reason `packages/db/src/hash.ts` gives: `jsonb` stores a
 * parsed value rather than a document, so hashing what comes back out of Postgres would
 * disagree with hashing what went in — and that mismatch looks exactly like the tampering the
 * hash exists to detect. The field is overwritten rather than deleted so the object's shape
 * cannot depend on how it was built.
 */
export function withHash(body: TaxDocumentBodyWire): TaxDocumentBodyWire {
  const { documentHash: _ignored, ...rest } = body;
  return { ...body, documentHash: createHash('sha256').update(canonicalJson(rest)).digest('hex') };
}
