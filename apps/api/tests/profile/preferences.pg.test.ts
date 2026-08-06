import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { CURRENCIES } from '@wewin/core/money';
import { LENGTH_UNITS } from '@wewin/core/units';
import { products } from '@wewin/core/fixtures';
import type { Product } from '@wewin/core';
import { encodeUm } from '@wewin/contract/measure';
import type { OrderLineRequestWire, OrderWire } from '@wewin/contract/order';

import { SUPPORTED_LOCALES } from '../../src/i18n';
import type { PreferencesResponseWire } from '../../src/profile';
import {
  bootProfileApp,
  client,
  makeCustomer,
  profileEnv,
  type Actor,
  type Json,
  type ProfileApp,
} from './support/profile-app';

/**
 * `GET/PUT/DELETE /me/preferences` over real HTTP, against a real Postgres — and the one
 * property the whole round exists to keep.
 *
 * ── The property, and why it is tested through the wire rather than the service ──
 *
 * *A preference is presentation. Changing one may not move a stored number, and may not
 * re-render a document that was frozen for somebody else.* Both halves live **between** the
 * layers, which is why nothing here is asserted through a service call:
 *
 *   - the CHECK that refuses a row preferring nothing is in the database, so a test that
 *     never issues a statement never meets it;
 *   - `order_documents.pinned_locale` is read by a different module entirely, and the only
 *     honest way to ask "did the document change" is to fetch it twice through the endpoint a
 *     customer fetches it through;
 *   - the guard, the middleware and the boot-time route audit are all in the request path,
 *     and a route added without an access policy has to fail at `listen`.
 *
 * The sweep at the bottom is modelled on `packages/core/tests/displayUnits.test.ts` — "a
 * canonical length survives every display unit" — pointed at the layer above: *a contract
 * survives every preference its customer can hold.*
 *
 * Skipped, not failed, without a database. Submitted orders are not cleaned up: `orders`
 * refuses to delete anything but a never-submitted draft, correctly, and the suite runs
 * against a database `globalSetup` creates empty every run.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);

/** The whole resource, all three keys, as PUT requires. */
const body = (
  preferredLocale: string | null,
  displayCurrency: string | null,
  displayLengthUnit: string | null,
): Record<string, unknown> => ({ preferredLocale, displayCurrency, displayLengthUnit });

const NOTHING = body(null, null, null);

/** The `Set-Cookie` a fresh cart hands back, trimmed to the pair a request sends. */
const guestCookie = (created: Json): string =>
  (created.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

describeWithPg('per-user presentation preferences', () => {
  let pool: Pool;
  let db: Database;
  let app: ProfileApp;
  let call: ReturnType<typeof client>;

  let alice: Actor;
  let bob: Actor;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);

    app = await bootProfileApp(profileEnv(url ?? ''));
    call = client(app.baseUrl);

    alice = await makeCustomer(db, app, `profile probe alice ${tag}`);
    bob = await makeCustomer(db, app, `profile probe bob ${tag}`);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const read = async (who: Actor): Promise<PreferencesResponseWire> => {
    const answer = await call('GET', '/me/preferences', { token: who.token });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return answer.body as PreferencesResponseWire;
  };

  const write = async (who: Actor, payload: unknown): Promise<Json> =>
    call('PUT', '/me/preferences', { token: who.token, body: payload });

  /* ---------------------------------------------------------------- *
   * An absence is a first-class answer
   * ---------------------------------------------------------------- */

  it('answers a person who has never chosen anything without inventing a row', async () => {
    /*
     * `packages/db/src/schema/profile.ts` is explicit that no row is created at signup and
     * that every column is nullable, so that a choice stays distinguishable from an absence —
     * a table full of `('th','THB','mm')` rows nobody set would make that impossible. This is
     * the API end of the same claim: `updatedAt: null` is what "there is no row" looks like,
     * and it is not a 404, because having no preferences is a perfectly ordinary state.
     */
    const answer = await read(bob);

    expect(answer.preferences).toStrictEqual({
      preferredLocale: null,
      displayCurrency: null,
      displayLengthUnit: null,
      updatedAt: null,
    });

    // And the fallback is reported as a fallback that nobody degraded *from* — plan 10.6's
    // `RenderLocale` keeps "they asked for Thai" and "they asked for nothing" apart, and this
    // is the second one.
    expect(answer.messageLocale.requested).toBeNull();
    expect(answer.messageLocale.rendered).toBe('th');
    expect(answer.messageLocale.degraded).toBe(false);
    expect(answer.messageLocale.translated).toBe(answer.messageLocale.total);
    expect(answer.messageLocale.total).toBeGreaterThan(0);
  });

  it('carries all twelve preference-by-surface statements on every response', async () => {
    // The screens render this list rather than deciding for themselves what a setting does, so
    // it has to be on the empty response as well as on a populated one — a person with no
    // preferences is exactly the person about to make one.
    const answer = await read(bob);
    expect(answer.effects).toHaveLength(12);
    expect(answer.effects.filter((effect) => effect.honoured)).toHaveLength(4);
  });

  /* ---------------------------------------------------------------- *
   * Storing and forgetting
   * ---------------------------------------------------------------- */

  it('stores all three, reads them back, and stamps when they last moved', async () => {
    const saved = await write(alice, body('en', 'EUR', 'in'));
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);

    const first = saved.body as PreferencesResponseWire;
    expect(first.preferences.preferredLocale).toBe('en');
    expect(first.preferences.displayCurrency).toBe('EUR');
    expect(first.preferences.displayLengthUnit).toBe('in');
    expect(first.preferences.updatedAt).not.toBeNull();

    // A second GET is the same row and not a second write.
    expect((await read(alice)).preferences).toStrictEqual(first.preferences);

    /*
     * `updatedAt` moves on an update. The column's `defaultNow()` only fires on insert, so an
     * upsert that forgot to set it on the conflict branch would leave a preference changed
     * today carrying the day it was first set — which is precisely the field a support
     * conversation about "when did my language change" reaches for.
     */
    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = await write(alice, body('de', 'EUR', 'in'));
    const second = (again.body as PreferencesResponseWire).preferences;
    expect(second.preferredLocale).toBe('de');
    expect(Date.parse(second.updatedAt ?? '')).toBeGreaterThan(
      Date.parse(first.preferences.updatedAt ?? ''),
    );
  });

  it('spells "no preferences" as a deleted row, not as a row of nulls', async () => {
    /*
     * `user_preferences_says_something` refuses `num_nonnulls(...) >= 1` being false, so a PUT
     * of three nulls has exactly two possible outcomes: a 500 out of a CHECK, or a delete. The
     * service chooses the delete, because "I want no preferences" is a reasonable request and
     * answering it with a constraint violation would be the schema's rule leaking through the
     * API as a bug.
     */
    await write(alice, body('en', 'THB', 'mm'));
    expect((await read(alice)).preferences.updatedAt).not.toBeNull();

    const cleared = await write(alice, NOTHING);
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);

    const after = (cleared.body as PreferencesResponseWire).preferences;
    expect(after).toStrictEqual({
      preferredLocale: null,
      displayCurrency: null,
      displayLengthUnit: null,
      updatedAt: null,
    });
    expect((await read(alice)).preferences).toStrictEqual(after);
  });

  it('deletes, and deleting twice is not an error', async () => {
    await write(alice, body('vi', null, 'ft'));

    for (const attempt of [1, 2]) {
      const answer = await call('DELETE', '/me/preferences', { token: alice.token });
      expect(answer.status, `attempt ${String(attempt)}`).toBe(200);
      // 200 with the empty resource rather than 204: the screen re-renders from this response,
      // and `messageLocale` changes when the locale goes — Thai by fallback rather than Thai by
      // choice. A 204 would make the client guess that or ask again.
      expect((answer.body as PreferencesResponseWire).preferences.updatedAt).toBeNull();
      expect((answer.body as PreferencesResponseWire).messageLocale.requested).toBeNull();
    }
  });

  it('keeps a partial preference partial', async () => {
    // One of the three is a legal row — the CHECK asks for at least one, not all three — and a
    // person who cares about units and not about language must not be forced to state one.
    const saved = await write(alice, body(null, null, 'ft'));
    expect(saved.status).toBe(200);

    const stored = (saved.body as PreferencesResponseWire).preferences;
    expect(stored.displayLengthUnit).toBe('ft');
    expect(stored.preferredLocale).toBeNull();
    expect(stored.displayCurrency).toBeNull();

    await call('DELETE', '/me/preferences', { token: alice.token });
  });

  /* ---------------------------------------------------------------- *
   * What the API refuses that the column would have accepted
   * ---------------------------------------------------------------- */

  it('refuses a well-formed language tag this build has no catalogue for', async () => {
    /*
     * The column's CHECK is a *shape* check (`^[a-z]{2}(-…)?$`) and `packages/db` says why: it
     * cannot import `@wewin/i18n`, and a hand-copied list of eight locales in a migration would
     * be a fourth copy with no drift test able to see it. It names this layer as the one that
     * can import the authority — so `'ja'` is stored happily by Postgres and refused here.
     */
    const answer = await write(alice, body('ja', null, null));
    expect(answer.status).toBe(400);
  });

  it('refuses an unknown currency and an unknown unit', async () => {
    expect((await write(alice, body(null, 'XXX', null))).status).toBe(400);
    expect((await write(alice, body(null, null, 'furlong'))).status).toBe(400);
  });

  it('refuses a partial body and an unknown key', async () => {
    // PUT replaces the whole resource, so all three keys are required: "absent" and "cleared"
    // are the two things a settings form has to be able to say, and a schema where omission
    // means "leave it alone" cannot say the second without a sentinel.
    expect((await write(alice, { preferredLocale: 'en' })).status).toBe(400);
    expect((await write(alice, { ...NOTHING, theme: 'dark' })).status).toBe(400);
  });

  it('accepts every locale, every currency and every unit the domain defines', async () => {
    // The mirror of the two refusals above, and the reason the lists are imported rather than
    // typed out: a currency added to `@wewin/core` is accepted here the day it lands, and a
    // list that had silently narrowed would fail this rather than quietly rejecting a customer.
    let checked = 0;
    for (const locale of SUPPORTED_LOCALES) {
      const answer = await write(alice, body(locale, null, null));
      expect(answer.status, locale).toBe(200);
      checked += 1;
    }
    for (const currency of CURRENCIES) {
      const answer = await write(alice, body(null, currency, null));
      expect(answer.status, currency).toBe(200);
      checked += 1;
    }
    for (const unit of LENGTH_UNITS) {
      const answer = await write(alice, body(null, null, unit));
      expect(answer.status, unit).toBe(200);
      checked += 1;
    }

    expect(checked).toBe(8 + 9 + 5);
    await call('DELETE', '/me/preferences', { token: alice.token });
  });

  /* ---------------------------------------------------------------- *
   * Plan 10.6, the live half: what a message would actually be written in
   * ---------------------------------------------------------------- */

  it('says when a chosen language will arrive as Thai anyway', async () => {
    /*
     * Six of the eight catalogues are empty (plan 13: translation is a person's job, not a code
     * task). A preferences screen that let somebody choose Burmese, saved it, and then sent
     * Thai forever with nothing explaining why is the honest failure this field prevents.
     */
    const burmese = (await write(alice, body('my', null, null)))
      .body as PreferencesResponseWire;
    expect(burmese.messageLocale.requested).toBe('my');
    expect(burmese.messageLocale.rendered).toBe('th');
    expect(burmese.messageLocale.degraded).toBe(true);
    // Counted for what will be rendered, not for what was asked: the reader needs to know how
    // complete the Thai they are getting is, and `degraded` is what tells them a substitution
    // happened at all.
    expect(burmese.messageLocale.translated).toBe(burmese.messageLocale.total);

    const english = (await write(alice, body('en', null, null)))
      .body as PreferencesResponseWire;
    expect(english.messageLocale.rendered).toBe('en');
    // Not degraded — eleven-odd sentences really do arrive in English — and visibly partial,
    // which is the pair of facts a screen prints as `11/100`. A `degraded` that were true for
    // every locale short of complete would be permanently on, which is the same as absent.
    expect(english.messageLocale.degraded).toBe(false);
    expect(english.messageLocale.translated).toBeGreaterThan(0);
    expect(english.messageLocale.translated).toBeLessThan(english.messageLocale.total);

    const thai = (await write(alice, body('th', null, null))).body as PreferencesResponseWire;
    expect(thai.messageLocale.rendered).toBe('th');
    expect(thai.messageLocale.degraded).toBe(false);

    await call('DELETE', '/me/preferences', { token: alice.token });
  });

  /* ---------------------------------------------------------------- *
   * Whose preferences these are
   * ---------------------------------------------------------------- */

  it('refuses a write from a caller with no session, and from a guest', async () => {
    for (const method of ['PUT', 'DELETE'] as const) {
      const anonymous = await call(method, '/me/preferences', {
        ...(method === 'PUT' ? { body: NOTHING } : {}),
      });
      expect(anonymous.status, method).toBe(401);
    }

    /*
     * A guest is a principal — it owns a cart, and most of this API's customer routes accept
     * one — and it may not write here. `user_preferences.user_id` is a foreign key to `users`,
     * so a guest has nowhere to put a row; giving them one means a second nullable owner column
     * and a CHECK that exactly one is set, which is a seam not worth opening for a setting a
     * browser already holds in `localStorage`. The storefront screen says so rather than hiding
     * the controls behind a sign-in.
     */
    const cart = await call('POST', '/orders', { body: {} });
    expect(cart.status).toBe(201);
    const cookie = (cart.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(cookie.length).toBeGreaterThan(0);

    const guestWrite = await call('PUT', '/me/preferences', { cookie, body: body('en', null, null) });
    expect(guestWrite.status).toBe(401);
  });

  it('answers a reader with no account at all, with the empty resource and the full effects table', async () => {
    /*
     * `GET` is anonymous and the write routes are not — see the controller. The storefront's
     * settings screen is reachable without an account (the anonymous visitor is the main
     * funnel, plan section 6), and the `effects` table is the half that keeps that screen
     * honest: eight of the twelve statements are `false`, and a screen that could only show
     * them to signed-in readers would be silent about them for every visitor this site has.
     *
     * What must never happen is somebody else's row coming back. There is no id in the request
     * to name one with, and the empty answer comes from the same presenter the absent-row case
     * uses, so "anonymous" and "you have no preferences" cannot drift apart.
     */
    await write(alice, body('en', 'USD', 'in'));

    for (const auth of [{}, { cookie: guestCookie(await call('POST', '/orders', { body: {} })) }]) {
      const answer = await call('GET', '/me/preferences', auth);
      expect(answer.status, JSON.stringify(auth)).toBe(200);

      const seen = answer.body as PreferencesResponseWire;
      expect(seen.preferences).toStrictEqual({
        preferredLocale: null,
        displayCurrency: null,
        displayLengthUnit: null,
        updatedAt: null,
      });
      expect(seen.effects).toHaveLength(12);
      expect(seen.messageLocale.rendered).toBe('th');
      expect(seen.messageLocale.degraded).toBe(false);
    }

    // And Alice's row is still there — the anonymous read did not disturb it.
    expect((await read(alice)).preferences.displayCurrency).toBe('USD');
    await call('DELETE', '/me/preferences', { token: alice.token });
  });

  it('has no request shape that names somebody else', async () => {
    /*
     * The row filter is not a WHERE clause anybody could forget: `user_id` is the primary key,
     * the service takes it as its first argument, and the only source of it is `@CurrentScope()`.
     * There is no body key, no path parameter and no query string that carries a user id — so
     * the strongest available assertion is that trying to smuggle one is a 400 and that Bob is
     * untouched either way.
     */
    await write(alice, body('en', 'USD', 'in'));
    await call('DELETE', '/me/preferences', { token: bob.token });

    const smuggled = await write(alice, { ...body('de', null, null), userId: bob.userId });
    expect(smuggled.status).toBe(400);

    expect((await read(bob)).preferences.updatedAt).toBeNull();
    expect((await read(alice)).preferences.preferredLocale).toBe('en');

    await call('DELETE', '/me/preferences', { token: alice.token });
  });

  it('never lets a preferences body into a shared cache', async () => {
    // Plan 8.2's third trap is one reader's preference being served to another, and the header
    // is the layer where that is actually decided — 6b measured `revalidate = false` emitting
    // `s-maxage=31536000` and had to bound it in `next.config.ts`. This body is per-person by
    // definition.
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      const answer = await call(method, '/me/preferences', {
        token: alice.token,
        ...(method === 'PUT' ? { body: NOTHING } : {}),
      });
      expect(answer.headers.get('cache-control'), method).toBe('no-store');
    }

    // The anonymous read most of all: it is the one a CDN would happily keep, and the body it
    // would keep is the shape a signed-in reader's body has.
    const anonymous = await call('GET', '/me/preferences', {});
    expect(anonymous.headers.get('cache-control')).toBe('no-store');
  });

  /* ------------------------------------------------------------------ *
   * THE SWEEP — a contract survives every preference its customer can hold
   *
   * Modelled on `packages/core/tests/displayUnits.test.ts`, which sweeps every authored
   * bound through all five display units and asserts the micrometre comes back. This is
   * the same claim one layer up: the customer's *order* — its money and its pinned
   * document — is theirs, and looking at the site in another language, currency or unit
   * is looking, not editing.
   *
   * Every combination, not a sample: the three columns are independent in the schema, so
   * a cartesian product is the only sweep that can catch a bug that needs two of them at
   * once (a currency preference that only bites while a non-Thai locale is set is exactly
   * the shape of the bug plan 8.2 trap 3 describes).
   * ------------------------------------------------------------------ */

  describe('plan 10.6 and plan 4.1/4.2 — an issued quote is not re-rendered for the reader', () => {
    let order: OrderWire;
    let documentAtSubmit: string;
    let moneyAtSubmit: string;

    beforeAll(async () => {
      const line = await liveLine(call);

      const created = await call('POST', '/orders', { token: alice.token, body: {} });
      expect(created.status).toBe(201);

      const submitted = await call(
        'POST',
        `/orders/${(created.body as OrderWire).id}/transitions/awaiting_payment`,
        {
          token: alice.token,
          body: {
            /*
             * Submitted in **English**, deliberately, and Alice's preference is moved to all
             * eight below. A document pinned in Thai and read by a Thai-preferring customer
             * would pass this sweep whatever the code did — the two values agree by accident.
             * `contact.locale: 'en'` is what makes the pin visible: seven of the eight
             * preferences below disagree with it, so anything that renegotiated would change
             * the bytes.
             */
            contact: { email: `profile-${tag}@probe.invalid`, name: `profile probe ${tag}`, locale: 'en' },
            lines: [line],
          },
        },
      );
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);

      order = submitted.body as OrderWire;
      documentAtSubmit = await documentJson(order.id);
      moneyAtSubmit = JSON.stringify(order.money);

      expect(documentAtSubmit.length).toBeGreaterThan(100);
      expect(moneyAtSubmit).not.toBe('null');
    }, 60_000);

    const documentJson = async (orderId: string): Promise<string> => {
      const answer = await call('GET', `/orders/${orderId}/document`, { token: alice.token });
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      return JSON.stringify(answer.body);
    };

    it('a document pinned at submit is byte-identical under every preference a customer can hold', async () => {
      let checked = 0;

      for (const locale of SUPPORTED_LOCALES) {
        for (const currency of CURRENCIES) {
          for (const unit of LENGTH_UNITS) {
            const saved = await write(alice, body(locale, currency, unit));
            expect(saved.status, `${locale}/${currency}/${unit}`).toBe(200);

            expect(await documentJson(order.id), `${locale}/${currency}/${unit}`).toBe(
              documentAtSubmit,
            );
            checked += 1;
          }
        }
      }

      /*
       * Pinned rather than floored, exactly as `displayUnits.test.ts` pins 57,490. The size of
       * this sweep is a fact about the domain — eight languages × nine currencies × five units
       * is every preference a person can express — so a floor would let it be eroded to a
       * handful of points without anything saying so.
       */
      expect(checked).toBe(8 * 9 * 5);
    }, 180_000);

    it('and so is the money, which is the half a wrong answer would be visible in', async () => {
      /*
       * The document is prose and structure; the money is the number on the invoice. Plan 4.2
       * fixes one base currency and a pinned rate, and `orders_currency_is_thb` holds it — so
       * the failure this catches is not a rounding error, it is somebody deciding that a
       * `displayCurrency` of EUR should be applied on the way out of the orders endpoint.
       *
       * Swept over the currencies alone: the locale and the unit cannot reach an amount even in
       * principle, and the cartesian product above already covers their combination for the
       * document, which is the surface that carries all three.
       */
      let checked = 0;

      for (const currency of CURRENCIES) {
        await write(alice, body('th', currency, 'mm'));

        const answer = await call('GET', `/orders/${order.id}`, { token: alice.token });
        expect(answer.status).toBe(200);
        expect(JSON.stringify((answer.body as OrderWire).money), currency).toBe(moneyAtSubmit);
        checked += 1;
      }

      expect(checked).toBe(9);
    }, 60_000);

    it('the sweep would notice — the document really does change when the order does', async () => {
      /*
       * ⚠️ The two sweeps above are `expect(x).toBe(unchanged)` repeated 369 times, which is
       * the exact shape of a test that would also pass if `documentJson` had started returning
       * a constant, or if the endpoint had started 200ing with an empty body. A guard nobody
       * has watched fire is a guard nobody has evidence for.
       *
       * So: fetch a *different* order's document through the same helper and assert it differs.
       * That exercises the whole path — the request, the scope filter, the serialisation — and
       * proves the comparison can distinguish two documents.
       */
      const other = await call('POST', '/orders', { token: alice.token, body: {} });
      const otherSubmitted = await call(
        'POST',
        `/orders/${(other.body as OrderWire).id}/transitions/awaiting_payment`,
        {
          token: alice.token,
          body: {
            contact: { email: `profile-other-${tag}@probe.invalid`, name: `probe ${tag}`, locale: 'th' },
            lines: [await liveLine(call)],
          },
        },
      );
      expect(otherSubmitted.status, JSON.stringify(otherSubmitted.body)).toBe(200);

      expect(await documentJson((otherSubmitted.body as OrderWire).id)).not.toBe(documentAtSubmit);
    }, 60_000);
  });
});

/**
 * A line configured at a published product's own defaults, taken from the live catalogue.
 *
 * Lifted from `tests/orders/lifecycle.pg.test.ts`, which explains the shape: the version id and
 * the document hash have to come from what is actually published, because submit refuses a
 * handle that has moved. Nothing about this line matters to the preferences under test; it
 * exists so that there is a real contract with a real pinned document to hold still.
 */
async function liveLine(call: ReturnType<typeof client>): Promise<OrderLineRequestWire> {
  const listed = await call('GET', '/catalog/products', {});
  if (listed.status !== 200) throw new Error(`the catalogue is not being served: ${String(listed.status)}`);

  const wire = listed.body as {
    readonly products: readonly {
      readonly productVersionId: string;
      readonly documentHash: string;
      readonly product: { readonly id: string };
    }[];
  };

  for (const published of wire.products) {
    const product = products.find((candidate: Product) => candidate.id === published.product.id);
    if (!product || !product.groups.some((group) => group.kind === 'custom')) continue;

    const selections: Record<string, string> = {};
    const measures: Record<string, ReturnType<typeof encodeUm>> = {};
    const enteredUnits: Record<string, 'cm' | 'mm'> = {};

    for (const group of product.groups) {
      if (group.kind === 'sku') selections[group.code] = group.defaultValue;
      else {
        measures[group.code] = encodeUm(group.defaultUm);
        enteredUnits[group.code] = group.unit;
      }
    }

    return {
      productVersionId: published.productVersionId,
      documentHash: published.documentHash,
      productId: product.id,
      selections,
      measures,
      enteredUnits,
      qty: 2,
    };
  }

  throw new Error('no published product with a measurement to order');
}
