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
import { Label } from '@/components/ui/label';
import { failureMessage } from '@/components/products/catalog-api';

import { setUserGroups, type Group, type UserSummary } from './user-api';

/**
 * Which groups somebody belongs to.
 *
 * The permissions each group grants are shown beside it, because "put them in
 * `sales_lead`" is not a decision anybody can make without knowing what that means — and
 * looking it up on the other tab and coming back is how people stop looking it up.
 *
 * The total is recomputed live from the ticks, so the consequence of the change is visible
 * before it is saved rather than after.
 */
export function UserGroupsDialog({
  user,
  groups,
  onClose,
  onSaved,
}: {
  readonly user: UserSummary;
  readonly groups: readonly Group[];
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(user.groups.map((group) => group.id)),
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const granted = new Set(
    groups.filter((group) => selected.has(group.id)).flatMap((group) => group.permissions),
  );

  function toggle(groupId: string, on: boolean): void {
    const next = new Set(selected);
    if (on) next.add(groupId);
    else next.delete(groupId);
    setSelected(next);
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await setUserGroups(user.id, [...selected]);
      onSaved();
    } catch (cause) {
      setProblem(failureMessage(cause));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>กลุ่มของ {user.displayName ?? user.emails[0] ?? ''}</DialogTitle>
          <DialogDescription>สิทธิ์ทั้งหมดมาจากกลุ่ม — ให้สิทธิ์รายคนโดยตรงไม่ได้</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {problem !== null && (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle>บันทึกไม่สำเร็จ</AlertTitle>
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          )}

          <div className="flex flex-col gap-3">
            {groups.map((group) => (
              <div key={group.id} className="flex items-start gap-3">
                <Checkbox
                  id={`group-${group.id}`}
                  checked={selected.has(group.id)}
                  onCheckedChange={(next) => toggle(group.id, next === true)}
                  disabled={busy}
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <Label htmlFor={`group-${group.id}`}>{group.nameTh}</Label>
                  <code className="text-muted-foreground text-xs">{group.code}</code>
                  <span className="text-muted-foreground text-xs">
                    {group.permissions.length === 0
                      ? 'ไม่ให้สิทธิ์ใดเลย'
                      : group.permissions.join(' · ')}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div className="border-border/60 rounded-lg border border-dashed p-3">
            <p className="text-sm">
              รวมแล้วจะมี {granted.size} สิทธิ์
              {granted.has('users.write') && ' — รวมสิทธิ์จัดการผู้ใช้'}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            บันทึก
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
