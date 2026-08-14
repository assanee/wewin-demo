'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { AdminOptionGroupWire } from '@wewin/contract/admin';

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
import { failureMessage } from '@/components/products/catalog-api';

import { updateOptionGroup } from './option-group-api';

/**
 * Renaming a group.
 *
 * Two fields, and that is the whole of what `UpdateOptionGroupRequestWire` accepts. The
 * immutable four are shown read-only rather than omitted: somebody who opens this dialog
 * looking for "change the code" needs to see the code and see that it cannot be changed,
 * not fail to find it and wonder whether they are on the wrong screen.
 *
 * ⚠️ **A rename reaches every product that cites this group** — the vocabulary is shared,
 * not copied. It does not reach a *customer* until somebody publishes a version, because
 * the published document froze the label it was compiled with. Both halves of that are said
 * out loud below, because "did my change go live?" has a different answer here than on the
 * availability switch two components over.
 */
export function EditGroupDialog({
  group,
  onClose,
  onSaved,
}: {
  readonly group: AdminOptionGroupWire;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const [labelTh, setLabelTh] = useState(group.labelTh);
  const [helperTh, setHelperTh] = useState(group.helperTh ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const changed = labelTh.trim() !== group.labelTh || helperTh.trim() !== (group.helperTh ?? '');

  async function submit(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await updateOptionGroup(group.code, {
        labelTh: labelTh.trim(),
        /*
         * `''` and not `undefined` to clear it: `undefined` is omitted from the JSON body and
         * the endpoint would read that as "leave it alone", so a person deleting the helper
         * text would watch it come straight back.
         */
        helperTh: helperTh.trim(),
      });
      onSaved();
    } catch (cause) {
      setProblem(failureMessage(cause));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>แก้ไข {group.labelTh}</DialogTitle>
          <DialogDescription>
            ชื่อที่แก้จะใช้กับทุกสินค้าที่หยิบกลุ่มนี้ไปใช้ — แต่ลูกค้าจะเห็นก็ต่อเมื่อมีการเผยแพร่เวอร์ชันใหม่
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

          <TextField label="ชื่อที่แสดง" value={labelTh} onChange={setLabelTh} disabled={busy} />

          <TextField
            label="คำอธิบายกำกับ"
            description="ลบข้อความออกทั้งหมดเพื่อไม่ให้แสดงคำอธิบาย"
            value={helperTh}
            onChange={setHelperTh}
            disabled={busy}
            multiline
          />

          {/* Read-only, deliberately present. See the header. */}
          <div className="border-border/60 text-muted-foreground grid grid-cols-2 gap-3 rounded-lg border border-dashed type-body p-3">
            <div>
              <p className="type-caption">รหัสกลุ่ม</p>
              <code>{group.code}</code>
            </div>
            <div>
              <p className="type-caption">ชนิด · รูปแบบ</p>
              <span>
                {group.kind} · {group.input}
              </span>
            </div>
            <div>
              <p className="type-caption">อยู่ในรหัส SKU</p>
              <span>{group.includeInSkuCode ? 'ใช่' : 'ไม่'}</span>
            </div>
            <div>
              <p className="type-caption">หน่วยที่เขียน</p>
              <span>{group.authoredUnit ?? '—'}</span>
            </div>
            <p className="type-caption col-span-2">
              สี่ค่านี้แก้ไม่ได้ — รหัส SKU ที่ออกไปแล้วต้องหมายถึงของเดิมเสมอ
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !changed || labelTh.trim() === ''}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            บันทึก
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
