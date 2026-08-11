import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  apiErrorFromResponse,
  displayMessage,
  failureMessage,
  ERROR_CODES,
} from '../src/lib/api/errors';
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  LOCALE_HEADER,
  preferredLocale,
  setPreferredLocale,
  SUPPORTED_LOCALES,
} from '../src/lib/i18n/locale';

/**
 * The dashboard's half of phase 6a: state a language, and never show a key.
 *
 * The brief for this round is blunt about which of the two matters more here — the
 * dashboard "is staff-facing and Thai-first, so it needs less than the storefront — but it
 * must not be the place a raw key leaks to a screen." So most of this file is about the
 * second sentence.
 */

/** A `Response` far enough along to be read by `apiErrorFromResponse`. */
const responseOf = (status: number, body: unknown): Response =>
  ({
    status,
    statusText: 'Whatever',
    json: () => Promise.resolve(body),
  }) as unknown as Response;

const envelope = (error: Record<string, unknown>): unknown => ({
  error: { requestId: 'req_123', path: '/quotes', timestamp: '2026-08-06T00:00:00.000Z', ...error },
});

describe('the language this app asks for', () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('matches the list apps/api supports, with Thai as the default', () => {
    // The list is copied from apps/api/src/i18n/locales.ts and this is the check that keeps
    // the copy honest. A ninth language on the server that nobody added here would leave
    // this dashboard unable to ask for it, silently.
    expect([...SUPPORTED_LOCALES]).toStrictEqual(['de', 'en', 'hi', 'la', 'my', 'th', 'vi', 'zh']);
    expect(DEFAULT_LOCALE).toBe('th');
    expect(LOCALE_HEADER).toBe('x-wewin-locale');
  });

  it('is Thai until somebody chooses otherwise', () => {
    // ⭐ The reason the header exists at all. Without it a staff laptop set to `en-US` would
    // get apps/api's *partial* English catalogue — a screen of eleven English sentences and
    // ninety Thai ones. Defaulting to Thai in this app is what stops that.
    expect(preferredLocale()).toBe('th');

    setPreferredLocale('vi');
    expect(preferredLocale()).toBe('vi');
  });

  it('ignores a stored value this build does not support', () => {
    store.set('wewin.dashboard.locale', 'klingon');
    expect(preferredLocale()).toBe('th');
  });

  it('answers Thai rather than throwing when storage is unavailable', () => {
    // Safari in private mode throws on `localStorage`. A language preference is not worth an
    // exception on a screen that was about to show somebody an error.
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('SecurityError');
        },
        setItem: () => {
          throw new Error('SecurityError');
        },
      },
    });

    expect(preferredLocale()).toBe('th');
    expect(() => setPreferredLocale('de')).not.toThrow();
  });

  it('answers Thai when rendered on the server, where there is no window', () => {
    vi.stubGlobal('window', undefined);
    expect(preferredLocale()).toBe('th');
  });

  it('recognises exactly the eight', () => {
    for (const locale of SUPPORTED_LOCALES) expect(isSupportedLocale(locale)).toBe(true);
    expect(isSupportedLocale('en-GB')).toBe(false);
    expect(isSupportedLocale(null)).toBe(false);
  });
});

describe('reading the 6a envelope', () => {
  it('keeps the key and the locale beside the sentence', async () => {
    const error = await apiErrorFromResponse(
      responseOf(
        409,
        envelope({
          code: 'CONFLICT',
          message: 'รายการนี้มีราคาที่ตกลงกับลูกค้าไว้แล้ว — ต้องยกเลิกราคาที่ตกลงไว้ก่อนจึงจะลบรายการได้',
          messageKey: 'error.quote.frozen.remove_line',
          messageParams: {},
          locale: { requested: 'th', rendered: 'th', degraded: false },
        }),
      ),
    );

    expect(error.code).toBe('CONFLICT');
    expect(error.messageKey).toBe('error.quote.frozen.remove_line');
    expect(error.locale).toStrictEqual({ requested: 'th', rendered: 'th', degraded: false });
    expect(error.isUntranslated).toBe(false);
    expect(displayMessage(error)).toContain('ต้องยกเลิกราคาที่ตกลงไว้ก่อน');
  });

  it('reports a message that fell back to Thai', async () => {
    const error = await apiErrorFromResponse(
      responseOf(
        409,
        envelope({
          code: 'CONFLICT',
          message: 'ออร์เดอร์นี้กำลังถูกแก้ไขอยู่ — กรุณาลองใหม่อีกครั้ง',
          messageKey: 'error.order.locked',
          locale: { requested: 'de', rendered: 'th', degraded: true },
        }),
      ),
    );

    expect(error.isUntranslated).toBe(true);
    /* Degraded is not broken: the sentence is still shown, in Thai. */
    expect(displayMessage(error)).toBe('ออร์เดอร์นี้กำลังถูกแก้ไขอยู่ — กรุณาลองใหม่อีกครั้ง');
  });

  it('leaves the key undefined for an un-migrated API call site', async () => {
    const error = await apiErrorFromResponse(
      responseOf(404, envelope({ code: 'NOT_FOUND', message: 'ไม่พบออร์เดอร์นี้' })),
    );

    expect(error.messageKey).toBeUndefined();
    expect(error.locale).toBeUndefined();
    expect(error.isUntranslated).toBe(false);
    expect(displayMessage(error)).toBe('ไม่พบออร์เดอร์นี้');
  });

  it('survives a body that is not our envelope at all', async () => {
    // A 502 from a load balancer is HTML. The 6a fields must not turn a defensive read into
    // a throw — the dashboard's error handling breaking when the API is broken is the exact
    // failure this file's predecessor was written to prevent.
    const error = await apiErrorFromResponse(responseOf(502, '<html>bad gateway</html>'));

    expect(error.code).toBe('MALFORMED');
    expect(error.messageKey).toBeUndefined();
    expect(displayMessage(error).length).toBeGreaterThan(0);
  });

  it('ignores a locale block that is the wrong shape', async () => {
    const error = await apiErrorFromResponse(
      responseOf(409, envelope({ code: 'CONFLICT', message: 'x', locale: { rendered: 7 } })),
    );

    expect(error.locale).toBeUndefined();
  });
});

describe('a raw key must not reach a screen', () => {
  it('never displays the key even though it is carried', async () => {
    const error = await apiErrorFromResponse(
      responseOf(
        422,
        envelope({
          code: 'VALIDATION_FAILED',
          message: 'ยอดที่ตัดชำระแต่ละงวดต้องมากกว่าศูนย์',
          messageKey: 'error.slip.allocation_amount_positive',
        }),
      ),
    );

    expect(displayMessage(error)).not.toContain('error.slip');
    expect(displayMessage(error)).toBe('ยอดที่ตัดชำระแต่ละงวดต้องมากกว่าศูนย์');
  });

  it('refuses to build an ApiError whose message IS a key', async () => {
    // ⭐ The gate. Reachable if a renderer ever returns its input, if a catalogue entry is
    // written as the key, or if something between here and the API substitutes a body. It
    // has to fail into a sentence, because the alternative — `error.slip.foot_mismatch` in
    // a toast — is worse than the Thai string this whole round replaced.
    const error = await apiErrorFromResponse(
      responseOf(422, envelope({ code: 'VALIDATION_FAILED', message: 'error.slip.foot_mismatch' })),
    );

    const shown = displayMessage(error);
    expect(shown).not.toContain('error.slip.foot_mismatch');
    expect(shown).toContain('req_123');
    /* The key is not lost — it moves to where a key belongs. */
    expect(error.messageKey).toBe('error.slip.foot_mismatch');
  });

  it('does not mistake a real sentence for a key', () => {
    // The gate is shape-based, so the thing worth checking is that it does not fire on the
    // sentences it will actually see — including the English ones, which are Latin, and the
    // Thai ones, which are not.
    const sentences = [
      'ยอดคืนเงินต้องมากกว่าศูนย์',
      'The request body is larger than this endpoint accepts.',
      'This already exists.',
      'ไม่พบสินค้ารหัส "awn-4t"',
      'ยอดที่ตัดชำระรวม ฿5,529.20 แต่สลิปใบนี้เป็นเงิน ฿5,529.60',
      'req_01JABCDEF',
    ];

    for (const sentence of sentences) {
      const error = new ApiError({ status: 422, code: 'VALIDATION_FAILED', message: sentence });
      expect(displayMessage(error), sentence).toBe(sentence);
    }
  });

  it('still shows something when the API sends an empty message', () => {
    const error = new ApiError({
      status: 500,
      code: 'INTERNAL',
      message: '   ',
      requestId: 'req_999',
    });

    // An empty toast reads as "nothing happened", which is the one thing that is not true.
    expect(displayMessage(error)).toContain('req_999');
    expect(displayMessage(error).trim().length).toBeGreaterThan(10);
  });

  /**
   * ⭐ The one English sentence a member of staff can reach, rendered in Thai.
   *
   * `RbacGuard` refuses with a raw Nest `ForbiddenException` — `Missing permission: users.read.`
   * — which is not an `AppError`, carries no `messageKey`, and never passes through the API's
   * i18n rendering. A reviewer met it head-on: navigating to a screen they lacked the
   * permission for produced an all-English alert on an all-Thai page.
   *
   * ⚠️ The codes survive into the Thai sentence on purpose. `rbac.guard.ts` names them
   * deliberately — its own comment says that is the difference between "ask an administrator
   * for orders.refund" and a support thread that starts with "it says forbidden".
   */
  it('renders the permission guard’s English refusal in Thai, codes intact', () => {
    const refused = new ApiError({
      status: 403,
      code: 'FORBIDDEN',
      message: 'Missing permission: users.read.',
    });

    expect(failureMessage(refused)).not.toContain('Missing permission');
    expect(failureMessage(refused)).toContain('users.read');
    expect(failureMessage(refused)).toContain('ผู้ดูแลระบบ');

    /* More than one code is one refusal, not two. */
    expect(
      failureMessage(
        new ApiError({
          status: 403,
          code: 'FORBIDDEN',
          message: 'Missing permission: groups.read, groups.write.',
        }),
      ),
    ).toContain('groups.read, groups.write');
  });

  /**
   * ⚠️ …and every *other* forbidden answer is left exactly as the server wrote it.
   *
   * Most 403s from this API are Thai sentences from `AppError.forbidden` that say something
   * specific — which quote, which account, which rule. Replacing those with a generic line
   * because they share a code would throw away the only part a person can act on. The match is
   * on the guard's shape, not on `FORBIDDEN`.
   */
  it('leaves a forbidden answer the API wrote for itself alone', () => {
    const specific = 'คุณอนุมัติคำขอของตัวเองไม่ได้';
    expect(
      failureMessage(new ApiError({ status: 403, code: 'FORBIDDEN', message: specific })),
    ).toBe(specific);

    const notTheGuard = 'Missing permission for reasons';
    expect(
      failureMessage(new ApiError({ status: 403, code: 'FORBIDDEN', message: notTheGuard })),
    ).toBe(notTheGuard);
  });

  it('has not lost any of the codes the app branches on', () => {
    expect(ERROR_CODES).toContain('UNAUTHENTICATED');
    expect(ERROR_CODES).toContain('FORBIDDEN');
    expect(new ApiError({ status: 401, code: 'UNAUTHENTICATED', message: 'x' }).isUnauthenticated).toBe(true);
    expect(new ApiError({ status: 403, code: 'FORBIDDEN', message: 'x' }).isUnauthenticated).toBe(false);
  });
});
