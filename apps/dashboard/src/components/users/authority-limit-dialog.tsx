'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';

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
import { ReadOnlyField, SelectField, TextField } from '@/components/products/form-field';
import { failureMessage } from '@/lib/api/errors';

import { setAuthorityLimit, type AuthorityLimitView } from './authority-limits-api';
import {
  DIMENSION_HINT_TH,
  DIMENSION_LABEL_TH,
  EMPTY_LIMIT_FIELDS,
  dimensionOptions,
  fieldsFromLimit,
  limitFormErrors,
  limitFormReady,
  readCeilingMinor,
  setLimitRequest,
  type LimitFields,
} from './authority-limits';
import type { Group } from './user-api';

/**
 * Granting, changing or reinstating one role's ceiling.
 *
 * `limit === null` to grant a new one — the same shape `TaxCountryDialog` and
 * `BankAccountDialog` use, and for the same reason: one form, whichever request it sends,
 * rather than two dialogs that drift the moment a field is added to one of them. The write is
 * a `PUT` keyed on `(group, dimension)`, so "create" and "edit" really are the same request.
 *
 * ⚠️ **The role and the dimension are frozen while editing**, because together they *are* the
 * row's identity. Letting either move would silently create a second ceiling and leave the
 * first one standing — the person would believe they had moved an authority when they had
 * granted a new one and left the old one live.
 *
 * ⚠️ **A withdrawn ceiling is reinstated through this dialog and no other route.** Same call
 * `TaxCountryService.setAvailability` makes about reusing `patch`: one write path means one
 * history-writing discipline, proved once. The button that opens it says คืนอำนาจ rather than
 * แก้ไข so the consequence is on the control rather than in a paragraph.
 */
export function AuthorityLimitDialog({
  limit,
  groups,
  taken,
  onClose,
  onSaved,
}: {
  /** `null` to grant a new ceiling. */
  readonly limit: AuthorityLimitView | null;
  readonly groups: readonly Group[];
  /** Every ceiling that already exists, live or withdrawn — see `collision` below. */
  readonly taken: readonly AuthorityLimitView[];
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const editing = limit !== null;
  const [fields, setFields] = useState<LimitFields>(
    limit === null ? EMPTY_LIMIT_FIELDS : fieldsFromLimit(limit),
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const errors = limitFormErrors(fields);
  const ready = limitFormReady(fields);

  /*
   * ⚠️ Not a validation error — a warning, and the difference is deliberate. The `PUT` is an
   * upsert, so choosing a pair that already exists is legal and *overwrites*. That is the right
   * behaviour (it is how a ceiling is corrected) and the wrong surprise: somebody who came here
   * to grant a new authority would silently replace one they never looked at. So the form still
   * sends, and it says what will happen first.
   */
  const collision =
    !editing && fields.groupId !== ''
      ? taken.find((row) => row.groupId === fields.groupId && row.dimension === fields.dimension)
      : undefined;

  const typed = readCeilingMinor(fields.ceilingBaht);

  async function submit(): Promise<void> {
    if (!ready) return;
    setBusy(true);
    setProblem(null);
    try {
      await setAuthorityLimit(setLimitRequest(fields));
      onSaved();
    } catch (cause) {
      setProblem(failureMessage(cause));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? limit.revokedAt === null
                ? 'แก้ไขเพดานอำนาจ'
                : 'คืนอำนาจให้บทบาทนี้'
              : 'กำหนดเพดานอำนาจ'}
          </DialogTitle>
          <DialogDescription>
            เพดานคือยอดสูงสุดที่บทบาทนี้ลดให้ลูกค้าได้เองต่อหนึ่งใบเสนอราคา
            ทุกการเปลี่ยนแปลงถูกบันทึกพร้อมชื่อผู้แก้และเวลา แก้ไขหรือลบภายหลังไม่ได้
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

          {editing ? (
            <>
              <ReadOnlyField
                label="บทบาท"
                value={`${limit.groupNameTh} (${limit.groupCode})`}
                description="บทบาทและมิติคือชื่อของแถวนี้ ย้ายไม่ได้ — ถ้าต้องการบทบาทอื่น ให้กำหนดเพดานใหม่"
              />
              <ReadOnlyField
                label="มิติ"
                value={DIMENSION_LABEL_TH[limit.dimension]}
                description={DIMENSION_HINT_TH[limit.dimension]}
              />
            </>
          ) : (
            <>
              <SelectField
                label="บทบาท"
                placeholder="เลือกบทบาท"
                value={fields.groupId}
                onChange={(groupId) => setFields({ ...fields, groupId })}
                options={groups.map((group) => ({
                  value: group.id,
                  labelTh: `${group.nameTh} (${group.code})`,
                }))}
                description="อำนาจผูกกับบทบาท ไม่ใช่กับคน — ทุกคนในบทบาทนี้ได้เพดานเดียวกัน"
                {...(errors.groupId === undefined ? {} : { error: errors.groupId })}
              />
              <SelectField
                label="มิติ"
                value={fields.dimension}
                onChange={(dimension) =>
                  setFields({ ...fields, dimension: dimension as LimitFields['dimension'] })
                }
                options={[...dimensionOptions()]}
                description={DIMENSION_HINT_TH[fields.dimension]}
              />
            </>
          )}

          {collision !== undefined && (
            <Alert>
              <AlertTriangle className="size-4" />
              <AlertTitle>บทบาทนี้มีเพดานในมิตินี้อยู่แล้ว</AlertTitle>
              <AlertDescription>
                บันทึกแล้วจะทับของเดิม{collision.revokedAt === null ? '' : ' และคืนอำนาจที่ถูกยกเลิกไว้'}
              </AlertDescription>
            </Alert>
          )}

          <TextField
            label="เพดาน"
            value={fields.ceilingBaht}
            onChange={(ceilingBaht) => setFields({ ...fields, ceilingBaht })}
            placeholder="10000"
            prefix="฿"
            mono
            /*
             * ⚠️ The sentence that keeps ฿0 from looking like a mistake. `authority_limits`'
             * own schema note: zero is a role that may record a concession and approve none of
             * its own; no row at all is a role with no authority. They are different grants,
             * and this is the one place a person chooses between them.
             */
            description={
              typed === 0n
                ? '฿0 คือให้บันทึกส่วนลดได้ แต่ต้องให้คนอื่นอนุมัติทุกครั้ง — ไม่เท่ากับไม่มีเพดาน'
                : 'ยอดต่อหนึ่งใบเสนอราคา เกินจากนี้ต้องขออนุมัติ'
            }
            {...(errors.ceilingBaht === undefined ? {} : { error: errors.ceilingBaht })}
          />

          <TextField
            label="หมายเหตุ"
            value={fields.noteTh}
            onChange={(noteTh) => setFields({ ...fields, noteTh })}
            placeholder="เหตุผลที่ให้อำนาจระดับนี้"
            multiline
            description="ไม่บังคับ แต่จะอยู่ในประวัติถาวร"
            {...(errors.noteTh === undefined ? {} : { error: errors.noteTh })}
          />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !ready}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            บันทึก
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
