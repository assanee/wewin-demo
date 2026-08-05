import { CircleAlert, RefreshCw, ShieldAlert } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

import { baht } from './amounts';
import { ANCHOR_LABEL_TH } from './override-entry';
import type { ConflictKind } from './quote-api';
import type { IntegrityAlarm, QuoteView } from './quote-model';
import { thbMinorOf } from './quote-wire';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The banners. Four refusals, four recoveries, and one that is not a refusal at all.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Plan 7.9(จ) splits the 409 because *"the UI can only recover from one of them"*. That
 * sentence is a specification for this file: a screen that showed one "conflict, please
 * reload" for all of them would make a person re-confirm eleven prices they never needed to
 * look at, or — far worse — reload past a catalogue publish and carry on quoting a discount
 * that is now twice the one anybody agreed to.
 *
 *   `quote_stale`      somebody else edited this quote. The figures are still the machine's,
 *                      so nothing needs re-agreeing. Reload and carry on — the hook already
 *                      has by the time this renders.
 *   `baselines_stale`  a catalogue version was published under one or more promises. Not
 *                      recoverable by reloading: **a person has to look at each affected
 *                      line** and either re-promise the same money against the new baseline
 *                      or let the new price stand. The list is on the lines themselves.
 *   `catalogue_stale`  the product document moved under a line being added or revised. The
 *                      recovery is mechanical — re-render from the current document — and
 *                      needs no decision, which is why it is a different word.
 *   `other`            a 409 with a reason this client has no recovery for. Shown as itself.
 */

export function ConflictBanner({
  conflict,
  onDismiss,
  onReload,
}: {
  readonly conflict: ConflictKind;
  readonly onDismiss: () => void;
  readonly onReload: () => void;
}) {
  if (conflict === 'quote_stale') {
    return (
      <Alert>
        <RefreshCw />
        <AlertTitle>มีผู้อื่นแก้ใบเสนอราคานี้</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-2">
          <p>
            โหลดฉบับล่าสุดให้แล้ว ตัวเลขทั้งหมดยังเป็นค่าที่ระบบคำนวณ ไม่มีอะไรต้องตกลงใหม่ — ทำรายการอีกครั้งได้เลย
          </p>
          <Button size="sm" variant="outline" onClick={onDismiss}>
            รับทราบ
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (conflict === 'baselines_stale') {
    return (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertTitle>แคตตาล็อกถูกเผยแพร่เวอร์ชันใหม่หลังจากตกลงราคาไว้</AlertTitle>
        <AlertDescription>
          <p>
            ราคาที่ตกลงไว้ยังเป็นตัวเลขเดิม แต่ <strong>ราคาฐานเปลี่ยนไปแล้ว</strong> — ส่วนลดเดิมจึงไม่ใช่ส่วนลดเดิมอีกต่อไป
            บรรทัดที่ได้รับผลกระทบมีป้ายกำกับอยู่ในตาราง ต้องยืนยันหรือยกเลิกราคาทีละบรรทัดก่อนส่งใบนี้ออก
          </p>
        </AlertDescription>
      </Alert>
    );
  }

  if (conflict === 'catalogue_stale') {
    return (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertTitle>สินค้าถูกเผยแพร่เวอร์ชันใหม่ระหว่างที่คุณกำลังแก้ไข</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-2">
          <p>
            รายการนี้อ้างเวอร์ชันที่ไม่ใช่เวอร์ชันปัจจุบันแล้ว ไม่มีอะไรต้องตัดสินใจ — โหลดใหม่แล้วทำรายการอีกครั้ง
          </p>
          <Button size="sm" variant="outline" onClick={onReload}>
            โหลดใหม่
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertTitle>ทำรายการไม่สำเร็จเพราะสถานะเปลี่ยนไป</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-2">
        <p>เซิร์ฟเวอร์ปฏิเสธด้วยเหตุผลที่หน้าจอนี้ยังไม่รู้จัก โหลดใหม่แล้วลองอีกครั้ง ถ้ายังเกิดซ้ำให้แจ้งทีมพัฒนา</p>
        <Button size="sm" variant="outline" onClick={onReload}>
          โหลดใหม่
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/**
 * The banner that is not a response to anything the person just did.
 *
 * `staleBaselines` arrives with the quote itself, so this shows on load rather than after a
 * refused write — which matters, because somebody should learn that prices need re-confirming
 * *before* they spend ten minutes adding lines to a quote they cannot send.
 *
 * The two kinds are counted separately because the two jobs are different sizes: a promise
 * that needs re-agreeing is a phone call, and a line pinned to an unpublished version is a
 * re-render. A single number would make a salesperson prepare for the wrong conversation.
 */
export function StaleBaselineBanner({ view }: { readonly view: QuoteView }) {
  if (view.staleLines.length === 0) return null;

  const promises = view.staleLines.filter((line) => line.stale?.kind === 'promise_baseline_moved');
  const repricings = view.staleLines.filter((line) => line.stale?.kind === 'line_needs_repricing');

  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertTitle>ราคาในแคตตาล็อกเปลี่ยนหลังจากใบนี้ถูกตั้งราคา</AlertTitle>
      <AlertDescription>
        <ul className="flex list-disc flex-col gap-1 ps-4">
          {promises.length === 0 ? null : (
            <li>
              <strong>{promises.length} บรรทัด</strong> มีราคาที่คนตกลงไว้ และราคาฐานขยับไปแล้ว — ต้องมีคนตัดสินใจว่าจะยืนราคาเดิมหรือปล่อยให้ใช้ราคาใหม่
            </li>
          )}
          {repricings.length === 0 ? null : (
            <li>
              <strong>{repricings.length} บรรทัด</strong> ผูกกับเวอร์ชันที่เลิกเผยแพร่แล้ว — ต้องคิดราคาใหม่จากแคตตาล็อกปัจจุบัน (ไม่มีอะไรต้องตัดสินใจ)
            </li>
          )}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

/**
 * Things that should be impossible, said out loud.
 *
 * Every alarm here is a comparison of two figures the server itself sent. None can be fixed
 * from this screen and none offers a button — the honest response to "the lines do not add up
 * to the subtotal" is to stop, not to retry.
 *
 * `baseline_moved_under_core` is the same condition apps/api raises as a 500 with a stack.
 * Seeing it here means the server has not been asked to write anything yet: it is what the
 * screen can tell from a plain `GET`, before anybody negotiates on top of it.
 */
export function IntegrityAlarms({ alarms }: { readonly alarms: readonly IntegrityAlarm[] }) {
  if (alarms.length === 0) return null;

  return (
    <Alert variant="destructive">
      <ShieldAlert />
      <AlertTitle>ข้อมูลใบนี้ขัดกันเอง — อย่าส่งออกจนกว่าจะตรวจสอบ</AlertTitle>
      <AlertDescription>
        <ul className="flex list-disc flex-col gap-1 ps-4">
          {alarms.map((alarm) => (
            <li key={alarmKey(alarm)}>{alarmText(alarm)}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

const alarmKey = (alarm: IntegrityAlarm): string => {
  switch (alarm.kind) {
    case 'duplicate_live_override':
      return `dup:${alarm.anchor}:${alarm.subjectId ?? 'document'}`;
    case 'lines_do_not_foot':
      return 'foot';
    case 'baseline_moved_under_core':
      return `drift:${alarm.lineId}`;
  }
};

function alarmText(alarm: IntegrityAlarm): string {
  switch (alarm.kind) {
    case 'duplicate_live_override':
      return `มีการแก้ราคา "${ANCHOR_LABEL_TH[alarm.anchor]}" ที่ยังมีผลอยู่พร้อมกัน ${String(alarm.count)} รายการ ทั้งที่ต้องมีได้อย่างมากหนึ่งรายการ`;
    case 'lines_do_not_foot':
      return `ยอดรวมรายบรรทัดที่หน้าจอบวกได้คือ ${baht(alarm.foldedThbMinor)} แต่เซิร์ฟเวอร์ส่งฐานภาษีมาว่า ${baht(alarm.serverThbMinor)} — ต่างกัน ${baht(alarm.serverThbMinor - alarm.foldedThbMinor)}`;
    case 'baseline_moved_under_core':
      return `ราคาฐานที่แช่แข็งไว้คือ ${baht(alarm.frozenThbMinor)} แต่ตอนนี้บรรทัดเดียวกันรายงาน ${baht(alarm.currentThbMinor)} ทั้งที่เซิร์ฟเวอร์ไม่ได้แจ้งว่าแคตตาล็อกเปลี่ยน — แจ้งทีมพัฒนา`;
  }
}

/**
 * The VAT treatment, spelled out.
 *
 * Here rather than in the totals card because the customer's document needs the same words,
 * and two translations of `zero_rated` on one screen is how a quote and its own preview end
 * up disagreeing about whether tax was charged.
 */
export function vatLabelTh(rateBp: number, treatment: string): string {
  const rate = (rateBp / 100).toString();
  switch (treatment) {
    case 'standard':
      return `VAT ${rate}%`;
    case 'zero_rated':
      return `VAT ${rate}% (อัตราศูนย์)`;
    case 'exempt':
      return 'ยกเว้นภาษีมูลค่าเพิ่ม';
    case 'out_of_scope':
      return 'อยู่นอกระบบภาษีมูลค่าเพิ่ม';
    default:
      /* A treatment this build has not been taught. Shown as itself rather than as "standard". */
      return `VAT ${rate}% (${treatment})`;
  }
}

/** The net figure a caller wants beside the VAT line, opened once. */
export const netOf = (view: QuoteView): bigint => thbMinorOf(view.wire.money.netThbMinor);
