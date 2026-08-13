import { describe, expect, it } from 'vitest';

import type { AuthorityLimitSnapshot } from '@/components/authority/authority-limits-api';

import { GAP_FLOOR_MS, gapLabelTh } from './elapsed';
import { railSegment, recordLines, recordValueText } from './settings-history';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The settings spine's decisions, proved without a browser.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `apps/dashboard`'s vitest is `environment: 'node'` with no jsdom and **no `.test.tsx`
 * collection** — a `.test.tsx` here is silently never run, which is why this is a `.ts` and why the
 * rail's arithmetic and the record layer are in `settings-history.ts` rather than inside the
 * component. Everything a screenshot can show is left to the screenshots; what is here is the
 * arithmetic and the totality a screenshot of the dev database cannot reach.
 *
 * ⚠️ Every Thai string is compared with `toBe`, never `toContain`. `'3 ชม.'` is a substring of
 * `'13 ชม.'` and `'2 นาที'` of `'12 นาที'`, so a containment assertion on these units passes for
 * the wrong answer — that cost a false pass on the order timeline.
 */

/* ------------------------------------------------------------------ *
 * The rail
 * ------------------------------------------------------------------ */

describe('⭐ which segment of rail an entry draws', () => {
  it('gives a lone entry no rail at all', () => {
    /*
     * The state the order spine has no constant for, because a spine always has a terminus below
     * its last event. `organisation_profile_changes` starts every fresh database at one entry.
     */
    expect(railSegment(0, 1)).toBe('none');
  });

  it('starts at the first marker and stops at the last', () => {
    expect(railSegment(0, 2)).toBe('from-marker');
    expect(railSegment(1, 2)).toBe('to-marker');
  });

  it('passes through every entry between the two ends', () => {
    /* Twelve is the deepest single subject in the dev database — tax country SG. */
    expect(railSegment(0, 12)).toBe('from-marker');
    for (let index = 1; index < 11; index += 1) {
      expect(railSegment(index, 12), `entry ${index} of 12 is a middle entry`).toBe('full');
    }
    expect(railSegment(11, 12)).toBe('to-marker');
  });

  it('never runs the rail off the bottom of the list', () => {
    /*
     * ⚠️ The off-by-one this file exists to pin. `index < total` instead of `index < total - 1`
     * makes the last entry draw a line past its own marker, which reads as "there is more below"
     * on a list that has ended. Asserted as a property over every length rather than one case.
     */
    for (const total of [1, 2, 3, 5, 8, 12, 30]) {
      const last = railSegment(total - 1, total);
      expect(last, `the last of ${total} must not continue downwards`).toBe(
        total === 1 ? 'none' : 'to-marker',
      );
    }
  });
});

/* ------------------------------------------------------------------ *
 * ⭐ The elapsed label, on the settings data it was reused for
 * ------------------------------------------------------------------ */

describe('⭐ the elapsed time between two settings entries', () => {
  /*
   * Real rows off `tax_country_changes` for SG, to millisecond precision — the history that
   * settled both halves of why this label transferred to these dialogs at all.
   */
  it('names a long quiet stretch, which is half the point of the label', () => {
    expect(gapLabelTh('2026-08-10T18:14:40.296Z', '2026-08-12T03:01:12.063Z')).toBe('1 วัน 8 ชม.');
  });

  it('says out loud that a setting has not moved in months', () => {
    /* "This bank account has not changed in four months" — the other half. */
    const start = Date.parse('2026-04-14T09:00:00.000Z');
    const later = new Date(start + 120 * 24 * 60 * 60_000).toISOString();
    expect(gapLabelTh('2026-04-14T09:00:00.000Z', later)).toBe('120 วัน');
  });

  it('labels a cluster of edits minutes apart', () => {
    expect(gapLabelTh('2026-08-12T03:01:12.063Z', '2026-08-12T03:20:40.728Z')).toBe('19 นาที');
    expect(gapLabelTh('2026-08-12T06:30:51.537Z', '2026-08-12T06:34:15.321Z')).toBe('3 นาที');
  });

  it('leaves consecutive clicks unannotated without hiding either entry', () => {
    /*
     * Three real SG pairs under the floor: 66s, 35s and 16s. `null` suppresses a *label*; the
     * component still renders both entries with their own markers, actors and records, and it is
     * those two rows that say somebody was clicking fast.
     */
    expect(GAP_FLOOR_MS).toBe(120_000);
    expect(gapLabelTh('2026-08-12T06:29:44.946Z', '2026-08-12T06:30:51.537Z')).toBeNull();
    expect(gapLabelTh('2026-08-12T09:22:30.249Z', '2026-08-12T09:23:05.490Z')).toBeNull();
    expect(gapLabelTh('2026-08-12T10:16:35.163Z', '2026-08-12T10:16:51.237Z')).toBeNull();
  });

  it('prints nothing when the clock disagrees with the order the API returned', () => {
    /*
     * ⚠️ The API's ordering is the authority, not `changed_at` — `clock_timestamp()` in migration
     * `0039_history_clock` makes a backwards clock rare rather than impossible. A pair the list
     * ordered one way and the clock the other is an *absence* of a duration, not a negative one.
     */
    expect(gapLabelTh('2026-08-12T03:20:40.728Z', '2026-08-12T03:01:12.063Z')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * ⭐⚠️ The record layer, and the bigint that would blank one dialog
 * ------------------------------------------------------------------ */

describe('⭐⚠️ a stored value, read verbatim', () => {
  it('prints a bigint as its digits instead of throwing', () => {
    /*
     * ⚠️⚠️ THE ONE THAT MATTERS. `JSON.stringify(1n)` is a `TypeError`, not a fallback, and
     * `authority_limit_changes`' snapshots carry `maxConcessionThbMinor` as a `bigint`. A record
     * layer that reached for `JSON.stringify` would throw inside render on the authority dialog
     * alone — the one of the four whose subject is who may give away money — and pass every test
     * and every screenshot of the other three.
     */
    expect(recordValueText(500_000n)).toBe('500000');
    expect(recordValueText(0n)).toBe('0');
    /* Past 2^53, which is the whole reason a ceiling is a bigint rather than a number. */
    expect(recordValueText(9_007_199_254_740_993n)).toBe('9007199254740993');
  });

  it('reaches a bigint nested inside a snapshot value', () => {
    /* The replacer, not the top-level branch. A future snapshot holding a nested amount. */
    expect(recordValueText({ ceiling: 12_345n })).toBe('{"ceiling":"12345"}');
    expect(recordValueText([1n, 2n])).toBe('["1","2"]');
  });

  it('keeps a string exactly as stored, including one that looks like something else', () => {
    expect(recordValueText('SCB')).toBe('SCB');
    expect(recordValueText('')).toBe('');
    /* A stored string `"null"` must not become indistinguishable from a stored `null`. */
    expect(recordValueText('null')).toBe('null');
  });

  it('distinguishes the JSON primitives a snapshot can hold', () => {
    expect(recordValueText(null)).toBe('null');
    expect(recordValueText(true)).toBe('true');
    expect(recordValueText(false)).toBe('false');
    expect(recordValueText(700)).toBe('700');
    expect(recordValueText(0)).toBe('0');
  });

  it('renders a nested object rather than [object Object]', () => {
    expect(recordValueText({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
  });
});

describe('⭐⚠️ a snapshot pair, key by key', () => {
  it('renders every key of both sides in one shared order', () => {
    /*
     * ⚠️ The columns must print in the *same* order or they cannot be diffed by eye, which is the
     * reason this is sorted rather than left to `Object.keys` on two separately-parsed objects.
     */
    const lines = recordLines(
      { promptpayId: null, bankCode: 'SCB', accountNumber: '1234567890' },
      { accountNumber: '9999999999', bankCode: 'SCB', promptpayId: '0812345678' },
    );

    expect(lines.map((line) => line.key)).toEqual(['accountNumber', 'bankCode', 'promptpayId']);
    expect(lines[0]?.beforeText).toBe('1234567890');
    expect(lines[0]?.afterText).toBe('9999999999');
  });

  it('⚠️ keeps a key that is in only one side, in both directions', () => {
    /*
     * ⚠️⚠️ The rule this function exists for. The services snapshot a fixed field list on every
     * write, so a key on one side only is an **anomaly** — and an anomaly is the most interesting
     * thing an audit layer can be looking at. Iterating `after` alone drops a removed field;
     * iterating `before` alone drops an added one. Either way the line vanishes with nothing to
     * say it was ever there, on a screen whose entire value is that it is complete.
     */
    const removed = recordLines({ gone: 'was here', kept: 'a' }, { kept: 'a' });
    expect(removed.map((line) => line.key)).toEqual(['gone', 'kept']);
    expect(removed[0]).toMatchObject({ inBefore: true, inAfter: false, beforeText: 'was here' });

    const added = recordLines({ kept: 'a' }, { kept: 'a', fresh: 'new' });
    expect(added.map((line) => line.key)).toEqual(['fresh', 'kept']);
    expect(added[0]).toMatchObject({ inBefore: false, inAfter: true, afterText: 'new' });
  });

  it('⚠️ tells an absent key apart from a stored empty string and a stored null', () => {
    /*
     * Three different facts that would otherwise all print as nothing. `inBefore`/`inAfter` are
     * what carry the distinction; no amount of text in `beforeText` could do it unambiguously.
     */
    const lines = recordLines({ absent: 'x' }, { blank: '', nulled: null });
    const by = (key: string) => lines.find((line) => line.key === key);

    expect(by('absent')).toMatchObject({ inAfter: false });
    expect(by('blank')).toMatchObject({ inAfter: true, afterText: '' });
    expect(by('nulled')).toMatchObject({ inAfter: true, afterText: 'null' });
  });

  it('marks every key as absent from before on a creation', () => {
    const lines = recordLines(null, { bankCode: 'KBANK', isActive: true });

    expect(lines.map((line) => line.key)).toEqual(['bankCode', 'isActive']);
    for (const line of lines) {
      expect(line.inBefore, `${line.key} has no before on a creation`).toBe(false);
      expect(line.inAfter).toBe(true);
    }
    expect(lines[1]?.afterText).toBe('true');
  });

  it('⚠️ survives the authority snapshot shape, which is the one carrying a bigint', () => {
    /*
     * Typed against the real `AuthorityLimitSnapshot`, so this breaks if that interface gains a
     * field — which is also the reason `authority-limit-history.tsx` spreads the snapshot rather
     * than hand-listing its three keys. This is the composition that would have blanked the
     * dialog: a typed snapshot reaching the record layer.
     */
    const before: AuthorityLimitSnapshot = {
      maxConcessionThbMinor: 500_000n,
      noteTh: null,
      isRevoked: false,
    };
    const after: AuthorityLimitSnapshot = {
      maxConcessionThbMinor: 1_500_000n,
      noteTh: 'ขยายให้ทีมขายภาคอีสาน',
      isRevoked: false,
    };

    const lines = recordLines({ ...before }, { ...after });

    expect(lines.map((line) => line.key)).toEqual([
      'isRevoked',
      'maxConcessionThbMinor',
      'noteTh',
    ]);
    expect(lines[1]?.beforeText).toBe('500000');
    expect(lines[1]?.afterText).toBe('1500000');
    expect(lines[2]?.beforeText).toBe('null');
    expect(lines[2]?.afterText).toBe('ขยายให้ทีมขายภาคอีสาน');
  });

  it('returns nothing for two empty snapshots rather than inventing a line', () => {
    expect(recordLines({}, {})).toHaveLength(0);
  });
});
