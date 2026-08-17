'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import type { TaxDocumentSettingsWire } from '@wewin/contract/forfeit';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import { failureMessage } from '@/lib/api/errors';

import { getTaxDocumentSettings, putTaxDocumentSettings } from './organisation-api';
import { editableTaxRows, mutedTaxRows } from './tax-document-rows';

/**
 * ⭐ เอกสารภาษี — whether and how this company issues tax documents.
 *
 * Every switch ships off, because a company that has not decided must not start issuing numbered
 * documents because a default said so. Turning the first one on is a decision somebody makes
 * once, with their bookkeeper in the room.
 *
 * ── ⚠️ The warning beside `onDelivery` is the whole reason this screen has prose ──
 *
 * The owner was told that issuing a single document at delivery can under-declare output VAT
 * when a deposit was taken earlier — the tax point on that money has already passed — and chose
 * to keep both switches independent: *"เปิดอิสระทั้งสองสวิตช์ ตามที่สั่งเดิม"*. So the system
 * permits the combination and says what it means, right where it is chosen. A warning filed in a
 * commit message is a warning nobody reads at the moment it matters.
 *
 * ⚠️ Nothing here decides anything about tax. It states what was explained, and points at the
 * one person who can answer it — which is not this software and not the person writing it.
 */
export function TaxDocumentSection() {
  const [state, setState] = useState<
    | { readonly status: 'loading' }
    | { readonly status: 'failed'; readonly problem: string }
    | { readonly status: 'ready'; readonly settings: TaxDocumentSettingsWire }
  >({ status: 'loading' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getTaxDocumentSettings()
      .then((settings) => setState({ status: 'ready', settings }))
      .catch((cause: unknown) => setState({ status: 'failed', problem: failureMessage(cause) }));
  }, []);

  const save = async (next: TaxDocumentSettingsWire): Promise<void> => {
    setBusy(true);
    try {
      const saved = await putTaxDocumentSettings(next);
      setState({ status: 'ready', settings: saved });
      toast.success('บันทึกการตั้งค่าเอกสารภาษีแล้ว');
    } catch (cause: unknown) {
      toast.error(failureMessage(cause));
      /* Re-read rather than keep the failed shape on screen: the server is what decides. */
      const settings = await getTaxDocumentSettings().catch(() => null);
      if (settings !== null) setState({ status: 'ready', settings });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="type-section">เอกสารภาษี</h2>
        <p className="text-muted-foreground type-body max-w-3xl">
          ใบกำกับภาษี ใบเสร็จรับเงิน และใบแจ้งหนี้ — ปิดอยู่ทั้งหมดจนกว่าจะเปิดที่นี่
          เอกสารที่ออกไปแล้วแก้ไม่ได้และลบไม่ได้ ยกเลิกได้ด้วยใบลดหนี้เท่านั้น
        </p>
      </div>

      {state.status === 'loading' && <Skeleton className="h-56 w-full" />}

      {state.status === 'failed' && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>โหลดการตั้งค่าเอกสารภาษีไม่สำเร็จ</AlertTitle>
          <AlertDescription>{state.problem}</AlertDescription>
        </Alert>
      )}

      {state.status === 'ready' && (
        <TaxDocumentRows settings={state.settings} busy={busy} save={save} />
      )}
    </section>
  );
}

/**
 * ⚠️ Which rows may be clicked and which merely read as not-yet-in-force is decided in
 * `tax-document-rows.ts`, not here, because that file is a `.ts` the suite can run: vitest is
 * `environment: 'node'` in this app and never renders a `.tsx`. Deciding it inline is how the
 * deadlock got in — the master switch was unreachable and nothing went red.
 */
function TaxDocumentRows({
  settings,
  busy,
  save,
}: {
  readonly settings: TaxDocumentSettingsWire;
  readonly busy: boolean;
  readonly save: (next: TaxDocumentSettingsWire) => Promise<void>;
}) {
  const editable = editableTaxRows(settings);
  const muted = mutedTaxRows(settings);

  const rowProps = (key: keyof TaxDocumentSettingsWire) => ({
    checked: settings[key],
    disabled: busy || !editable.includes(key),
    muted: muted.includes(key),
    onChange: (next: boolean) => void save({ ...settings, [key]: next }),
  });

  return (
    <div className="flex flex-col gap-4">
      <Row
        label="เปิดใช้เอกสารภาษี"
        hint={
          settings.enabled
            ? 'สวิตช์หลัก — ปิดเมื่อไรก็หยุดออกเอกสารทันที'
            : 'สวิตช์หลัก — เลือกจังหวะที่จะออกข้างล่างอย่างน้อยหนึ่งอย่างก่อน แล้วจึงเปิดที่นี่'
        }
        {...rowProps('enabled')}
      />

      <Row
        label="ออกทุกครั้งที่รับเงิน (รายงวด)"
        hint="รับมัดจำออกใบหนึ่ง รับงวดสุดท้ายออกอีกใบ — ตรงกับจังหวะที่รับเงินจริง"
        {...rowProps('onInstalment')}
      />

      <div className="flex flex-col gap-2">
        <Row
          label="ออกใบเดียวตอนส่งมอบ"
          hint="ออกครั้งเดียวเมื่อส่งมอบและชำระครบ"
          {...rowProps('onDelivery')}
        />

        {/*
         * ⚠️ Shown only when the combination it is about is actually chosen. A warning that
         * is always on screen is a warning that is never read.
         */}
        {settings.onDelivery && !settings.onInstalment && (
          <Alert>
            <AlertTriangle className="size-4" />
            <AlertTitle>ตรวจกับผู้ทำบัญชีก่อน</AlertTitle>
            <AlertDescription>
              ถ้าเก็บมัดจำก่อนส่งมอบ จุดรับรู้ภาษีของเงินก้อนนั้นเกิดตั้งแต่วันที่รับเงิน —
              การรอออกใบเดียวตอนส่งมอบจึงอาจแจ้งภาษีขายช้ากว่าที่ควร
              ถ้างานส่วนใหญ่เก็บมัดจำ ให้เปิด “ออกทุกครั้งที่รับเงิน” ด้วย
            </AlertDescription>
          </Alert>
        )}
      </div>

      <Row
        label="รวมใบเสร็จรับเงินกับใบกำกับภาษีเป็นใบเดียว"
        hint="ธรรมเนียมไทยส่วนใหญ่ออกรวมเป็น “ใบเสร็จรับเงิน/ใบกำกับภาษี” ใบเดียว"
        {...rowProps('combinedReceipt')}
      />

      <Row
        label="ออกใบแจ้งหนี้เมื่อลูกค้าขอ"
        hint="สำหรับลูกค้าที่ต้องวางบิลก่อนจ่าย — ออกแยกจากใบกำกับภาษี"
        {...rowProps('invoiceOnDemand')}
      />

      <Row
        label="อนุญาตใบกำกับภาษีอย่างย่อ"
        hint="สำหรับขายปลีกหน้าร้าน — ไม่ต้องมีชื่อและที่อยู่ผู้ซื้อ ใช้ได้เฉพาะกิจการที่มีสิทธิ์"
        {...rowProps('abbreviatedAllowed')}
      />
    </div>
  );
}

/**
 * ⚠️ `muted` is not `disabled`, and the difference is the whole reason this screen works.
 *
 * The API refuses “on with no moment chosen”, so a screen that greys the moments out until the
 * master switch is on is a screen where the master switch can never be turned on — a deadlock
 * that no test in this repo could have found, because none of them render a `.tsx`. The moments
 * stay editable while the master is off; they simply read as not-yet-in-force.
 */
function Row({
  label,
  hint,
  checked,
  disabled,
  muted = false,
  onChange,
}: {
  readonly label: string;
  readonly hint: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly muted?: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onChange(next === true)}
        aria-label={label}
        className="mt-1"
      />
      <div className="flex flex-col gap-0.5">
        <span className={muted ? 'text-muted-foreground type-body' : 'type-body'}>{label}</span>
        <span className="text-muted-foreground type-caption">{hint}</span>
      </div>
    </div>
  );
}
