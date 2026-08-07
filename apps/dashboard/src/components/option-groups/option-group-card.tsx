'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2, Pencil, Plus } from 'lucide-react';
import type { AdminOptionGroupWire, AdminOptionValueWire } from '@wewin/contract/admin';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
 * The card is the unit because a value has no meaning without the group it belongs to — a
 * table of every value in the company sorted by name would be a list nobody could act on.
 */
export function OptionGroupCard({
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
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex flex-wrap items-center gap-2">
              {group.labelTh}
              <code className="text-muted-foreground text-xs font-normal">{group.code}</code>
            </CardTitle>
            <CardDescription>
              {group.helperTh ?? 'ไม่มีคำอธิบายกำกับ'}
            </CardDescription>
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
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {problem !== null && (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" />
            <AlertTitle>ทำรายการไม่สำเร็จ</AlertTitle>
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        )}

        {group.values.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {group.kind === 'custom'
              ? 'กลุ่มวัดขนาดไม่มีตัวเลือก — ช่วงขนาดถูกกำหนดที่สินค้าแต่ละตัว'
              : 'ยังไม่มีตัวเลือกในกลุ่มนี้'}
          </p>
        ) : (
          <Table>
            <TableBody>
              {group.values.map((value) => (
                <TableRow key={value.code} className={value.available ? undefined : 'opacity-60'}>
                  <TableCell className="w-10">
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

                  <TableCell>
                    <div className="flex flex-col">
                      <span>{value.labelTh}</span>
                      <code className="text-muted-foreground text-xs">
                        {value.code}
                        {value.swatchHex !== undefined && ` · ${value.swatchHex}`}
                      </code>
                    </div>
                  </TableCell>

                  <TableCell className="text-muted-foreground text-sm">
                    {deltaText(value.delta)}
                  </TableCell>

                  <TableCell className="text-right">
                    {value.available ? (
                      <Badge variant="outline">ขายอยู่</Badge>
                    ) : (
                      <Badge variant="destructive">ปิดการขาย</Badge>
                    )}
                  </TableCell>

                  {editable && (
                    <TableCell className="w-56 text-right">
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
      </CardContent>

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
    </Card>
  );
}
