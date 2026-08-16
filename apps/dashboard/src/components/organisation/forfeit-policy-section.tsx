'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import type { ForfeitPolicyWire } from '@wewin/contract/forfeit';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { failureMessage } from '@/lib/api/errors';

import { getForfeitPolicy, publishForfeitPolicy } from './organisation-api';
import {
  FORFEIT_STATUS_TH,
  forfeitPercentText,
  inDisplayOrder,
  parseForfeitPercent,
} from './forfeit-entry';

/**
 * ⭐ อัตราริบมัดจำ — the last of plan 13's unanswered numbers, given a place to be answered.
 *
 * Every rate shipped at 0 bp: a customer who cancels gets everything back, whenever they cancel.
 * That was the honest default while nobody had decided, and the API had no write path at all —
 * this screen is the way in.
 *
 * ── What the person is actually deciding ────────────────────────────────────────
 *
 * One number per moment-of-cancellation, and only for the customer's own change of mind. The
 * ceiling is the **pinned deposit**, never the order total: `order_forfeit_thb_minor()` clamps
 * to `orders.scheduled_deposit_thb_minor` and to money actually held, so 100% here means "keep
 * the deposit", not "keep everything".
 *
 * ── Publishing, not saving ──────────────────────────────────────────────────────
 *
 * ⛔ The button says ประกาศใช้ and it means it: an order pins `forfeit_policy_id` at submit, so
 * a new version leaves every existing contract priced by the one it agreed to. That is the whole
 * reason this is not a form with a save button, and the copy has to carry it — a person who
 * believes they are editing "the" policy will expect their change to reach the order they are
 * arguing about, which is exactly what it must not do.
 *
 * ⚠️ The locked cells are rendered, greyed, with the server's reason beside them. Dropping them
 * would read as an oversight and somebody would eventually ask for the row to be added.
 */
export function ForfeitPolicySection() {
  const [state, setState] = useState<
    | { readonly status: 'loading' }
    | { readonly status: 'failed'; readonly problem: string }
    | { readonly status: 'ready'; readonly policy: ForfeitPolicyWire }
  >({ status: 'loading' });

  const [typed, setTyped] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    try {
      const policy = await getForfeitPolicy();
      setState({ status: 'ready', policy });
      setTyped(
        Object.fromEntries(
          policy.cells
            .filter((cell) => cell.fault === 'customer')
            .map((cell) => [cell.fromStatus, forfeitPercentText(cell.forfeitBp)]),
        ),
      );
    } catch (cause: unknown) {
      setState({ status: 'failed', problem: failureMessage(cause) });
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount; `load` is stable in effect
  }, []);

  const publish = async (): Promise<void> => {
    if (state.status !== 'ready') return;

    const cells: { fromStatus: string; forfeitBp: number }[] = [];
    for (const cell of state.policy.cells) {
      if (cell.fault !== 'customer' || !cell.editable) continue;

      const reading = parseForfeitPercent(typed[cell.fromStatus] ?? '');
      if (!reading.ok) {
        setProblem(`${FORFEIT_STATUS_TH[cell.fromStatus] ?? cell.fromStatus}: ${reading.messageTh}`);
        return;
      }
      cells.push({ fromStatus: cell.fromStatus, forfeitBp: reading.bp });
    }

    if (note.trim() === '') {
      setProblem('เขียนเหตุผลสั้น ๆ ว่าทำไมถึงเปลี่ยน — คนที่มาอ่านทีหลังต้องอธิบายการคืนเงินได้');
      return;
    }

    setBusy(true);
    try {
      const published = await publishForfeitPolicy({
        descriptionTh: note.trim(),
        cells: cells as never,
      });
      setState({ status: 'ready', policy: published });
      setNote('');
      setProblem(null);
      toast.success('ประกาศนโยบายฉบับใหม่แล้ว — ออร์เดอร์เดิมยังใช้ฉบับที่ตกลงไว้');
    } catch (cause: unknown) {
      setProblem(failureMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="type-section">อัตราริบมัดจำเมื่อลูกค้ายกเลิก</h2>
        <p className="text-muted-foreground type-body max-w-3xl">
          กรอกเป็นเปอร์เซ็นต์ของ<strong>ยอดมัดจำ</strong> ไม่ใช่ของยอดรวม — 100% คือเก็บมัดจำไว้ทั้งหมด
          และริบได้ไม่เกินเงินที่ลูกค้าโอนมาจริง เว้นว่างไว้ = คืนเต็ม
        </p>
      </div>

      {state.status === 'loading' && <Skeleton className="h-64 w-full" />}

      {state.status === 'failed' && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>โหลดนโยบายการริบไม่สำเร็จ</AlertTitle>
          <AlertDescription>{state.problem}</AlertDescription>
        </Alert>
      )}

      {state.status === 'ready' && (
        <>
          <p className="text-muted-foreground type-caption">
            ฉบับที่ใช้อยู่: {state.policy.descriptionTh} · เริ่มใช้{' '}
            {new Date(state.policy.effectiveFrom).toLocaleString('th-TH')}
          </p>

          <div className="flex flex-col gap-2">
            {inDisplayOrder(state.policy.cells.filter((cell) => cell.fault === 'customer')).map(
              (cell) => (
                <div key={cell.fromStatus} className="grid grid-cols-[16rem_8rem_1fr] items-center gap-3">
                  <span className="type-body">
                    {FORFEIT_STATUS_TH[cell.fromStatus] ?? cell.fromStatus}
                  </span>

                  <div className="flex items-center gap-2">
                    <Input
                      inputMode="decimal"
                      aria-label={FORFEIT_STATUS_TH[cell.fromStatus] ?? cell.fromStatus}
                      placeholder={cell.editable ? '0' : '0'}
                      disabled={!cell.editable}
                      value={cell.editable ? (typed[cell.fromStatus] ?? '') : ''}
                      onChange={(event) => {
                        setTyped((was) => ({ ...was, [cell.fromStatus]: event.target.value }));
                        setProblem(null);
                      }}
                      className="tabular-nums"
                    />
                    <span className="text-muted-foreground">%</span>
                  </div>

                  {/* The server's sentence, not this screen's — see the header. */}
                  <span className="text-muted-foreground type-caption">
                    {cell.whyLockedTh ?? ''}
                  </span>
                </div>
              ),
            )}
          </div>

          <div className="flex flex-col gap-2">
            <label className="type-body" htmlFor="forfeit-note">
              เหตุผลที่เปลี่ยน
            </label>
            <Textarea
              id="forfeit-note"
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
                setProblem(null);
              }}
              placeholder="เช่น ตกลงกันในที่ประชุม 17 ส.ค. — งานที่ตัดอะลูมิเนียมแล้วขายต่อไม่ได้"
              className="max-w-3xl"
            />
          </div>

          {problem !== null && (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle>ประกาศไม่สำเร็จ</AlertTitle>
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          )}

          <div className="flex items-center gap-3">
            <Button onClick={() => void publish()} disabled={busy}>
              ประกาศใช้ฉบับใหม่
            </Button>
            <span className="text-muted-foreground type-caption">
              ออร์เดอร์ที่ส่งไปแล้วยังใช้ฉบับที่ตกลงกันไว้ตอนนั้น — ฉบับใหม่มีผลกับออร์เดอร์ที่ส่งหลังจากนี้
            </span>
          </div>
        </>
      )}
    </section>
  );
}
