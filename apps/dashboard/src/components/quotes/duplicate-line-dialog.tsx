'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { QuoteLineWire } from '@wewin/contract/quote';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { TextField } from '@/components/products/form-field';

import { duplicateRequest, umToCm, type MeasureEntry } from './duplicate-line';
import { duplicateLine } from './quote-api';
import type { QuoteWriteFn } from './authority-panel';

/**
 * ทำสำเนารายการ — the entry point for adding a line to a quotation.
 *
 * `duplicate-line.ts` carries the argument for why adding a line is a copy rather than a
 * configurator. In short: `POST …/quote/lines` has never had a caller, so every line in this
 * system came through the storefront, and a phone order could not gain a second window.
 *
 * ⚠️ The measured groups are labelled by their catalogue code — `width`, `height` — and not by
 * a Thai name. The line carries its measures but not their labels, and the Thai label lives on
 * the product document, which this dialog does not have. Inventing one would mean guessing
 * which group a code belongs to, and a box labelled ความสูง that sets the width is worse than
 * a box labelled `height`.
 */
export function DuplicateLineDialog({
  orderId,
  line,
  onClose,
  onWrite,
}: {
  readonly orderId: string;
  readonly line: QuoteLineWire;
  readonly onClose: () => void;
  readonly onWrite: QuoteWriteFn;
}) {
  const measures = line.measures ?? {};
  const [entries, setEntries] = useState<readonly MeasureEntry[]>(() =>
    Object.entries(measures).map(([groupCode, length]) => ({
      groupCode,
      labelTh: groupCode,
      cm: umToCm(length),
    })),
  );
  const [qtyText, setQtyText] = useState(String(line.qty));
  const [busy, setBusy] = useState(false);

  const built = duplicateRequest(entries, qtyText);

  async function submit(): Promise<void> {
    if (!built.ok) return;
    if (line.productVersionId === null || line.documentHash === null || line.productId === null) {
      return;
    }
    setBusy(true);
    const ok = await onWrite('เพิ่มรายการแล้ว', (expect) =>
      duplicateLine(orderId, expect, {
        productVersionId: line.productVersionId ?? '',
        documentHash: line.documentHash ?? '',
        productId: line.productId ?? '',
        /*
         * ⭐ The selections come across untouched. The customer configured them, the catalogue
         * validated them and `priceLine` accepted them — so the copy cannot be a configuration
         * the configurator would have refused. Only the size and the count are open.
         */
        selections: line.selections ?? {},
        measures: built.measures,
        qty: built.qty,
      }),
    );
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>ทำสำเนา {line.skuCode ?? 'รายการนี้'}</DialogTitle>
          <DialogDescription>
            ตัวเลือกทั้งหมดคัดลอกมาเหมือนเดิม — แก้ได้เฉพาะขนาดและจำนวน
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {entries.map((entry, index) => (
            <TextField
              key={entry.groupCode}
              label={entry.groupCode}
              description="เซนติเมตร"
              value={entry.cm}
              onChange={(next) =>
                setEntries((current) =>
                  current.map((item, at) => (at === index ? { ...item, cm: next } : item)),
                )
              }
              mono
              disabled={busy}
            />
          ))}

          <TextField
            label="จำนวน"
            value={qtyText}
            onChange={setQtyText}
            mono
            disabled={busy}
          />

          {!built.ok && (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle>ยังเพิ่มไม่ได้</AlertTitle>
              <AlertDescription>
                <ul className="flex list-disc flex-col gap-1 pl-4">
                  {built.problems.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {/*
            The server prices the copy and may refuse it — a size outside the group's bounds, or
            off its step. That refusal arrives through `onWrite`, which is the same path every
            other write on this screen reports through.
          */}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </Button>
          <Button onClick={() => void submit()} disabled={!built.ok || busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            เพิ่มรายการ
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
