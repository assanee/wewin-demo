import { describe, expect, it } from 'vitest';
import type { FxRateHealthWire } from '@wewin/contract/organisation';

import { decodeFxRateHealth } from './fx-health-api';
import {
  fxAgeTh,
  fxClockTh,
  fxFailuresTh,
  fxFrozenFeedTh,
  fxHealthBadgeTh,
  fxHealthBadgeVariant,
  fxHealthDetailTh,
  fxHealthRemedyTh,
  fxHealthTitleTh,
  fxHealthVerdict,
  fxHoursTh,
  fxNoRecipientsTh,
  fxRecipientsTh,
  fxThresholdsTh,
} from './fx-health';

/**
 * The words on the exchange-rate health card, asserted as the pure functions that produce them.
 *
 * `apps/dashboard/vitest.config.ts` runs `environment: 'node'` and its own note says why: *"a test
 * that renders a sidebar and asserts it contains three links is a test of `visibleNavigation`,
 * spelled expensively"*. There is no jsdom and no testing library here, and a `.test.tsx` would be
 * silently uncollected by that config's `include`. So nothing below renders: the card's **content**
 * — the thing that decides whether somebody waits, edits a destination, or goes looking for a
 * stopped cron — is a function of one wire row and is tested as one, the same treatment
 * `quote-alerts.test.ts` gives `unrecognisedDestinationTitleTh`.
 *
 * `decodeFxRateHealth` is tested here too. It is pure and DOM-free like everything else in this
 * file, and it is the only thing standing between a renamed field and a card that reports "never
 * synced" — the loudest sentence it can print — because a key went missing.
 *
 * ⚠️ **The threshold assertions are the load-bearing ones.** Every fixture below that quotes an
 * hour count uses `warnAfterHours: 10` / `refuseAfterHours: 20`, which are *not* the server's real
 * 36 and 72. A card that hardcoded the real numbers would pass a test written against 36/72 and
 * fail these, which is the point: the failure this suite exists to catch is a screen quoting one
 * threshold while the refusal compares against another.
 */

/**
 * A healthy row, one field at a time overridden. `warnAfterHours`/`refuseAfterHours` are
 * deliberately not 36/72 — see the note above.
 *
 * `warningRecipients: 4` — nonzero, so the zero-recipient warning stays silent in every fixture
 * that is not specifically about it, and so *every other* assertion in this file is made on a row
 * where somebody could be told. A base fixture of `0` would make that alarm the ambient state and
 * hide the one test that is about it.
 */
const health = (overrides: Readonly<Partial<FxRateHealthWire>> = {}): FxRateHealthWire => ({
  status: 'ok',
  ageHours: 3,
  observedAt: '2026-08-09T01:00:00.000Z',
  fetchedAt: '2026-08-09T01:05:00.000Z',
  consecutiveFailures: 0,
  lastFailureAt: null,
  warnAfterHours: 10,
  refuseAfterHours: 20,
  warningRecipients: 4,
  /*
   * Empty by default, and `dailyLimit: 5` rather than the server's real 10 — the same discipline
   * the two thresholds above are held to, and for the same reason. A card that hardcoded the real
   * daily limit would pass a test written against 10 and fail this one, which is exactly the
   * failure worth catching: a screen promising a budget the server does not enforce.
   */
  configuredRates: [],
  base: 'USD',
  manualSync: {
    dailyLimit: 5,
    usedToday: 0,
    remainingToday: 5,
    minIntervalSeconds: 30,
    nextAllowedAt: null,
  },
  ...overrides,
});

const OK = health();
const WARN = health({ status: 'warn', ageHours: 14 });
const BLOCKED = health({ status: 'blocked', ageHours: 30, consecutiveFailures: 3 });
const NEVER = health({
  status: 'blocked',
  ageHours: null,
  observedAt: null,
  fetchedAt: null,
});
const UNRECOGNISED = health({ status: 'degraded' });

const EVERY_STATE = [OK, WARN, BLOCKED, NEVER, UNRECOGNISED] as const;

describe('five things to say, from three words on the wire', () => {
  it('splits the two facts that both arrive as "blocked"', () => {
    /* The server is right to summarise both as one word — a foreign-currency submit is refused
       either way — and the card is right to split them, because "too old" invites waiting for the
       next sync and "never" means no sync has ever landed. */
    expect(fxHealthVerdict(BLOCKED)).toBe('stale_blocked');
    expect(fxHealthVerdict(NEVER)).toBe('never_synced');
  });

  it('reads the plain words plainly', () => {
    expect(fxHealthVerdict(OK)).toBe('ok');
    expect(fxHealthVerdict(WARN)).toBe('warn');
  });

  it('resolves a word this build has not been taught toward unusable, never toward green', () => {
    /* ⭐ `status` is `string` on the contract and the union lives server-side, so a fourth word is
       a version skew this build can reach. Green over a submit that is being refused is the one
       failure mode `staleness.ts` names explicitly. */
    expect(fxHealthVerdict(UNRECOGNISED)).toBe('unrecognised');
    expect(fxHealthBadgeVariant(UNRECOGNISED)).toBe('destructive');
  });

  it('lets a null age win over the word beside it', () => {
    /* They cannot disagree today. If a future build makes them, the stored fact beats the summary:
       a card cannot honestly report an age it does not have. */
    expect(fxHealthVerdict(health({ status: 'ok', ageHours: null }))).toBe('never_synced');
  });

  it('names every verdict in the badge, with no state left unlabelled', () => {
    const labels = EVERY_STATE.map(fxHealthBadgeTh);

    expect(labels).toStrictEqual(['ปกติ', 'เริ่มเก่า', 'ปฏิเสธอยู่', 'ไม่มีอัตราเลย', 'สถานะไม่รู้จัก']);
    /* Five distinct labels: a badge that read the same in two states would be a badge that cannot
       distinguish "working" from "refusing". */
    expect(new Set(labels).size).toBe(5);
  });
});

describe('the warning state must not read like the refusal', () => {
  it('says out loud that quotations still work', () => {
    /* ⭐ The whole content of `warn` is "you have time". A card that reads like a refusal here
       teaches staff to ignore the one that is a refusal. */
    expect(fxHealthTitleTh(WARN)).toContain('ยังออกได้ตามปกติ');
    expect(fxHealthTitleTh(WARN)).not.toContain('ไม่ได้');
    expect(fxHealthDetailTh(WARN)).toContain('ยังไม่มีใบเสนอราคาใดถูกปฏิเสธ');
  });

  it('is not styled as a failure', () => {
    expect(fxHealthBadgeVariant(WARN)).toBe('secondary');
    expect(fxHealthBadgeVariant(OK)).toBe('outline');
    expect(fxHealthBadgeVariant(BLOCKED)).toBe('destructive');
  });

  it('offers no instructions, because nothing needs doing yet', () => {
    /* A warning whose text ends in a task reads as a task. */
    expect(fxHealthRemedyTh(WARN)).toBeNull();
    expect(fxHealthRemedyTh(OK)).toBeNull();
  });

  it('names the hour at which the warning becomes a refusal', () => {
    const detail = fxHealthDetailTh(WARN);

    /* ⚠️ Each number is asserted *in its role*, not merely present. Both appear in this sentence,
       so a pair of assertions that only checked presence would pass with the two swapped — which
       is the exact mistake that would tell staff they have ten more hours when they have none. */
    expect(detail).toContain('เกณฑ์เตือน 10 ชั่วโมง');
    expect(detail).toContain('ถูกปฏิเสธเมื่ออัตราเก่ากว่า 20 ชั่วโมง');
  });
});

describe('the refusal says it is happening now, and names the way out', () => {
  it('is present tense about being refused', () => {
    expect(fxHealthTitleTh(BLOCKED)).toContain('ไม่ได้ตอนนี้');
    expect(fxHealthDetailTh(BLOCKED)).toContain('ปฏิเสธการออกใบเสนอราคาสกุลเงินต่างประเทศทุกใบ');
  });

  it('says baht-only quotations are unaffected', () => {
    /* The first question on seeing red on a settings page is "is the whole thing down". */
    expect(fxHealthDetailTh(BLOCKED)).toContain('เงินบาทเท่านั้นไม่ได้รับผลกระทบ');
    expect(fxHealthDetailTh(NEVER)).toContain('เงินบาทเท่านั้นไม่ได้รับผลกระทบ');
  });

  it('names the field an administrator has to fill in, not just "ask an administrator"', () => {
    const remedy = fxHealthRemedyTh(BLOCKED);

    /* ⭐ The remedy is one text box on this same page. The field's label here is character-for-
       character the label `tax-country-dialog.tsx` puts on it — a remedy naming a box that does
       not exist under that name is a remedy nobody can follow. */
    expect(remedy).toContain('อัตราแลกเปลี่ยนกำหนดเอง');
    expect(remedy).toContain('ตารางประเทศปลายทาง');
    expect(remedy).toContain('แก้ไข');
    /* And who can do it: the read permission opens this card, the write permission is what the
       edit needs. */
    expect(remedy).toContain('organisation.write');
  });

  it('offers the same way out for a status it cannot read', () => {
    expect(fxHealthRemedyTh(UNRECOGNISED)).not.toBeNull();
    expect(fxHealthRemedyTh(NEVER)).toContain('อัตราแลกเปลี่ยนกำหนดเอง');
  });

  it('quotes the unrecognised word itself rather than swallowing it', () => {
    /* Whoever reads this card is the person who can report the skew. */
    expect(fxHealthTitleTh(UNRECOGNISED)).toContain('degraded');
  });
});

describe('"never synced" is worded as never, not as old', () => {
  it('refuses to call an absent rate an old one', () => {
    const title = fxHealthTitleTh(NEVER);
    const detail = fxHealthDetailTh(NEVER);

    expect(title).toContain('ยังไม่เคยมีอัตราแลกเปลี่ยนในระบบ');
    expect(title).not.toContain('เก่าเกิน');
    expect(detail).toContain('ว่างเปล่า');
    expect(detail).toContain('ไม่ใช่ว่าอัตราเก่า');
  });

  it('quotes no hour count at all, because there is no age to quote', () => {
    /* ⚠️ An hour count in this sentence would be a number describing nothing. */
    expect(fxHealthDetailTh(NEVER)).not.toMatch(/\d/u);
  });

  it('prints the age as never rather than as zero hours', () => {
    /* ⭐ Zero hours old is what a *perfectly fresh* rate looks like. */
    expect(fxAgeTh(null)).toBe('ยังไม่เคยมีอัตราแลกเปลี่ยน');
    expect(fxAgeTh(null)).not.toMatch(/\d/u);
    expect(fxAgeTh(0)).toBe('0 นาที');
  });
});

describe('the thresholds come from the response, never from this screen', () => {
  it('quotes the numbers it was sent and no others', () => {
    /* ⚠️ The fixture's thresholds are 10 and 20 on purpose. A file that hardcoded the server's
       real 36/72 would pass a test written against those and fail this one. */
    for (const row of EVERY_STATE) {
      const said = `${fxHealthTitleTh(row)} ${fxHealthDetailTh(row)} ${fxThresholdsTh(row)}`;

      expect(said, 'a threshold this screen was never sent appears in its copy').not.toMatch(/36|72/u);
    }
  });

  it('prints both thresholds side by side, so a reader can see the gap they have', () => {
    /* Each pinned to its role rather than merely present — the two are adjacent in one string, so
       presence alone would accept them swapped. */
    expect(fxThresholdsTh(OK)).toBe('เตือนเมื่อเก่ากว่า 10 ชั่วโมง · ปฏิเสธเมื่อเก่ากว่า 20 ชั่วโมง');
  });

  it('moves with the response rather than with a constant', () => {
    const shifted = fxThresholdsTh(health({ warnAfterHours: 6, refuseAfterHours: 9 }));

    expect(shifted).toContain('เตือนเมื่อเก่ากว่า 6 ชั่วโมง');
    expect(shifted).toContain('ปฏิเสธเมื่อเก่ากว่า 9 ชั่วโมง');
    expect(shifted).not.toContain('10');
  });
});

describe('an age is read to decide whether to act', () => {
  it('reads sub-hour ages in minutes, where a healthy feed lives', () => {
    expect(fxAgeTh(0.5)).toBe('30 นาที');
    expect(fxAgeTh(0.25)).toBe('15 นาที');
  });

  it('reads ordinary ages in hours, to one decimal place', () => {
    expect(fxAgeTh(1)).toBe('1 ชั่วโมง');
    expect(fxAgeTh(12.34)).toBe('12.3 ชั่วโมง');
  });

  it('adds a day count once nobody would divide by 24 in their head', () => {
    expect(fxAgeTh(48)).toBe('48 ชั่วโมง (ประมาณ 2 วัน)');
    /* Two and a half weeks is the fact that makes somebody act; 412.5 is not. */
    expect(fxAgeTh(412.5)).toBe('412.5 ชั่วโมง (ประมาณ 17 วัน)');
  });

  it('drops a trailing .0 the way a percentage box does', () => {
    expect(fxHoursTh(36)).toBe('36');
    expect(fxHoursTh(12.04)).toBe('12');
    expect(fxHoursTh(12.34)).toBe('12.3');
    expect(fxHoursTh(0.05)).toBe('0.1');
  });
});

describe('zero failures beside an old rate is the loudest signal here', () => {
  it('refuses to print a comforting zero over a stale rate', () => {
    /* ⭐ `consecutiveFailures` counts failures *since the newest stored rate*, so zero beside a
       stale rate means nothing has tried — a stopped scheduler, not a struggling provider. The two
       have different fixes and only one resolves itself. */
    const said = fxFailuresTh(health({ ageHours: 30, consecutiveFailures: 0 }));

    expect(said).toContain('ไม่ใช่ข่าวดี');
    expect(said).toContain('ตัวตั้งเวลา');
  });

  it('says the same thing when there is no rate at all', () => {
    expect(fxFailuresTh(NEVER)).toContain('ไม่ใช่ข่าวดี');
  });

  it('leaves a fresh rate with a plain zero', () => {
    /* Nothing has failed and nothing is stale: silence is the honest reading. */
    expect(fxFailuresTh(health({ ageHours: 3, consecutiveFailures: 0 }))).toBe('0 ครั้ง');
  });

  it('draws the "old enough for silence to be suspicious" line where the server draws it', () => {
    /* `fxRateHealthStatus` warns on `>` and not `>=`, so an age exactly at the threshold is still
       healthy — and this card must not start editorialising half an hour before the server does. */
    expect(fxFailuresTh(health({ ageHours: 10, consecutiveFailures: 0 }))).toBe('0 ครั้ง');
    expect(fxFailuresTh(health({ ageHours: 10.1, consecutiveFailures: 0 }))).toContain('ไม่ใช่ข่าวดี');
  });

  it('labels a nonzero count as the lower bound it is', () => {
    /* A failure the database refused to record is a failure that is not counted — see
       `FxRatesService.record`. Printing it as exact would overstate what the number knows. */
    const said = fxFailuresTh(health({ consecutiveFailures: 3 }));

    expect(said).toContain('3 ครั้ง');
    expect(said).toContain('อย่างน้อย');
  });
});

describe('a frozen provider feed, which no fetch-time check can see', () => {
  it('diagnoses a fresh fetch carrying a weeks-old observation', () => {
    /* ⭐ The provider answers 200 every day with the same `timestamp`. `fetchedAt` is minutes old,
       so every "did the sync work" check reports perfect health while the number being frozen onto
       documents is weeks old. */
    const said = fxFrozenFeedTh(
      health({ observedAt: '2026-07-01T00:00:00.000Z', fetchedAt: '2026-08-09T01:00:00.000Z' }),
    );

    expect(said).toContain('937 ชั่วโมง');
    expect(said).toContain('หยุดอัปเดตอัตรา');
    expect(said).toContain('ดึงสำเร็จ');
  });

  it('stays quiet when the two clocks agree, which is the normal case', () => {
    expect(fxFrozenFeedTh(OK)).toBeNull();
  });

  it('measures the gap against the threshold it was sent, not one of its own', () => {
    /* Exactly at the threshold is not past it — the same `>` the server uses. */
    const atThreshold = health({
      observedAt: '2026-08-09T00:00:00.000Z',
      fetchedAt: '2026-08-09T10:00:00.000Z',
    });
    const pastIt = health({
      observedAt: '2026-08-09T00:00:00.000Z',
      fetchedAt: '2026-08-09T10:30:00.000Z',
    });

    expect(fxFrozenFeedTh(atThreshold)).toBeNull();
    expect(fxFrozenFeedTh(pastIt)).toContain('10.5 ชั่วโมง');
  });

  it('says nothing when there is no pair to compare', () => {
    /* `never_synced` already has the reader's attention, and a malformed timestamp is a decoding
       complaint rather than a provider diagnosis. */
    expect(fxFrozenFeedTh(NEVER)).toBeNull();
    expect(fxFrozenFeedTh(health({ observedAt: 'not a date' }))).toBeNull();
    expect(fxFrozenFeedTh(health({ fetchedAt: 'not a date' }))).toBeNull();
  });
});

describe('nobody to tell, which is worse than the stale rate it would be telling them about', () => {
  const UNREACHABLE = health({ warningRecipients: 0 });

  it('fires while every other thing on this card is green', () => {
    /* ⭐ The assertion this whole feature turns on. A healthy feed with no reachable holder of
       `organisation.write` is a trap that is already armed: when the rate does go stale, the mail
       goes to the sales queue and the people who could type a manual rate are never told, so the
       first anybody hears of it is a refused quotation. The only useful moment to say so is this
       one — while nothing is wrong yet. */
    expect(fxHealthVerdict(UNREACHABLE)).toBe('ok');
    expect(fxNoRecipientsTh(UNREACHABLE)).not.toBeNull();
  });

  it('fires in every state, because the condition does not reference the rate at all', () => {
    for (const row of EVERY_STATE) {
      expect(
        fxNoRecipientsTh({ ...row, warningRecipients: 0 }),
        `no one could be warned and status ${row.status} silenced it`,
      ).not.toBeNull();
    }
  });

  it('stays silent whenever somebody could be told', () => {
    /* ⚠️ The other half of the pair. A warning that fires on a nonzero count is a warning that
       fires always, which is a warning nobody reads. */
    for (const row of EVERY_STATE) {
      expect(fxNoRecipientsTh(row), `status ${row.status} raised a false alarm`).toBeNull();
    }

    expect(fxNoRecipientsTh(health({ warningRecipients: 1 }))).toBeNull();
  });

  it('leaves the badge a verdict on the rate, and nothing else', () => {
    /* The header's promise is that this card cannot read green while quotations are refused. Turning
       the badge red over a feed that is working would trade that mis-signal for its inverse — so the
       recipients condition gets its own alert and touches neither badge nor verdict. */
    expect(fxHealthBadgeTh(UNREACHABLE)).toBe('ปกติ');
    expect(fxHealthBadgeVariant(UNREACHABLE)).toBe('outline');
    expect(fxHealthTitleTh(UNREACHABLE)).toBe(fxHealthTitleTh(OK));
  });

  it('names the consequence rather than a missing configuration', () => {
    const said = fxNoRecipientsTh(UNREACHABLE);

    /* Not "no recipients are configured" — there is nothing to configure. What a reader has to be
       told is that nobody will be told, and that they find out via a refused quotation. */
    expect(said).toContain('ไม่มีใครให้แจ้ง');
    expect(said).toContain('ออกใบเสนอราคาสกุลเงินต่างประเทศไม่ได้');
  });

  it('names the permission to grant, and both shapes the fix takes', () => {
    const said = fxNoRecipientsTh(UNREACHABLE);

    /* ⭐ The permission code appears in Thai staff copy on purpose: it is the string an
       administrator types on the groups screen, and "the appropriate permission" is not actionable.
       The two shapes are a grant to an active account, or reactivating a suspended one. */
    expect(said).toContain('organisation.write');
    expect(said).toContain('ให้สิทธิ์');
    expect(said).toContain('เปิดใช้งานบัญชีที่ถูกระงับ');
  });

  it('says the count measures reachability and not authority', () => {
    const said = fxNoRecipientsTh(UNREACHABLE);

    /* ⚠️ Without this, an administrator looking at a groups screen that lists four holders reads
       the `0` as a bug in this card and stops. A holder who is suspended, or who has no primary
       address, is not counted — because they cannot be told. */
    expect(said).toContain('บัญชีถูกระงับ');
    expect(said).toContain('ไม่มีอีเมลหลัก');
    expect(said).toContain('ไม่ถูกนับ');
  });

  it('refuses to let the shared sales queue read as a substitute', () => {
    const said = fxNoRecipientsTh(UNREACHABLE);

    /* The queue does still get its copy, and somebody being told beats nobody. It is not the same
       as reaching a person who holds the permission, and the sentence has to carry both halves. */
    expect(said).toContain('ฝ่ายขาย');
    expect(said).toContain('ไม่เท่ากับ');
  });

  it('prints an ordinary count as a count', () => {
    expect(fxRecipientsTh(health({ warningRecipients: 4 }))).toBe('4 คน');
    expect(fxRecipientsTh(health({ warningRecipients: 1 }))).toBe('1 คน');
  });

  it('prints zero as the fact it is rather than as a number in a column', () => {
    /* ⭐ The same discipline `fxFailuresTh` applies to a comforting `0`: a bare zero in a row of
       counts reads as "nothing to see", and this zero is the most consequential value on the card. */
    const none = fxRecipientsTh(UNREACHABLE);

    expect(none).toContain('0 คน');
    expect(none).toContain('ไม่มีใคร');
    expect(none).not.toBe('0 คน');
  });
});

describe('a timestamp that is not there', () => {
  it('never lets an absent clock become the Unix epoch', () => {
    /* ⚠️ `new Date(null)` is 1970. An unguarded call would print a real-looking date, in the past,
       on a card whose entire job is to say how old something is. The stub proves the guard runs
       before any formatter does. */
    expect(fxClockTh(null, () => 'FORMATTED')).toBe('ยังไม่มี');
    expect(fxClockTh(null)).not.toContain('2513');
    expect(fxClockTh(null)).not.toContain('1970');
  });

  it('hands a real timestamp to the formatter untouched', () => {
    expect(fxClockTh('2026-08-09T01:00:00.000Z', (iso) => `seen:${iso}`)).toBe(
      'seen:2026-08-09T01:00:00.000Z',
    );
  });
});

describe('the decoder refuses a payload this card would misread', () => {
  const WIRE = {
    status: 'warn',
    ageHours: 40.5,
    observedAt: '2026-08-07T09:00:00.000Z',
    fetchedAt: '2026-08-09T01:00:00.000Z',
    consecutiveFailures: 2,
    lastFailureAt: '2026-08-08T01:00:00.000Z',
    warnAfterHours: 36,
    refuseAfterHours: 72,
    warningRecipients: 3,
    configuredRates: [
      {
        countryCode: 'SG',
        countryNameTh: 'สิงคโปร์',
        currency: 'SGD',
        isActive: true,
        source: 'mid_market',
        effectiveThbPerUnit: '26.496296',
        midThbPerUnit: '27.037037',
        spreadBp: 200,
        spreadApplied: true,
        provider: { unitPerBase: 1.35, thbPerBase: 36.5 },
        problem: null,
      },
    ],
    base: 'USD',
    manualSync: {
      dailyLimit: 10,
      usedToday: 1,
      remainingToday: 9,
      minIntervalSeconds: 60,
      nextAllowedAt: null,
    },
  };

  it('reads a well-formed row field for field', () => {
    expect(decodeFxRateHealth(WIRE)).toStrictEqual(WIRE);
  });

  it('accepts the nulls that are real answers', () => {
    const empty = { ...WIRE, ageHours: null, observedAt: null, fetchedAt: null, lastFailureAt: null };

    expect(decodeFxRateHealth(empty)).toStrictEqual(empty);
  });

  it('refuses an absent nullable key rather than reading it as null', () => {
    /* ⚠️ The trap this exists for: `ageHours: null` is the card's loudest sentence — "there has
       never been a rate". A server build that renamed or dropped the key must not render as that
       off a key that merely went missing. Same for the two clocks and the failure timestamp. */
    for (const key of ['ageHours', 'observedAt', 'fetchedAt', 'lastFailureAt'] as const) {
      const { [key]: _dropped, ...missing } = WIRE;

      expect(() => decodeFxRateHealth(missing), `${key} absent was read as null`).toThrow(TypeError);
    }
  });

  it('refuses a missing or mistyped required field', () => {
    expect(() => decodeFxRateHealth({ ...WIRE, status: 7 })).toThrow(TypeError);
    expect(() => decodeFxRateHealth({ ...WIRE, consecutiveFailures: '2' })).toThrow(TypeError);
    expect(() => decodeFxRateHealth({ ...WIRE, ageHours: '40.5' })).toThrow(TypeError);
    expect(() => decodeFxRateHealth({ ...WIRE, observedAt: 17 })).toThrow(TypeError);
    expect(() => decodeFxRateHealth({ ...WIRE, warnAfterHours: null })).toThrow(TypeError);
    expect(() => decodeFxRateHealth({ ...WIRE, warningRecipients: '3' })).toThrow(TypeError);
    expect(() => decodeFxRateHealth({ ...WIRE, warningRecipients: null })).toThrow(TypeError);
  });

  it('refuses an absent recipient count rather than reading it as nobody', () => {
    /* ⚠️ The mirror image of the `ageHours` trap above, and the reason `warningRecipients` uses the
       plain `num` helper: here the loud value is *zero*, not `null`. A decoder that defaulted a
       missing key to `0` would put "nobody can be told" on a green card off a server build that
       merely renamed the field, and send an administrator granting a permission somebody holds. */
    const { warningRecipients: _dropped, ...missing } = WIRE;

    expect(() => decodeFxRateHealth(missing)).toThrow(TypeError);
  });

  it('refuses anything that is not an object at all', () => {
    expect(() => decodeFxRateHealth(undefined)).toThrow(TypeError);
    expect(() => decodeFxRateHealth(null)).toThrow(TypeError);
    expect(() => decodeFxRateHealth([WIRE])).toThrow(TypeError);
  });

  it('lets an unrecognised status through, because a decode failure hides the whole card', () => {
    /* ⭐ Narrowing `status` to a union here would turn a version skew into a `MALFORMED` error —
       the card replaced by a decode failure, at the exact moment somebody most needs to see the two
       clocks and the failure count. The word passes through; `fxHealthVerdict` decides what to say
       about it. */
    expect(decodeFxRateHealth({ ...WIRE, status: 'degraded' }).status).toBe('degraded');
  });
});
