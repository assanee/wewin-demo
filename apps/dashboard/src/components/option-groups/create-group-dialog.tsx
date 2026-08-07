'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { CreateOptionGroupRequestWire } from '@wewin/contract/admin';

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
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { SelectField, TextField } from '@/components/products/form-field';
import { failureMessage } from '@/components/products/catalog-api';

import { createOptionGroup } from './option-group-api';

/**
 * Creating a group.
 *
 * ⚠️ **Four of these six fields can never be changed afterwards**, and the dialog says so
 * rather than discovering it later: `UpdateOptionGroupRequestWire` carries only `labelTh`
 * and `helperTh`. `code` and `includeInSkuCode` are ingredients of a SKU string that gets
 * printed on quotations and stamped onto order lines, and `kind`/`input` decide what a
 * value even means. Getting them wrong means creating a second group and migrating the
 * products that cite the first — so the warning belongs at the moment of choosing, where it
 * still costs nothing.
 */
export function CreateGroupDialog({
  onClose,
  onCreated,
}: {
  readonly onClose: () => void;
  readonly onCreated: () => void;
}) {
  const [code, setCode] = useState('');
  const [labelTh, setLabelTh] = useState('');
  const [helperTh, setHelperTh] = useState('');
  const [kind, setKind] = useState<'sku' | 'custom'>('sku');
  const [input, setInput] = useState<'swatch' | 'chip' | 'toggle' | 'number'>('chip');
  const [includeInSkuCode, setIncludeInSkuCode] = useState(false);
  const [authoredUnit, setAuthoredUnit] = useState<'cm' | 'mm'>('cm');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /*
   * The two shapes the API's CHECK constraints allow, restated here so the form cannot
   * offer a combination that will be refused: a `sku` group uses swatch/chip/toggle and has
   * no unit; a `custom` group uses `number` and must name the unit its bounds are written
   * in. `error.catalog.sku_group_shape` and `error.catalog.custom_group_shape` are the two
   * refusals this prevents, and preventing them beats translating them.
   */
  const measuring = kind === 'custom';
  const inputOptions = measuring
    ? [{ value: 'number', labelTh: 'number — ช่องกรอกตัวเลข' }]
    : [
        { value: 'chip', labelTh: 'chip — ปุ่มข้อความ' },
        { value: 'swatch', labelTh: 'swatch — ปุ่มสี' },
        { value: 'toggle', labelTh: 'toggle — เปิด/ปิด' },
      ];

  async function submit(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const request: CreateOptionGroupRequestWire = {
        code: code.trim(),
        kind,
        labelTh: labelTh.trim(),
        input: measuring ? 'number' : input,
        includeInSkuCode,
        ...(measuring ? { authoredUnit } : {}),
        ...(helperTh.trim() === '' ? {} : { helperTh: helperTh.trim() }),
      };
      await createOptionGroup(request);
      onCreated();
    } catch (cause) {
      setProblem(failureMessage(cause));
      setBusy(false);
    }
  }

  const ready = code.trim() !== '' && labelTh.trim() !== '';

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>สร้างชุดตัวเลือกใหม่</DialogTitle>
          <DialogDescription>
            กลุ่มนี้จะใช้ร่วมกันทุกสินค้า — สินค้าแต่ละเวอร์ชันเลือกหยิบเฉพาะตัวเลือกที่ต้องการ
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {problem !== null && (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle>สร้างไม่สำเร็จ</AlertTitle>
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          )}

          <Alert>
            <AlertTitle>รหัส ชนิด รูปแบบ และการอยู่ใน SKU แก้ทีหลังไม่ได้</AlertTitle>
            <AlertDescription>
              รหัสกลุ่มถูกประกอบเป็นรหัส SKU ที่พิมพ์อยู่บนใบเสนอราคาและถูกบันทึกไว้กับรายการสั่งซื้อแล้ว
              — เปลี่ยนทีหลังจะทำให้รหัสเดิมหมายถึงของคนละอย่าง · แก้ได้เฉพาะชื่อและคำอธิบาย
            </AlertDescription>
          </Alert>

          <TextField
            label="รหัสกลุ่ม"
            description="ตัวพิมพ์เล็ก ตัวเลข และขีดล่าง เช่น profile_color"
            value={code}
            onChange={setCode}
            mono
            disabled={busy}
            placeholder="profile_color"
          />

          <TextField
            label="ชื่อที่แสดง"
            value={labelTh}
            onChange={setLabelTh}
            disabled={busy}
            placeholder="สีโปรไฟล์อะลูมิเนียม"
          />

          <TextField
            label="คำอธิบายกำกับ"
            description="ไม่บังคับ — ข้อความสั้นๆ ใต้หัวข้อในหน้าสินค้า"
            value={helperTh}
            onChange={setHelperTh}
            disabled={busy}
            multiline
          />

          <SelectField
            label="ชนิด"
            description="ตัวเลือก = ลูกค้าเลือกจากรายการ · วัดขนาด = ลูกค้ากรอกตัวเลข"
            value={kind}
            onChange={(next) => {
              const chosen = next as 'sku' | 'custom';
              setKind(chosen);
              // Kept consistent as the kind changes, so the form can never submit a
              // combination the schema refuses.
              setInput(chosen === 'custom' ? 'number' : 'chip');
            }}
            disabled={busy}
            options={[
              { value: 'sku', labelTh: 'ตัวเลือก (sku)' },
              { value: 'custom', labelTh: 'วัดขนาด (custom)' },
            ]}
          />

          <SelectField
            label="รูปแบบการกรอก"
            value={measuring ? 'number' : input}
            onChange={(next) => setInput(next as 'swatch' | 'chip' | 'toggle' | 'number')}
            disabled={busy || measuring}
            options={inputOptions}
          />

          {measuring && (
            <SelectField
              label="หน่วยที่ใช้เขียนช่วงขนาด"
              description="เก็บจริงเป็นไมโครเมตรเสมอ — หน่วยนี้คือหน่วยที่คนอ่านและกรอก"
              value={authoredUnit}
              onChange={(next) => setAuthoredUnit(next as 'cm' | 'mm')}
              disabled={busy}
              options={[
                { value: 'cm', labelTh: 'cm — เซนติเมตร' },
                { value: 'mm', labelTh: 'mm — มิลลิเมตร' },
              ]}
            />
          )}

          {!measuring && (
            <div className="flex items-start gap-3">
              <Checkbox
                id="include-in-sku"
                checked={includeInSkuCode}
                onCheckedChange={(next) => setIncludeInSkuCode(next === true)}
                disabled={busy}
              />
              <div className="flex flex-col gap-1">
                <Label htmlFor="include-in-sku">ให้ตัวเลือกนี้ปรากฏในรหัส SKU</Label>
                <p className="text-muted-foreground text-sm">
                  เปิดเมื่อค่าที่ลูกค้าเลือกทำให้เป็นสินค้าคนละตัวในสายผลิต
                </p>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !ready}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            สร้างกลุ่ม
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
