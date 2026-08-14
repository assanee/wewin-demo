/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ The ceiling screen's one primary statement: whether anybody may reduce a price at all.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `isFailClosed` means the **entire discount and approval machinery is inert company-wide** —
 * no salesperson may concede a satang and no manager may approve one for them. It is the most
 * consequential sentence this dashboard can print, and it was rendered as a **default-variant
 * `<Alert>`**: visually identical to "ทำรายการไม่สำเร็จ" and to every other notice in the app,
 * in a screen whose only other typography was one muted paragraph.
 *
 * So it becomes the `type-focal` statement, on the page ground with no border — and it keeps a
 * counterpart, which the Alert never had: when ceilings *are* live, the screen now says so
 * instead of saying nothing. A warning that only ever appears in one direction teaches a reader
 * nothing about the other.
 *
 * ⚠️ **The flag decides the branch; the rows only supply the number.** `isFailClosed` comes off
 * the response and is never recomputed from `limits.length === 0` — `authority-limits.test.ts`
 * makes the argument at length: since withdrawal became a flag, a *non-empty* list of withdrawn
 * ceilings is fail-closed, and a client that counted rows would tell an administrator the
 * feature was on the day it had been switched off. If the two ever disagree the flag wins, which
 * is the fail-closed direction and the safe one.
 *
 * Pure, in a `.ts`, because vitest here is `environment: 'node'` and a `.test.tsx` is **silently
 * never collected** — the same reason `authority-limits.ts` holds every other rule on this screen.
 */

/** Just enough of a ceiling to count it. `AuthorityLimitView` structurally satisfies this. */
export interface CountedCeiling {
  /** `null` is a ceiling that grants money **right now** — see the decoder's own test. */
  readonly revokedAt: string | null;
}

export interface AuthorityFocus {
  readonly live: number;
  readonly withdrawn: number;
  /** The `type-focal` line. A statement, not a label. */
  readonly headlineTh: string;
  readonly detailTh: string;
}

export function authorityFocus(input: {
  readonly isFailClosed: boolean;
  readonly limits: readonly CountedCeiling[];
}): AuthorityFocus {
  const live = input.limits.filter((limit) => limit.revokedAt === null).length;
  const withdrawn = input.limits.length - live;

  if (input.isFailClosed) {
    return {
      live,
      withdrawn,
      /*
       * ⚠️ These are the Alert's exact words, deliberately. `authority-limits.test.ts` asserts on
       * this sentence in two places — an empty table and a table of nothing but withdrawn rows —
       * and those cases are the whole point of the screen, not incidental strings. Moving the
       * sentence to a new size is a design change; rewording it would quietly delete two tests'
       * subject matter.
       */
      headlineTh: 'ยังไม่มีใครมีอำนาจลดราคา',
      detailTh:
        'ตอนนี้ไม่มีเพดานที่ใช้งานอยู่เลย พนักงานขายจึงลดราคาเองไม่ได้ และไม่มีใครอนุมัติส่วนลดให้ได้ — ใบเสนอราคาที่ไม่มีส่วนลดยังส่งได้ตามปกติ',
    };
  }

  return {
    live,
    withdrawn,
    headlineTh: `${String(live)} บทบาทลดราคาได้เองภายในเพดาน`,
    detailTh: [
      'บทบาทที่ไม่มีเพดานยังลดราคาเองไม่ได้ และอนุมัติส่วนลดให้ใครไม่ได้',
      ...(withdrawn === 0 ? [] : [`ถูกถอนไปแล้ว ${String(withdrawn)}`]),
    ].join(' · '),
  };
}
