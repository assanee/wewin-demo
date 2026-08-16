import Link from 'next/link';
import type { Route } from 'next';
import { CircleAlert, Globe, RefreshCw, Send, ShieldAlert } from 'lucide-react';

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
 * ⭐ THE EDIT HAS NOT REACHED THE CUSTOMER — and the button that sends it.
 *
 * Every write on this screen changes the quote. **None of them changes what the customer is
 * asked for**: that figure lives on the order and is written only by a submit or a re-issue. So
 * a salesperson could take ฿20,000 off, watch every total here agree, and the customer's
 * payment page would go on asking for the old amount — with nothing anywhere saying so.
 *
 * Both figures, side by side and labelled, because "ยังไม่ได้ส่ง" on its own leaves the reader
 * to work out what the customer is looking at. The one they are being asked for comes first: it
 * is the number a person on the telephone is about to be told, and the reason this banner is
 * the loudest thing on the screen when it appears.
 *
 * ⚠️ In a status the API will not re-issue from, the sentence stays and the button goes. A
 * difference the customer cannot be told about is more alarming than one they can — hiding the
 * banner because there is no button would hide the problem, not solve it.
 */
export function IssuedBehindBanner({
  view,
  busy,
  onReissue,
}: {
  readonly view: QuoteView;
  readonly busy: boolean;
  readonly onReissue: () => void;
}) {
  const behind = view.issuedBehind;
  if (behind === null) return null;

  return (
    <Alert variant="destructive">
      <Send />
      <AlertTitle>ลูกค้ายังเห็นยอดเดิม — การแก้ไขนี้ยังไม่ถูกส่งออกไป</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        <dl className="grid grid-cols-[auto_auto] gap-x-6 gap-y-1">
          <dt>ยอดที่ลูกค้าถูกเรียกเก็บอยู่</dt>
          <dd className="text-right tabular-nums">{baht(behind.issuedThbMinor)}</dd>
          <dt>ยอดตามใบที่แก้แล้ว</dt>
          <dd className="text-right tabular-nums font-medium">{baht(behind.liveThbMinor)}</dd>
        </dl>

        {behind.mayReissue ? (
          <>
            <p>
              กด <strong>ออกใบเสนอราคาใหม่</strong> เพื่อให้ยอดใหม่มีผลกับลูกค้า —
              ระบบจะบันทึกลงประวัติออร์เดอร์ แจ้งลูกค้า และคิดยอดมัดจำใหม่ตามยอดล่าสุด
            </p>
            <Button size="sm" onClick={onReissue} disabled={busy}>
              ออกใบเสนอราคาใหม่
            </Button>
          </>
        ) : (
          <p>
            ออร์เดอร์นี้อยู่สถานะ <strong>{behind.status}</strong> จึงออกใบใหม่จากหน้านี้ไม่ได้ —
            ออกใบใหม่ได้เฉพาะตอนรอชำระเงินเท่านั้น
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}

/**
 * ⭐ The destination the server could not resolve — and the one banner here that is about a
 * refusal which has **not happened yet**.
 *
 * Every other notice in this file is a 409 that already came back, or a contradiction already
 * present in the data. This one is a 422 the person is *going to* get, shown at the moment they
 * open the quote rather than at the moment they press send.
 *
 * That gap is the whole reason it exists. `POST /orders` accepts any two-letter code without
 * validating it, and the API used to refuse an unresolvable one on every read — which made a
 * typo terminal, because nothing but a submit can rewrite `orders.destination_country`. The fix
 * was to let reads and edits degrade to the default rule so the cart stays openable and
 * correctable. The cost of that fix is exactly this screen: without a notice, a salesperson
 * opens the quote, sees plausible Thai totals, and can negotiate an entire quotation before the
 * refusal surfaces. They were losing a loud 422 at the door and getting a quiet one at the end.
 *
 * ⚠️ **A warning and not a gate.** Nothing here disables a control. The refusal is
 * `assertSubmittable`'s in apps/api and it stays there — a second gate computed on this screen
 * is the thing `QuoteView.hasStaleBaselines`' own note forbids, and it would be a *worse* gate
 * because it could be reached by a client that had not been updated.
 *
 * It says three things, because a person needs all three: the code is not one the system knows,
 * the figures on screen are therefore the **default** rule rather than that country's, and
 * there are two ways out — submit naming a real country, or add this one under ตั้งค่าบริษัท.
 */
export function UnrecognisedDestinationBanner({ view }: { readonly view: QuoteView }) {
  const code = view.unrecognisedDestination;
  if (code === null) return null;

  return (
    <Alert variant="destructive">
      <Globe />
      <AlertTitle>{unrecognisedDestinationTitleTh(code)}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-2">
        <ul className="flex list-disc flex-col gap-1 ps-4">
          {unrecognisedDestinationPointsTh(code).map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
        <Button asChild size="sm" variant="outline">
          <Link href={'/organisation' as Route}>เปิดตั้งค่าประเทศปลายทาง</Link>
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/**
 * The heading, as a pure function of the code — so the assertion about *what it says* can be
 * made without a DOM, the way `visibleNavigation` is asserted in `tests/navigation.test.ts`.
 *
 * It leads with the consequence rather than the cause. "ส่งใบเสนอราคาไม่ได้" is what changes
 * what the reader does next; the code is why.
 */
export const unrecognisedDestinationTitleTh = (code: string | null): string =>
  `ส่งใบเสนอราคานี้ไม่ได้ — ไม่รู้จักประเทศปลายทาง "${code ?? '—'}"`;

/**
 * The three sentences, in the order a person needs them: what is wrong, why the numbers in
 * front of them cannot be quoted, and the two ways out.
 *
 * ⚠️ The second one is the one worth keeping. Somebody who reads only the title might still
 * repeat the total on the screen to a customer over the phone — it looks like a finished quote
 * — and that total is the **default** rule, not this country's.
 */
export const unrecognisedDestinationPointsTh = (code: string | null): readonly string[] => [
  `ออร์เดอร์นี้ระบุรหัสประเทศ "${code ?? '—'}" ซึ่งไม่มีอยู่ในตั้งค่าประเทศปลายทาง`,
  'ยอดและอัตราภาษีที่แสดงอยู่จึงคิดจากอัตราเริ่มต้น (VAT 7% แบบไม่รวมภาษี) ไม่ใช่ของประเทศนี้ — อย่ายืนยันตัวเลขนี้กับลูกค้า',
  `แก้ได้สองทาง: ส่งใบเสนอราคาโดยระบุประเทศปลายทางที่ถูกต้อง หรือเพิ่มรหัส "${code ?? '—'}" ในตั้งค่าบริษัท > ประเทศปลายทาง แล้วเปิดใบนี้ใหม่`,
];

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
