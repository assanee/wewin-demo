import { Body, Controller, Delete, Get, Header, Put } from '@nestjs/common';

import { ZodBodyPipe } from '../admin/zod-body.pipe';
import { AllowAnonymous, RequireAuthenticated } from '../rbac';
import { CurrentScope } from '../rbac/current-scope.decorator';
import { matchScope, type Scope } from '../rbac/scope';
import { AppError } from '../common/errors/app-error';
import {
  preferencesRequestSchema,
  type PreferencesRequest,
  type PreferencesResponseWire,
} from './profile.contract';
import { ProfileService } from './profile.service';

/**
 * The caller's own presentation preferences.
 *
 *     GET    /me/preferences   what is stored, what it resolves to, and what it changes
 *     PUT    /me/preferences   replace all three
 *     DELETE /me/preferences   have no preferences again
 *
 * ── Why it is under `/me` and not `/profile` ─────────────────────────────────────
 *
 * The directory is `src/profile/` because that is what this round is called; the *route* is
 * `/me/preferences` because that is what it holds. `/profile` is an invitation: the next
 * person with a display name, an email address or a delivery address to store puts it on the
 * profile endpoint, and the argument in `packages/db/src/schema/profile.ts` for why
 * `user_preferences` is a separate table from `users` — three kinds of fact on one row is how
 * personal data ends up somewhere `ERASURE_TREATMENTS` cannot see it — is undone at the API
 * by a URL. `/me/preferences` names exactly what is behind it and nothing else fits there.
 *
 * It sits beside `GET /me`, which is the other question a client asks about itself, and the
 * two are deliberately different kinds of answer: `/me` is *what you may do* (derived from
 * permissions, anonymous, useful to a visitor), this is *what you prefer* (stored, private,
 * meaningless without an account).
 *
 * ── `@RequireAuthenticated`, not `@RequirePrincipal` ─────────────────────────────
 *
 * The storefront's main funnel is anonymous and most of this API's customer-facing routes are
 * `principal` for exactly that reason. This one is not, and the difference is that a guest
 * has nowhere to put a preference: `user_preferences.user_id` is a foreign key to `users`,
 * and giving a guest a row would mean a second nullable owner column and a CHECK that exactly
 * one is set — the seam `order.ts` already describes and which is not worth opening for a
 * setting a browser can hold in `localStorage`.
 *
 * So the anonymous visitor keeps their preferences on their own device, which is what
 * `DisplayUnitProvider` and the `wewin.locale` cookie already do, and signing in is what makes
 * the choice survive a new device. **That is the whole product difference**, and the storefront
 * screen is written to say it rather than to gate the controls behind a sign-in.
 *
 * ── No permission, and no row filter to get wrong ────────────────────────────────
 *
 * `RequireAuthenticated`'s own header says it is "for the routes that are about the caller
 * themselves — their own profile", and then warns that the handler still has to filter by
 * `scope.userId` because being signed in is not permission to read somebody else's row. Here
 * that filter is not a WHERE clause somebody could forget: `user_id` is the table's primary
 * key, the service takes it as its first argument, and the only source of it is
 * `@CurrentScope()`. There is no request shape — no body key, no path parameter, no query —
 * that names a user id at all. A caller cannot ask about anybody but themselves.
 *
 * ⚠️ **And there is no staff route here on purpose.** `users.read` exists in the permission
 * catalogue and no controller consumes it; adding "read a customer's preferences" would be
 * the first use, and it should be a decision taken with the rest of the user-administration
 * surface rather than smuggled in beside a settings form.
 */
@Controller('me/preferences')
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  /**
   * `no-store`, on all three.
   *
   * This response is per-person by definition and is exactly the kind of body that must never
   * land in a shared cache — plan 8.2's third trap is one reader's preference being served to
   * another, and the header is the layer where that is actually decided (6b measured
   * `revalidate = false` emitting `s-maxage=31536000` and had to bound it in
   * `next.config.ts`). `AuthController` sets the same header on the refresh response for the
   * same reason.
   */
  /**
   * ⚠️ **`@AllowAnonymous`, and it is the one decision on this controller worth arguing.**
   *
   * The write routes below require a session. This one does not, for the same reason `GET /me`
   * does not: **the anonymous visitor is the main funnel** (plan section 6), the storefront's
   * settings screen is reachable without an account, and two thirds of what this response
   * carries is a *constant* — `effects`, the twelve statements of what a preference does and
   * does not change. Eight of those twelve are `false`, and they are the honest half; a screen
   * that could only show them to signed-in readers would be silent about them for every
   * visitor this site actually has.
   *
   * What an anonymous caller gets is the **empty resource**: three nulls, `updatedAt: null`,
   * the Thai fallback, and the effects table. Never somebody else's row — there is no id in
   * the request to name one with, and `userIdOrNull` returns `null` for every non-user scope
   * rather than falling through to a default.
   *
   * The alternative considered and rejected was compiling the effects table into each client.
   * It is a constant *today*; the day a `false` becomes a `true` there would be three copies
   * of it and two of them stale, which is precisely the "second opinion" failure this endpoint
   * exists to prevent.
   */
  @Get()
  @Header('Cache-Control', 'no-store')
  @AllowAnonymous(
    'the effects table is what stops a settings screen implying a preference does something it does not, and the anonymous visitor is the main funnel — a caller with no account gets the empty resource, never anybody else’s',
  )
  async read(@CurrentScope() scope: Scope): Promise<PreferencesResponseWire> {
    const userId = userIdOrNull(scope);
    // Not "read the row for nobody": a null id must never reach a WHERE clause. The empty
    // resource is produced from the same presenter the absent-row case already goes through,
    // so an anonymous answer and "you have no preferences" are one code path and cannot drift.
    return userId === null ? this.profile.empty() : this.profile.read(userId);
  }

  @Put()
  @Header('Cache-Control', 'no-store')
  @RequireAuthenticated()
  async replace(
    @CurrentScope() scope: Scope,
    @Body(new ZodBodyPipe(preferencesRequestSchema)) body: PreferencesRequest,
  ): Promise<PreferencesResponseWire> {
    return this.profile.replace(userIdOf(scope), body);
  }

  /**
   * 200 with the (now empty) resource rather than 204.
   *
   * A screen that just cleared its preferences has to re-render from something, and the
   * something includes `messageLocale` — which changes when the locale goes, because the
   * answer reverts to Thai-by-fallback rather than Thai-by-choice. A 204 would make the client
   * either guess that or issue a second request to find out.
   */
  @Delete()
  @Header('Cache-Control', 'no-store')
  @RequireAuthenticated()
  async clear(@CurrentScope() scope: Scope): Promise<PreferencesResponseWire> {
    return this.profile.clear(userIdOf(scope));
  }
}

/**
 * The signed-in user's id, or a refusal.
 *
 * `RequireAuthenticated` has already refused the guest, the public and the machine, so the
 * three non-`user` branches are unreachable through HTTP. They are written out rather than
 * defaulted because `matchScope` has no `default` — that is the mechanism `scope.ts` exists
 * for, and a `default` here would be the one place in the codebase where "which rows does
 * this reach" fell through to whatever the fallback did.
 *
 * `system` refuses too. A background job has no preferences: it is a process, it reads no
 * screen, and a worker that reached this endpoint would be a worker acting as somebody.
 *
 * ⚠️ **The sentence is a bare string, and that is a stated shortfall rather than a choice.**
 * Every migrated refusal in this API carries a `ServerMessage` key so it can be rendered in
 * the caller's language; the catalogue those keys live in is `src/i18n/message.ts`, which
 * this round does not own. Rather than invent a ninth `error.*` family in a file another
 * round is editing, this reuses `AuthController`'s literal for the same condition — one
 * sentence for "your session is not a session", in one wording — and accepts what
 * `AppError`'s own header says a string costs: an envelope with no `messageKey`,
 * untranslatable and visibly so. The branch is unreachable through HTTP, which is why the
 * cost is affordable and why it must not become the precedent for a reachable one.
 */
const SIGN_IN_AGAIN = 'Sign in again.';

function userIdOf(scope: Scope): string {
  const userId = userIdOrNull(scope);
  if (userId === null) throw AppError.unauthenticated(SIGN_IN_AGAIN);
  return userId;
}

/**
 * The signed-in user's id, or `null` for every other kind of caller.
 *
 * `matchScope` and not `scope.kind === 'user' ? … : null`, because `matchScope` has no
 * `default` — that is the mechanism `scope.ts` exists for, and a ternary here would be the one
 * place in the codebase where "which rows does this reach" fell through to whatever the
 * fallback did. A fifth scope added later is a compile error in this function.
 *
 * `system` answers `null` too. A background job has no preferences: it is a process, it reads
 * no screen, and a worker that reached this endpoint would be a worker acting as somebody.
 */
function userIdOrNull(scope: Scope): string | null {
  return matchScope<string | null>(scope, {
    user: (user) => user.userId,
    guest: () => null,
    public: () => null,
    system: () => null,
  });
}
