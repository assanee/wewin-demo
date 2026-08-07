import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Database } from '@wewin/db';
import { groupPermissions, groups, userGroups, users } from '@wewin/db/schema';
import { products } from '@wewin/core/fixtures';
import type { Product } from '@wewin/core';
import { encodeUm } from '@wewin/contract/measure';
import type { OrderLineRequestWire, OrderWire } from '@wewin/contract/order';

import { AppModule } from '../../../src/app.module';
import { AccessTokenService } from '../../../src/auth/session/access-token';
import { parseOAuthConfig } from '../../../src/auth/oauth/oauth.config';
import { AllExceptionsFilter } from '../../../src/common/errors/all-exceptions.filter';
import { parseEnv, type Env } from '../../../src/config/env';
import type { PermissionCode } from '../../../src/rbac';
import { testSessionConfig , testMfaSecretKey } from '../../support/app';

/**
 * The real application graph. Nothing added, and that is the change.
 *
 * This used to import `OrdersModule` and `RefundsModule` explicitly, because `RefundsModule` was
 * not in `AppModule.forRoot`'s list — the suite exercised a feature the shipped application did
 * not serve, and `GET /payments/refunds` was a 404 in production. The alarm that was supposed to
 * catch it (`tests/rbac/route-audit.test.ts`) did catch it; nobody had wired the module.
 *
 * ⚠️ AND NAMING THEM AGAIN IS NOW ACTIVELY WRONG, not merely redundant. Nest deduplicates static
 * modules by class reference, so a second `OrdersModule` is free — but `SlipsModule.forRoot()`
 * returns a *fresh* `DynamicModule` object every call, so the same controllers register twice and
 * the boot audit refuses to start: *"shares one handler function with … — an inherited handler
 * cannot carry two access policies"*. The audit catching a double registration is the same audit
 * catching a missing one, which is the argument for having it.
 *
 * Everything else is the real thing — the same middleware, the same global guard, the same
 * boot-time route audit — which means a refund route added without an access policy fails this
 * suite at `listen`, before a single assertion runs.
 */

export interface PaymentsApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

export function paymentsEnv(databaseUrl: string): Env {
  return parseEnv({ NODE_ENV: 'test', DATABASE_URL: databaseUrl });
}

export async function bootPaymentsApp(env: Env): Promise<PaymentsApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(env, {
        session: testSessionConfig(),
        mfaSecretKey: testMfaSecretKey(),
        oauth: parseOAuthConfig({}),
      })],
  }).compile();

  const app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalFilters(new AllExceptionsFilter(env));
  app.enableShutdownHooks();
  await app.listen(0, '127.0.0.1');

  const address = app.getHttpServer().address() as AddressInfo;
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await app.close();
    },
  };
}

export interface Actor {
  readonly userId: string;
  readonly token: string;
}

/**
 * A user, a group holding exactly these permissions, and a token the running app will accept.
 *
 * Signed by the application's own `AccessTokenService`: minting a JWT in the test would prove
 * the test can sign, not that the app can authenticate. Each actor gets a group of its own —
 * the three people in a refund (requester, approver, disburser) must be genuinely different
 * principals, and sharing a group would make it too easy to accidentally share an identity.
 */
export async function makeActor(
  db: Database,
  app: PaymentsApp,
  label: string,
  codes: readonly PermissionCode[],
): Promise<Actor> {
  const [user] = await db.insert(users).values({ displayName: label }).returning({ id: users.id });
  if (!user) throw new Error('fixture insert returned nothing');

  if (codes.length > 0) {
    const code = `payments_probe_${label.replace(/[^a-z0-9]+/giu, '_').toLowerCase()}`.slice(0, 60);
    const [group] = await db
      .insert(groups)
      .values({ code, nameTh: 'กลุ่มทดสอบการเงิน' })
      .onConflictDoUpdate({ target: groups.code, set: { nameTh: 'กลุ่มทดสอบการเงิน' } })
      .returning({ id: groups.id });
    if (!group) throw new Error('fixture insert returned nothing');

    await db.insert(userGroups).values({ userId: user.id, groupId: group.id }).onConflictDoNothing();
    await db
      .insert(groupPermissions)
      .values(codes.map((permissionCode) => ({ groupId: group.id, permissionCode })))
      .onConflictDoNothing();
  }

  const issued = app.app.get(AccessTokenService).sign({ userId: user.id, sessionId: randomUUID() });
  return { userId: user.id, token: issued.token };
}

export interface Json {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}

/** One HTTP client for the whole suite, carrying a bearer token. */
export function client(baseUrl: string) {
  return async function call(
    method: string,
    path: string,
    options: { readonly token?: string; readonly body?: unknown } = {},
  ): Promise<Json> {
    const headers: Record<string, string> = {};
    if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });

    const text = await response.text();
    return {
      status: response.status,
      body: text.length === 0 ? null : (JSON.parse(text) as unknown),
      headers: response.headers,
    };
  };
}

/** A configured line against a really-published product, at its catalogue defaults. */
export async function liveLine(call: ReturnType<typeof client>): Promise<OrderLineRequestWire> {
  const listed = await call('GET', '/catalog/products', {});
  if (listed.status !== 200) throw new Error(`the catalogue is not being served: ${listed.status}`);

  const wire = listed.body as {
    products: readonly {
      productVersionId: string;
      documentHash: string;
      product: { id: string };
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

/**
 * A submitted order with a real, pinned `grand_total_thb_minor` and `scheduled_deposit_thb_minor`.
 *
 * Priced by the application, from the published catalogue, through `submit_for_payment` — the
 * only path that pins those two columns, and the reason this suite does not fabricate an order
 * row. `scheduled_deposit_thb_minor` is the ceiling on every forfeit in this phase, and a
 * fabricated one would be a ceiling the fixture chose rather than the one the contract did.
 */
export async function submittedOrder(
  call: ReturnType<typeof client>,
  customer: Actor,
  line: OrderLineRequestWire,
  contact: { readonly email: string; readonly name: string },
): Promise<OrderWire> {
  const created = await call('POST', '/orders', { token: customer.token, body: {} });
  if (created.status !== 201) throw new Error(`could not start a cart: ${JSON.stringify(created.body)}`);

  const draft = created.body as OrderWire;
  const submitted = await call('POST', `/orders/${draft.id}/transitions/awaiting_payment`, {
    token: customer.token,
    body: { contact, lines: [line] },
  });

  if (submitted.status !== 200) throw new Error(`could not submit: ${JSON.stringify(submitted.body)}`);
  return submitted.body as OrderWire;
}
