'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { toast } from 'sonner';
import { TAX_DOCUMENT_CAPTION_TH } from '@wewin/core/tax-document';
import type { TaxDocumentKindWire, TaxDocumentWire } from '@wewin/contract/forfeit';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { failureMessage } from '@/lib/api/errors';

import { Input } from '@/components/ui/input';

import { getTaxDocuments, issueTaxDocument, voidTaxDocument } from './order-api';

/**
 * ⭐ เอกสารภาษี — the numbered documents raised against this order, and the button that raises
 * one.
 *
 * ── ⚠️ Why the button asks before it acts ────────────────────────────────────
 *
 * Everything else on this screen can be undone. This cannot: the document takes a number out of
 * a series that may not have holes, and `tax_documents_freeze()` makes the row uncorrectable
 * afterwards. The remedy for a wrong one is a credit note and a second number, which is a thing
 * an accountant has to explain. So the action is a two-step confirm with the caption spelled
 * out — not because a dialog prevents mistakes, but because a mis-click should not be able to
 * mint a legal document.
 *
 * ⚠️ Only three kinds are offered here. ใบกำกับภาษีอย่างย่อ is for over-the-counter retail and
 * is gated behind its own setting; ใบลดหนี้ is what voiding produces and is never raised on its
 * own. Offering them all would suggest they are interchangeable.
 */
const OFFERED_KINDS: readonly TaxDocumentKindWire[] = [
  'tax_invoice_receipt',
  'tax_invoice',
  'invoice',
];

export function TaxDocumentCard({
  orderId,
  mayWrite,
}: {
  readonly orderId: string;
  readonly mayWrite: boolean;
}) {
  const [documents, setDocuments] = useState<readonly TaxDocumentWire[] | null>(null);
  const [confirming, setConfirming] = useState<TaxDocumentKindWire | null>(null);
  /** Which document is being struck out, and the reason typed so far. */
  const [striking, setStriking] = useState<{ id: string; no: string; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = (): void => {
    void getTaxDocuments(orderId)
      .then(setDocuments)
      .catch(() => {
        /* The order screen shows the error; an empty card is the honest fallback here. */
      });
  };

  useEffect(reload, [orderId]);

  const raise = async (kind: TaxDocumentKindWire): Promise<void> => {
    setBusy(true);
    try {
      const raised = await issueTaxDocument(orderId, { kind, instalmentId: null });
      setConfirming(null);
      reload();
      toast.success(`ออก ${TAX_DOCUMENT_CAPTION_TH[kind]} เลขที่ ${raised.documentNo} แล้ว`);
    } catch (cause: unknown) {
      toast.error(failureMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const strike = async (): Promise<void> => {
    if (striking === null) return;
    setBusy(true);
    try {
      const { creditNote } = await voidTaxDocument(orderId, striking.id, striking.reason);
      setStriking(null);
      reload();
      toast.success(`ยกเลิก ${striking.no} แล้ว — ออกใบลดหนี้ ${creditNote.documentNo}`);
    } catch (cause: unknown) {
      toast.error(failureMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <h3 className="type-section">เอกสารภาษี</h3>

      {documents === null ? null : documents.length === 0 ? (
        <p className="text-muted-foreground type-body">
          ยังไม่ได้ออกเอกสารภาษีสำหรับออเดอร์นี้
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {documents.map((document) => (
            <li key={document.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-sm">{document.documentNo}</span>
              <span className="type-body">{TAX_DOCUMENT_CAPTION_TH[document.kind]}</span>
              {document.status === 'voided' && <Badge variant="destructive">ยกเลิกแล้ว</Badge>}
              <Link
                href={`/orders/${orderId}/documents/${document.id}` as Route}
                className="text-muted-foreground hover:text-foreground text-sm underline"
              >
                เปิด / พิมพ์
              </Link>
              {/*
                ⚠️ Offered only on a live document that is not itself a credit note. A credit
                note is what does the reducing; the remedy for a wrong one is a ใบเพิ่มหนี้,
                which this system does not have — so there is no button that pretends otherwise.
              */}
              {mayWrite && document.status === 'issued' && document.kind !== 'credit_note' && (
                <button
                  type="button"
                  onClick={() =>
                    setStriking({ id: document.id, no: document.documentNo, reason: '' })
                  }
                  className="text-muted-foreground hover:text-destructive focus-visible:outline-ring rounded text-sm underline focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  ยกเลิก
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {striking !== null && (
        <div className="border-destructive/40 flex flex-col gap-2 rounded-md border p-3">
          <p className="type-body">
            ยกเลิก <strong>{striking.no}</strong>?
          </p>
          <p className="text-muted-foreground type-caption">
            เอกสารที่ออกแล้วลบไม่ได้ — ระบบจะออกใบลดหนี้อ้างถึงใบนี้ แล้วทำเครื่องหมายว่ายกเลิก
            ทั้งสองใบยังอยู่ในชุดเลขที่ตามเดิม
          </p>
          <Input
            value={striking.reason}
            onChange={(event) =>
              setStriking((was) => (was === null ? was : { ...was, reason: event.target.value }))
            }
            placeholder="เหตุผลที่ยกเลิก เช่น ออกผิดชื่อผู้ซื้อ"
            aria-label="เหตุผลที่ยกเลิก"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={busy || striking.reason.trim() === ''}
              onClick={() => void strike()}
            >
              ยืนยันยกเลิกและออกใบลดหนี้
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setStriking(null)}>
              ไม่ยกเลิก
            </Button>
          </div>
        </div>
      )}

      {mayWrite &&
        striking === null &&
        (confirming === null ? (
          <div className="flex flex-wrap gap-2">
            {OFFERED_KINDS.map((kind) => (
              <Button key={kind} size="sm" variant="outline" onClick={() => setConfirming(kind)}>
                ออก{TAX_DOCUMENT_CAPTION_TH[kind]}
              </Button>
            ))}
          </div>
        ) : (
          <div className="border-destructive/40 flex flex-col gap-2 rounded-md border p-3">
            <p className="type-body">
              ออก <strong>{TAX_DOCUMENT_CAPTION_TH[confirming]}</strong> สำหรับยอดทั้งใบ?
            </p>
            <p className="text-muted-foreground type-caption">
              เอกสารจะได้เลขที่ถาวรทันที แก้ไขและลบไม่ได้ ถ้าออกผิดต้องยกเลิกด้วยใบลดหนี้
            </p>
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => void raise(confirming)}>
                ยืนยันออกเอกสาร
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setConfirming(null)}
              >
                ยกเลิก
              </Button>
            </div>
          </div>
        ))}
    </div>
  );
}
