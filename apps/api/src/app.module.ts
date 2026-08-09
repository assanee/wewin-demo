import { Module, type DynamicModule, type MiddlewareConsumer, type NestModule } from '@nestjs/common';

import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { AuthenticationMiddleware } from './auth/authentication.middleware';
import type { OAuthConfig } from './auth/oauth/oauth.config';
import type { SessionConfig } from './auth/session/session.config';
import { CatalogModule } from './catalog/catalog.module';
import { JsonBodyMiddleware } from './common/json-body.middleware';
import { RequestIdMiddleware } from './common/request-id';
import { ConfigModule } from './config/config.module';
import type { Env } from './config/env';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { MediaModule } from './media/media.module';
import { MetaModule } from './meta/meta.module';
import { NotificationsModule, parseNotificationsConfig } from './notifications';
import { DocumentLinkModule, OrdersModule } from './orders';
import { OrganisationModule } from './organisation';
import { RefundsModule } from './payments/refunds';
import { SlipsModule } from './payments/slips';
import { AuthorityModule } from './quotes/authority';
import { QuotesModule } from './quotes';
import { ReviewsModule } from './reviews';
import { ProfileModule } from './profile';
import { UsersModule } from './users';
import { AccountModule } from './account';
import { OverviewModule } from './overview/overview.module';
import { RbacModule } from './rbac/rbac.module';

/*
 * `forRoot(env, …)` rather than reading process.env inside the module: configuration is
 * validated in main.ts before Nest exists, and passing it in keeps that the only place it
 * is read. Tests build the same graph with a hand-written Env and no .env file anywhere.
 *
 * The session configuration is a second parameter rather than part of `Env` because it
 * holds the access-token signing key as a `KeyObject` — `Env` is frozen, logged in parts,
 * and handed whole to every module in the graph, and a signing key should be in none of
 * those places. See src/auth/session/session.config.ts.
 */

export interface AppModuleOptions {
  readonly session: SessionConfig;
  /**
   * ⚠️ `AUTH_MFA_SECRET_KEY` — 32 bytes, base64url — and it is here rather than in `Env` for
   * the reason stated above about the signing key: `Env` is frozen, logged in parts, and
   * handed whole to every module in the graph. Key material belongs in none of those places.
   */
  readonly mfaSecretKey: string;
  /** Omitted means the OAuth module parses `process.env` itself. Tests pass their own. */
  readonly oauth?: OAuthConfig;
}

@Module({})
export class AppModule implements NestModule {
  static forRoot(env: Env, options: AppModuleOptions): DynamicModule {
    /*
     * Built once and handed to both places that need it. `UsersModule` resolves
     * `PasswordResetService` through this graph — a second `AuthModule.forRoot(...)` would
     * mint a second session-signing key *and* a second reset throttle with its own counters,
     * neither of which fails loudly.
     */
    const notifications = parseNotificationsConfig(process.env);

    const auth = AuthModule.forRoot({
      session: options.session,
      mfaSecretKey: options.mfaSecretKey,
      ...(options.oauth === undefined ? {} : { oauth: options.oauth }),
    });

    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(env),
        DatabaseModule,
        /*
         * Before the feature modules, though Nest does not care about the order: it binds
         * a global guard over every controller in the graph and audits every route at
         * boot, so a module added below this line is enforced whether or not it knows
         * this module exists. A new endpoint that states no access stops the process from
         * starting — see src/rbac/route-registry.service.ts.
         */
        RbacModule.forRoot({ cookieSecure: env.COOKIE_SECURE }),
        auth,
        HealthModule,
        MetaModule,
        CatalogModule,
        /*
         * The write side, after the read side for the same non-reason: order does not
         * matter to Nest here. It is last because it is the only module in this list whose
         * every endpoint requires a permission, so the boot audit's one-line summary reads
         * as "the public surface, then the guarded one".
         */
        AdminModule,
        /*
         * Images. Last, and it is the one module here that reaches something other than
         * Postgres — an S3-compatible bucket, configured from its own directory rather than
         * from `Env`, the same way OAuthModule handles its credentials. Nothing connects at
         * construction, so a graph built with no storage running still boots.
         */
        MediaModule.forRoot(),
        /*
         * The order lifecycle (phase 5a) and the outbox that delivers what it appends.
         *
         * They are listed together and must stay together. `OrdersModule` writes
         * `order_events`; a deferred trigger on that table fans a row out into
         * `notifications` in the same transaction; `NotificationsModule` is the only thing
         * that drains that table. Registering the first without the second gives a process
         * that changes an order's status and queues a message no worker will ever pick up —
         * which is precisely plan 10.1's failure ("committed, and nobody was told"), reached
         * by a wiring omission rather than by an SMTP outage.
         *
         * Neither exports anything the other can import: an order handler still has no way to
         * reach a transport, which is what stops `sendEmail()` reappearing inside a
         * transition. See the note at the top of orders.module.ts.
         */
        OrdersModule,
        /*
         * ⚠️ One storefront origin, built once and handed to both.
         *
         * The worker puts a quotation link in an email; the dashboard offers the same link
         * for staff to paste into LINE. Two configurations would be two origins, and the
         * customer who was emailed one and read the other out over the telephone would find
         * that only one of them worked.
         */
        DocumentLinkModule.forRoot(auth, notifications.webBaseUrl),
        NotificationsModule.forRoot({ auth, config: notifications }),
        /*
         * Money that has actually moved (phase 5b), and it is listed here because *not* listing
         * it was the single largest finding of the round.
         *
         * Three modules shipped complete, tested and unreachable. Against the assembled
         * application `GET /payments/slips` and `GET /payments/refunds` were 404, and an order
         * submitted through the real funnel had no instalments at all — so
         * `order_settled_through()` was NULL, `order_gate_is_open()` was true with ฿0.00
         * received, and the freeze gate that decides when aluminium is cut opened for nothing.
         * Every attack the red team reported had to hand-write the instalment row a fixture,
         * because the shipped application could not take a payment at all.
         *
         * `SlipsModule.forRoot()` reads its own bucket configuration from the environment, the
         * same arrangement `MediaModule` uses and for the same reason: a slip's bucket is not a
         * field of `Env`, and it must never be the product-image bucket, which is served
         * anonymously (`slip-storage.config.ts` refuses the two being equal).
         *
         * `PaymentLifecycleModule` is deliberately absent from this list: `OrdersModule` imports
         * it, which is the only edge from the lifecycle to the ledger and the only direction it
         * runs. Nest deduplicates by class reference either way; what matters is that there is
         * one importer.
         */
        SlipsModule.forRoot(),
        RefundsModule,
        /*
         * The sales-editable quote and the authority that bounds it (phase 5c) — and they are
         * listed here because *not* listing them was, again, the largest finding of the round.
         *
         * Two complete modules, 1,100 tests between them, and against the assembled application
         * every route in both was a 404 while `AuthorityService.gate` had zero callers anywhere
         * in `src/`. That is 5b's finding repeated one phase later with different nouns, which
         * is why the note now sits in three files instead of one.
         *
         * `OrdersModule` imports both as well, which is not redundancy: Nest deduplicates by
         * class reference, and the import there is what makes `submit` able to price the quote
         * and call the gate. These two lines are what make the routes *exist*.
         */
        QuotesModule,
        AuthorityModule,
        /*
         * Reviews and per-user preferences (phase 7). Listed for the same reason as the two
         * above — and this was the *third* consecutive round in which a finished, tested
         * module reached the end of the phase unimported, so the note above is no longer
         * only a note: `tests/rbac/controller-reachability.test.ts` now fails when a
         * controller exists under `src/` that the assembled application does not serve.
         *
         * A comment cannot catch this. It said so twice and the thing happened again.
         */
        ReviewsModule.forRoot(),
        UsersModule.forRoot({ imports: [auth] }),
        AccountModule,
        ProfileModule,
        OverviewModule,
        /*
         * The company's own settings — its profile, and the bank accounts it is paid into.
         * Imports nothing and is imported by nothing else in this list, so its place here is
         * not load-bearing; it is last because it is the newest.
         */
        OrganisationModule,
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    /*
     * Order is the security property, and it is the order of this array: a request id
     * exists before anything logs, and the identity is attached before `RbacGuard` runs.
     * Nest runs middleware before guards, which is what makes the second half true by
     * construction rather than by `APP_GUARD` registration order.
     *
     * '{*splat}' and not '*': Express 5's path parser rejects a bare wildcard.
     *
     * `JsonBodyMiddleware` is third because it inspects the parsed body and has nothing to
     * say about identity; it is *before every controller* because that is the whole of its
     * job — the one key that `z.strictObject` cannot refuse, refused once for every route
     * rather than in each schema (see the file for what it is and is not).
     */
    consumer
      .apply(RequestIdMiddleware, AuthenticationMiddleware, JsonBodyMiddleware)
      .forRoutes('{*splat}');
  }
}
