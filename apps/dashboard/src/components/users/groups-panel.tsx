'use client';

import { useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { failureMessage } from '@/components/products/catalog-api';

import {
  createGroup,
  deleteGroup,
  renameGroup,
  setGroupPermissions,
  type Group,
} from './user-api';

/**
 * Groups, and what each one grants.
 *
 * A permission is held by a group and never by a person, so this is where "what may a sales
 * lead do" is actually answered. The tick boxes write straight through on Save — there is no
 * draft and no publish, because unlike the catalogue there is no frozen document to protect:
 * the next request that person makes reads the new set.
 *
 * ⚠️ **Deleting is refused by the API while anybody is a member**, and the count is shown
 * beside the button so the refusal is predictable rather than surprising. `user_groups`
 * cascades, so a delete that went through would quietly strip permissions from however many
 * people were in it — which is not what a button labelled "ลบกลุ่ม" should do.
 *
 * The last-administrator guard is not reimplemented here. It lives in the API and answers
 * 409; a client-side copy would be a second implementation of the only rule on this screen
 * that cannot be recovered from.
 */
export function GroupsPanel({
  groups,
  available,
  editable,
  onChanged,
  onProblem,
}: {
  readonly groups: readonly Group[];
  readonly available: readonly string[];
  readonly editable: boolean;
  readonly onChanged: () => void;
  readonly onProblem: (message: string) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [code, setCode] = useState('');
  const [nameTh, setNameTh] = useState('');

  async function run(id: string, action: () => Promise<unknown>): Promise<void> {
    setBusyId(id);
    try {
      await action();
      onChanged();
    } catch (cause) {
      onProblem(failureMessage(cause));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {editable && !creating && (
        <div>
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            สร้างกลุ่ม
          </Button>
        </div>
      )}

      {creating && (
        <Card>
          <CardHeader>
            <CardTitle>สร้างกลุ่มใหม่</CardTitle>
            <CardDescription>ตั้งสิทธิ์ได้หลังสร้าง</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="group-code">รหัสกลุ่ม</Label>
              <Input
                id="group-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="sales_lead"
              />
              {/* `groups_code_shape` is `^[a-z][a-z0-9_]*$` — underscores, no hyphens. */}
              <p className="text-muted-foreground text-xs">a-z, 0-9 และ _ เท่านั้น ขึ้นต้นด้วยตัวอักษร</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="group-name">ชื่อที่แสดง</Label>
              <Input id="group-name" value={nameTh} onChange={(event) => setNameTh(event.target.value)} />
            </div>
            <div className="flex gap-2">
              <Button
                disabled={busyId === 'new' || code.trim() === '' || nameTh.trim() === ''}
                onClick={() =>
                  void run('new', async () => {
                    await createGroup({ code: code.trim(), nameTh: nameTh.trim(), permissions: [] });
                    setCode('');
                    setNameTh('');
                    setCreating(false);
                  })
                }
              >
                {busyId === 'new' && <Loader2 className="size-4 animate-spin" />}
                สร้าง
              </Button>
              <Button variant="ghost" onClick={() => setCreating(false)}>
                ยกเลิก
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {groups.map((group) => (
        <GroupCard
          key={group.id}
          group={group}
          available={available}
          editable={editable}
          busy={busyId === group.id}
          onSave={(permissions) => void run(group.id, () => setGroupPermissions(group.id, permissions))}
          onRename={(next) => void run(group.id, () => renameGroup(group.id, next))}
          onDelete={() => void run(group.id, () => deleteGroup(group.id))}
        />
      ))}
    </div>
  );
}

function GroupCard({
  group,
  available,
  editable,
  busy,
  onSave,
  onRename,
  onDelete,
}: {
  readonly group: Group;
  readonly available: readonly string[];
  readonly editable: boolean;
  readonly busy: boolean;
  readonly onSave: (permissions: readonly string[]) => void;
  readonly onRename: (nameTh: string) => void;
  readonly onDelete: () => void;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(group.permissions));
  const [name, setName] = useState(group.nameTh);

  const dirty =
    selected.size !== group.permissions.length ||
    group.permissions.some((code) => !selected.has(code));

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex flex-wrap items-center gap-2">
              {group.nameTh}
              <code className="text-muted-foreground text-xs font-normal">{group.code}</code>
              {group.isSystem && <Badge variant="secondary">กลุ่มระบบ</Badge>}
            </CardTitle>
            <CardDescription>สมาชิก {group.memberCount} คน</CardDescription>
          </div>

          {editable && (
            <Button
              variant="destructive"
              size="sm"
              disabled={busy || group.isSystem || group.memberCount > 0}
              onClick={onDelete}
              title={
                group.isSystem
                  ? 'กลุ่มของระบบ ลบไม่ได้'
                  : group.memberCount > 0
                    ? 'ยังมีสมาชิกอยู่ — ย้ายออกให้หมดก่อน'
                    : undefined
              }
            >
              <Trash2 className="size-4" />
              ลบกลุ่ม
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {editable && (
          <div className="flex items-end gap-2">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor={`name-${group.id}`}>ชื่อที่แสดง</Label>
              <Input
                id={`name-${group.id}`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={busy}
              />
            </div>
            <Button
              variant="outline"
              disabled={busy || name.trim() === '' || name.trim() === group.nameTh}
              onClick={() => onRename(name.trim())}
            >
              เปลี่ยนชื่อ
            </Button>
          </div>
        )}

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {available.map((code) => (
            <div key={code} className="flex items-center gap-2">
              <Checkbox
                id={`${group.id}-${code}`}
                checked={selected.has(code)}
                disabled={!editable || busy}
                onCheckedChange={(next) => {
                  const copy = new Set(selected);
                  if (next === true) copy.add(code);
                  else copy.delete(code);
                  setSelected(copy);
                }}
              />
              <Label htmlFor={`${group.id}-${code}`} className="font-mono text-xs">
                {code}
              </Label>
            </div>
          ))}
        </div>

        {editable && dirty && (
          <div>
            <Button onClick={() => onSave([...selected])} disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              บันทึกสิทธิ์
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
