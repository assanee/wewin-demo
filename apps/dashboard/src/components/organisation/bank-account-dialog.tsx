'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { BankAccountWire } from '@wewin/contract/organisation';

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
import { failureMessage } from '@/lib/api/errors';

import {
  bankAccountCreateRequest,
  bankAccountFormErrors,
  bankAccountFormReady,
  bankAccountPatchRequest,
  fieldsFromAccount,
  type BankAccountFields,
} from './bank-account-form';
import { createBankAccount, patchBankAccount } from './organisation-api';

const EMPTY: BankAccountFields = {
  bankCode: '',
  accountNumber: '',
  accountName: '',
  promptpayId: '',
};

/**
 * Adding or editing one receiving account.
 *
 * ⚠️ **A save is always the whole form, never a diff.** `bank-account-form.ts`'s
 * `bankAccountPatchRequest` explains why a partial patch would make a cleared promptpay id
 * un-clearable; this dialog is what makes that true in practice, by always reading every field
 * out of `fields` rather than tracking which one the person actually touched.
 *
 * There is no confirmation step for an edit, unlike `SuspendDialog`'s required reason —
 * editing a bank account is reversible in the one sense that matters here: every write lands
 * in `bank_account_changes` with the previous values still readable from `ประวัติ`, which is
 * the control this screen leans on instead of a second click.
 */
export function BankAccountDialog({
  account,
  onClose,
  onSaved,
}: {
  /** `null` to add a new account. */
  readonly account: BankAccountWire | null;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const editing = account !== null;
  const [fields, setFields] = useState<BankAccountFields>(() =>
    account === null ? EMPTY : fieldsFromAccount(account),
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const set = (key: keyof BankAccountFields) => (value: string) => {
    setFields((current) => ({ ...current, [key]: value }));
  };

  const errors = bankAccountFormErrors(fields);
  const ready = bankAccountFormReady(fields);

  async function submit(): Promise<void> {
    if (!ready) return;
    setBusy(true);
    setProblem(null);
    try {
      if (account === null) {
        await createBankAccount(bankAccountCreateRequest(fields));
      } else {
        await patchBankAccount(account.id, bankAccountPatchRequest(fields));
      }
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
          <DialogTitle>{editing ? 'แก้ไขบัญชีธนาคาร' : 'เพิ่มบัญชีธนาคาร'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'การแก้ไขจะถูกบันทึกไว้ในประวัติของบัญชีนี้ พร้อมชื่อผู้แก้และเวลาที่แก้'
              : 'บัญชีนี้จะแสดงให้ลูกค้าเห็นเป็นทางเลือกสำหรับโอนเงินทันที'}
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

          <TextField
            label="รหัสธนาคาร"
            description="ตัวพิมพ์ใหญ่ 3–8 ตัว เช่น SCB, KBANK, BBL"
            value={fields.bankCode}
            onChange={set('bankCode')}
            error={errors.bankCode}
            mono
            disabled={busy}
            placeholder="SCB"
          />

          <TextField
            label="เลขบัญชี"
            description="ตัวเลข 10–15 หลัก ไม่มีขีดหรือเว้นวรรค"
            value={fields.accountNumber}
            onChange={set('accountNumber')}
            error={errors.accountNumber}
            mono
            disabled={busy}
          />

          <TextField
            label="ชื่อบัญชี"
            value={fields.accountName}
            onChange={set('accountName')}
            disabled={busy}
          />

          <TextField
            label="พร้อมเพย์"
            /* The leading zero, said *before* the field is wrong rather than only after —
               "10 หลัก" was true of `1234567890`, which is how it came to be typed and
               stored. The hint and `bankAccountFormErrors`' message now say the same thing. */
            description="ไม่บังคับ — เบอร์มือถือ 10 หลักขึ้นต้นด้วย 0 หรือเลขผู้เสียภาษี 13 หลัก"
            value={fields.promptpayId}
            onChange={set('promptpayId')}
            error={errors.promptpayId}
            mono
            disabled={busy}
          />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !ready}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {editing ? 'บันทึก' : 'เพิ่มบัญชี'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
