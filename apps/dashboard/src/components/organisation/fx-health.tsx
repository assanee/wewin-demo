'use client';

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, MailX, RefreshCw } from 'lucide-react';
import type { FxConfiguredRateWire, FxManualSyncBudgetWire, FxManualSyncResultWire, FxRateHealthWire } from '@wewin/contract/organisation';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { ReadOnlyField } from '@/components/products/form-field';
import { failureMessage } from '@/lib/api/errors';
import { postFxManualSync } from './fx-health-api';
import {
  FX_FIX_PERMISSION,
  fxAgeTh,
  fxClockTh,
  fxFailuresTh,
  fxFrozenFeedTh,
  fxHealthBadgeTh,
  fxHealthBadgeVariant,
  fxHealthDetailTh,
  fxHealthRemedyTh,
  fxHealthTitleTh,
  fxManualOverrideNoteTh,
  fxMidRateTh,
  fxNoConfiguredRatesTh,
  fxNoRecipientsTh,
  fxProviderRawTh,
  fxRateProblemTh,
  fxRateSourceTh,
  fxRateTh,
  fxRecipientsTh,
  fxSyncBlockedTh,
  fxSyncBudgetTh,
  fxSyncOutcomeTh,
  fxSyncOutcomeTitleTh,
  fxSyncOutcomeVariant,
  fxThresholdsTh,
} from './fx-health-copy';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ How old the exchange rate is, on a screen instead of in a log.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Before `GET /admin/fx/health` existed, the only thing that knew a sync had failed was a
 * `logger.warn`, and the only thing that knew *how old* the newest rate was, was arithmetic
 * nobody performed. Both facts existed and neither was reachable by a person, which is the
 * definition of a silent failure. This section is the reachable half.
 *
 * ── ⭐ It is the page's primary statement now, and it is no longer a Card ─────
 *
 * `/organisation` is four unrelated jobs on one route, and three of them — the profile, the bank
 * accounts, the tax destinations — are configuration: they say back exactly what somebody last
 * typed, and they cannot be *wrong* while nobody is looking. **This one can.** The rate ages by
 * itself, and past `refuseAfterHours` every foreign-currency quotation in the company is refused
 * by a rule nobody on this screen touched. That is what makes it the one thing worth opening the
 * page with.
 *
 * So `fxHealthTitleTh(health)` is now the screen's single `type-focal` line, on the page ground
 * with no border, and this file owns that line — see `organisation-screen.tsx`'s header for the
 * "at most once per screen" rule it is spending.
 *
 * ⚠️ **The verdict is no longer wrapped in an `Alert`, and the two alerts below it still are.**
 * That is the distinction rather than an inconsistency: the verdict is now the largest text on the
 * page and needs nothing around it to be found, while `fxFrozenFeedTh` and `fxNoRecipientsTh` are
 * *asides* — true or false independently of the verdict, easy to walk past, and each one a warning
 * about a consequence. `Alert` is this app's established shape for exactly that, which is the same
 * argument `account-settings.tsx` makes for keeping its one-way-in Alert while the rest of that
 * screen became plain sections.
 *
 * ⚠️ **It used to say "read-only, and it holds no controls at all — not even a refresh button",
 * and it now holds exactly one.** The half of that sentence that stands is that nothing here is
 * *settable*: the two thresholds are constants in `apps/api/src/fx/staleness.ts`, and the rate is
 * changed by an administrator editing a *destination* in the tax-country table below, which is
 * still why that table sits directly beneath this section. The clause after it — *"rather than at
 * the top of the page"* — has expired: this **is** the top of the page now, and the adjacency was
 * kept by promoting the tax table along with it rather than by holding this one down. What changed
 * besides is that there is now one thing here that is *doable* — ซิงก์เดี๋ยวนี้ — and it sets no
 * value: it asks the provider for the number 01:00 would have asked for. See `SyncNowPanel`.
 *
 * ── ⭐ AND IT NOW SHOWS THE NUMBERS, NOT ONLY THE HEALTH ─────────────────────────
 *
 * The section reported how *old* the rate was and never what it *was*, which meant the one thing a
 * person actually opens this screen to do — check the system's rate against the one they know —
 * was the one thing it could not help with. `configuredRates` on the payload is that gap closed,
 * and the whole of the design is in two rules that `configured-rates.ts` argues server-side and
 * this file renders:
 *
 *   1. **Only the currencies that matter.** The feed carries ~170; the ones shown here are the
 *      ones configured on a destination in `tax_countries`, which is a list of two.
 *   2. **⭐ The provider's number is never presented as the rate.** `rates['SGD'] = 1.35` means
 *      1.35 Singapore dollars per US dollar; the figure staff need is ~27 baht per Singapore
 *      dollar. A reciprocal, a cross-rate and a spread separate them. Every rate here is
 *      rendered with its unit welded into the string (`27.037037 บาท ต่อ 1 SGD`), and every raw
 *      provider figure as a full equation naming the base (`1 USD = 1.35 SGD`), in muted text,
 *      under a label that says it is not what prices anything. A person comparing against Google
 *      has to be unable to pick up the wrong one.
 *
 * ── ⭐ The wording is the feature, and there are five states, not three ──────────
 *
 * `status` carries three words. What a reader has to be told is five things, because two of them
 * hide inside `blocked`:
 *
 *   - **`ok`** — nothing wrong. Says so in one line and gets out of the way.
 *   - **`warn`** — the rate is getting old and **quotations still work**. This is the state most
 *     at risk of being mis-worded into a panic: the whole content of `warn` is *"you have time"*,
 *     and wording that reads like a refusal here trains staff to ignore the one that is a refusal.
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
 * legible only when a reader can see both, so both are on screen with labels saying which is
 * which, and `fxFrozenFeedTh` states the diagnosis outright when the gap is wide enough that
 * nothing else explains it.
 *
 * ── ⭐ Nobody to tell is a worse condition than a stale rate ─────────────────────
 *
 * `warningRecipients` counts the people the staleness email could actually reach: holders of
 * `organisation.write` with an active account and a primary (therefore verified) address. The
 * routing is by permission and not by a configured list because `organisation.write` is exactly
 * what can type `อัตราแลกเปลี่ยนกำหนดเอง` and end the outage.
 *
 * Zero is the condition this section exists to surface, and it is **orthogonal to `status`**: a feed
 * that is green right now with nobody to warn is a trap already armed — when the rate does go
 * stale, the mail goes to the shared sales queue and the people who could fix it are never told,
 * so the first anybody hears of it is a foreign-currency submit being refused. So
 * `fxNoRecipientsTh` is its own alert with its own trigger, shown beside a green verdict rather
 * than folded into the verdict's paragraph — the same separation `fxFrozenFeedTh` gets, for the
 * same reason: a fact that can only be said once the rate is already too old is a fact said too
 * late.
 *
 * ⚠️ It deliberately leaves the badge alone. The badge is a verdict on the *rate*, and the
 * header's promise — that this screen cannot read green while quotations are refused — is about
 * that. Turning the badge red over a working feed would trade one mis-signal for its inverse.
 *
 * ── ⚠️ Every threshold in every sentence comes from the response ─────────────────
 *
 * `warnAfterHours` and `refuseAfterHours` are reported *down* precisely so this screen holds no
 * copy of them. There is no `36` and no `72` anywhere in this file, and there must not be: the
 * drift that matters is a screen quoting one number while the refusal compares against another.
 *
 * ── ⭐ Pure functions, exported, tested — and now next door ─────────────────────
 *
 * Every derived sentence this section prints is a named `…Th` function of the wire row and nothing
 * else, so what it *says* is asserted directly in `fx-health.test.ts` without a DOM, per
 * `vitest.config.ts`'s own stance that a component test here would be a test of those functions
 * spelled expensively. `quote-alerts.tsx` set that precedent.
 *
 * ⚠️ **They used to live in this file, and the paragraph here used to explain why.** It accepted
 * fourteen `react/only-export-components` warnings — a Fast-Refresh ergonomics rule, `warn` in the
 * root `.oxlintrc.json`, not a correctness one — and then named the condition under which that
 * stopped being the right trade: *"Should this card's wording ever grow past what fits comfortably
 * here, the fix is a third file — `fx-health-copy.ts` — and not a retreat from testing what the
 * card says."*
 *
 * The round that added the synced figures and the manual-sync button took that count from fourteen
 * to twenty-seven, which is past the line this file drew for itself. So the sentences now live in
 * `fx-health-copy.ts` and this file exports one component and one type. The second half of that
 * sentence held: nothing was untested to get there, and no assertion changed — the test file moved
 * one import specifier.
 *
 * What stayed: `FxHealthState`, because it is *this component's* contract with
 * `organisation-screen.tsx` rather than anything a sentence is derived from.
 */

export type FxHealthState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly problem: string }
  | { readonly status: 'ready'; readonly health: FxRateHealthWire };


/* ------------------------------------------------------------------ *
 * The section
 * ------------------------------------------------------------------ */

export function FxHealthSection({
  state,
  editable,
  onSynced,
}: {
  readonly state: FxHealthState;
  /**
   * `organisation.write` — resolved once at the top of `OrganisationScreen` and passed down as a
   * boolean, which is this app's rule for every permission gate (see `tax-country-fields.test.ts`
   * on why a component that called `useSession()` itself would be untestable here).
   *
   * The sync panel is **hidden** rather than disabled without it, exactly as every other write
   * control on this page is. A greyed-out button is an invitation to go looking for why.
   */
  readonly editable: boolean;
  /** The parent's reload, so a sync that moved the number redraws the figures it moved. */
  readonly onSynced: () => Promise<void>;
}) {
  /* A skeleton and not a heading over a skeleton: the only thing this band has to say before the
     payload lands is that it is still reading, and the page's own title already says where the
     reader is. */
  if (state.status === 'loading') return <Skeleton className="h-40 w-full" />;

  /* Its own failure, on its own. A rate feed this screen cannot reach must not take the company
     profile, the bank accounts or the tax table down with it — the same independence
     `organisation-screen.tsx` gives each of its other sections. No `type-focal` here either: a
     screen that could not read the status has no verdict to state at 24px. */
  if (state.status === 'failed') {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="size-4" />
        <AlertTitle>โหลดสถานะอัตราแลกเปลี่ยนไม่สำเร็จ</AlertTitle>
        <AlertDescription>
          {state.problem} — ข้อความนี้บอกว่าอ่านสถานะไม่ได้ ไม่ได้บอกว่าอัตราแลกเปลี่ยนใช้งานได้หรือไม่
        </AlertDescription>
      </Alert>
    );
  }

  return <FxHealthBody health={state.health} editable={editable} onSynced={onSynced} />;
}

/**
 * The three bands this section contributes to the page, as a fragment.
 *
 * ⚠️ A fragment and not a wrapper `<div>`, deliberately: `organisation-screen.tsx` lays the page
 * out as one `flex flex-col gap-10`, and returning a fragment makes these three direct children of
 * it. A wrapper would give the exchange-rate bands their own inner spacing rhythm and put them at a
 * different distance from each other than every other band on the page is from its neighbour.
 */
function FxHealthBody({
  health,
  editable,
  onSynced,
}: {
  readonly health: FxRateHealthWire;
  readonly editable: boolean;
  readonly onSynced: () => Promise<void>;
}) {
  const remedy = fxHealthRemedyTh(health);
  const frozen = fxFrozenFeedTh(health);
  const unreachable = fxNoRecipientsTh(health);

  return (
    <>
      <section className="flex flex-col gap-5">
        {/*
         * ⭐ THE PRIMARY THING ON THIS SCREEN. On the page ground, no border, type doing the work.
         *
         * The badge stays beside it and is not a duplicate of it: `fxHealthBadgeTh` is two or three
         * words for a glance and `fxHealthTitleTh` is the sentence — the same pairing an order gets
         * from its status chip and its focal line. The badge is also the only thing here that
         * *colours* the state, and it is a `ui/**` primitive doing it, which is why the verdict
         * losing its red `Alert` wrapper costs nothing.
         */}
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <p className="type-focal text-balance">{fxHealthTitleTh(health)}</p>
            <Badge variant={fxHealthBadgeVariant(health)}>{fxHealthBadgeTh(health)}</Badge>
          </div>

          <p className="text-muted-foreground type-body max-w-3xl">{fxHealthDetailTh(health)}</p>

          {/* Full contrast where the paragraph above it is muted, because this one is an
              instruction rather than an explanation, and it only exists at all in the states
              where somebody has to act. `fxHealthRemedyTh` returns `null` for `ok` and `warn`. */}
          {remedy !== null && <p className="type-body max-w-3xl">{remedy}</p>}
        </div>

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

        {/* ⭐ Orthogonal to the verdict in the same way the frozen feed is, and more so: this one is
            true or false without reference to the rate at all. It is rendered from its own trigger so
            it stands *directly beneath a green verdict* when the feed is healthy and nobody can be
            warned — which is the only moment at which saying it still prevents something. Folding it
            into the verdict would mean this screen first mentioned "nobody was told" in the state
            where the telling had already failed to happen.

            `destructive` and its own icon, because a quiet note under a reassuring verdict is
            furniture: the whole requirement here is that this stays legible while everything else in
            this band says there is nothing to do. `MailX` rather than the `AlertTriangle` above it —
            this is not a third opinion about the rate, it is a message with no destination. */}
        {unreachable !== null && (
          <Alert variant="destructive">
            <MailX className="size-4" />
            <AlertTitle>ไม่มีใครได้รับอีเมลเตือนเมื่ออัตราแลกเปลี่ยนเก่า</AlertTitle>
            <AlertDescription>{unreachable}</AlertDescription>
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
          <ReadOnlyField
            label="คนที่จะได้รับอีเมลเตือนเมื่ออัตราเก่า"
            value={fxRecipientsTh(health)}
            description={`มาจากผู้ที่ถือสิทธิ์ ${FX_FIX_PERMISSION} ในระบบสิทธิ์ ไม่ใช่รายชื่อผู้รับที่ตั้งค่าไว้ที่ไหน — ให้สิทธิ์นี้กับใครเพิ่ม คนนั้นได้รับอีเมลทันทีโดยไม่ต้องแก้รายชื่อ และคนที่ลาออกก็หยุดรับเองเมื่อบัญชีถูกปิด นับเฉพาะบัญชีที่ใช้งานอยู่และมีอีเมลหลัก เพราะเป็นสิทธิ์เดียวกับที่กรอกอัตราแลกเปลี่ยนกำหนดเองได้`}
          />
        </FieldGroup>
      </section>

      <SyncedRates health={health} />

      {/* Hidden, not disabled, without `organisation.write` — the rule every write control on
          this page follows. See `FxHealthSection`'s prop. */}
      {editable && <SyncNowPanel budget={health.manualSync} onSynced={onSynced} />}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * ⭐ The figures
 * ------------------------------------------------------------------ */

function SyncedRates({ health }: { readonly health: FxRateHealthWire }) {
  const empty = fxNoConfiguredRatesTh(health);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        {/*
         * ⚠️ `type-section`, where this was `text-sm font-medium` — **the same 14px as the
         * paragraph directly beneath it**, separated from its own body copy by a font weight and
         * nothing else. That is the app-wide failure this pass exists to fix, in its purest form:
         * a heading indistinguishable from the text it heads is not a heading.
         *
         * An `<h2>` and not the `<h3>` it was, because there is no `<h2>` above it any more: the
         * exchange-rate band opens with a statement rather than a section title, so this is a
         * top-level heading of the page and the document outline should say so.
         */}
        <h2 className="type-section">อัตราที่ระบบถืออยู่ตอนนี้</h2>
        <p className="text-muted-foreground type-body max-w-3xl">
          เฉพาะสกุลเงินที่มีประเทศปลายทางตั้งค่าไว้จริง — ชุดข้อมูลที่ดึงมามีสกุลเงินนับร้อย
          แต่ที่เหลือไม่มีผลกับใบเสนอราคาใดเลย ตัวเลขที่แสดงคืออัตราที่ระบบจะใช้เสนอราคาจริง
          รวมส่วนต่างแล้ว ไม่ใช่ตัวเลขดิบของผู้ให้บริการ
        </p>
      </div>

      {empty !== null ? (
        <p className="text-muted-foreground type-body max-w-3xl">{empty}</p>
      ) : (
        /*
         * ⭐ **A divided list, where this was one bordered box per destination inside a bordered
         * card.** `ConfiguredRateRow` renders once per configured destination, so the source held
         * a single `rounded-md border` and the *screen* drew as many as the company sells into —
         * chrome inside chrome, which is where the ลายตา on this page came from more than anywhere
         * else. A hairline between rows says "these are separate destinations" with one edge
         * instead of four, and it is the same statement. `account-settings.tsx` settled the shape.
         */
        <div className="divide-border/60 flex flex-col divide-y">
          {health.configuredRates.map((rate) => (
            <ConfiguredRateRow key={rate.countryCode} rate={rate} base={health.base} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * ⭐ One destination, with the useful figure large and the provider's raw numbers small.
 *
 * The visual hierarchy is doing real work here and is not decoration: the effective rate is the
 * only number on this row a person should act on, so it is the only one at full size and full
 * contrast. The provider's figures are `text-muted-foreground` and small — present, because this
 * section is about the feed and what the feed said is a fact worth seeing, but never competing for
 * the eye with the number that prices a quotation.
 *
 * ⚠️ The rate is `text-xl` where it was `text-base`. 16px is the one size the scale removed — it
 * is the value that collided with the 14px body copy around it — and this figure is the thing on
 * the row worth reading from across a desk. It deliberately stays *below* the 24px `type-focal`
 * verdict at the top of the page: a rate for one destination does not outrank the sentence saying
 * whether any destination can be quoted at all.
 */
function ConfiguredRateRow({
  rate,
  base,
}: {
  readonly rate: FxConfiguredRateWire;
  readonly base: string | null;
}) {
  const value = fxRateTh(rate);
  const mid = fxMidRateTh(rate);
  const raw = fxProviderRawTh(rate, base);
  const problem = fxRateProblemTh(rate);
  const overridden = fxManualOverrideNoteTh(rate);

  return (
    <div className="flex flex-col gap-1 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="type-body font-medium">
          {rate.countryNameTh} ({rate.countryCode}) · {rate.currency}
        </span>
        <Badge variant={rate.source === 'manual' ? 'secondary' : 'outline'}>
          {rate.source === 'manual' ? 'กรอกอัตราเอง' : 'อัตราตลาด'}
        </Badge>
        {/* A withdrawn destination is still listed, because its rate can still be pinned onto a
            document — see `configuredRates`. The badge is what stops that reading as an error. */}
        {!rate.isActive && <Badge variant="outline">ปิดใช้งานอยู่</Badge>}
      </div>

      {value !== null ? (
        <p className="text-xl leading-tight font-semibold tabular-nums">{value}</p>
      ) : (
        <p className="text-destructive type-body font-medium">คำนวณอัตราไม่ได้</p>
      )}

      <p className="text-muted-foreground type-body">{fxRateSourceTh(rate)}</p>
      {mid !== null && <p className="text-muted-foreground type-body tabular-nums">{mid}</p>}

      {problem !== null && <p className="text-destructive type-body max-w-3xl">{problem}</p>}

      {/* ⭐ The sentence the owner asked for: for a destination with a typed override, the feed's
          number is not what gets used, said outright rather than left to be inferred from a
          badge. See `fxManualOverrideNoteTh`. */}
      {overridden !== null && (
        <p className="text-muted-foreground type-body max-w-3xl">{overridden}</p>
      )}

      {raw !== null && (
        <p className="text-muted-foreground type-caption max-w-3xl tabular-nums">{raw}</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * ⭐ The button, and the budget under it
 * ------------------------------------------------------------------ */

/**
 * ⭐ ซิงก์เดี๋ยวนี้ — with the guard printed above it rather than only enforced behind it.
 *
 * ⚠️ **The disabled state is a courtesy; the guard is the server's.** `FxRatesService.syncNow`
 * refuses on its own and answers 429 with a Thai sentence naming which limit and until when, and
 * that refusal is what actually protects the quota — a client-side `disabled` protects nothing
 * against a second tab, a stale page, or curl. What the disabled state buys is that the ordinary
 * user never meets the refusal at all, and the refusal is a sentence rather than a mystery when
 * they do (a stale budget in a tab left open is exactly how that happens).
 *
 * The budget after the press comes back **on the sync response**, so the button re-disables
 * itself from the server's own arithmetic without waiting for `onSynced` to complete. That
 * matters for the case this whole guard is about: a second press one second after the first.
 */
function SyncNowPanel({
  budget: initial,
  onSynced,
}: {
  readonly budget: FxManualSyncBudgetWire;
  readonly onSynced: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<FxManualSyncResultWire | null>(null);

  /* The freshest budget known: the one the last sync answered with, or the one the section loaded
     with. Never a locally decremented copy — see `syncNow`'s note on re-reading it. */
  const budget = result?.manualSync ?? initial;
  const blocked = fxSyncBlockedTh(budget);

  async function sync(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const outcome = await postFxManualSync();
      setResult(outcome);
      /* Redraw the figures and the two clocks. Awaited inside `busy` so the button stays
         disabled until the figures are showing what the sync actually did. */
      await onSynced();
    } catch (cause) {
      setProblem(failureMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        {/* `type-section`, for the reason `SyncedRates`' own heading gives: this was `text-sm
            font-medium` above a `text-sm` paragraph — a heading two weights, and zero pixels,
            away from the text it heads. */}
        <h2 className="type-section">ดึงอัตราเดี๋ยวนี้</h2>
        <p className="text-muted-foreground type-body max-w-3xl">
          ปกติระบบดึงอัตราวันละครั้งตอนตีหนึ่ง ปุ่มนี้สั่งให้ดึงทันทีโดยไม่ต้องรอรอบถัดไป
          — ไม่ได้ตั้งค่าอะไร และไม่ได้เปลี่ยนอัตราด้วยตัวเอง เพียงแต่ไปถามผู้ให้บริการซ้ำ
        </p>
      </div>

      {/* ⭐ The quota, stated every time and not only when it is nearly gone. The cost of
          pressing this lands a week later, on somebody else; nobody joins those two up on
          their own, so the screen joins them up. */}
      <p className="text-muted-foreground type-body max-w-3xl">{fxSyncBudgetTh(budget)}</p>

      {blocked !== null && (
        <Alert>
          <Clock className="size-4" />
          <AlertTitle>ยังกดซิงก์ไม่ได้ตอนนี้</AlertTitle>
          <AlertDescription>{blocked}</AlertDescription>
        </Alert>
      )}

      <div>
        <Button
          variant="secondary"
          disabled={busy || blocked !== null}
          onClick={() => void sync()}
        >
          {busy ? <Spinner /> : <RefreshCw className="size-4" />}
          ซิงก์อัตราแลกเปลี่ยนเดี๋ยวนี้
        </Button>
      </div>

      {problem !== null && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>ทำรายการไม่สำเร็จ</AlertTitle>
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}

      {result !== null && (
        <Alert variant={fxSyncOutcomeVariant(result)}>
          {result.outcome === 'stored' ? (
            <CheckCircle2 className="size-4" />
          ) : result.outcome === 'failed' ? (
            <AlertTriangle className="size-4" />
          ) : (
            /* A clock, not a tick. `unchanged` is not a success about the thing that was asked
               for, and the icon is read before the words are. */
            <Clock className="size-4" />
          )}
          <AlertTitle>{fxSyncOutcomeTitleTh(result)}</AlertTitle>
          <AlertDescription>{fxSyncOutcomeTh(result)}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}
