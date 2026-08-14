'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2, Pencil, Plus } from 'lucide-react';
import type { AdminOptionGroupWire, AdminOptionValueWire } from '@wewin/contract/admin';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import { failureMessage } from '@/components/products/catalog-api';
import { deltaText } from '@/components/products/wire';

import { GroupKindBadges } from './option-group-list';
import { setOptionValueAvailability } from './option-group-api';
import { EditGroupDialog } from './edit-group-dialog';
import { ValueDialog } from './value-dialog';

/**
 * One group and its values.
 *
 * The group is the unit because a value has no meaning without the group it belongs to — a
 * table of every value in the company sorted by name would be a list nobody could act on.
 *
 * ── ⭐ It was a `<Card>`, and there were about ten of it ─────────────────────
 *
 * The source held **one** `<Card>` literal and `option-group-list.tsx` rendered it once per
 * group, so a screen with today's ten groups drew ten identical rings, ten identical grounds and
 * ten identical paddings down the page — with a bordered `<Table>` inside each one. That is the
 * exact shape of the owner's complaint: *once everything is a peer, nothing is primary*. Ten
 * borders do not rank ten things, they only cost the reader ten edges to skip past.
 *
 * So this is a `<section>` in a `divide-y` list now. The heading is `type-section` — 18px against
 * the 14px of the values under it, where `CardTitle` used to be 16px against 14px and read as body
 * copy in bold. The hairline between groups says "these are separate groups" with one edge instead
 * of four, and the list reads as a list instead of as a stack of boxes.
 *
 * ⚠️ **The `<Table>` stayed and lost its container, which is the rule rather than a preference.**
 * A table draws its own rules; a ring around one is an edge around an edge. The rows are tighter
 * now (`px-2 py-1.5`) because a group of nine colours should be scannable rather than airy. It has
 * no `<TableHeader>` and deliberately still does not: three of its columns are a swatch, a code
 * and a pair of buttons, and a header row of labels over those would be more furniture than the
 * borders just removed.
 */
export function OptionGroupSection({
  group,
  editable,
  onChanged,
}: {
  readonly group: AdminOptionGroupWire;
  readonly editable: boolean;
  readonly onChanged: () => void;
}) {
  const [editingGroup, setEditingGroup] = useState(false);
  const [editingValue, setEditingValue] = useState<AdminOptionValueWire | 'new' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pendingCode, setPendingCode] = useState<string | null>(null);

  async function toggle(value: AdminOptionValueWire): Promise<void> {
    setPendingCode(value.code);
    setProblem(null);
    try {
      await setOptionValueAvailability(group.code, value.code, !value.available);
      onChanged();
    } catch (cause) {
      setProblem(failureMessage(cause));
    } finally {
      setPendingCode(null);
    }
  }

  return (
    <section className="flex flex-col gap-3 py-6 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="type-section flex flex-wrap items-center gap-2">
            {group.labelTh}
            {/* The machine name, kept beside the human one because it is what a product version
                cites. `type-caption` and `font-normal` so it reads as an annotation on the
                heading rather than as part of it. */}
            <code className="text-muted-foreground type-caption font-normal">{group.code}</code>
          </h2>
          <p className="text-muted-foreground type-body">
            {group.helperTh ?? 'ไม่มีคำอธิบายกำกับ'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <GroupKindBadges group={group} />
          {editable && (
            <Button variant="ghost" size="sm" onClick={() => setEditingGroup(true)}>
              <Pencil className="size-4" />
              แก้ไข
            </Button>
          )}
        </div>
      </div>

      {problem !== null && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>ทำรายการไม่สำเร็จ</AlertTitle>
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}

      {group.values.length === 0 ? (
        <p className="text-muted-foreground type-body">
          {group.kind === 'custom'
            ? 'กลุ่มวัดขนาดไม่มีตัวเลือก — ช่วงขนาดถูกกำหนดที่สินค้าแต่ละตัว'
            : 'ยังไม่มีตัวเลือกในกลุ่มนี้'}
        </p>
      ) : (
        <Table>
          <TableBody>
            {group.values.map((value) => (
              <TableRow key={value.code} className={value.available ? undefined : 'opacity-60'}>
                <TableCell className="w-10 px-2 py-1.5">
                  {value.swatchHex !== undefined && (
                    <span
                      className="border-border inline-block size-5 rounded border"
                      style={{ backgroundColor: value.swatchHex }}
                      /* The hex is in the label too — a swatch alone is unreadable to
                         anybody who cannot distinguish the two greys this catalogue has. */
                      aria-hidden
                    />
                  )}
                </TableCell>

                <TableCell className="px-2 py-1.5">
                  <div className="flex flex-col">
                    <span className="type-body">{value.labelTh}</span>
                    <code className="text-muted-foreground type-caption">
                      {value.code}
                      {value.swatchHex !== undefined && ` · ${value.swatchHex}`}
                    </code>
                  </div>
                </TableCell>

                <TableCell className="text-muted-foreground type-body px-2 py-1.5">
                  {deltaText(value.delta)}
                </TableCell>

                {/* `w-full` on the last column of each shape — the buttons when they are there,
                    the status badge when they are not. The slack has to land somewhere, and
                    anywhere else pushes a value's own label, price and state apart. */}
                <TableCell
                  className={editable ? 'px-2 py-1.5 text-right' : 'w-full px-2 py-1.5 text-right'}
                >
                  {value.available ? (
                    <Badge variant="outline">ขายอยู่</Badge>
                  ) : (
                    <Badge variant="destructive">ปิดการขาย</Badge>
                  )}
                </TableCell>

                {editable && (
                  <TableCell className="w-full px-2 py-1.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setEditingValue(value)}>
                        แก้ไข
                      </Button>
                      {/*
                        ⚠️ Its own button, its own wording, and destructive styling when it
                        takes something away. This is the only control on the screen whose
                        effect a customer sees before anybody publishes anything — see the
                        header of `option-group-list.tsx`. Folding it into the edit dialog
                        would put "rename this colour" and "withdraw it from every quotation
                        in progress" behind one Save.
                      */}
                      <Button
                        variant={value.available ? 'destructive' : 'secondary'}
                        size="sm"
                        disabled={pendingCode === value.code}
                        onClick={() => void toggle(value)}
                      >
                        {pendingCode === value.code && <Loader2 className="size-4 animate-spin" />}
                        {value.available ? 'ปิดการขาย' : 'เปิดขาย'}
                      </Button>
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {editable && group.kind === 'sku' && (
        <div>
          <Button variant="outline" size="sm" onClick={() => setEditingValue('new')}>
            <Plus className="size-4" />
            เพิ่มตัวเลือก
          </Button>
        </div>
      )}

      {editingGroup && (
        <EditGroupDialog
          group={group}
          onClose={() => setEditingGroup(false)}
          onSaved={() => {
            onChanged();
            setEditingGroup(false);
          }}
        />
      )}

      {editingValue !== null && (
        <ValueDialog
          groupCode={group.code}
          value={editingValue === 'new' ? null : editingValue}
          nextSortOrder={group.values.length}
          onClose={() => setEditingValue(null)}
          onSaved={() => {
            onChanged();
            setEditingValue(null);
          }}
        />
      )}
    </section>
  );
}
