'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { failureMessage } from '@/components/products/catalog-api';

import { createUser, type Group } from './user-api';

/**
 * Adding a colleague.
 *
 * ⚠️ **There is no password field, and there must never be one.** The account is created
 * without a credential and the person sets their own through the same one-shot link the
 * login page sends. An administrator who typed somebody's first password would know it, and
 * would go on knowing it for as long as that person never changed it — including after the
 * administrator left the company.
 *
 * The address is marked verified on the operator's word, exactly as `create-staff-user` does
 * and for the same reason: somebody with this screen is somebody the company trusts to say
 * "this is my colleague's address". It is also precisely why no public endpoint can do it.
 */
export function CreateUserDialog({
  groups,
  onClose,
  onCreated,
}: {
  readonly groups: readonly Group[];
  readonly onClose: () => void;
  readonly onCreated: (invitationSent: boolean) => void;
}) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const result = await createUser({
        email: email.trim(),
        displayName: displayName.trim(),
        groupIds: [...selected],
      });
      onCreated(result.invitationSent);
    } catch (cause) {
      setProblem(failureMessage(cause));
      setBusy(false);
    }
  }

  const ready = email.trim().includes('@') && displayName.trim() !== '';

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>เพิ่มผู้ใช้</DialogTitle>
          <DialogDescription>
            ระบบจะส่งลิงก์ให้เจ้าตัวตั้งรหัสผ่านเอง — ผู้ดูแลไม่ได้ตั้งรหัสให้
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {problem !== null && (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle>สร้างบัญชีไม่สำเร็จ</AlertTitle>
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-user-email">อีเมล</Label>
            <Input
              id="new-user-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy}
            />
            <p className="text-muted-foreground type-caption">
              ถือว่ายืนยันแล้วทันที เพราะคุณเป็นผู้ยืนยันว่านี่คืออีเมลของเพื่อนร่วมงาน
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-user-name">ชื่อที่แสดง</Label>
            <Input
              id="new-user-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              disabled={busy}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label>กลุ่ม</Label>
            {groups.map((group) => (
              <div key={group.id} className="flex items-start gap-3">
                <Checkbox
                  id={`new-user-group-${group.id}`}
                  checked={selected.has(group.id)}
                  onCheckedChange={(next) => {
                    const copy = new Set(selected);
                    if (next === true) copy.add(group.id);
                    else copy.delete(group.id);
                    setSelected(copy);
                  }}
                  disabled={busy}
                />
                <div className="flex flex-col gap-0.5">
                  <Label htmlFor={`new-user-group-${group.id}`}>{group.nameTh}</Label>
                  <span className="text-muted-foreground type-caption">
                    {group.permissions.length === 0 ? 'ไม่ให้สิทธิ์ใดเลย' : group.permissions.join(' · ')}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !ready}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            สร้างบัญชีและส่งลิงก์
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
