import type {
  FxConfiguredRateWire,
  FxManualSyncBudgetWire,
  FxManualSyncResultWire,
  FxRateHealthWire,
} from '@wewin/contract/organisation';

/**
 * ──────────────────────────────────────────────────────────────────────────────
 * ⭐ EVERY SENTENCE THE EXCHANGE-RATE CARD SAYS — as functions of the wire row, and nothing else.
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ **This file exists because `fx-health.tsx` said it should, and then said when.**
 *
 * That file's header carried the trade-off out loud rather than discovering it: exporting pure
 * functions from a `.tsx` trips `react/only-export-components`, which the root `.oxlintrc.json`
 * sets to `warn`. It accepted fourteen such warnings on the grounds that the rule is about Fast
 * Refresh preserving component state in dev rather than about correctness, and that the two
 * alternatives available at the time were worse — in particular that putting Thai copy about
 * stopped cron jobs into `fx-health-api.ts` would put two unrelated concerns behind one name. And
 * then it named the condition and the remedy exactly:
 *
 *   *"Should this card's wording ever grow past what fits comfortably here, the fix is a third
 *   file — `fx-health-copy.ts` — and not a retreat from testing what the card says."*
 *
 * The round that put the synced figures and the manual-sync button on the card took that count
 * from fourteen to twenty-seven. This is that third file, opened on the terms its own predecessor
 * set, and the second half of that sentence is honoured too: **not one assertion moved**. Every
 * function below is byte-for-byte what it was in the `.tsx`; `fx-health.test.ts` changed by one
 * import specifier and nothing else, which is the whole proof that this was a move and not a
 * rewrite.
 *
 * ── Why a `-copy` module and not `-fields`, which is the house name ──────────
 *
 * The pattern being followed is `tax-country-fields.ts` beside `tax-countries.tsx`: the pure half
 * of a screen, provable without rendering, per `vitest.config.ts`'s stance that a component test
 * here would be a test of these functions spelled expensively. The name differs because the
 * content does. `-fields` is a *codec* — `rateField`/`readRateBp`, text in and values out, a form's
 * two directions. Nothing here is a codec: every function is one-way, wire row in and a Thai
 * sentence out, and there is no reading anything back. `-copy` says which of the two this is, so
 * nobody looks in here for a parser.
 *
 * ── ⭐ What did NOT come with it, and why the split lands where it does ─────
 *
 * `FxHealthState` stayed behind. It is the shape of `FxHealthCard`'s prop — loading, failed,
 * ready — and it describes the *component's* contract with `organisation-screen.tsx`, not
 * anything any sentence below is derived from. `FxHealthVerdict` came, because it is the value
 * these functions switch on and it is meaningless without them.
 *
 * `decodeFxRateHealth` and `postFxManualSync` stayed in `fx-health-api.ts`, which is the
 * distinction that made this file necessary in the first place: that one narrows a wire payload,
 * this one words it.
 *
 * ── ⚠️ The rule the whole card is built on, restated where it now lives ────
 *
 * **Every threshold in every sentence comes from the response.** `warnAfterHours`,
 * `refuseAfterHours` and `dailyLimit` are reported *down* precisely so this screen holds no copy
 * of them: there is no `36`, no `72` and no `10` anywhere in this file, and there must not be.
 * The drift that matters is a screen quoting one number while the refusal compares against
 * another — green over a submit that is being refused, or a budget the server will not honour.
 * `fx-health.test.ts` enforces it by building every fixture with values that are *not* the
 * server's real ones, so a hardcoded copy passes a test written against reality and fails there.
 */

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
 * ⭐ The permission that can end an outage, named once because three sentences on this card name
 * it — the remedy below, the recipients field's description, and the zero-recipient warning.
 *
 * Naming a permission code in Thai staff copy is deliberate and not a leak of internals: it is the
 * string an administrator types into the groups screen, so a sentence that said "the appropriate
 * permission" would be a sentence nobody could act on. It is a constant rather than three literals
 * for the ordinary reason — the three would drift, and two of them would then send a reader to
 * grant something that is not what the email is routed on.
 *
 * ⚠️ Not imported from a shared permissions module, because there is no runtime one to import
 * from: `PermissionCode` is a server-side type and the wire carries only the *count*. This is a
 * copy of a server-side fact, and the honest place for it is one line the compiler cannot check —
 * which is why `fx-health.test.ts` asserts the string appears in the copy that matters.
 *
 * ⭐ Exported now, where it used to be module-private: the card's recipients field prints it in
 * its own description, and that field is a component. It is the same one definition either way —
 * the point of the constant is that the three sentences naming this code cannot drift, and a
 * fourth reader across a module boundary changes nothing about that.
 */
export const FX_FIX_PERMISSION = 'organisation.write';

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
      return `ถ้าต้องออกใบเสนอราคาสกุลเงินต่างประเทศเดี๋ยวนี้: ในตารางประเทศปลายทางด้านล่าง กด "แก้ไข" ที่ประเทศนั้น แล้วกรอกช่อง "อัตราแลกเปลี่ยนกำหนดเอง" เป็นจำนวนบาทต่อ 1 หน่วยของสกุลเงินนั้น ระบบจะใช้อัตราที่กรอกแทนอัตรากลางตลาดทันที และบันทึกไว้ในประวัติการแก้ไขของประเทศนั้นพร้อมผู้แก้ — ต้องมีสิทธิ์ ${FX_FIX_PERMISSION}`;
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

/**
 * How many people the staleness warning could actually reach.
 *
 * ⚠️ **Zero is printed as a fact, not as a number**, for the same reason `fxFailuresTh` refuses to
 * print a comforting `0`: a bare `0 คน` in a column of counts reads as "nothing to see", and this
 * particular zero is the most consequential value on the card. The sentence in the field says what
 * it means; `fxNoRecipientsTh` below says what to do about it.
 *
 * `คน` and not `รายชื่อ` on purpose — these are people resolved from the permission model at send
 * time, not entries on a list somebody maintains.
 */
export function fxRecipientsTh(health: FxRateHealthWire): string {
  if (health.warningRecipients === 0) {
    return '0 คน — ไม่มีใครที่ระบบจะแจ้งได้เมื่ออัตราแลกเปลี่ยนเริ่มเก่า';
  }

  return `${String(health.warningRecipients)} คน`;
}

/**
 * ⭐ Nobody can be told — the condition that is worse than the one this card was built to report.
 *
 * `null` — say nothing — whenever at least one person is reachable. Non-`null` whenever the count
 * is zero, **and that is deliberately not conditioned on `status`**. See this file's header: a
 * green feed with no reachable holder of the permission is a trap that has already been set, and
 * the only useful time to say so is before it fires. A version of this check that only spoke when
 * the rate was already stale would speak for the first time in the one state where the warning it
 * is about has already failed to arrive.
 *
 * The copy has to do three jobs, and each is one somebody got wrong in the log-line version of
 * this:
 *
 *   1. **Name the consequence, not the configuration.** Not "no recipients are configured" — there
 *      is nothing to configure. The consequence is that the rate will go stale and the people who
 *      could type a manual rate will find out when a quotation is refused.
 *   2. **Name the fix as a grant, not as a settings change.** Grant `organisation.write` to an
 *      active account, or reactivate one — those are the two shapes this condition has.
 *   3. **Say that the count measures reachability, not authority.** Somebody suspended, or with no
 *      primary address, holds the permission and is still not counted, because they cannot be
 *      told. Without that sentence an administrator looking at a groups screen listing four
 *      holders reads the `0` as a bug in this card and stops.
 *
 * And it says outright that the shared sales queue still gets its copy, because it does — while
 * refusing to let that read as a substitute. Somebody being told is better than nobody; it is not
 * the same as reaching a person who holds the permission.
 */
export function fxNoRecipientsTh(health: FxRateHealthWire): string | null {
  if (health.warningRecipients > 0) return null;

  return (
    `ไม่มีบัญชีที่ใช้งานอยู่คนใดถือสิทธิ์ ${FX_FIX_PERMISSION} พร้อมอีเมลหลัก ระบบจึงไม่มีใครให้แจ้งเมื่ออัตราแลกเปลี่ยนเริ่มเก่า — ` +
    'คนที่กรอกอัตราเองเพื่อจบปัญหาได้จะไม่ได้รับอีเมลเลย และจะรู้ตัวตอนที่ออกใบเสนอราคาสกุลเงินต่างประเทศไม่ได้แล้ว ' +
    'คำเตือนนี้จึงขึ้นทุกครั้งที่ตัวเลขนี้เป็นศูนย์ ไม่ว่าสถานะอัตราด้านบนจะเป็นอะไร เพราะต้องแก้ก่อนอัตราจะเก่า ไม่ใช่หลังจากนั้น ' +
    `วิธีแก้: ให้สิทธิ์ ${FX_FIX_PERMISSION} กับบัญชีที่ใช้งานอยู่ หรือเปิดใช้งานบัญชีที่ถูกระงับไว้กลับมา แล้วตรวจว่าบัญชีนั้นมีอีเมลหลัก ` +
    'ตัวเลขนี้นับว่าแจ้งถึงได้จริงกี่คน ไม่ใช่ว่ามีสิทธิ์กี่คน — ผู้ที่ถือสิทธิ์แต่บัญชีถูกระงับ หรือไม่มีอีเมลหลัก จะไม่ถูกนับ เพราะแจ้งไปก็ไม่ถึงตัว ' +
    'ส่วนอีเมลที่เข้ากล่องกลางของฝ่ายขายยังส่งตามปกติ แต่นั่นไม่เท่ากับมีคนที่ถือสิทธิ์รู้เรื่อง'
  );
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
 * ⭐ The numbers that were synced — and keeping them apart from the provider's
 * ------------------------------------------------------------------ */

/**
 * ⭐⭐ **THE RATE — baht per one unit, with the unit written into the string.**
 *
 * This is the figure a staff member compares against a bank's screen or a search engine, and it
 * is the only one on the card that is comparable against either. Everything about how it is
 * rendered is aimed at one failure: somebody reading the provider's `1.35` as though it were a
 * baht rate.
 *
 * ⚠️ **The unit is part of the value, not a column heading.** `27.037037` under a heading that
 * says "อัตรา" is a number a reader supplies their own units for, and the units they supply will
 * be whichever ones they were already thinking about. `27.037037 บาท ต่อ 1 SGD` cannot be
 * misread, survives being copied into a chat message, and is still right when the heading has
 * scrolled off the top of a phone. The provider's raw figures below get the identical treatment
 * for the identical reason — see `fxProviderRawTh`.
 *
 * `null` when there is no resolved rate; `fxRateProblemTh` says why instead.
 */
export function fxRateTh(rate: FxConfiguredRateWire): string | null {
  if (rate.effectiveThbPerUnit === null) return null;

  return `${rate.effectiveThbPerUnit} บาท ต่อ 1 ${rate.currency}`;
}

/**
 * Where that rate came from, in the words the tax-country dialog uses for the same settings.
 *
 * ⚠️ The manual arm says the spread is **not** applied, out loud, even though `spreadApplied` is
 * on the payload and the card could simply not mention it. THE RULE in `packages/core/src/fx.ts`
 * is genuinely surprising the first time — an administrator who set a spread and then typed an
 * override reasonably expects both to be in force — and a screen that stays silent about it lets
 * that expectation survive contact with a figure that contradicts it.
 */
export function fxRateSourceTh(rate: FxConfiguredRateWire): string {
  if (rate.source === 'manual') {
    return rate.spreadBp === 0
      ? 'อัตราแลกเปลี่ยนกำหนดเอง (กรอกไว้ที่ประเทศนี้)'
      : `อัตราแลกเปลี่ยนกำหนดเอง (กรอกไว้ที่ประเทศนี้) — ส่วนต่าง ${fxSpreadTh(rate.spreadBp)} ที่ตั้งไว้ไม่ถูกนำมาใช้ซ้ำกับอัตราที่กรอกเอง`;
  }

  return rate.spreadBp === 0
    ? 'อัตรากลางตลาดจากผู้ให้บริการ (ไม่ได้ตั้งส่วนต่างไว้)'
    : `อัตรากลางตลาดจากผู้ให้บริการ หักส่วนต่าง ${fxSpreadTh(rate.spreadBp)} แล้ว`;
}

/** Basis points as a percentage: `200` → `'2%'`, `250` → `'2.5%'`. */
export function fxSpreadTh(spreadBp: number): string {
  const percent = Math.round((spreadBp / 100) * 100) / 100;
  return `${String(percent)}%`;
}

/**
 * ⭐ The mid-market rate before the spread — and `null` whenever there is not one.
 *
 * Shown only for `source: 'mid_market'`, because that is the only case in which a "rate before
 * the spread" exists. See `FxConfiguredRateWire.midThbPerUnit`: for an override the server sends
 * `null` deliberately rather than deriving a figure the system would never apply, and this
 * function's job is to not invent one either.
 */
export function fxMidRateTh(rate: FxConfiguredRateWire): string | null {
  if (rate.midThbPerUnit === null) return null;

  return `ก่อนหักส่วนต่าง: ${rate.midThbPerUnit} บาท ต่อ 1 ${rate.currency}`;
}

/**
 * ⭐⭐ **THE PROVIDER'S OWN NUMBERS — and the sentence that stops them being mistaken for the rate.**
 *
 * The free plan is USD-base, so what the feed actually holds for Singapore is `1.35`, meaning
 * *1.35 Singapore dollars per US dollar*. The useful figure is ~27 baht per Singapore dollar.
 * Between them sit a reciprocal, a cross-rate through USD and a spread. They are not the same
 * quantity and not the same order of magnitude, and a staff member checking "SGD to THB" against
 * a search engine will see 27.
 *
 * So every raw figure is rendered as a **full equation including the base** — `1 USD = 1.35 SGD`
 * — rather than as a bare number under a heading. An equation cannot be silently re-unitised by
 * the reader. And the string ends by saying outright that this is not the rate used for pricing,
 * because a settings card is read at speed and the label above a value is the first thing to be
 * skipped.
 *
 * `null` — say nothing — when there is no observation for this currency at all: a heading with
 * "ไม่มี" under it invites a reader to wonder what is broken, and `fxRateProblemTh` is already
 * saying what is.
 */
export function fxProviderRawTh(rate: FxConfiguredRateWire, base: string | null): string | null {
  if (rate.provider === null || base === null) return null;

  return (
    `1 ${base} = ${String(rate.provider.unitPerBase)} ${rate.currency} · ` +
    `1 ${base} = ${String(rate.provider.thbPerBase)} THB — ` +
    'เป็นตัวเลขดิบที่ผู้ให้บริการส่งมา อิงฐาน ' +
    `${base} ไม่ใช่อัตราที่ระบบใช้เสนอราคา`
  );
}

/**
 * ⭐ For a destination quoting off a typed override: the feed's number is **not what is used**.
 *
 * The owner's instruction on this was explicit — say so on screen rather than showing a figure
 * that is never applied — and it is right, because a manual destination is the case in which the
 * card is at its most misleading by default. The feed keeps bringing SGD in every day; that
 * number is on this card because this card is about the feed; and it has no effect on a single
 * baht of any quotation for as long as the override is set.
 *
 * The sentence also names the way *back*, because the pairing is what makes the state
 * intelligible: clearing `อัตราแลกเปลี่ยนกำหนดเอง` is what puts the feed back in charge, and an
 * administrator who does not know that will read this as the feed being broken for that country.
 *
 * `null` for a mid-market destination — there is nothing surprising to explain there.
 */
export function fxManualOverrideNoteTh(rate: FxConfiguredRateWire): string | null {
  if (rate.source !== 'manual') return null;

  return (
    `ประเทศนี้ใช้อัตราที่กรอกเองไว้ ${rate.effectiveThbPerUnit ?? '—'} บาท ต่อ 1 ${rate.currency} ` +
    'ระบบจึงไม่ได้ใช้ตัวเลขที่ดึงมาจากผู้ให้บริการกับประเทศนี้เลย แม้จะดึงมาได้ทุกวันก็ตาม — ' +
    'ตัวเลขของผู้ให้บริการที่แสดงไว้จึงมีไว้ให้เทียบดูเฉยๆ ไม่ได้ใช้คิดราคา ' +
    'ถ้าต้องการกลับไปใช้อัตราตลาดตามที่ดึงมา ให้ล้างช่อง “อัตราแลกเปลี่ยนกำหนดเอง” ของประเทศนี้ในตารางด้านล่าง'
  );
}

/**
 * Why a destination has no usable rate, in a sentence naming what to do about it.
 *
 * `null` when there is one. The four causes come from `@wewin/core/fx`'s own vocabulary plus
 * `no_snapshot`, and they are worded apart because the fixes are genuinely different: an empty
 * table is a sync problem, a currency the provider does not carry is a configuration problem, and
 * an unreadable override is a typo in a text box on this very page.
 *
 * ⚠️ An unrecognised cause resolves toward "unusable", never toward silence — the same stance
 * `fxHealthVerdict` takes about an unknown `status`, for the same reason. A blank cell where a
 * rate belongs reads as "loading", and this row is not loading, it is refusing.
 */
export function fxRateProblemTh(rate: FxConfiguredRateWire): string | null {
  if (rate.problem === null) return null;

  switch (rate.problem) {
    case 'no_snapshot':
      return 'ยังไม่มีอัตราแลกเปลี่ยนในระบบเลย จึงคำนวณอัตราของประเทศนี้ไม่ได้ — ใบเสนอราคาสกุลเงินนี้จะถูกปฏิเสธจนกว่าจะดึงอัตราได้สำเร็จ หรือมีผู้ดูแลกรอกอัตราเอง';
    case 'destination_rate_missing':
      return `ชุดอัตราที่ดึงมาไม่มีสกุลเงิน ${rate.currency} อยู่ในนั้น จึงแปลงค่าให้ประเทศนี้ไม่ได้ — เป็นปัญหาเฉพาะประเทศนี้ ประเทศอื่นยังใช้ได้ตามปกติ ทางแก้คือกรอกอัตราแลกเปลี่ยนกำหนดเองให้ประเทศนี้`;
    case 'baht_rate_missing':
      return 'ชุดอัตราที่ดึงมาไม่มีค่าเงินบาทอยู่ในนั้น จึงแปลงจากบาทไม่ได้เลย — ปัญหานี้กระทบทุกประเทศพร้อมกัน ไม่ใช่เฉพาะประเทศนี้';
    case 'manual_rate_unreadable':
      return 'อัตราแลกเปลี่ยนกำหนดเองที่กรอกไว้อ่านเป็นตัวเลขไม่ได้ ระบบจึงไม่ใช้ทั้งอัตราที่กรอกและอัตราตลาด — ให้แก้ค่าในช่อง “อัตราแลกเปลี่ยนกำหนดเอง” ของประเทศนี้ในตารางด้านล่าง';
    case 'same_currency':
      return 'ประเทศนี้ถูกตั้งค่าสกุลเงินเป็นบาท ซึ่งไม่ใช่การแปลงค่า — ให้ล้างช่องสกุลเงินของประเทศนี้ในตารางด้านล่าง';
    default:
      return `ระบบคำนวณอัตราของประเทศนี้ไม่ได้ (เหตุผล "${rate.problem}" ที่แดชบอร์ดรุ่นนี้ไม่รู้จัก) — ให้ถือว่าใช้ไม่ได้ไว้ก่อน`;
  }
}

/**
 * What to say when there are no rows at all — and there are two reasons for that, not one.
 *
 * `null` when there is at least one destination to show.
 *
 * ⚠️ The two empties are told apart, because they need opposite responses. **No destination
 * configured** is an ordinary state of a business selling only in Thailand, and nothing is wrong.
 * **Destinations configured but nothing ever synced** is the state in which every foreign
 * quotation is already being refused. A single "ไม่มีข้อมูล" covering both would reassure a reader
 * during an outage.
 */
export function fxNoConfiguredRatesTh(health: FxRateHealthWire): string | null {
  if (health.configuredRates.length > 0) return null;

  return 'ยังไม่มีประเทศปลายทางใดตั้งค่าสกุลเงินต่างประเทศไว้ ทุกใบเสนอราคาจึงคิดเป็นเงินบาทอย่างเดียว และอัตราที่ดึงมาไม่ได้ถูกนำไปใช้กับใบใดเลย — ถ้าต้องการเสนอราคาเป็นสกุลเงินอื่น ให้ตั้งค่าสกุลเงินที่ประเทศปลายทางในตารางด้านล่าง';
}

/* ------------------------------------------------------------------ *
 * ⭐ The manual sync, its budget, and its most common outcome
 * ------------------------------------------------------------------ */

/**
 * ⭐ How much of the manual sync's budget is left — printed **before** the button is pressed.
 *
 * The whole difficulty with this guard is that its cost is displaced in time. Spending the
 * month's quota today does not hurt today; it hurts next week, when the 01:00 sync draws on the
 * same 1,000 requests, finds none, and the rate quietly stops moving until a foreign quotation is
 * refused. Nobody makes that connection unprompted, so the screen makes it: this sentence names
 * the shared pool every time, not only when the budget is nearly gone.
 *
 * Every figure comes from the response — `dailyLimit` is a server constant reported down, exactly
 * as `warnAfterHours` is, so this screen keeps no copy of a number the refusal compares against.
 */
export function fxSyncBudgetTh(budget: FxManualSyncBudgetWire): string {
  return (
    `เหลือสิทธิ์ซิงก์ด้วยตนเอง ${String(budget.remainingToday)} จาก ${String(budget.dailyLimit)} ครั้งในรอบ 24 ชั่วโมง — ` +
    'โควตาการดึงจากผู้ให้บริการเป็นของทั้งระบบร่วมกัน และรอบดึงอัตโนมัติตอนตีหนึ่งใช้โควตาก้อนเดียวกัน ' +
    'การกดถี่ ๆ วันนี้จึงทำให้รอบอัตโนมัติดึงไม่ได้ในสัปดาห์หน้า'
  );
}

/**
 * Why the button is not available right now, or `null` when it is.
 *
 * Two sentences for the two limits, because the reader's next move differs: a spent quota means
 * stop until tomorrow, and a minimum interval means wait under a minute. `remainingToday` is what
 * separates them — see `FxManualSyncBudgetWire.nextAllowedAt`, which is non-`null` for both.
 */
export function fxSyncBlockedTh(
  budget: FxManualSyncBudgetWire,
  format: (iso: string) => string = at,
): string | null {
  if (budget.nextAllowedAt === null) return null;

  if (budget.remainingToday === 0) {
    return `ใช้สิทธิ์ซิงก์ด้วยตนเองครบ ${String(budget.dailyLimit)} ครั้งแล้วในรอบ 24 ชั่วโมง จะกดได้อีกครั้งประมาณ ${format(budget.nextAllowedAt)} — ถ้าต้องใช้อัตราใหม่ก่อนหน้านั้น ให้กรอก “อัตราแลกเปลี่ยนกำหนดเอง” ที่ประเทศปลายทางแทน`;
  }

  return `เพิ่งซิงก์ไปเมื่อครู่ ระบบเว้นระยะอย่างน้อย ${String(budget.minIntervalSeconds)} วินาทีระหว่างการกดแต่ละครั้ง จะกดได้อีกครั้งประมาณ ${format(budget.nextAllowedAt)}`;
}

/**
 * ⭐⭐ **WHAT THE SYNC ACTUALLY DID — and `unchanged` is why this function exists.**
 *
 * The free plan updates hourly. A manual sync minutes after the last one therefore asks the
 * provider for a number it has not recomputed yet, gets the identical observation back, appends a
 * row, and moves nothing. That is the *ordinary* outcome of pressing this button, not an edge
 * case, and reporting it as success is how a team learns that the button works — right up until
 * the day it matters, when the same green tick means the same nothing.
 *
 * So `unchanged` gets its own sentence, and the sentence has three jobs:
 *
 *   1. **Say the number did not move**, in those words, first.
 *   2. **Say why that is normal**, so nobody starts debugging a working system: the provider
 *      updates hourly and this is what asking again in between looks like.
 *   3. **Say it was not free.** A request was spent and a row was written. `unchanged` is a no-op
 *      against the rate and is not a no-op against the quota, and a reader who takes it for a
 *      no-op will press it ten more times.
 *
 * `failed` names the stage and nothing else — never a URL, never a provider message. `app_id`
 * travels in the request URL, so `FxHttp` is built never to hand its caller either; the stage is
 * enough to say whether to chase a network, a provider, or this database.
 */
export function fxSyncOutcomeTh(result: FxManualSyncResultWire): string {
  switch (result.outcome) {
    case 'stored':
      return 'ดึงอัตราใหม่สำเร็จ และได้ตัวเลขชุดใหม่จริง — เวลาที่ผู้ให้บริการออกอัตราขยับไปแล้ว ตัวเลขด้านล่างเป็นของรอบล่าสุดนี้';
    case 'unchanged':
      return 'ดึงสำเร็จ แต่ได้ตัวเลขชุดเดิมที่ระบบมีอยู่แล้ว — อัตราไม่ได้ขยับ นี่เป็นเรื่องปกติ เพราะผู้ให้บริการอัปเดตอัตราชั่วโมงละครั้ง การกดซ้ำในระหว่างนั้นจะได้ค่าเดิมเสมอ ⚠️ แต่การกดครั้งนี้ใช้โควตาการดึงไปแล้วหนึ่งครั้งเท่ากับการดึงที่ได้ค่าใหม่';
    case 'failed':
      return `ดึงอัตราไม่สำเร็จ (ล้มเหลวที่ขั้นตอน "${result.failureStage ?? 'ไม่ทราบ'}") — ระบบบันทึกความล้มเหลวนี้ไว้แล้วเหมือนกับรอบดึงอัตโนมัติที่ล้มเหลว จึงนับรวมในช่อง “ดึงไม่สำเร็จติดต่อกัน” ด้านบน อัตราเดิมที่เก็บไว้ยังใช้งานได้ตามปกติ ไม่ได้หายไปไหน`;
    case 'disabled':
      return 'ระบบนี้ยังไม่ได้ตั้งค่ากุญแจของผู้ให้บริการอัตราแลกเปลี่ยน (OPENEXCHANGERATES_APP_ID) จึงไม่ได้ติดต่อผู้ให้บริการเลย ไม่มีการใช้โควตา และไม่มีอะไรถูกบันทึกว่าล้มเหลว — เป็นสภาพปกติของเครื่องพัฒนาที่ยังไม่ได้ใส่กุญแจ';
  }
}

/**
 * ⚠️ `unchanged` is **not** `default`, and that is the whole point of having three variants for
 * four outcomes. A green tick over a number that did not move is precisely the mis-signal this
 * feature exists to remove; `failed` is not an alarm either, because the cached rate is still
 * working and nothing is refused.
 */
export function fxSyncOutcomeVariant(
  result: FxManualSyncResultWire,
): 'default' | 'destructive' {
  return result.outcome === 'failed' ? 'destructive' : 'default';
}

/** The heading over the outcome alert — the verdict in three or four words, for a glance. */
export function fxSyncOutcomeTitleTh(result: FxManualSyncResultWire): string {
  switch (result.outcome) {
    case 'stored':
      return 'ได้อัตราชุดใหม่';
    case 'unchanged':
      return 'ดึงสำเร็จ แต่อัตราไม่ขยับ';
    case 'failed':
      return 'ดึงอัตราไม่สำเร็จ';
    case 'disabled':
      return 'ยังไม่ได้ตั้งค่ากุญแจผู้ให้บริการ';
  }
}
