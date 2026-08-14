'use client';

import { useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
 *
 * ── ⭐ One Card per group was the worst instance of the pattern in this app ────
 *
 * This panel rendered **`groups.length` `<Card>`s** — one literal in the source, N on the
 * screen, which is why counting the file undercounts the damage in exactly the way the
 * overview's `QueueTile` did. They were N identical peers: same ring, same ground, same
 * padding, each holding a heading, a rename box and the same thirty tick boxes. Nothing about
 * that list needed a border to be understood, because **nobody was ever confused about where
 * one group ended and the next began** — the repetition itself says that, and repetition is
 * question 2 in the house rule answering "no".
 *
 * So: a `divide-y` list of `type-section` headings. One hairline between neighbours instead of
 * four edges around each, exactly as `account-settings.tsx` did for its provider and device
 * rows. The heading is what separates the groups now, which is what a heading is for.
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
    <div className="flex flex-col gap-8">
      {editable && !creating && (
        <div>
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            สร้างกลุ่ม
          </Button>
        </div>
      )}

      {creating && (
        /*
         * A `<section>` rather than the Card this was. It is a form that appears in place of the
         * button that opened it — transient, never read on its own, and separated from the list
         * below by `gap-8` and its own heading. That is the whole job the ring was doing.
         */
        <section className="flex max-w-md flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="type-section">สร้างกลุ่มใหม่</h2>
            <p className="text-muted-foreground type-body">ตั้งสิทธิ์ได้หลังสร้าง</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="group-code">รหัสกลุ่ม</Label>
            <Input
              id="group-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="sales_lead"
            />
            {/* `groups_code_shape` is `^[a-z][a-z0-9_]*$` — underscores, no hyphens. */}
            <p className="text-muted-foreground type-caption">
              a-z, 0-9 และ _ เท่านั้น ขึ้นต้นด้วยตัวอักษร
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="group-name">ชื่อที่แสดง</Label>
            <Input
              id="group-name"
              value={nameTh}
              onChange={(event) => setNameTh(event.target.value)}
            />
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
        </section>
      )}

      <div className="divide-border/60 flex flex-col divide-y">
        {groups.map((group) => (
          <GroupRow
            key={group.id}
            group={group}
            available={available}
            editable={editable}
            busy={busyId === group.id}
            onSave={(permissions) =>
              void run(group.id, () => setGroupPermissions(group.id, permissions))
            }
            onRename={(next) => void run(group.id, () => renameGroup(group.id, next))}
            onDelete={() => void run(group.id, () => deleteGroup(group.id))}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One group, as a row in a divided list.
 *
 * The heading is `type-section` — 18px against the 14px of everything under it. As a `CardTitle`
 * it was `text-base`, two pixels above its own body copy, which is the measurement that started
 * this whole pass: not a weak hierarchy but the absence of one.
 *
 * ⚠️ `first:pt-0 last:pb-0` so the list's outer edges sit on the page's own rhythm rather than
 * adding half a gap at each end — the same shape `account-settings.tsx` uses for its two lists.
 */
function GroupRow({
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
    <section className="flex flex-col gap-4 py-6 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="type-section flex flex-wrap items-center gap-2">
            {group.nameTh}
            <code className="text-muted-foreground type-caption font-normal">{group.code}</code>
            {group.isSystem && <Badge variant="secondary">กลุ่มระบบ</Badge>}
          </h3>
          <p className="text-muted-foreground type-body">สมาชิก {group.memberCount} คน</p>
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

      {editable && (
        <div className="flex max-w-md items-end gap-2">
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

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
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
            <Label htmlFor={`${group.id}-${code}`} className="type-caption font-mono">
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
    </section>
  );
}
