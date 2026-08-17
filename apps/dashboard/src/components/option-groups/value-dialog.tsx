'use client';

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { AdminOptionValueWire } from '@wewin/contract/admin';
import type { PriceDeltaWire } from '@wewin/contract';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SelectField, TextField } from '@/components/products/form-field';
import { failureMessage } from '@/components/products/catalog-api';
import { deltaWire } from '@/components/products/wire';
import { amountFieldText, readDeltaBaht, readDeltaPercent } from './delta-field';

import { createOptionValue, updateOptionValue } from './option-group-api';

/**
 * Adding or editing one value.
 *
 * ── Money never becomes a `number` on this path ──────────────────────────────────
 *
 * The field holds text, `readBaht`/`readPercent` turn it into a `bigint`, and `deltaWire`
 * encodes it. There is no `parseFloat` and no `Number(...)` anywhere between the keyboard
 * and the request — which is the same rule the whole codebase follows for money, and it is
 * load-bearing rather than stylistic: a per-square-metre rate is satang per m², a percent is
 * basis points, and the one thing that must never happen is 8% and ฿8 sharing a code path
 * because both looked like `8` for a moment.
 *
 * ── The two shapes a delta can take, and the one it cannot ───────────────────────
 *
 * `none` carries no amount at all, so the amount field disappears rather than being
 * disabled with a stale figure in it. The API's CHECK is `error.catalog.delta_shape`; the
 * form is arranged so it cannot be reached.
 */
export function ValueDialog({
  groupCode,
  value,
  nextSortOrder,
  onClose,
  onSaved,
}: {
  readonly groupCode: string;
  /** `null` to add a new value. */
  readonly value: AdminOptionValueWire | null;
  readonly nextSortOrder: number;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const editing = value !== null;

  const [code, setCode] = useState(value?.code ?? '');
  const [labelTh, setLabelTh] = useState(value?.labelTh ?? '');
  const [swatchHex, setSwatchHex] = useState(value?.swatchHex ?? '');
  const [type, setType] = useState<PriceDeltaWire['type']>(value?.delta.type ?? 'none');
  const [amount, setAmount] = useState(() => amountFieldText(value?.delta));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const needsAmount = type !== 'none';
  const parsed = needsAmount
    ? type === 'percent'
      ? readDeltaPercent(amount)
      : readDeltaBaht(amount)
    : null;
  const amountError = parsed !== null && !parsed.ok ? parsed.reasonTh : undefined;

  /*
   * `#RRGGBB` or empty, checked here because the schema's regex refuses anything else and a
   * refusal that arrives as a 422 after pressing Save is a worse way to learn it. Empty is
   * legal — a chip has no colour.
   */
  const hexError =
    swatchHex.trim() !== '' && !/^#[0-9a-fA-F]{6}$/.test(swatchHex.trim())
      ? 'ต้องเป็นรหัสสีแบบ #RRGGBB'
      : undefined;

  async function submit(): Promise<void> {
    if (parsed !== null && !parsed.ok) return;
    setBusy(true);
    setProblem(null);

    const delta: PriceDeltaWire =
      parsed === null || !parsed.ok ? { type: 'none' } : deltaWire(type, parsed.value);
    const hex = swatchHex.trim();

    try {
      if (editing) {
        await updateOptionValue(groupCode, value.code, {
          labelTh: labelTh.trim(),
          delta,
          ...(hex === '' ? {} : { swatchHex: hex }),
        });
      } else {
        await createOptionValue(groupCode, {
          code: code.trim(),
          labelTh: labelTh.trim(),
          delta,
          sortOrder: nextSortOrder,
          ...(hex === '' ? {} : { swatchHex: hex }),
        });
      }
      onSaved();
    } catch (cause) {
      setProblem(failureMessage(cause));
      setBusy(false);
    }
  }

  const ready =
    labelTh.trim() !== '' &&
    (editing || code.trim() !== '') &&
    amountError === undefined &&
    hexError === undefined;

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `แก้ไข ${value.labelTh}` : 'เพิ่มตัวเลือก'}</DialogTitle>
          <DialogDescription>
            ส่วนเพิ่มราคาจะมีผลกับสินค้าทุกตัวที่หยิบตัวเลือกนี้ไปใช้ เมื่อเผยแพร่เวอร์ชันใหม่
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {problem !== null && (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle>บันทึกไม่สำเร็จ</AlertTitle>
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          )}

          {editing ? (
            <div className="border-border/60 text-muted-foreground rounded-lg border border-dashed type-body p-3">
              <p className="type-caption">รหัสตัวเลือก</p>
              <code>{value.code}</code>
              <p className="type-caption mt-1">
                แก้ไม่ได้ — รหัสนี้ถูกประกอบอยู่ในรหัส SKU ที่ออกใบเสนอราคาไปแล้ว
              </p>
            </div>
          ) : (
            <TextField
              label="รหัสตัวเลือก"
              description="ตัวพิมพ์ใหญ่หรือเล็ก ตัวเลข และขีดล่าง เช่น DW หรือ GRN"
              value={code}
              onChange={setCode}
              mono
              disabled={busy}
            />
          )}

          <TextField label="ชื่อที่แสดง" value={labelTh} onChange={setLabelTh} disabled={busy} />

          <div className="flex items-end gap-3">
            <div className="flex-1">
              <TextField
                label="รหัสสี"
                description="ไม่บังคับ — ใส่เมื่อรูปแบบการกรอกเป็น swatch"
                value={swatchHex}
                onChange={setSwatchHex}
                mono
                disabled={busy}
                placeholder="#8A8F98"
                error={hexError}
              />
            </div>
            {hexError === undefined && swatchHex.trim() !== '' && (
              <span
                className="border-border mb-1 inline-block size-9 shrink-0 rounded border"
                style={{ backgroundColor: swatchHex.trim() }}
                aria-label={`ตัวอย่างสี ${swatchHex.trim()}`}
              />
            )}
          </div>

          <SelectField
            label="ส่วนเพิ่มราคา"
            value={type}
            onChange={(next) => {
              const chosen = next as PriceDeltaWire['type'];
              setType(chosen);
              // Cleared on every change of arm. Carrying "8" from a percent across to baht
              // would offer ฿8 as though somebody had typed it.
              setAmount('');
            }}
            disabled={busy}
            options={[
              { value: 'none', labelTh: 'ไม่มีส่วนเพิ่ม' },
              { value: 'flat', labelTh: 'บาทต่อชุด' },
              { value: 'per_sqm', labelTh: 'บาทต่อตารางเมตร' },
              { value: 'percent', labelTh: 'เปอร์เซ็นต์ของราคาฐาน' },
            ]}
          />

          {needsAmount && (
            <TextField
              label={type === 'percent' ? 'เปอร์เซ็นต์' : 'จำนวนเงิน'}
              description={
                type === 'percent'
                  ? 'จำนวนเต็มเปอร์เซ็นต์ · ติดลบได้เพื่อเป็นส่วนลด'
                  : 'จำนวนเต็มบาท ไม่มีสตางค์ · ติดลบได้เพื่อเป็นส่วนลด'
              }
              value={amount}
              onChange={setAmount}
              disabled={busy}
              error={amountError}
              suffix={type === 'percent' ? '%' : type === 'per_sqm' ? '฿/ตร.ม.' : '฿'}
            />
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !ready}>
            {busy && <Spinner />}
            {editing ? 'บันทึก' : 'เพิ่มตัวเลือก'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

