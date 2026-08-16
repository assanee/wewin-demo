import { describe, expect, it } from 'vitest';

import {
  FORFEIT_STATUS_ORDER,
  FORFEIT_STATUS_TH,
  forfeitPercentText,
  inDisplayOrder,
  parseForfeitPercent,
} from './forfeit-entry';

/**
 * อัตราริบมัดจำ — the box a person types a forfeit rate into.
 *
 * The one thing worth pinning hardest is that **blank and 0 are the same answer**, because the
 * neighbouring deposit box treats 0 as a mistake and the two files share a parser.
 */

describe('a forfeit rate somebody typed', () => {
  it('⭐ reads the ordinary cases', () => {
    expect(parseForfeitPercent('50')).toStrictEqual({ ok: true, bp: 5_000 });
    expect(parseForfeitPercent('50%')).toStrictEqual({ ok: true, bp: 5_000 });
    expect(parseForfeitPercent('12.5')).toStrictEqual({ ok: true, bp: 1_250 });
    expect(parseForfeitPercent('100')).toStrictEqual({ ok: true, bp: 10_000 });
    expect(parseForfeitPercent('๕๐')).toStrictEqual({ ok: true, bp: 5_000 });
  });

  it('⭐ treats an empty box as 0 — nobody should type zeros into rows they do not care about', () => {
    /*
     * ⚠️ The contrast that matters: `parseDepositPercent('')` refuses, because a deposit of
     * nothing is a policy mistake. A forfeit of nothing is the generous, shipped answer.
     */
    expect(parseForfeitPercent('')).toStrictEqual({ ok: true, bp: 0 });
    expect(parseForfeitPercent('   ')).toStrictEqual({ ok: true, bp: 0 });
    expect(parseForfeitPercent('0')).toStrictEqual({ ok: true, bp: 0 });
  });

  it('⛔ refuses over 100%, and says what the ceiling is about', () => {
    const answer = parseForfeitPercent('120');
    expect(answer.ok).toBe(false);
    /* The ceiling is the *deposit*, not the order total — the sentence says so. */
    expect(answer.ok === false && answer.messageTh).toContain('ยอดมัดจำ');
  });

  it('⛔ refuses text and more precision than a basis point carries', () => {
    expect(parseForfeitPercent('ครึ่งหนึ่ง').ok).toBe(false);
    expect(parseForfeitPercent('50.555').ok).toBe(false);
  });

  it('shows 0 as an empty box rather than as a typed zero', () => {
    expect(forfeitPercentText(0)).toBe('');
    expect(forfeitPercentText(5_000)).toBe('50');
    expect(forfeitPercentText(1_250)).toBe('12.5');
  });
});

describe('the order the rows are shown in', () => {
  it('⭐ follows the life of an order, not the alphabet', () => {
    const shuffled = [
      { fromStatus: 'redesign' },
      { fromStatus: 'draft' },
      { fromStatus: 'in_production' },
      { fromStatus: 'awaiting_confirmation' },
    ];

    expect(inDisplayOrder(shuffled).map((cell) => cell.fromStatus)).toStrictEqual([
      'draft',
      'awaiting_confirmation',
      'in_production',
      'redesign',
    ]);
  });

  it('⚠️ puts a status this bundle has never heard of last rather than dropping it', () => {
    /*
     * The cells come from the server, which reads them out of the transitions table. A status
     * added there and not here must still be editable — a row that disappears is a rate nobody
     * can set and nobody can see is missing.
     */
    const withNewcomer = [{ fromStatus: 'a_status_from_a_newer_api' }, { fromStatus: 'draft' }];
    expect(inDisplayOrder(withNewcomer).map((cell) => cell.fromStatus)).toStrictEqual([
      'draft',
      'a_status_from_a_newer_api',
    ]);
  });

  it('⚠️ every status in the display order has Thai', () => {
    /* A missing label would render the wire code on a settings screen. */
    for (const status of FORFEIT_STATUS_ORDER) {
      expect(FORFEIT_STATUS_TH[status], status).toMatch(/[฀-๿]/u);
    }
  });
});
