'use client';

import { AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import type { FxRateHealthWire } from '@wewin/contract/organisation';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldGroup } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { ReadOnlyField } from '@/components/products/form-field';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ How old the exchange rate is, on a screen instead of in a log.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Before `GET /admin/fx/health` existed, the only thing that knew a sync had failed was a
 * `logger.warn`, and the only thing that knew *how old* the newest rate was, was arithmetic
 * nobody performed. Both facts existed and neither was reachable by a person, which is the
 * definition of a silent failure. This card is the reachable half.
 *
 * Read-only, and it holds no controls at all — not even a refresh button. There is nothing here
 * to set: the two thresholds are constants in `apps/api/src/fx/staleness.ts`, and the rate is
 * changed by an administrator editing a *destination* in the tax-country table below, which is
 * why this card sits directly above that table rather than at the top of the page.
 *
 * ── ⭐ The wording is the feature, and there are five states, not three ──────────
 *
 * `status` carries three words. What a reader has to be told is five things, because two of them
 * hide inside `blocked`:
 *
 *   - **`ok`** — nothing wrong. Says so in one line and gets out of the way.
 *   - **`warn`** — the rate is getting old and **quotations still work**. This is the state most
 *     at risk of being mis-worded into a panic: the whole content of `warn` is *"you have time"*,
 *     and a card that reads like a refusal here trains staff to ignore the one that is a refusal.
 *     Every `warn` sentence below says out loud that nothing is being refused yet, and names the
 *     hour count at which that changes.
 *   - **`blocked` with a rate** — foreign-currency quotations are being **refused right now**,
 *     because the newest rate is older than `refuseAfterHours`. Named as a present-tense refusal,
 *     with the way out attached.
 *   - **`blocked` with `ageHours === null`** — `fx_rates` has never held a row. It arrives as the
 *     same word and it is *not the same fact*: nothing is old, there is nothing at all. Told
 *     separately, because "the rate is too old" invites somebody to wait for the next sync to fix
 *     it, and here every sync has already failed or none has ever run.
 *   - **a fourth word this build has not been taught** — see `fxHealthVerdict`.
 *
 * ── ⚠️ Both clocks are shown, and the pair is the diagnosis ──────────────────────
 *
 * `observedAt` is when the provider struck the rate; `fetchedAt` is when we stored it. A
 * `fetchedAt` of minutes ago beside an `observedAt` of three weeks ago is a provider whose feed
 * has frozen while its HTTP endpoint stays perfectly healthy — the one failure invisible to any
 * check built on fetch time, and the reason `staleness.ts` measures age on the first clock. It is
 * legible only when a reader can see both, so both are on the card with labels saying which is
 * which, and `fxFrozenFeedTh` states the diagnosis outright when the gap is wide enough that
 * nothing else explains it.
 *
 * ── ⚠️ Every threshold in every sentence comes from the response ─────────────────
 *
 * `warnAfterHours` and `refuseAfterHours` are reported *down* precisely so this screen holds no
 * copy of them. There is no `36` and no `72` anywhere in this file, and there must not be: the
 * drift that matters is a screen quoting one number while the refusal compares against another.
 *
 * ── Pure functions, exported, tested ────────────────────────────────────────────
 *
 * Every derived sentence below is a named `…Th` function of the wire row and nothing else, so
 * what this card *says* is asserted directly in `fx-health.test.ts`. `quote-alerts.tsx` sets this
 * precedent exactly — `unrecognisedDestinationTitleTh` and friends live beside the component that
 * renders them and are tested without a DOM, per `vitest.config.ts`'s own stance that a component
 * test here would be a test of these functions, spelled expensively.
 *
 * ⚠️ The cost, named rather than discovered: exporting functions from a `.tsx` trips
 * `react/only-export-components`, which the root `.oxlintrc.json` sets to `warn` — twelve of them
 * from this file, more than any other single file in the app. That rule is about Fast Refresh
 * preserving component state in dev, not about correctness, and the alternative was worse in a way
 * that is not about lint: the *other* house pattern is a separate pure module (`tax-country-fields
 * .ts` beside `tax-countries.tsx`), and the only `.ts` in this feature is `fx-health-api.ts`, whose
 * job is narrowing a wire payload. Thai copy about stopped cron jobs in a file named `-api` would
 * put two unrelated concerns behind one name to quiet a dev-ergonomics warning. Should this card's
 * wording ever grow past what fits comfortably here, the fix is a third file — `fx-health-copy.ts`
 * — and not a retreat from testing what the card says.
 */

export type FxHealthState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly problem: string }
  | { readonly status: 'ready'; readonly health: FxRateHealthWire };

/**
 * The five things a reader can be told, as one value the wording functions switch on.
 *
 * `never_synced` and `stale_blocked` both arrive as `status: 'blocked'` — the server is right to
 * summarise them the same way, because a foreign-currency submit is refused either way — and they
 * are split here because the *sentence* differs and the next action differs.
 */
export type FxHealthVerdict = 'ok' | 'warn' | 'stale_blocked' | 'never_synced' | 'unrecognised';

/**
 * ⚠️ **`ageHours === null` is checked before the word, and the order is deliberate.**
 *
 * The null age is a fact about the stored data — `fx_rates` is empty — while `status` is the
 * server's one-word summary of it. They cannot disagree today (`fxRateHealthStatus(null)` is
 * `'blocked'` by its own first line), and if a future build ever made them disagree, the fact
 * should win over the summary for this branch: a card cannot honestly report an age it does not
 * have.
 *
 * ⭐ **An unrecognised word resolves toward "unusable", never toward green.** The contract types
 * `status` as `string` and the union lives server-side, so a fourth word is a version skew that
 * this build can reach. Reading it as `ok` would put a green badge over submits that are, right
 * now, being refused — which `staleness.ts` names as the specific failure its single shared
 * comparison exists to prevent. Reading it as a hard refusal would be an unearned alarm, so
 * `unrecognised` is its own verdict with its own sentence: the numbers below are real, the word
 * above them is not one we know, treat it as unusable until somebody checks.
 */
export function fxHealthVerdict(health: FxRateHealthWire): FxHealthVerdict {
  if (health.ageHours === null) return 'never_synced';

  switch (health.status) {
    case 'ok':
      return 'ok';
    case 'warn':
      return 'warn';
    case 'blocked':
      return 'stale_blocked';
    default:
      return 'unrecognised';
  }
}

/** The badge beside the card title — the state in two or three words, for a glance. */
export function fxHealthBadgeTh(health: FxRateHealthWire): string {
  switch (fxHealthVerdict(health)) {
    case 'ok':
      return 'ปกติ';
    case 'warn':
      return 'เริ่มเก่า';
    case 'stale_blocked':
      return 'ปฏิเสธอยู่';
    case 'never_synced':
      return 'ไม่มีอัตราเลย';
    case 'unrecognised':
      return 'สถานะไม่รู้จัก';
  }
}

/**
 * ⚠️ `warn` is `secondary` and not `destructive`, and that is the whole point of having four
 * variants for five states. A red badge over a state in which every quotation still works is how
 * a team learns to stop reading the badge.
 */
export function fxHealthBadgeVariant(
  health: FxRateHealthWire,
): 'outline' | 'secondary' | 'destructive' {
  switch (fxHealthVerdict(health)) {
    case 'ok':
      return 'outline';
    case 'warn':
      return 'secondary';
    default:
      return 'destructive';
  }
}

/**
 * The headline. Leads with the consequence rather than the cause wherever there is one — the same
 * rule `unrecognisedDestinationTitleTh` follows in `quote-alerts.tsx`, for the same reason: what
 * changes the reader's next action goes first, and the hour count is why.
 */
export function fxHealthTitleTh(health: FxRateHealthWire): string {
  switch (fxHealthVerdict(health)) {
    case 'ok':
      return 'อัตราแลกเปลี่ยนเป็นปัจจุบัน';
    case 'warn':
      return 'อัตราแลกเปลี่ยนเริ่มเก่า — ใบเสนอราคาสกุลเงินต่างประเทศยังออกได้ตามปกติ';
    case 'stale_blocked':
      return 'ออกใบเสนอราคาสกุลเงินต่างประเทศไม่ได้ตอนนี้ — อัตราแลกเปลี่ยนเก่าเกินกำหนด';
    case 'never_synced':
      return 'ออกใบเสนอราคาสกุลเงินต่างประเทศไม่ได้เลย — ยังไม่เคยมีอัตราแลกเปลี่ยนในระบบ';
    case 'unrecognised':
      return `เซิร์ฟเวอร์ส่งสถานะ "${health.status}" ที่แดชบอร์ดรุ่นนี้ไม่รู้จัก`;
  }
}

/**
 * What is true right now, in one paragraph, with the hour counts taken from the response.
 *
 * ⚠️ The `warn` sentence and the `stale_blocked` sentence are written to be impossible to
 * mistake for each other. `warn` says *ยังไม่มีใบใดถูกปฏิเสธ* and names the hour at which that
 * stops being true; `stale_blocked` says *ถูกปฏิเสธทุกใบตั้งแต่นี้* in the present tense. Both also
 * say that baht-only quotations are unaffected, because the first question a reader asks on
 * seeing red on a settings page is "is the whole thing down".
 */
export function fxHealthDetailTh(health: FxRateHealthWire): string {
  const warn = fxHoursTh(health.warnAfterHours);
  const refuse = fxHoursTh(health.refuseAfterHours);

  switch (fxHealthVerdict(health)) {
    case 'ok':
      return `อัตราล่าสุดยังใหม่กว่าเกณฑ์เตือน ${warn} ชั่วโมง ใบเสนอราคาสกุลเงินต่างประเทศออกได้ตามปกติ`;
    case 'warn':
      return `อัตราล่าสุดเก่ากว่าเกณฑ์เตือน ${warn} ชั่วโมงแล้ว — เป็นคำเตือนเท่านั้น ยังไม่มีใบเสนอราคาใดถูกปฏิเสธ และจะเริ่มถูกปฏิเสธเมื่ออัตราเก่ากว่า ${refuse} ชั่วโมง จึงยังมีเวลาแก้ก่อนถึงตรงนั้น`;
    case 'stale_blocked':
      return `อัตราล่าสุดเก่ากว่าเกณฑ์ปฏิเสธ ${refuse} ชั่วโมง ระบบจึงปฏิเสธการออกใบเสนอราคาสกุลเงินต่างประเทศทุกใบตั้งแต่นี้ จนกว่าจะดึงอัตราใหม่ได้สำเร็จหรือมีผู้ดูแลกรอกอัตราเอง ส่วนใบเสนอราคาที่คิดเป็นเงินบาทเท่านั้นไม่ได้รับผลกระทบ`;
    case 'never_synced':
      return 'ตารางอัตราแลกเปลี่ยนว่างเปล่า ไม่ใช่ว่าอัตราเก่า แต่คือยังไม่มีอัตราให้ใช้เลยแม้แต่ครั้งเดียว ระบบจึงปฏิเสธใบเสนอราคาสกุลเงินต่างประเทศทุกใบ การรอรอบดึงถัดไปอาจไม่ช่วย เพราะถ้าเคยดึงสำเร็จแม้ครั้งเดียวก็จะมีอัตราค้างอยู่แล้ว ส่วนใบเสนอราคาที่คิดเป็นเงินบาทเท่านั้นไม่ได้รับผลกระทบ';
    case 'unrecognised':
      return `แดชบอร์ดถือว่าใช้งานไม่ได้ไว้ก่อน เพราะการขึ้นสีเขียวทับสถานะที่อ่านไม่ออกคือความผิดพลาดที่แย่ที่สุดของการ์ดนี้ ตัวเลขทั้งหมดข้างล่างยังเป็นของจริงจากเซิร์ฟเวอร์ ใช้ประกอบการตัดสินใจได้ (เกณฑ์เตือน ${warn} ชั่วโมง เกณฑ์ปฏิเสธ ${refuse} ชั่วโมง)`;
  }
}

/**
 * The way out, or `null` when nothing needs one.
 *
 * ⭐ Names the *field* and the *place*, not just "contact an administrator". The remedy is one
 * text box on this same page: open the destination in the tax-country table below and fill in
 * `อัตราแลกเปลี่ยนกำหนดเอง`, which converts at the typed rate directly and is recorded in that
 * destination's change history with the actor's id. That path is chosen over anything faster on
 * purpose — `FxController`'s own note says a second way to influence conversion that skipped the
 * audit row is exactly what this codebase does not have.
 *
 * `null` for `ok` and for `warn`: a warning whose text ends in an instruction reads as a task,
 * and `warn` is explicitly not one yet.
 */
export function fxHealthRemedyTh(health: FxRateHealthWire): string | null {
  switch (fxHealthVerdict(health)) {
    case 'ok':
    case 'warn':
      return null;
    default:
      return 'ถ้าต้องออกใบเสนอราคาสกุลเงินต่างประเทศเดี๋ยวนี้: ในตารางประเทศปลายทางด้านล่าง กด "แก้ไข" ที่ประเทศนั้น แล้วกรอกช่อง "อัตราแลกเปลี่ยนกำหนดเอง" เป็นจำนวนบาทต่อ 1 หน่วยของสกุลเงินนั้น ระบบจะใช้อัตราที่กรอกแทนอัตรากลางตลาดทันที และบันทึกไว้ในประวัติการแก้ไขของประเทศนั้นพร้อมผู้แก้ — ต้องมีสิทธิ์ organisation.write';
  }
}

/**
 * A number of hours as text: `36` → `'36'`, `12.34` → `'12.3'`, `12.04` → `'12'`.
 *
 * One decimal place, because a rate's age is read to decide whether to act and the tenth of an
 * hour is already more precision than that decision needs — while `12.033333333333333 ชั่วโมง` on
 * a settings card is just noise. A trailing `.0` is dropped for the same reason `rateField` in
 * `tax-country-fields.ts` drops it: a figure that always shows a decimal reads as more precise
 * than it is.
 */
export function fxHoursTh(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * How old the newest rate is, in words.
 *
 * ⚠️ **`null` is "never", not "zero".** `ageHours === null` means `fx_rates` has never held a
 * row; printing `0 ชั่วโมง` there would be the single most misleading string this card could
 * produce, because zero hours old is what a perfectly fresh rate looks like.
 *
 * Minutes below one hour (a healthy feed sits between ~1h and ~26h, so sub-hour is worth
 * reading exactly), and a day count added past two days — nobody converts `412.5 ชั่วโมง` into
 * "two and a half weeks" in their head, and "two and a half weeks" is the fact that makes
 * somebody act.
 */
export function fxAgeTh(ageHours: number | null): string {
  if (ageHours === null) return 'ยังไม่เคยมีอัตราแลกเปลี่ยน';

  if (ageHours < 1) return `${String(Math.round(ageHours * 60))} นาที`;
  if (ageHours < 48) return `${fxHoursTh(ageHours)} ชั่วโมง`;

  return `${fxHoursTh(ageHours)} ชั่วโมง (ประมาณ ${String(Math.floor(ageHours / 24))} วัน)`;
}

/**
 * The failure count, and the one reading of it that is a trap.
 *
 * ⭐ **Zero failures beside an old rate is not reassurance — it is the loudest signal here.**
 * `consecutiveFailures` counts failures *recorded since the newest stored rate*, so zero means
 * nothing has failed since then, which beside a stale rate means nothing has *tried*: a stopped
 * scheduler rather than a struggling provider. Those two have different fixes and only one of
 * them resolves itself, so the card says which one it is looking at rather than printing a
 * comforting `0`.
 *
 * The staleness boundary for "old enough that silence is suspicious" is `warnAfterHours` from the
 * response — the same threshold the server warns on — rather than a number invented here.
 *
 * ⚠️ A nonzero count is labelled a lower bound, because it is one: a failure the database refused
 * to record is a failure that is not counted (`FxRatesService.record` swallows that path
 * deliberately). Printing it as exact would overstate what the number knows.
 */
export function fxFailuresTh(health: FxRateHealthWire): string {
  const { ageHours, consecutiveFailures, warnAfterHours } = health;

  if (consecutiveFailures > 0) {
    return `${String(consecutiveFailures)} ครั้ง (เป็นค่าอย่างน้อย — ความล้มเหลวที่บันทึกไม่สำเร็จจะไม่ถูกนับ)`;
  }

  if (ageHours === null || ageHours > warnAfterHours) {
    return '0 ครั้ง — และนี่ไม่ใช่ข่าวดี: อัตราเก่าแล้วแต่ไม่มีการดึงที่ล้มเหลวเลย แปลว่าไม่มีอะไรพยายามดึงอยู่ ให้ไปตรวจตัวตั้งเวลาของงานดึงอัตรา ไม่ใช่ผู้ให้บริการ';
  }

  return '0 ครั้ง';
}

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * ⭐ The frozen feed, stated outright — the failure no fetch-time check can see.
 *
 * A provider whose feed has stopped updating but whose HTTP endpoint is healthy answers 200 every
 * day with the same `timestamp`. That writes a new row daily, so `fetchedAt` is always minutes old
 * and every "did the sync work" check reports perfect health, while the number being frozen onto
 * documents is weeks old. Showing both clocks makes it *visible*; this sentence makes it
 * *diagnosed*, so that a reader who has not internalised the difference between the two columns
 * still leaves knowing which side to chase.
 *
 * The gap is the lag between the two clocks, and it is compared against `warnAfterHours` from the
 * response rather than a threshold of its own — there is no second opinion here about how much
 * staleness is too much, and inventing one would be a number to keep in step with the server's.
 *
 * `null` — say nothing — when either clock is missing (there is nothing to compare, and
 * `never_synced` already has the reader's attention) or when either fails to parse, because a
 * malformed timestamp is a decoding complaint and not a provider diagnosis.
 */
export function fxFrozenFeedTh(health: FxRateHealthWire): string | null {
  const { observedAt, fetchedAt, warnAfterHours } = health;
  if (observedAt === null || fetchedAt === null) return null;

  const observed = Date.parse(observedAt);
  const fetched = Date.parse(fetchedAt);
  if (Number.isNaN(observed) || Number.isNaN(fetched)) return null;

  const lagHours = (fetched - observed) / MS_PER_HOUR;
  if (lagHours <= warnAfterHours) return null;

  return `ระบบดึงข้อมูลสำเร็จ แต่ตัวเลขที่ได้มาถูกออกไว้ก่อนเวลาที่ดึงถึง ${fxHoursTh(lagHours)} ชั่วโมง — ผู้ให้บริการยังตอบปกติแต่หยุดอัปเดตอัตรา การดูแค่ว่า "ดึงสำเร็จหรือไม่" จะไม่เห็นปัญหานี้เลย เพราะดึงสำเร็จทุกครั้งจริง`;
}

/** The two thresholds, printed from the response so this screen keeps no copy of them. */
export function fxThresholdsTh(health: FxRateHealthWire): string {
  return `เตือนเมื่อเก่ากว่า ${fxHoursTh(health.warnAfterHours)} ชั่วโมง · ปฏิเสธเมื่อเก่ากว่า ${fxHoursTh(health.refuseAfterHours)} ชั่วโมง`;
}

/**
 * The same four-line `at` every sibling here defines — `tax-country-history.tsx`,
 * `bank-account-history.tsx`, `profile-history.tsx`. Asia/Bangkok explicitly, so a laptop left on
 * UTC does not quietly show staff a different hour than the one their colleague is reading.
 */
const at = (iso: string): string =>
  new Date(iso).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

/**
 * One of the three timestamps, or the word for its absence.
 *
 * ⚠️ The `null` guard is load-bearing rather than tidy: `new Date(null)` is the Unix epoch, so
 * an unguarded call would print `1 ม.ค. 2513, 07:00` — a real-looking date, in the past, on a card
 * whose entire job is to say how old something is.
 *
 * `format` is injected with `at` as its default so the branch that *is* this file's decision — what
 * absence reads as — is assertable without depending on which ICU build the test runs against.
 * The formatting itself is ICU's and is not this file's to prove.
 */
export function fxClockTh(iso: string | null, format: (iso: string) => string = at): string {
  return iso === null ? 'ยังไม่มี' : format(iso);
}

/* ------------------------------------------------------------------ *
 * The card
 * ------------------------------------------------------------------ */

export function FxHealthCard({ state }: { readonly state: FxHealthState }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>สถานะอัตราแลกเปลี่ยน</CardTitle>
            <CardDescription>
              อัตราที่ระบบใช้แปลงสกุลเงินบนใบเสนอราคา — อ่านได้เท่านั้น ไม่มีอะไรตั้งค่าได้ที่การ์ดนี้
              ตัวเลขทั้งหมดมาจากเซิร์ฟเวอร์ รวมทั้งเกณฑ์เตือนและเกณฑ์ปฏิเสธ ซึ่งเป็นตัวเดียวกับที่ใช้ปฏิเสธจริง
              การ์ดนี้จึงไม่มีทางบอกว่าปกติในขณะที่ใบเสนอราคาถูกปฏิเสธอยู่
            </CardDescription>
          </div>
          {/* Only when there is a state to name. A badge over a skeleton, or over a failed load,
              would be a verdict on a rate this screen has not managed to read. */}
          {state.status === 'ready' && (
            <Badge variant={fxHealthBadgeVariant(state.health)}>{fxHealthBadgeTh(state.health)}</Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {state.status === 'loading' && <Skeleton className="h-40 w-full" />}

        {/* Its own failure, in its own card. A rate feed this screen cannot reach must not take
            the company profile, the bank accounts or the tax table down with it — the same
            independence `organisation-screen.tsx` gives each of its other sections. */}
        {state.status === 'failed' && (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" />
            <AlertTitle>โหลดสถานะอัตราแลกเปลี่ยนไม่สำเร็จ</AlertTitle>
            <AlertDescription>
              {state.problem} — ข้อความนี้บอกว่าอ่านสถานะไม่ได้ ไม่ได้บอกว่าอัตราแลกเปลี่ยนใช้งานได้หรือไม่
            </AlertDescription>
          </Alert>
        )}

        {state.status === 'ready' && <FxHealthBody health={state.health} />}
      </CardContent>
    </Card>
  );
}

function FxHealthBody({ health }: { readonly health: FxRateHealthWire }) {
  const verdict = fxHealthVerdict(health);
  const remedy = fxHealthRemedyTh(health);
  const frozen = fxFrozenFeedTh(health);
  const refused = verdict !== 'ok' && verdict !== 'warn';

  return (
    <>
      <Alert variant={refused ? 'destructive' : 'default'}>
        {verdict === 'ok' ? (
          <CheckCircle2 className="size-4" />
        ) : verdict === 'warn' ? (
          /* A clock, not a triangle. The icon is read before the words are, and `warn` is a
             "this is ageing" state in which every quotation still works. */
          <Clock className="size-4" />
        ) : (
          <AlertTriangle className="size-4" />
        )}
        <AlertTitle>{fxHealthTitleTh(health)}</AlertTitle>
        <AlertDescription className="flex flex-col gap-2">
          <p>{fxHealthDetailTh(health)}</p>
          {remedy !== null && <p>{remedy}</p>}
        </AlertDescription>
      </Alert>

      {/* Separate from the verdict above, because it is orthogonal to it: a frozen feed shows up
          as `ok` for its first day and a half, then as `warn`, then as `blocked` — and the
          explanation is the same one throughout. Folding it into the verdict's paragraph would
          mean it could only be said once the rate was already too old to quote. */}
      {frozen !== null && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>ผู้ให้บริการยังตอบ แต่ตัวเลขไม่ขยับ</AlertTitle>
          <AlertDescription>{frozen}</AlertDescription>
        </Alert>
      )}

      <FieldGroup className="grid gap-4 md:grid-cols-2">
        <ReadOnlyField
          label="อายุของอัตราล่าสุด"
          value={fxAgeTh(health.ageHours)}
          description="วัดจากเวลาที่ผู้ให้บริการออกอัตรา ไม่ใช่เวลาที่ระบบดึงมา — เป็นตัวเลขเดียวกับที่ใช้ตัดสินว่าจะปฏิเสธหรือไม่"
        />
        <ReadOnlyField
          label="ดึงไม่สำเร็จติดต่อกัน"
          value={fxFailuresTh(health)}
          description="นับตั้งแต่อัตราล่าสุดที่เก็บได้ — การดึงที่สำเร็จจะรีเซ็ตตัวเลขนี้เอง ไม่มีใครต้องไปล้างค่า"
        />

        {/* ⚠️ The two clocks, adjacent and labelled, because the pair is the diagnosis and
            neither is derivable from the other. See this file's header. */}
        <ReadOnlyField
          label="ผู้ให้บริการออกอัตรานี้เมื่อ (observedAt)"
          value={fxClockTh(health.observedAt)}
          description="เวลาที่ตลาดให้ตัวเลขนี้ — เวลาเดียวกับที่พิมพ์บนใบเสนอราคาว่า “อ้างอิงอัตรา ณ …”"
        />
        <ReadOnlyField
          label="ระบบดึงมาเก็บเมื่อ (fetchedAt)"
          value={fxClockTh(health.fetchedAt)}
          description="ถ้าเวลานี้ใหม่มากแต่เวลาด้านซ้ายเก่ามาก แปลว่าดึงสำเร็จทุกครั้งแต่ผู้ให้บริการหยุดอัปเดตอัตรา"
        />

        <ReadOnlyField
          label="ดึงไม่สำเร็จครั้งล่าสุดเมื่อ"
          value={fxClockTh(health.lastFailureAt)}
          description="ว่างหมายถึงไม่มีความล้มเหลวที่บันทึกไว้เลย ซึ่งอ่านคู่กับช่องจำนวนครั้งด้านบน"
        />
        <ReadOnlyField
          label="เกณฑ์ที่ใช้ตัดสิน"
          value={fxThresholdsTh(health)}
          description="ค่าคงที่ฝั่งเซิร์ฟเวอร์ ส่งลงมาพร้อมสถานะ เพื่อให้หน้าจอนี้ไม่ต้องเก็บสำเนาไว้เองและไม่มีทางอ้างเลขที่ไม่ตรงกับของจริง"
        />
      </FieldGroup>
    </>
  );
}
