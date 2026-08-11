import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { AllExceptionsFilter } from '../../src/common/errors/all-exceptions.filter';
import { AppError, type ErrorEnvelope } from '../../src/common/errors/app-error';
import {
  encodeServerMessage,
  isServerMessage,
  message,
  SERVER_MESSAGE_KEYS,
  thb,
} from '../../src/i18n';

/**
 * What actually reaches a client, and what is honestly still missing.
 *
 * The envelope is where the whole round is either true or a claim: a key, its params as
 * JSON, the sentence rendered in the caller's language, and a flag saying whether that
 * language was the one they asked for.
 */

/* ------------------------------------------------------------------ *
 * The wire
 * ------------------------------------------------------------------ */

describe('a message as JSON', () => {
  it('writes satang as digits, because JSON.stringify refuses a bigint', () => {
    const wire = encodeServerMessage(
      message('error.slip.foot_mismatch', {
        allocated: thb(552_920n),
        slip: thb(552_960n),
        difference: thb(40n),
      }),
    );

    expect(wire.key).toBe('error.slip.foot_mismatch');
    expect(wire.params).toStrictEqual({
      allocated: { kind: 'money', minor: '552920', currency: 'THB' },
      slip: { kind: 'money', minor: '552960', currency: 'THB' },
      difference: { kind: 'money', minor: '40', currency: 'THB' },
    });

    // The point of the digit string: it survives `JSON.stringify`, which the bigint does not.
    expect(() => JSON.stringify(wire)).not.toThrow();
    expect(JSON.stringify(wire)).toContain('"552960"');
  });

  it('keeps a count as a number and a code as a string', () => {
    // Not everything becomes a string. A count is small and exact in JSON, and turning it
    // into `"2"` would make a client parse something that never needed parsing.
    const wire = encodeServerMessage(
      message('error.slip.over_allocated', {
        seq: { kind: 'count', value: 2 },
        remaining: thb(1n),
        requested: thb(2n),
      }),
    );

    expect(wire.params['seq']).toStrictEqual({ kind: 'count', value: 2 });
  });
});

describe('a message from an untrusted source', () => {
  const sound = message('error.slip.overpayment_not_acknowledged', { excess: thb(40n) });

  it('accepts a well-formed one', () => {
    expect(isServerMessage(sound)).toBe(true);
    expect(isServerMessage(message('error.http.busy'))).toBe(true);
  });

  it('rejects a key this build does not know', () => {
    expect(isServerMessage({ key: 'error.slip.invented', params: {} })).toBe(false);
  });

  it('rejects a missing param', () => {
    expect(isServerMessage({ key: 'error.slip.overpayment_not_acknowledged', params: {} })).toBe(false);
  });

  it('rejects an extra param', () => {
    // A payload carrying a param this key does not take was built by a different version of
    // this service, and guessing which half to believe is how a message renders with
    // somebody else's numbers in it.
    expect(
      isServerMessage({
        key: 'error.slip.overpayment_not_acknowledged',
        params: { excess: thb(40n), surprise: thb(1n) },
      }),
    ).toBe(false);
  });

  it('rejects a param of the wrong kind, and satang that arrived as a string', () => {
    expect(
      isServerMessage({
        key: 'error.slip.overpayment_not_acknowledged',
        params: { excess: { kind: 'count', value: 40 } },
      }),
    ).toBe(false);

    // The decoded form holds `bigint`. A message still carrying the digit string has not
    // been decoded, and interpolating it would print the right characters for the wrong
    // reason — until the day a locale wants its own digits.
    expect(
      isServerMessage({
        key: 'error.slip.overpayment_not_acknowledged',
        params: { excess: { kind: 'money', minor: '40', currency: 'THB' } },
      }),
    ).toBe(false);
  });

  it('rejects a currency that is not the one this system holds money in', () => {
    expect(
      isServerMessage({
        key: 'error.slip.overpayment_not_acknowledged',
        params: { excess: { kind: 'money', minor: 40n, currency: 'EUR' } },
      }),
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The envelope
 * ------------------------------------------------------------------ */

interface Captured {
  status: number;
  body: ErrorEnvelope;
}

/** Enough of express for the filter, and nothing that would make this an HTTP test. */
function throwAt(exception: unknown, headers: Record<string, string> = {}): Captured {
  const captured: Captured = { status: 0, body: { error: {} } as ErrorEnvelope };

  const response = {
    headersSent: false,
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: ErrorEnvelope) {
      captured.body = body;
      return this;
    },
    end() {},
  };

  const request = { method: 'POST', url: '/orders', headers };

  const filter = new AllExceptionsFilter({ NODE_ENV: 'test' } as never);
  filter.catch(exception, {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as never);

  return captured;
}

describe('the error envelope', () => {
  it('carries the key, the params and the language it chose', () => {
    const { status, body } = throwAt(
      AppError.validationFailed(message('error.slip.overpayment_not_acknowledged', { excess: thb(27_776n) })),
      { 'accept-language': 'de;q=0.9,en;q=0.8' },
    );

    expect(status).toBe(422);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.messageKey).toBe('error.slip.overpayment_not_acknowledged');
    expect(body.error.messageParams).toStrictEqual({
      excess: { kind: 'money', minor: '27776', currency: 'THB' },
    });
    /* No German for this key, so Thai — with ฿277.76 still in it, and marked as degraded. */
    expect(body.error.message).toContain('฿277.76');
    expect(body.error.locale).toStrictEqual({ requested: 'de', rendered: 'th', degraded: true });
  });

  it('answers in the caller’s language when it has one', () => {
    const { body } = throwAt(AppError.badRequest(message('error.http.busy')), {
      'accept-language': 'en-GB,en;q=0.9',
    });

    expect(body.error.message).toBe('The service is handling a lot of requests right now. Please try again.');
    expect(body.error.locale?.rendered).toBe('en');
    expect(body.error.locale?.degraded).toBe(false);
  });

  it('lets an explicit header beat the browser’s configuration', () => {
    // Somebody who picked Thai in the app has said something more specific than whatever
    // their laptop was set up with in the shop.
    const { body } = throwAt(AppError.badRequest(message('error.http.busy')), {
      'accept-language': 'en-GB,en;q=0.9',
      'x-wewin-locale': 'th',
    });

    expect(body.error.locale?.rendered).toBe('th');
    expect(body.error.message).toBe('ระบบกำลังมีคำขอพร้อมกันจำนวนมาก กรุณาลองใหม่อีกครั้ง');
  });

  it('ignores an explicit header naming a language that does not exist', () => {
    const { body } = throwAt(AppError.badRequest(message('error.http.busy')), {
      'accept-language': 'en',
      'x-wewin-locale': 'klingon',
    });

    expect(body.error.locale?.rendered).toBe('en');
  });

  it('omits the key entirely for a call site that still passes a Thai string', () => {
    // ⭐ Absence is the signal. A client can tell "we have no key for this yet" from "the
    // key is one you do not know", and only the second is worth a bug report. A `messageKey`
    // of `''` or `'unknown'` would have collapsed the two.
    const { body } = throwAt(AppError.notFound('ไม่พบออร์เดอร์นี้'), { 'accept-language': 'en' });

    expect(body.error.message).toBe('ไม่พบออร์เดอร์นี้');
    expect(body.error.messageKey).toBeUndefined();
    expect(body.error.locale).toBeUndefined();
  });

  it('gives a key to a body-parser throw, which is not one of ours', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), { type: 'entity.too.large' });
    const { status, body } = throwAt(tooLarge, { 'accept-language': 'en' });

    expect(status).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(body.error.messageKey).toBe('error.http.payload_too_large');
    expect(body.error.message).toBe('The request body is larger than this endpoint accepts.');
  });

  it('gives a key to an exhausted connection pool', () => {
    const { status, body } = throwAt(new Error('timeout exceeded when trying to connect'));

    expect(status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(body.error.messageKey).toBe('error.http.busy');
    /* No preference expressed: Thai, and not reported as a degradation. */
    expect(body.error.locale).toStrictEqual({ requested: null, rendered: 'th', degraded: false });
  });

  it('logs Thai even when it answers German', () => {
    // The sentence an engineer greps for and the sentence the customer saw have to be the
    // same string, and the only way they can be is if the log does not follow the customer.
    const error = AppError.badRequest(message('error.http.busy'));
    expect(error.message).toBe('ระบบกำลังมีคำขอพร้อมกันจำนวนมาก กรุณาลองใหม่อีกครั้ง');

    const { body } = throwAt(error, { 'accept-language': 'en' });
    expect(body.error.message).not.toBe(error.message);
  });
});

/* ------------------------------------------------------------------ *
 * The debt
 * ------------------------------------------------------------------ */

describe('what is still a Thai string, as a number', () => {
  /*
   * ⭐ A half-migration with no counter is a half-migration forever.
   *
   * `AppError` accepts `string | ServerMessage`, which is what let 6a convert the enumerable
   * translators without touching ~200 unrelated call sites in one commit. The risk of that
   * choice is that the union becomes permanent and nobody can say how much is left. So: it
   * is counted, and the number is pinned. Converting a call site makes this test fail, and
   * the fix is to lower the number — deliberately, in the same commit.
   */
  const SOURCE = join(__dirname, '..', '..', 'src');

  const files = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return files(path);
      return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
    });

  /** `AppError.something('…'` or `AppError.something(\`…\`` — a literal, not a key. */
  const RAW = /AppError\.\w+\(\s*['"`]/g;

  it('counts every AppError still constructed from a literal', () => {
    const counts = files(SOURCE)
      .map((path) => ({ path, n: (readFileSync(path, 'utf8').match(RAW) ?? []).length }))
      .filter((row) => row.n > 0)
      .sort((left, right) => right.n - left.n);

    const total = counts.reduce((sum, row) => sum + row.n, 0);

    // The figure at the end of 6a. Every one of these is an error a non-Thai customer reads
    // in Thai, and every one of them is a line in the handoff rather than a surprise.
    expect(total, counts.map((row) => `${row.path.slice(SOURCE.length + 1)}: ${String(row.n)}`).join('\n')).toBe(
      RAW_LITERAL_CALL_SITES,
    );
  });

  it('has no literal left in the modules 6a claimed', () => {
    // The claim is specific, so the check is specific. These five translators plus the
    // allocation arithmetic and the staleness refusals are what this round said it converted;
    // a regression that reintroduced one would otherwise only move the total by one and
    // could be absorbed by converting something else.
    const converted = [
      'admin/pg-errors.ts',
      'orders/pg-errors.ts',
      'quotes/pg-errors.ts',
      'quotes/errors.ts',
      'payments/ledger/pg-errors.ts',
      'payments/slips/slip-errors.ts',
      'payments/slips/allocations.ts',
      'common/errors/all-exceptions.filter.ts',
    ];

    for (const relative of converted) {
      const source = readFileSync(join(SOURCE, relative), 'utf8');
      expect((source.match(RAW) ?? []).length, relative).toBe(0);
    }
  });

  it('has a catalogue entry for every key that exists', () => {
    // Derived from one table, so this can only fail if the derivation is broken — which is
    // worth one assertion, because the failure mode is a key with no translation in any
    // language, found by a customer.
    expect(SERVER_MESSAGE_KEYS.length).toBeGreaterThan(90);
    expect(new Set(SERVER_MESSAGE_KEYS).size).toBe(SERVER_MESSAGE_KEYS.length);
  });
});

/**
 * The count of un-migrated `AppError` call sites.
 *
 * Pinned as a literal the way pricing-parity pins `correctedUp === 87`: a test that read the
 * number from the code it is checking would pass at any value.
 *
 * ── 146 → 179, and it went the wrong way ─────────────────────────────────────────
 *
 * 146 was the figure at the end of 6a, which spent the phase *lowering* it. Phase 7 raised it
 * by 33, every one of them in `src/reviews` and `src/profile`:
 *
 *     reviews/pg-errors.ts          14
 *     reviews/reviews.service.ts     9
 *     reviews/reviews.controller.ts  2
 *     reviews-admin.controller.ts    1
 *     …and the remainder across profile
 *
 * This is recorded as a regression and not as a new baseline. The counter's purpose is that
 * nobody can say "roughly a hundred and something" — raising it is allowed, raising it
 * quietly is what the test exists to stop, so the breakdown lives here rather than in a
 * commit message.
 *
 * Roughly half are customer-facing — a rating outside 1–5, an empty review, one review per
 * line, the photograph limit — and those are read by whoever bought the window, in Thai,
 * whatever language they asked the site for. The rest are moderator-facing (already hidden,
 * already published, a hiding with no reason), where the audience is Thai staff and the cost
 * is close to nothing.
 *
 * The follow-up is the customer-facing half, and it is a bounded job: `ServerMessage` keys
 * exist, `src/i18n/catalog/th.ts` is the only catalogue to author, and the strings are already
 * written — they are sitting in the call sites. See plan 12.
 *
 * ── 179 → 197: user administration ───────────────────────────────────────────────
 *
 * 18 more, all in `src/users`, and they are a different kind of debt from the reviews half
 * above rather than more of the same. **Every reader of this screen is Thai staff.** It is
 * behind `users.read`, it is in the dashboard, and the dashboard has one language. So the
 * cost of these not being keyed is close to zero today and the reason to key them is
 * consistency rather than a customer reading Thai they cannot read.
 *
 * Worth saying because it is the argument somebody will make about the *next* eighteen, and
 * it is only true while the audience really is staff-only. The moment any of these sentences
 * can reach a customer, the calculation changes and this note is wrong.
 *
 * ── 197 → 206: account settings ──────────────────────────────────────────────────
 *
 * ── 206 → 211: the second factor ─────────────────────────────────────────────────
 *
 * ⚠️ A real increase, not a re-count. Three sources, and the largest is a *refactor that
 * was right*:
 *
 *   `users/users.service.ts` +3 — `refuseSelf` was one `AppError.conflict` with a ternary
 *   picking between two sentences. A third self-action arrived (`self-disable-mfa`) and the
 *   ternary handed it the *permissions* sentence silently, because both arms were already
 *   strings and nothing typed the pairing. It is a `switch` now, with no default arm, so the
 *   fourth is a compile error — and three explicit calls where there was one conditional.
 *
 *   `auth/mfa/mfa-admin.controller.ts` +2 — a local `requireUuid` message and the refusal
 *   when the route is aimed at the caller's own account.
 *
 * `account/signed-in.ts` shows three and cost nothing: they moved out of
 * `account.controller.ts` when the helper was lifted so the MFA controller could share it
 * rather than copy it. Copying would have added three.

 *
 * 9 more, in `src/account`, and this is the round where the argument above stops being
 * comfortable. These are on `/me/account`, which is **not** an admin surface — it is a
 * person's own password, providers and devices, and the storefront is one route away from
 * needing the same page for customers in eight languages.
 *
 * They are keyed last rather than first only because the screen that consumes them today is
 * the Thai dashboard. That is a scheduling decision, not a judgement that these sentences
 * are staff-only, and the two should not be confused when somebody picks this up.
 *
 * ── 211 → 212: the organisation module ───────────────────────────────────────────
 *
 * One, in `organisation.controller.ts`'s local `userIdOf` — the sentence for a scope the
 * permission guard should never let reach this handler in the first place. Same reasoning
 * as the account-settings note above and the same answer: every route on this controller
 * demands `organisation.read` or `organisation.write`, so the only reader is Thai staff,
 * and keying a sentence nobody today can see in another language is not this round's job.
 * `media-admin.controller.ts`'s `userIdOf` — the helper this one is modelled on — is
 * likewise unkeyed, for the identical reason.
 *
 * ── 212 → 213: task 13 fix round 1 ────────────────────────────────────────────────
 *
 * One, in `payments/slips/slips.service.ts`'s new `assertKnownActiveAccount` — refused when
 * a customer's `receivedBankAccountId` names no active account. Unlike the two additions
 * above, this one is reachable by a customer through the storefront, not staff-only — but
 * it lands beside `assertSlipAttachable`'s, `assertRoomForAnotherSlip`'s and
 * `assertTransferPlausible`'s literal Thai sentences in the very same file, none of which
 * `payments/slips/slip-errors.ts`'s "converted" list (below) claims, so keying only the new
 * one would be a smaller, inconsistent island inside a file the round otherwise left alone.
 *
 * ── 213 → 220: phone verification ────────────────────────────────────────────────
 *
 * Seven, all in `users/users.service.ts`'s new `verifyPhone`/`unverifyPhone` — the same
 * argument the "179 → 197: user administration" note above already made for the rest of this
 * module, applying unchanged: this screen is `/admin/users`, gated on `users.write`, and its
 * one reader is Thai staff. A member of staff clicking "verify" or "ยกเลิกยืนยัน" and being
 * told `เบอร์นี้ยืนยันแล้ว` is not a customer reading Thai they cannot read — the sentence
 * that note already flags as the day this reasoning stops holding.
 *
 * ── 220 → 221: un-verify's third refusal ──────────────────────────────────────────
 *
 * One, `unverifyPhone`'s new refusal for a row proved with no voucher — reachable today only
 * by a test constructing the row directly, since `verifyPhone` is the only writer of
 * `verified_at` and always sets both columns together. Same screen, same permission, same
 * argument as the seven immediately above: `/admin/users`, gated on `users.write`, one reader,
 * Thai staff.
 *
 * ── 221 → 224: the ceiling screen's three refusals ────────────────────────────────
 *
 * Three, all in `quotes/authority/authority.service.ts`, and all of them arrived with the
 * screen that finally lets `authority_limits` be filled in:
 *
 *   `setLimit`     `ไม่พบบทบาทนี้` — `lockGroup` found no such group. It replaces a raw
 *                  foreign-key violation, i.e. a 500 with a `DrizzleQueryError` in it, so this
 *                  literal is a *net improvement* on what a client used to get.
 *   `removeLimit`  the same sentence, for the same reason, on the withdrawal path.
 *   `removeLimit`  a second `ไม่พบเพดานอำนาจของบทบาทนี้ในมิตินี้` for a ceiling that is already
 *                  withdrawn — `revokeLimit`'s own `revoked_at IS NULL` makes that update zero
 *                  rows rather than restamping the first withdrawal with a new name, and the
 *                  caller has to be told their act was not the one that did it.
 *
 * Same argument as the user-administration block above, and if anything narrower: the only
 * screen that reaches these is `/users` → อำนาจอนุมัติ, gated on `groups.write` — a permission
 * held by nobody at boot — and its reader is the person deciding what a Thai sales team may
 * concede. No customer, in any locale, can reach a route that writes this table.
 */
const RAW_LITERAL_CALL_SITES = 224;
