import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  DIMENSION_LABEL_TH,
  EMPTY_LIMIT_FIELDS,
  ceilingMeaningTh,
  changeHeadlineTh,
  changedFields,
  dimensionOptions,
  fieldsFromLimit,
  isGrant,
  limitFormErrors,
  limitFormReady,
  readCeilingMinor,
  setLimitRequest,
} from './authority-limits';
import {
  decodeAuthorityLimit,
  decodeAuthorityLimitChange,
  decodeAuthorityLimitList,
  type AuthorityGroupView,
  type AuthorityLimitChangeView,
  type AuthorityLimitView,
} from './authority-limits-api';
import AuthorityLimitsPanel, { type AuthorityLimitsState } from './authority-limits-panel';

/**
 * The ceiling screen's rules, proved without a browser.
 *
 * `apps/dashboard`'s vitest is `environment: 'node'` — deliberately, and there is no
 * `@testing-library`, no jsdom and no `.test.tsx` collection. So everything that decides what a
 * number *means* lives in `authority-limits.ts` with no React in it, and the component is
 * reduced to layout plus the permission gate, which `renderToStaticMarkup` can still see
 * because the gate is a prop rather than a `useSession()` call.
 */

const limit = (over: Partial<AuthorityLimitView> = {}): AuthorityLimitView => ({
  groupId: '11111111-1111-4111-8111-111111111111',
  groupCode: 'sales_lead',
  groupNameTh: 'หัวหน้าฝ่ายขาย',
  dimension: 'margin',
  maxConcessionThbMinor: 500_000n,
  grantedByUserId: '22222222-2222-4222-8222-222222222222',
  updatedAt: '2026-08-11T03:00:00.000Z',
  noteTh: null,
  revokedAt: null,
  revokedByUserId: null,
  ...over,
});

const change = (over: Partial<AuthorityLimitChangeView> = {}): AuthorityLimitChangeView => ({
  id: '33333333-3333-4333-8333-333333333333',
  groupId: '11111111-1111-4111-8111-111111111111',
  groupCode: 'sales_lead',
  dimension: 'margin',
  changedByUserId: '22222222-2222-4222-8222-222222222222',
  changedAt: '2026-08-11T03:00:00.000Z',
  before: null,
  after: { maxConcessionThbMinor: 500_000n, noteTh: null, isRevoked: false },
  ...over,
});

/* ------------------------------------------------------------------ *
 * The distinction the whole feature turns on
 * ------------------------------------------------------------------ */

describe('no ceiling, a ceiling of zero, and a withdrawn ceiling are three different things', () => {
  /**
   * ⭐ The one that would be easy to get wrong and impossible to notice.
   *
   * `Number('')` is 0 and `BigInt('')` is 0n, so an empty box has two natural-looking ways to
   * become an authority of ฿0 that nobody typed. ฿0 is a *real grant* here — "may record a
   * concession, may approve none of its own" — so that mistake does not fail loudly anywhere:
   * it silently converts "I have not answered yet" into a policy.
   */
  it('reads an empty ceiling box as unanswered, never as zero', () => {
    expect(readCeilingMinor('')).toBeNull();
    expect(readCeilingMinor('   ')).toBeNull();
    expect(readCeilingMinor('0')).toBe(0n);
    expect(limitFormReady({ ...EMPTY_LIMIT_FIELDS, groupId: 'g' })).toBe(false);
    expect(limitFormReady({ ...EMPTY_LIMIT_FIELDS, groupId: 'g', ceilingBaht: '0' })).toBe(true);
  });

  it('refuses what the database refuses, before a request is sent', () => {
    /* `authority_limits_ceiling_nonnegative`. Negative authority is not a smaller ceiling. */
    expect(readCeilingMinor('-1')).toBeNull();
    /* `Number('1e3')` is 1000; a ceiling assembled that way is a thousand baht nobody typed. */
    expect(readCeilingMinor('1e3')).toBeNull();
    expect(readCeilingMinor('10,000.5')).toBe(1_000_050n);
  });

  it('says something different about each of the three states', () => {
    expect(ceilingMeaningTh(limit({ maxConcessionThbMinor: 0n }))).toContain('ต้องให้คนอื่นอนุมัติ');
    expect(ceilingMeaningTh(limit({ maxConcessionThbMinor: 500_000n }))).toContain('฿5,000.00');
    expect(ceilingMeaningTh(limit({ revokedAt: '2026-08-11T04:00:00.000Z' }))).toContain('ยกเลิก');

    /* And the withdrawn sentence wins over the amount — the row still carries its old number. */
    expect(
      ceilingMeaningTh(limit({ maxConcessionThbMinor: 500_000n, revokedAt: '2026-08-11T04:00:00.000Z' })),
    ).not.toContain('฿5,000.00');
  });
});

/* ------------------------------------------------------------------ *
 * The request body
 * ------------------------------------------------------------------ */

describe('the request the form sends', () => {
  it('sends minor units as digits, never baht', () => {
    const request = setLimitRequest({
      groupId: 'g',
      dimension: 'cashflow',
      ceilingBaht: '12,500.25',
      noteTh: '',
    });

    expect(request.maxConcessionThbMinor).toBe('1250025');
    expect(request.dimension).toBe('cashflow');
  });

  /**
   * ⚠️ `setAuthorityLimitSchema` is a `z.strictObject` whose `noteTh` is `.trim().min(1)`, so
   * `''` is a 422 and `undefined` is "no note". Sending the empty string would make leaving the
   * note blank an error the person cannot see the cause of.
   */
  it('omits an empty note rather than sending an empty string', () => {
    expect(
      'noteTh' in setLimitRequest({ groupId: 'g', dimension: 'margin', ceilingBaht: '1', noteTh: '   ' }),
    ).toBe(false);

    expect(
      setLimitRequest({ groupId: 'g', dimension: 'margin', ceilingBaht: '1', noteTh: ' ทดสอบ ' }).noteTh,
    ).toBe('ทดสอบ');
  });

  it('round-trips an existing ceiling back into the form without moving it', () => {
    const fields = fieldsFromLimit(limit({ maxConcessionThbMinor: 1_234_567n, noteTh: 'เดิม' }));
    expect(fields.ceilingBaht).toBe('12345.67');
    expect(setLimitRequest(fields).maxConcessionThbMinor).toBe('1234567');
  });

  it('leaves a merely empty field alone and complains about a malformed one', () => {
    expect(limitFormErrors(EMPTY_LIMIT_FIELDS)).toEqual({});
    expect(limitFormErrors({ ...EMPTY_LIMIT_FIELDS, ceilingBaht: 'มาก' }).ceilingBaht).toBeDefined();
    expect(
      limitFormErrors({ ...EMPTY_LIMIT_FIELDS, noteTh: 'ก'.repeat(1001) }).noteTh,
    ).toBeDefined();
  });

  /** The salesperson and the administrator have to be reading the same two words. */
  it('labels the dimensions exactly as the quote screen does', () => {
    expect(DIMENSION_LABEL_TH.margin).toBe('ส่วนลด (เงินที่ลูกค้าจ่ายน้อยลง)');
    expect(dimensionOptions().map((option) => option.value)).toEqual(['margin', 'cashflow']);
  });
});

/* ------------------------------------------------------------------ *
 * The history
 * ------------------------------------------------------------------ */

describe('the history reads as verbs, not as JSON', () => {
  it('names what each entry actually did', () => {
    const live = { maxConcessionThbMinor: 500_000n, noteTh: null, isRevoked: false };

    expect(changeHeadlineTh(change())).toBe('ให้อำนาจครั้งแรก');
    expect(
      changeHeadlineTh(
        change({ before: live, after: { ...live, maxConcessionThbMinor: 900_000n } }),
      ),
    ).toBe('ขยายเพดาน');
    expect(
      changeHeadlineTh(
        change({ before: live, after: { ...live, maxConcessionThbMinor: 100_000n } }),
      ),
    ).toBe('ลดเพดาน');
    expect(changeHeadlineTh(change({ before: live, after: { ...live, isRevoked: true } }))).toBe(
      'ยกเลิกอำนาจ',
    );
    expect(
      changeHeadlineTh(change({ before: { ...live, isRevoked: true }, after: live })),
    ).toBe('คืนอำนาจ');
  });

  it('shows every field on a first grant and only what moved on a change', () => {
    expect(isGrant(change())).toBe(true);
    expect(changedFields(change()).map((field) => field.key)).toEqual([
      'maxConcessionThbMinor',
      'noteTh',
      'isRevoked',
    ]);

    const live = { maxConcessionThbMinor: 500_000n, noteTh: 'เดิม', isRevoked: false };
    const widened = changedFields(
      change({ before: live, after: { ...live, maxConcessionThbMinor: 900_000n } }),
    );
    expect(widened.map((field) => field.key)).toEqual(['maxConcessionThbMinor']);
    expect(widened[0]?.beforeText).toBe('฿5,000.00');
    expect(widened[0]?.afterText).toBe('฿9,000.00');
  });
});

/* ------------------------------------------------------------------ *
 * The decoders
 * ------------------------------------------------------------------ */

describe('the wire is narrowed, never cast', () => {
  const wire = {
    groupId: '11111111-1111-4111-8111-111111111111',
    groupCode: 'sales_lead',
    groupNameTh: 'หัวหน้าฝ่ายขาย',
    dimension: 'margin',
    maxConcessionThbMinor: '500000',
    grantedByUserId: '22222222-2222-4222-8222-222222222222',
    updatedAt: '2026-08-11T03:00:00.000Z',
    noteTh: null,
    revokedAt: null,
    revokedByUserId: null,
  };

  it('widens a digit string to bigint and refuses anything else', () => {
    expect(decodeAuthorityLimit(wire).maxConcessionThbMinor).toBe(500_000n);
    expect(() => decodeAuthorityLimit({ ...wire, maxConcessionThbMinor: 500_000 })).toThrow(
      /maxConcessionThbMinor/u,
    );
    expect(() => decodeAuthorityLimit({ ...wire, maxConcessionThbMinor: '5e5' })).toThrow(
      /maxConcessionThbMinor/u,
    );
    expect(() => decodeAuthorityLimit({ ...wire, dimension: 'lead_time' })).toThrow(/dimension/u);
  });

  it('carries isFailClosed through rather than recomputing it from the list length', () => {
    /*
     * ⚠️ The server's answer, not `limits.length === 0`. Since revocation became a flag, a list
     * of withdrawn ceilings is fail-closed and non-empty — a client that recomputed would tell
     * an administrator the feature was on the day it had been switched off.
     */
    const decoded = decodeAuthorityLimitList({
      limits: [{ ...wire, revokedAt: '2026-08-11T04:00:00.000Z', revokedByUserId: wire.grantedByUserId }],
      isFailClosed: true,
    });

    expect(decoded.limits).toHaveLength(1);
    expect(decoded.isFailClosed).toBe(true);
  });

  /**
   * ⭐⭐ An absent key is not a `null` — on the one field whose `null` means **live**.
   *
   * `revokedAt: null` is a ceiling that grants money right now. A decoder that folded a *missing*
   * key into `null` would decode every withdrawn ceiling as live the moment the server stopped
   * sending it: the administrator is shown "ลดได้เองถึง ฿5,000" and a ยกเลิกอำนาจ button, for a
   * role `ceiling()` grants nothing to — while `isFailClosed`, which is decoded from a different
   * key on the same response, fires the fail-closed banner above it. Two contradictory sentences
   * on one screen, and the fail-*open* one is the one attached to the row.
   *
   * The three assertions are the whole contract: `null` passes, an instant passes, an absent key
   * throws. `noteTh` and `revokedByUserId` deliberately stay on `nullableStr` below — for those
   * two, `null` and "not sent" really are the same answer and neither grants anything.
   */
  it('refuses a limit whose revokedAt key is absent, rather than reading it as live', () => {
    const { revokedAt: _absent, ...withoutRevokedAt } = wire;

    expect(() => decodeAuthorityLimit(withoutRevokedAt)).toThrow(/revokedAt/u);
    expect(decodeAuthorityLimit(wire).revokedAt).toBeNull();
    expect(
      decodeAuthorityLimit({ ...wire, revokedAt: '2026-08-11T04:00:00.000Z' }).revokedAt,
    ).toBe('2026-08-11T04:00:00.000Z');

    /* And the fold really is the difference between the two sentences the screen prints. */
    expect(ceilingMeaningTh(decodeAuthorityLimit(wire))).toContain('฿5,000.00');
    expect(
      ceilingMeaningTh(decodeAuthorityLimit({ ...wire, revokedAt: '2026-08-11T04:00:00.000Z' })),
    ).toContain('ยกเลิก');

    /* …while the two fields where `null` genuinely means "not sent" keep folding. */
    const { noteTh: _noNote, revokedByUserId: _noActor, ...sparse } = wire;
    expect(decodeAuthorityLimit(sparse).noteTh).toBeNull();
    expect(decodeAuthorityLimit(sparse).revokedByUserId).toBeNull();
  });

  /**
   * ⭐ The same fold on `before`, where it erases the record the dialog exists to show.
   *
   * `before === null` is what marks a **first grant** — it drives `isGrant`, the
   * ให้อำนาจครั้งแรก headline, and the suppression of the จาก → เป็น rendering. Folding an absent
   * key into it turns every entry of a chain into a first grant with no before-value, which is
   * exactly the widen-for-one-deal-then-narrow-back history this table was built to catch.
   */
  it('refuses a change whose before key is absent, rather than reading it as a first grant', () => {
    const entry = {
      id: '33333333-3333-4333-8333-333333333333',
      groupId: wire.groupId,
      groupCode: 'sales_lead',
      dimension: 'margin',
      changedByUserId: wire.grantedByUserId,
      changedAt: wire.updatedAt,
      after: { maxConcessionThbMinor: '500000', noteTh: null, isRevoked: false },
    };

    expect(() => decodeAuthorityLimitChange(entry)).toThrow(/before/u);
    expect(decodeAuthorityLimitChange({ ...entry, before: null }).before).toBeNull();
    expect(isGrant(decodeAuthorityLimitChange({ ...entry, before: null }))).toBe(true);

    const chained = decodeAuthorityLimitChange({
      ...entry,
      before: { maxConcessionThbMinor: '100000', noteTh: null, isRevoked: false },
    });
    expect(isGrant(chained)).toBe(false);
    expect(chained.before?.maxConcessionThbMinor).toBe(100_000n);
  });

  it('reads a change with a null before, and refuses a snapshot that is not one', () => {
    const decoded = decodeAuthorityLimitChange({
      id: '33333333-3333-4333-8333-333333333333',
      groupId: wire.groupId,
      groupCode: 'sales_lead',
      dimension: 'margin',
      changedByUserId: wire.grantedByUserId,
      changedAt: wire.updatedAt,
      before: null,
      after: { maxConcessionThbMinor: '500000', noteTh: null, isRevoked: false },
    });

    expect(decoded.before).toBeNull();
    expect(decoded.after.maxConcessionThbMinor).toBe(500_000n);

    expect(() =>
      decodeAuthorityLimitChange({
        id: '33333333-3333-4333-8333-333333333333',
        groupId: wire.groupId,
        groupCode: 'sales_lead',
        dimension: 'margin',
        changedByUserId: wire.grantedByUserId,
        changedAt: wire.updatedAt,
        before: null,
        after: { maxConcessionThbMinor: '500000', noteTh: null },
      }),
    ).toThrow(/isRevoked/u);
  });
});

/* ------------------------------------------------------------------ *
 * The panel
 * ------------------------------------------------------------------ */

describe('AuthorityLimitsPanel', () => {
  const groups: readonly AuthorityGroupView[] = [
    { id: '11111111-1111-4111-8111-111111111111', code: 'sales_lead', nameTh: 'หัวหน้าฝ่ายขาย' },
  ];

  const render = (state: AuthorityLimitsState, editable: boolean): string =>
    renderToStaticMarkup(
      createElement(AuthorityLimitsPanel, {
        state,
        groups,
        editable,
        onChanged: async () => undefined,
      }),
    );

  const ready = (over: Partial<AuthorityLimitView> = {}): AuthorityLimitsState => ({
    status: 'ready',
    limits: [limit(over)],
    isFailClosed: over.revokedAt !== undefined && over.revokedAt !== null,
  });

  it('shows a reader the ceiling but no control that would change it', () => {
    const markup = render(ready(), false);

    expect(markup).toContain('หัวหน้าฝ่ายขาย');
    expect(markup).toContain('฿5,000.00');
    expect(markup).toContain('ประวัติ');
    expect(markup).not.toContain('กำหนดเพดาน');
    expect(markup).not.toContain('ยกเลิกอำนาจ');
  });

  it('gives a writer the three controls, and only the writer', () => {
    const markup = render(ready(), true);

    expect(markup).toContain('กำหนดเพดาน');
    expect(markup).toContain('แก้ไข');
    expect(markup).toContain('ยกเลิกอำนาจ');
  });

  /**
   * ⭐ The upsert button waits for the list, because the list is what warns about the upsert.
   *
   * `PUT` replaces whatever is at `(role, dimension)`. The dialog's "บทบาทนี้มีเพดานในมิตินี้อยู่แล้ว"
   * warning is computed from `taken`, which is `state.limits` — empty on `loading` and on
   * `failed`. A button live before then lets somebody replace a ฿5,000 ceiling with ฿50,000
   * believing it is a new grant, with the one sentence that would have said otherwise silently
   * unable to fire. `editable` alone is not enough to render it.
   */
  it('withholds the upsert button until it knows what is already in the table', () => {
    expect(render({ status: 'loading' }, true)).not.toContain('กำหนดเพดาน');
    expect(render({ status: 'failed', problem: 'โหลดไม่สำเร็จ' }, true)).not.toContain('กำหนดเพดาน');
    expect(render(ready(), true)).toContain('กำหนดเพดาน');
  });

  /**
   * ⭐ The sentence that stops an empty table reading as an unused feature.
   *
   * An empty `authority_limits` is the shipped default and it means "nobody in this company may
   * reduce a price by one satang" — including nobody being able to approve one. A screen that
   * showed a blank list would be describing a feature nobody had got round to using.
   */
  it('says out loud that nobody may concede anything when no ceiling is live', () => {
    const markup = render({ status: 'ready', limits: [], isFailClosed: true }, true);
    expect(markup).toContain('ยังไม่มีใครมีอำนาจลดราคา');
  });

  /** …and it is the flag that decides, not the row count. */
  it('says the same thing when every ceiling has been withdrawn', () => {
    const markup = render(ready({ revokedAt: '2026-08-11T04:00:00.000Z' }), true);

    expect(markup).toContain('ยังไม่มีใครมีอำนาจลดราคา');
    /* The row is still shown — it is what an administrator reinstates from. */
    expect(markup).toContain('ยกเลิกแล้ว');
    expect(markup).toContain('คืนอำนาจ');
    /* And there is nothing left to withdraw. */
    expect(markup).not.toContain('ยกเลิกอำนาจ');
  });
});
