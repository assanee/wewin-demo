'use client';

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';

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
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { failureMessage } from '@/components/products/catalog-api';

import { suspendUser, type UserSummary } from './user-api';

/**
 * Banning somebody, with the reason it took.
 *
 * ⚠️ **The reason is required and it is not stored on the row.** `users` has nowhere to put
 * one — adding a column is a migration this change did not need to make — so it goes to the
 * application log. Said here rather than hidden, because it changes what the field is worth:
 * a report six months later has to go looking for it, and the person typing should know that
 * while they type.
 *
 * The dialog exists at all because the reason is the point. A one-click suspend would make
 * the most consequential button on the screen the easiest one to press by accident.
 */
export function SuspendDialog({
  user,
  onClose,
  onDone,
}: {
  readonly user: UserSummary;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await suspendUser(user.id, reason.trim());
      onDone();
    } catch (cause) {
      setProblem(failureMessage(cause));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>ระงับบัญชี {user.displayName ?? user.emails[0] ?? ''}</DialogTitle>
          <DialogDescription>
            บัญชีจะออกจากระบบทุกอุปกรณ์ทันที และเข้าใช้งานไม่ได้จนกว่าจะปลดระงับ — ย้อนกลับได้
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {problem !== null && (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle>ระงับไม่สำเร็จ</AlertTitle>
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          )}

          {user.liveSessions > 0 && (
            <p className="text-muted-foreground type-body">
              ตอนนี้มี {user.liveSessions} เซสชันที่ยังใช้งานอยู่ ทั้งหมดจะถูกยกเลิก
            </p>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="suspend-reason">เหตุผล</Label>
            <Textarea
              id="suspend-reason"
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={busy}
              placeholder="เช่น ลาออกแล้ว · พักงานระหว่างสอบสวน"
            />
            <p className="text-muted-foreground type-caption">
              บันทึกไว้ใน log ของระบบ ไม่ได้เก็บไว้กับบัญชี
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </Button>
          <Button
            variant="destructive"
            onClick={() => void submit()}
            disabled={busy || reason.trim().length < 4}
          >
            {busy && <Spinner />}
            ระงับบัญชี
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
