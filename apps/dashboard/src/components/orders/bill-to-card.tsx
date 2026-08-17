'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { OrderBillToWire } from '@wewin/contract/forfeit';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { failureMessage } from '@/lib/api/errors';

import { getBillTo, putBillTo } from './order-api';
import {
  billToDraftOf,
  billToProblems,
  billToRequest,
  emptyBillTo,
  type BillToDraft,
  type BillToProblem,
} from './bill-to-entry';

/**
 * ⭐ ผู้ซื้อ — who the tax document will be made out to.
 *
 * The system has never held an address. It holds a contact name, an email and a telephone
 * number, which is enough for a quotation and not for a document filed with the Revenue
 * Department — so this is a second block, filled in when somebody asks for a tax invoice and
 * left empty on the many orders that never need one.
 *
 * ⚠️ It sits on the ORDER screen rather than on a customer record because that is where it is
 * keyed: a walk-in owns their order through a guest row that carries nothing personal, and the
 * party who orders and the party who is billed are often different — a landlord, a company, a
 * spouse. One order, one bill-to.
 *
 * ⚠️ Editing it changes nothing already issued. A tax document copies this block into its own
 * frozen body, which is what makes an issued document evidence rather than a view.
 */
export function BillToCard({ orderId, mayWrite }: { readonly orderId: string; readonly mayWrite: boolean }) {
  const [saved, setSaved] = useState<OrderBillToWire | null>(null);
  const [draft, setDraft] = useState<BillToDraft>(emptyBillTo);
  const [open, setOpen] = useState(false);
  const [problems, setProblems] = useState<readonly BillToProblem[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getBillTo(orderId)
      .then((wire) => {
        setSaved(wire);
        if (wire !== null) setDraft(billToDraftOf(wire));
      })
      .catch(() => {
        /* A read failure leaves the card in its empty state; the order screen shows the error. */
      });
  }, [orderId]);

  const save = async (): Promise<void> => {
    const found = billToProblems(draft);
    setProblems(found);
    if (found.length > 0) return;

    setBusy(true);
    try {
      const written = await putBillTo(orderId, billToRequest(draft));
      setSaved(written);
      setDraft(billToDraftOf(written));
      setOpen(false);
      toast.success('บันทึกข้อมูลผู้ซื้อแล้ว');
    } catch (cause: unknown) {
      toast.error(failureMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const problemFor = (field: keyof BillToDraft): string | null =>
    problems.find((problem) => problem.field === field)?.messageTh ?? null;

  if (!open) {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="type-section">ข้อมูลผู้ซื้อ (สำหรับใบกำกับภาษี)</h3>
        {saved === null ? (
          <p className="text-muted-foreground type-body">
            ยังไม่ได้กรอก — ออเดอร์ส่วนใหญ่ไม่ต้องใช้ กรอกเมื่อลูกค้าขอใบกำกับภาษี
          </p>
        ) : (
          <dl className="type-body grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">ชื่อ</dt>
            <dd>{saved.legalName}</dd>
            {saved.taxId === null ? null : (
              <>
                <dt className="text-muted-foreground">เลขผู้เสียภาษี</dt>
                <dd className="tabular-nums">{saved.taxId}</dd>
              </>
            )}
            <dt className="text-muted-foreground">สาขา</dt>
            <dd>{saved.branchCode ?? 'สำนักงานใหญ่'}</dd>
            <dt className="text-muted-foreground">ที่อยู่</dt>
            <dd>
              {saved.addressLine}
              {saved.postalCode === null ? '' : ` ${saved.postalCode}`}
            </dd>
          </dl>
        )}

        {mayWrite && (
          <div>
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              {saved === null ? 'กรอกข้อมูลผู้ซื้อ' : 'แก้ข้อมูลผู้ซื้อ'}
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="type-section">ข้อมูลผู้ซื้อ (สำหรับใบกำกับภาษี)</h3>

      <div className="flex gap-4">
        {(['individual', 'juristic'] as const).map((kind) => (
          <label key={kind} className="type-body flex items-center gap-2">
            <input
              type="radio"
              name="buyer-kind"
              checked={draft.buyerKind === kind}
              onChange={() => {
                setDraft((was) => ({ ...was, buyerKind: kind }));
                setProblems([]);
              }}
            />
            {kind === 'individual' ? 'บุคคลธรรมดา' : 'นิติบุคคล'}
          </label>
        ))}
      </div>

      <Field
        id="bill-to-name"
        label={draft.buyerKind === 'juristic' ? 'ชื่อนิติบุคคล' : 'ชื่อ-นามสกุล'}
        value={draft.legalName}
        problem={problemFor('legalName')}
        onChange={(legalName) => setDraft((was) => ({ ...was, legalName }))}
      />

      <Field
        id="bill-to-tax-id"
        label={draft.buyerKind === 'juristic' ? 'เลขประจำตัวผู้เสียภาษี (13 หลัก)' : 'เลขประจำตัวผู้เสียภาษี (ถ้ามี)'}
        value={draft.taxId}
        problem={problemFor('taxId')}
        onChange={(taxId) => setDraft((was) => ({ ...was, taxId }))}
      />

      <Field
        id="bill-to-branch"
        label="รหัสสาขา (เว้นว่าง = สำนักงานใหญ่)"
        value={draft.branchCode}
        problem={null}
        onChange={(branchCode) => setDraft((was) => ({ ...was, branchCode }))}
      />

      <Field
        id="bill-to-address"
        label="ที่อยู่"
        value={draft.addressLine}
        problem={problemFor('addressLine')}
        onChange={(addressLine) => setDraft((was) => ({ ...was, addressLine }))}
      />

      <Field
        id="bill-to-postal"
        label="รหัสไปรษณีย์"
        value={draft.postalCode}
        problem={null}
        onChange={(postalCode) => setDraft((was) => ({ ...was, postalCode }))}
      />

      <div className="flex gap-2">
        <Button size="sm" onClick={() => void save()} disabled={busy}>
          บันทึก
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setDraft(saved === null ? emptyBillTo() : billToDraftOf(saved));
            setProblems([]);
            setOpen(false);
          }}
        >
          ยกเลิก
        </Button>
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  value,
  problem,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly problem: string | null;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="flex max-w-xl flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        aria-invalid={problem !== null}
        onChange={(event) => onChange(event.target.value)}
      />
      {problem === null ? null : (
        <p role="alert" className="text-destructive type-caption">
          {problem}
        </p>
      )}
    </div>
  );
}
