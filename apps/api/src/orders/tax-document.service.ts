import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
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
import { message, thb } from '../i18n';
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
  private readonly logger = new Logger(TaxDocumentService.name);

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
   * ⭐ ออกอัตโนมัติ — the documents the company's own settings say to raise at this moment.
   *
   * ── ⛔ A document that cannot be raised must never undo the money ─────────────
   *
   * This runs inside the transaction that accepted the payment or recorded the delivery, and
   * every attempt is wrapped in its own SAVEPOINT. A missing bill-to block, a company that has
   * not filled in its own name, a supply already documented — any of them would otherwise roll
   * back a slip the customer really did pay, or a delivery that really did happen. The business
   * event is the fact; the document is a consequence of it, and a consequence may fail.
   *
   * ⚠️ A plain `try/catch` is enough for the refusals THIS service raises — a missing bill-to
   * block throws in TypeScript before any statement runs. It is not enough for the ones POSTGRES
   * raises: a duplicate caught by `tax_documents_one_whole_order_tax` aborts the whole
   * transaction, and every later statement in it fails too, including the ones still recording
   * the delivery. The SAVEPOINT — which is what a nested `tx.transaction()` emits — is what
   * makes the catch mean something in that case, and the test named after it is what proves it:
   * remove the nesting and exactly that test goes red.
   *
   * ⛔ AND THE GAP THIS LEAVES, SAID PLAINLY: a swallowed failure is a log line and nothing
   * else. The commonest cause is benign — a customer who never asked for a tax invoice, so no
   * bill-to block exists — but a company that switched the delivery moment on and expects a
   * document per delivered order has, today, no screen that says which ones did not get one.
   * That list is the next piece of this feature and it is not built. Until it is, the honest
   * description of automatic issuing is "usually", not "always".
   */
  async issueAutomatically(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    input: {
      readonly orderId: string;
      readonly moment: 'payment' | 'delivery';
      readonly instalmentId: string | null;
      readonly actorUserId: string | null;
    },
  ): Promise<readonly TaxDocumentWire[]> {
    const settings = records(
      await tx.execute(sql`
        select tax_doc_enabled, tax_doc_on_instalment, tax_doc_on_delivery,
               tax_doc_combined_receipt
          from organisation_profile where id = 1
      `),
    )[0];

    if (settings?.['tax_doc_enabled'] !== true) return [];

    const wanted =
      input.moment === 'payment'
        ? settings['tax_doc_on_instalment'] === true
        : settings['tax_doc_on_delivery'] === true;
    if (!wanted) return [];

    /*
     * ⚠️ `combinedReceipt` decides one paper or two, and nothing else. Thai practice is usually
     * a single "ใบเสร็จรับเงิน/ใบกำกับภาษี"; a company that keeps them apart gets both, and both
     * name the same supply. Which of the two habits is right is the accountant's answer, not
     * this service's — it is a switch in ข้อมูลบริษัท.
     */
    const kinds: readonly TaxDocumentKindWire[] =
      settings['tax_doc_combined_receipt'] === true
        ? ['tax_invoice_receipt']
        : ['receipt', 'tax_invoice'];

    const raised: TaxDocumentWire[] = [];

    for (const kind of kinds) {
      try {
        /* ⚠️ Nested → SAVEPOINT. A failure here rolls back to this point and no further. */
        const document = await tx.transaction(async (attempt) => {
          const body = await this.buildBody(attempt, {
            orderId: input.orderId,
            kind,
            instalmentId: input.instalmentId,
          });

          return this.write(attempt, {
            orderId: input.orderId,
            kind,
            instalmentId: input.instalmentId,
            body,
            actorUserId: input.actorUserId,
          });
        });

        raised.push(document);
      } catch (cause: unknown) {
        /*
         * ⚠️ Logged at `warn` and not `error`: the commonest cause is a customer who never
         * asked for a tax invoice, so no bill-to block was ever filled in. That is an ordinary
         * state of an ordinary order, not a fault. It is also, for now, the only trace — see
         * the note on this method about the list that does not exist yet.
         */
        this.logger.warn(
          `order ${input.orderId}: ${kind} not raised at ${input.moment} — ${String(cause)}`,
        );
      }
    }

    return raised;
  }

  /**
   * ⭐ Raise one.
   *
   * ⚠️ Both the number and the moment come from the database — `next_document_no()` for one,
   * `select now()` for the other — and the moment is then written to the column explicitly so
   * the face and the row cannot disagree. A service that stamps either from its own process
   * produces a document that contradicts the series it claims to belong to.
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

  /**
   * ⭐ ยกเลิกเอกสาร — strike one out, by raising the ใบลดหนี้ that reduces it.
   *
   * ── ⚠️ One act, not two ──────────────────────────────────────────────────────
   *
   * `tax_documents_freeze()` will not accept a void that does not name the document replacing
   * it, which is the schema saying what the Revenue Code says: a tax invoice is not cancelled
   * by crossing it out, it is reduced by a credit note that cites it. So this method raises the
   * credit note and marks the original in the same transaction, and there is no endpoint that
   * can do half of it.
   *
   * ── ⚠️ A full reversal, and only that ────────────────────────────────────────
   *
   * `correctedNetThbMinor` is zero: this is "that document should not have been issued", not
   * "the price changed". A partial credit note — a discount agreed after invoicing — is a
   * different act with a different conversation behind it, and giving it the same button would
   * let somebody reduce an invoice by the wrong amount while believing they had cancelled it.
   *
   * ⚠️ Voiding frees the slot. `tax_documents_one_whole_order_tax` and its two siblings are
   * partial on `status = 'issued'`, so the corrected document can be raised straight afterwards
   * — which is the whole point of striking one out.
   */
  async void(
    scope: Scope,
    orderId: string,
    documentId: string,
    input: { readonly reasonTh: string },
  ): Promise<{ readonly voidedDocumentNo: string; readonly creditNote: TaxDocumentWire }> {
    const order = await this.scoped.findOrFail(scope, orderId, 'act');

    return this.db.transaction(async (tx) => {
      const original = records(
        await tx.execute(sql`
          select id::text, kind, status, document_no, instalment_id::text,
                 net_thb_minor::text, vat_thb_minor::text, grand_total_thb_minor::text, document
            from tax_documents
           where id = ${documentId}::uuid and order_id = ${order.id}::uuid
           for update
        `),
      )[0];

      if (original === undefined) {
        throw new AppError('NOT_FOUND', 404, message('error.taxdoc.not_on_this_order'));
      }

      if (original['status'] !== 'issued') {
        throw new AppError('CONFLICT', 409, message('error.taxdoc.already_voided'));
      }

      /*
       * ⛔ A credit note is what does the reducing. Striking one out would need a second credit
       * note against it, which is not a thing — the remedy for a wrong credit note is a debit
       * note (ใบเพิ่มหนี้), which this system does not have yet.
       */
      if (original['kind'] === 'credit_note') {
        throw new AppError('VALIDATION_FAILED', 422, message('error.taxdoc.credit_note_not_voidable'));
      }

      const body = original['document'] as TaxDocumentBodyWire;
      const net = String(original['net_thb_minor']);
      const vat = String(original['vat_thb_minor']);

      const creditNote = await this.write(tx, {
        orderId: order.id,
        kind: 'credit_note',
        /*
         * ⚠️ The credit note does NOT inherit the original's `instalment_id`.
         *
         * `tax_documents_one_per_instalment_kind` is keyed on (instalment, kind) and would be
         * satisfied either way, but the deeper reason is what the column means: it says "this
         * document is the tax document for that instalment". The credit note is not — it is the
         * document that withdraws one. Copying it would make a later reader believe the
         * instalment still has a live document attached to it.
         */
        instalmentId: null,
        replacesDocumentId: String(original['id']),
        citesDocumentNo: String(original['document_no']),
        reasonTh: input.reasonTh,
        actorUserId: scope.kind === 'user' ? scope.userId : null,
        body: {
          ...body,
          bodySchemaVersion: 2,
          kind: 'credit_note',
          /* The figures are the original's, positive, with the direction carried by the kind. */
          netThbMinor: net,
          vatThbMinor: vat,
          grandTotalThbMinor: String(original['grand_total_thb_minor']),
          adjustment: {
            originalNetThbMinor: net,
            correctedNetThbMinor: '0',
            differenceThbMinor: net,
            vatOnDifferenceThbMinor: vat,
          },
        },
      });

      /*
       * ⚠️ Both columns, or the trigger refuses — and it is right to. A document marked void
       * with no replacement named is a hole in the series that nobody can explain.
       */
      await tx.execute(sql`
        update tax_documents
           set status = 'voided',
               voided_at = now(),
               voided_by_document_id = ${creditNote.id}::uuid,
               void_reason_th = ${input.reasonTh}
         where id = ${documentId}::uuid
      `);

      await tx.execute(sql`
        insert into order_events (order_id, event_type, actor_kind, actor_user_id, payload)
        values (${order.id}::uuid, 'tax_document_voided', 'staff',
                ${scope.kind === 'user' ? scope.userId : null}::uuid,
                ${JSON.stringify({
                  document_no: String(original['document_no']),
                  document_kind: String(original['kind']),
                  reason_th: input.reasonTh,
                  credit_note_no: creditNote.documentNo,
                })}::jsonb)
      `);

      return { voidedDocumentNo: String(original['document_no']), creditNote };
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

    /*
     * ⚠️ Which basis the quotation was priced on decides what the line column adds up to:
     * under `exclusive` the lines sum to the net and VAT is a row beneath them; under
     * `inclusive` they already contain the tax and sum to the grand total. Getting this
     * backwards prints a page whose own arithmetic disagrees with itself.
     */
    const basis = String(
      (quotation['document'] as { taxBasis?: unknown } | null)?.taxBasis ?? 'exclusive',
    );
    const linesSumTo = basis === 'inclusive' ? ('grand_total' as const) : ('net' as const);

    /*
     * ⚠️ An instalment document lists ONE line naming the instalment, not the order's goods.
     * Printing all four windows beside a figure that is 30% of them would be a face claiming
     * that four windows cost ฿35.31. The goods are identified by the order number, which is on
     * the page, and in full on the quotation the customer already holds.
     */
    const lines =
      subject.kind === 'instalment'
        ? [
            {
              descriptionTh: `${subject.labelTh} ตามใบเสนอราคาเลขที่ ${text(orderRow?.['order_no']) ?? '—'}`,
              quantity: 1,
              unitThbMinor: linesSumTo === 'grand_total' ? grand : net,
              amountThbMinor: linesSumTo === 'grand_total' ? grand : net,
            },
          ]
        : this.linesFrom(quotation['document']);

    return {
      bodySchemaVersion: 1,
      kind: input.kind,
      orderNo: text(orderRow?.['order_no']),
      seller: {
        buyerKind: null,
        legalName: String(seller['legal_name_th']),
        taxId: text(seller['tax_id']),
        /*
         * ⚠️ `null`, and the renderer prints สำนักงานใหญ่ — which is true of this company and is
         * not read from anywhere, because `organisation_profile` has no branch column. A second
         * branch would need one before its first document is raised, since a wrong branch on an
         * issued tax invoice cannot be corrected.
         */
        branchCode: null,
        addressLine: String(seller['address_th'] ?? ''),
        postalCode: null,
        country: 'TH',
      },
      buyer,
      subject,
      lines,
      linesSumTo,
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
   * ⛔ The face must add up, or no number is taken.
   *
   * A refusal here is a 422 somebody can act on. The alternative is a numbered, frozen document
   * whose lines sum to ฿0.00 beside a total of ฿117.70 — which is what this service did until
   * the field names in `linesFrom` were checked against `OrderDocumentLineWire`. This single
   * assertion catches every one of those four bugs at once, and any future one like them.
   *
   * ⚠️ Called from `write()` and not from `buildBody()`, because `write()` is the one door every
   * document goes through. A credit note is built from another document rather than from a
   * quotation, so a guard living in `buildBody` would have let exactly the documents that
   * correct mistakes past unchecked.
   */
  private assertFoots(body: Omit<TaxDocumentBodyWire, 'documentNo' | 'issuedAt' | 'documentHash'>): void {
    const summed = body.lines.reduce((total, line) => total + BigInt(line.amountThbMinor), 0n);
    const columnTotal =
      body.linesSumTo === 'grand_total' ? body.grandTotalThbMinor : body.netThbMinor;

    if (summed !== BigInt(columnTotal)) {
      throw new AppError(
        'VALIDATION_FAILED',
        422,
        message('error.taxdoc.lines_do_not_foot', {
          summed: thb(summed),
          total: thb(BigInt(columnTotal)),
        }),
        { linesSumTo: body.linesSumTo ?? 'net', lineCount: body.lines.length },
      );
    }
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
      buyerKind: row['buyer_kind'] === 'juristic' ? 'juristic' : 'individual',
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

  /**
   * The quotation's lines and charges, as a page prints them.
   *
   * ── ⚠️ Read the field names off `OrderDocumentLineWire`, not off intuition ────
   *
   * The first version of this function read `titleTh`, `quantity`, `unitThbMinor` and
   * `amountThbMinor`. Not one of those keys exists on a frozen quotation line: the product's
   * name is `nameTh`, the count is `qty`, and money is `netMinor`, a `MoneyWire` of the shape
   * `{ unit: 'THB.satang', digits: '11000' }` rather than a bare string. Every `??` fell through
   * to its default, so every line of every document would have printed with an empty
   * description, a quantity of 1, and a total of ฿0.00 — on a numbered document that cannot be
   * corrected after issue. `footsTo()` below is the assertion that would not let it happen
   * twice.
   *
   * ── ⚠️ Charges are lines on the face of a tax document ───────────────────────
   *
   * ค่าขนส่ง, ค่าติดตั้ง and any goodwill credit live in `document.charges`, a separate array
   * that the quotation renders separately. On a tax invoice they are supplies like any other:
   * they are inside `netThbMinor`, so a face that omits them shows a column of figures that
   * does not add up to its own total.
   */
  private linesFrom(document: unknown): TaxDocumentBodyWire['lines'] {
    const frozen = document as {
      lines?: readonly Record<string, unknown>[];
      charges?: readonly Record<string, unknown>[];
    } | null;

    /** `MoneyWire` is `{ unit, digits }`; a bare `String()` of it yields "[object Object]". */
    const satang = (money: unknown): string => {
      const digits = (money as { digits?: unknown } | null)?.digits;
      return digits === undefined || digits === null ? '0' : String(digits);
    };

    const goods = (frozen?.lines ?? []).map((line) => {
      const quantity = Number(line['qty'] ?? 1);
      const amount = satang(line['netMinor']);
      const unitPrice = (line['price'] as { unitPriceMinor?: unknown } | null)?.unitPriceMinor;

      return {
        /*
         * The product's pinned name, and the salesperson's own words for it when there are any:
         * `customerDescriptionTh` is what a customer recognises, and `nameTh` is what an
         * accountant matches against the catalogue. Both, when both exist.
         */
        descriptionTh: [line['nameTh'], line['customerDescriptionTh']]
          .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
          .join(' — '),
        quantity,
        /*
         * ⚠️ Derived from the line total rather than copied from `price.unitPriceMinor`, which
         * is the machine's figure before any human override. A line a salesperson repriced by
         * hand would otherwise print a unit price that does not multiply out to its own total.
         */
        unitThbMinor:
          quantity > 0 && unitPrice === undefined
            ? (BigInt(amount) / BigInt(quantity)).toString()
            : satang(unitPrice),
        amountThbMinor: amount,
      };
    });

    const charges = (frozen?.charges ?? []).map((charge) => ({
      descriptionTh: String(charge['customerDescriptionTh'] ?? ''),
      quantity: 1,
      unitThbMinor: satang(charge['netMinor']),
      amountThbMinor: satang(charge['netMinor']),
    }));

    return [...goods, ...charges];
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
    /* ⛔ Before the number, always. A refusal after one is taken is a hole in the series. */
    this.assertFoots(input.body);

    const numbered = records(
      await tx.execute(sql`select * from next_document_no(${SERIES_OF[input.kind]}, now())`),
    )[0];

    if (numbered === undefined) {
      throw new AppError('VALIDATION_FAILED', 422, message('error.taxdoc.no_series'));
    }

    const documentNo = String(numbered['document_no']);

    /*
     * ⚠️ The database's clock, not Node's, and the same instant is then written to the column
     * explicitly rather than left to `DEFAULT now()`.
     *
     * The JSDoc on `issue()` claimed this from the beginning and the code did not do it: the
     * body was stamped `new Date().toISOString()` while the row took the server's `now()` and
     * the number took its Buddhist year from `next_document_no(series, now())` in Asia/Bangkok.
     * Three clocks, and on a machine whose time had drifted — or at 23:59 on 31 December — the
     * face, the row and the number could disagree about what year the document belongs to.
     * Frozen, and therefore unfixable.
     */
    const issuedAt = new Date(
      String((records(await tx.execute(sql`select now() as at`))[0] ?? {})['at']),
    ).toISOString();

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
           issued_at, issued_by_user_id, created_by_event_id)
        values (${input.kind}, ${input.orderId}::uuid,
                ${input.instalmentId}::uuid, ${input.replacesDocumentId ?? null}::uuid,
                ${String(numbered['series_code'])}, ${Number(numbered['series_year'])},
                ${Number(numbered['series_seq'])}, ${documentNo},
                ${JSON.stringify(body)}::jsonb, ${body.documentHash},
                'th', ${body.vat.rateBp}, ${body.vat.treatment},
                ${body.netThbMinor}::bigint, ${body.vatThbMinor}::bigint,
                ${body.grandTotalThbMinor}::bigint,
                ${issuedAt}::timestamptz, ${input.actorUserId}::uuid, ${eventId}::uuid)
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
