'use client';

import { useState } from 'react';
import { Lock, Minus, Plus, Trash2, Undo2, UserPen } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

import { QTY_MAX, QTY_MIN, baht, measureText } from './amounts';
import { ChargeDialog } from './charge-dialog';
import { unitPriceOf, type OverrideContext } from './override-entry';
import { LineFigure } from './provenance';
import { addCharge, presentLine, removeLine, reviseQty, revokeOverride } from './quote-api';
import { liveOverrideOf, type LineView } from './quote-model';
import { measureUmOf } from './quote-wire';
import type { QuoteWriteFn } from './authority-panel';

/**
 * The editing surface: one row per line, with its computed and its effective figure.
 *
 * ### Three columns that answer three different questions
 *
 * *What is it* — the sku, the resolved selections and the measures, none of which a person
 * may retype here. *What did the machine say* and *what will the customer pay* are the same
 * cell, because putting them in two columns lets a reader compare the wrong pair; `LineFigure`
 * shows the baseline struck through beside the effective figure, so the comparison has
 * already been made for them.
 *
 * ### ⚠️ The description is for the customer and never reaches the factory
 *
 * Plan 7.9(ค): sales can type "กระจกเทมเปอร์ 8 มม." on a line whose sku says 6 mm, and a works
 * order renders from the sku and the resolved options only. apps/api makes that structural by
 * splitting the routes — `lines/:id/presentation` writes the field the factory never reads,
 * `lines/:id/revision` writes the fields it does. This table only ever calls the first one.
 *
 * ### Quantity is editable; options and measures still are not, and the two have different reasons
 *
 * Quantity was read-only for a round because `POST lines/:lineId/revision` takes a whole
 * `PriceRequestWire` and `QuoteLineWire` carried neither the `documentHash` the line is pinned
 * against nor its `productId` — so this screen could not construct a well-formed revision from
 * the quote it was served, and a hash supplied from anywhere else would have been a guess at
 * the pinned document. Both fields are on the line now and the stepper sends the line back to
 * be re-priced by `calcPrice`. No money moves with it: `+` writes a quantity and reads back
 * whatever the machine says the line now costs.
 *
 * Options and measures stay read-only for a different reason, and it is a scope decision rather
 * than a seam: changing a measure needs the product's custom-group bounds, its authored unit
 * and its step — the whole of the configurator's snapping and validation — and a second,
 * smaller answer to that is how two screens come to disagree about what can be manufactured.
 *
 * ⚠️ The stepper is absent, not disabled, on a line whose pinned version is no longer published:
 * there is no current handle to send, and `staleBaselines` already names that line with a
 * per-line recovery on it.
 *
 * ### A locked line, and why the control is disabled rather than absent
 *
 * `quote_lines_guard_write()` refuses a removal while a live `line_total` override exists,
 * because ฿17,000 for two is not ฿17,000 for three and plan 7.9(ง)(2) is the finding that
 * `quoteReducer.ts:68` drops that promise silently. The button stays on screen, disabled, with
 * the reason beside it — an absent button teaches a person nothing about why the thing they
 * wanted is impossible, and the answer here is something they can act on: withdraw the price
 * first.
 */
export function LineTable({
  orderId,
  lines,
  busy,
  mayWrite,
  onWrite,
  onOverride,
}: {
  readonly orderId: string;
  readonly lines: readonly LineView[];
  readonly busy: boolean;
  readonly mayWrite: boolean;
  readonly onWrite: QuoteWriteFn;
  readonly onOverride: (context: OverrideContext, subjectTh: string) => void;
}) {
  const [charging, setCharging] = useState(false);
  const disabled = !mayWrite || busy;

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">#</TableHead>
              <TableHead>รายการ</TableHead>
              <TableHead className="w-20 text-end">จำนวน</TableHead>
              <TableHead className="w-24">VAT</TableHead>
              <TableHead className="w-64 text-end">ยอดรวมบรรทัด</TableHead>
              <TableHead className="w-44" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((view) => (
              <LineRow
                key={view.line.id}
                orderId={orderId}
                view={view}
                disabled={disabled}
                onWrite={onWrite}
                onOverride={onOverride}
              />
            ))}
          </TableBody>
        </Table>
      </div>

      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={disabled}
        onClick={() => setCharging(true)}
      >
        <Plus data-icon="inline-start" />
        เพิ่มค่าขนส่ง / ติดตั้ง / รายการอิสระ
      </Button>

      <ChargeDialog
        open={charging}
        onOpenChange={setCharging}
        busy={busy}
        onSave={(charge) =>
          onWrite('เพิ่มรายการแล้ว', (expect) => addCharge(orderId, expect, charge))
        }
      />
    </div>
  );
}

const LOCK_REASON_TH =
  'บรรทัดนี้มีราคาที่คนตั้งไว้ — ลบทิ้งจะทำให้คำสัญญาหายไปพร้อมบริบทของมัน ให้คืนราคาที่คำนวณก่อน';

const MEASURES_REASON_TH =
  'แก้ตัวเลือกและขนาด ต้องทำจากหน้าตั้งค่าสินค้า เพราะต้องใช้ขอบเขตและสเต็ปของกลุ่มขนาดในการตรวจ';

const QTY_LOCK_REASON_TH =
  'บรรทัดนี้มีราคาที่คนตั้งไว้ — ฿17,000 สำหรับสองบานไม่ใช่ ฿17,000 สำหรับสามบาน ให้คืนราคาที่คำนวณก่อนแก้จำนวน';

const QTY_STALE_REASON_TH = 'เวอร์ชันสินค้าของบรรทัดนี้ไม่ได้เผยแพร่แล้ว — ยืนยันราคาบรรทัดนี้ก่อน';

/**
 * ⭐ The one input on this screen that changes a price without anybody typing one.
 *
 * `+` and `−` send the line back through `POST lines/:id/revision`, which re-runs `calcPrice`
 * over the same selections and measures at the new count and stores what *it* computed — plan
 * 7.9(ก)'s `computed` layer, reached from the editor rather than only from the configurator.
 * No figure travels up and none is predicted here: the new total arrives in the response.
 *
 * ### Three states, and each says something different
 *
 * *Editable* — the ordinary case. *Locked* — a live `line_total` promise hangs off this line,
 * so `quote_lines_guard_write()` refuses the write and the buttons are disabled with the
 * recovery on them (withdraw the price, then change the count). *Absent* — the line is
 * free-form, or its pinned catalogue version is no longer published, so there is no revision
 * to construct at all; `reviseQty` returns `null` for exactly these lines and the count is
 * rendered as plain text.
 *
 * The ceiling is `QTY_MAX`, imported from core rather than restated — plan 7.9(ง)(5) is the
 * finding that a duplicated `99` leaves a `+` button disabled after the real limit moves.
 */
function QtyStepper({
  orderId,
  view,
  disabled,
  onWrite,
}: {
  readonly orderId: string;
  readonly view: LineView;
  readonly disabled: boolean;
  readonly onWrite: QuoteWriteFn;
}) {
  const { line } = view;
  const revisable = line.documentHash !== null && line.productId !== null;

  if (!revisable) {
    return (
      <span title={line.skuCode === null ? undefined : QTY_STALE_REASON_TH}>{line.qty}</span>
    );
  }

  const step = (qty: number) => {
    void onWrite('แก้จำนวนแล้ว', (expect) => {
      const request = reviseQty(orderId, line, qty, expect);
      /*
       * Unreachable while `revisable` is true — the same five fields decide both. It is a
       * throw and not a `?? Promise.resolve()` because a silent no-op on a button a person
       * just pressed is the failure mode this whole screen is written against.
       */
      if (request === null) throw new Error('บรรทัดนี้แก้จำนวนไม่ได้');
      return request;
    });
  };

  const blocked = disabled || view.locked;
  const reason = view.locked ? QTY_LOCK_REASON_TH : undefined;

  return (
    <div className="flex items-center justify-end gap-1">
      <Button
        size="icon"
        variant="ghost"
        className="size-6"
        aria-label={`ลดจำนวนของบรรทัดที่ ${String(line.seq)}`}
        title={reason}
        disabled={blocked || line.qty <= QTY_MIN}
        onClick={() => step(line.qty - 1)}
      >
        <Minus />
      </Button>
      <span className="w-6 text-center">{line.qty}</span>
      <Button
        size="icon"
        variant="ghost"
        className="size-6"
        aria-label={`เพิ่มจำนวนของบรรทัดที่ ${String(line.seq)}`}
        title={reason}
        disabled={blocked || line.qty >= QTY_MAX}
        onClick={() => step(line.qty + 1)}
      >
        <Plus />
      </Button>
    </div>
  );
}

function LineRow({
  orderId,
  view,
  disabled,
  onWrite,
  onOverride,
}: {
  readonly orderId: string;
  readonly view: LineView;
  readonly disabled: boolean;
  readonly onWrite: QuoteWriteFn;
  readonly onOverride: (context: OverrideContext, subjectTh: string) => void;
}) {
  const { line } = view;
  /* Narrowed once. Re-narrowing inside a callback is how a handler ends up with an empty id. */
  const liveOverride = liveOverrideOf(view);
  const subjectTh = line.customerDescriptionTh ?? line.skuCode ?? `บรรทัดที่ ${String(line.seq)}`;

  return (
    <TableRow>
      <TableCell className="align-top tabular-nums text-muted-foreground">{line.seq}</TableCell>

      <TableCell className="align-top">
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            {line.skuCode === null ? (
              <Badge variant="secondary">รายการอิสระ — ไม่ผูกสินค้า</Badge>
            ) : (
              <Badge
                variant="outline"
                className="font-mono text-xs"
                title="รหัสที่ใบสั่งผลิตใช้ — แก้ที่นี่ไม่ได้ และไม่ได้มาจากคำอธิบายด้านล่าง"
              >
                {line.skuCode}
              </Badge>
            )}
          </div>

          {line.measures === null && line.selections === null ? null : (
            <p className="text-xs text-muted-foreground" title={MEASURES_REASON_TH}>
              {line.measures === null
                ? ''
                : Object.entries(line.measures)
                    .map(([code, measure]) => `${code} ${measureText(measureUmOf(measure))}`)
                    .join(' · ')}
              {line.selections === null
                ? ''
                : ` · ${Object.entries(line.selections)
                    .map(([group, value]) => `${group}=${value}`)
                    .join(' ')}`}
            </p>
          )}

          <DescriptionField orderId={orderId} view={view} disabled={disabled} onWrite={onWrite} />
        </div>
      </TableCell>

      <TableCell className="align-top text-end tabular-nums">
        <QtyStepper orderId={orderId} view={view} disabled={disabled} onWrite={onWrite} />
      </TableCell>

      <TableCell className="align-top">
        <label className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={line.isVatApplicable}
            disabled={disabled}
            onCheckedChange={(checked) => {
              void onWrite('แก้ความ taxable แล้ว', (expect) =>
                presentLine(orderId, line.id, expect, { isVatApplicable: checked === true }),
              );
            }}
          />
          คิด VAT
        </label>
      </TableCell>

      <TableCell className="align-top text-end">
        <LineFigure view={view} />
        {line.qty > 1 ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            หน่วยละ {baht(unitPriceOf(view.effectiveThbMinor, line.qty))} · ค่าแสดงผล บวกกันไม่ได้
          </p>
        ) : null}
      </TableCell>

      <TableCell className="align-top">
        <div className="flex flex-col items-start gap-1">
          {liveOverride === null ? (
            line.computedTotalThbMinor === null ? null : (
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => {
                  onOverride(
                    {
                      anchor: 'line_total',
                      quoteLineId: line.id,
                      computedThbMinor: view.baselineThbMinor,
                      qty: line.qty,
                    },
                    subjectTh,
                  );
                }}
              >
                <UserPen data-icon="inline-start" />
                แก้ราคา
              </Button>
            )
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              title={
                view.stale?.kind === 'promise_baseline_moved'
                  ? 'ยกเลิกเพื่อปล่อยให้ใช้ราคาใหม่ที่คำนวณได้ — นี่คือวิธียืนยันราคาหลังแคตตาล็อกเปลี่ยน'
                  : undefined
              }
              onClick={() => {
                void onWrite('ยกเลิกการแก้ราคาแล้ว', (expect) =>
                  revokeOverride(orderId, liveOverride.id, expect),
                );
              }}
            >
              <Undo2 data-icon="inline-start" />
              คืนราคาที่คำนวณ
            </Button>
          )}

          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            disabled={disabled || view.locked}
            title={view.locked ? LOCK_REASON_TH : undefined}
            onClick={() => {
              void onWrite('ลบบรรทัดแล้ว', (expect) => removeLine(orderId, line.id, expect));
            }}
          >
            <Trash2 data-icon="inline-start" />
            ลบ
          </Button>

          {view.locked ? (
            <span className="inline-flex items-start gap-1 text-xs text-muted-foreground">
              <Lock className="mt-0.5 size-3 shrink-0" />
              {LOCK_REASON_TH}
            </span>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * 📣 FOR THE CUSTOMER. The only field on a line that may be edited without a trace.
 *
 * Committed on blur rather than on every keystroke, because each commit consumes the revision
 * token and a person typing a sentence would otherwise have their own second keystroke
 * refused as `quote_stale`.
 *
 * An empty box sends `null`, which the contract defines as *clear it* — distinct from an
 * absent key, which leaves it alone. The two are different requests and this is the one that
 * says "the customer should read nothing here".
 */
function DescriptionField({
  orderId,
  view,
  disabled,
  onWrite,
}: {
  readonly orderId: string;
  readonly view: LineView;
  readonly disabled: boolean;
  readonly onWrite: QuoteWriteFn;
}) {
  const [text, setText] = useState(view.line.customerDescriptionTh ?? '');

  return (
    <Input
      value={text}
      disabled={disabled}
      placeholder="คำอธิบายที่ลูกค้าเห็น (ไม่ขึ้นใบสั่งผลิต)"
      aria-label="คำอธิบายสำหรับลูกค้า"
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        const next = text.trim();
        if (next === (view.line.customerDescriptionTh ?? '')) return;
        void onWrite('บันทึกคำอธิบายแล้ว', (expect) =>
          presentLine(orderId, view.line.id, expect, {
            customerDescriptionTh: next === '' ? null : next,
          }),
        );
      }}
    />
  );
}
