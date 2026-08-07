import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db';
import { passwordCredentials, userPhones, users } from '@wewin/db/schema';

import { AppError } from '../../common/errors/app-error';
import { DRIZZLE } from '../../database/database.tokens';
import { message } from '../../i18n';
import type { IssuedSession } from '../session/session.service';
import { assertPasswordAcceptable } from './password.contract';
import { hashPassword } from './password-hash';
import { SESSION_STARTER, type SessionStarter } from './session-starter';
import { normaliseUsername } from './username';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE FIRST WAY TO GET AN ACCOUNT WITHOUT ASKING SOMEBODY.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Until this, an account came from OAuth, an administrator, or the CLI. A Thai customer with
 * no email address had no way to have one at all.
 *
 * ── ⚠️ A telephone number only, and the refusal is the honest part ───────────
 *
 * An address is refused, which reads like an omission. It is not.
 *
 * **Email verification is not implemented.** No route redeems the `email_verification` token
 * purpose, and `findByVerifiedEmail` requires `verified_at` — so an account registered with
 * an address would be one nobody could ever sign into. That is precisely the dead end
 * phone-as-username was built to remove, and accepting an address here would recreate it one
 * field over, silently, for whoever tried it first.
 *
 * The day a verification email exists, deleting that refusal is the change.
 *
 * ── ⭐ Registering signs you in ──────────────────────────────────────────────
 *
 * No verification step, and `verified_at` stays null. `user_phones` splits the two questions
 * at length: *which account claimed this* is answered by `user_phones_number_key`, and needs
 * no proof; *does it really belong to them* needs one, costs money to obtain, and gates being
 * found by number rather than getting in.
 *
 * ── One transaction, and it has to be ────────────────────────────────────────
 *
 * ⚠️ Three rows: the user, the claim, the credential. A route that wrote them one at a time
 * and failed in the middle would leave an account with no password and — worse — a claim on a
 * number **nobody can now register**, since the claim is unique. A validation error would
 * have produced a denial of service.
 */

const UNIQUE_VIOLATION = '23505';

/**
 * The driver's SQLSTATE, however deeply it has been wrapped.
 *
 * ⚠️ **Drizzle rethrows as `DrizzleQueryError`, which carries no `code`** and keeps the real
 * error on `.cause`. Reading `error.code` off the top answers `undefined` for every
 * constraint — so the collision below would reach the caller as an untranslated 500: the
 * index fired, the data is safe, and the person is told nothing they can act on.
 *
 * Written out here rather than imported from `quotes/pg-errors.ts`, whose translator maps
 * *quote* constraint names to *quote* messages. Importing it for one SQLSTATE would pull an
 * unrelated vocabulary into `auth`; the ten lines are the smaller debt, and both copies carry
 * the same warning so neither can be simplified away in ignorance of the other.
 */
function sqlStateOf(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; depth < 8; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;

    if ('code' in current) {
      const { code } = current as { code: unknown };
      if (typeof code === 'string') return code;
    }

    current = 'cause' in current ? (current as { cause: unknown }).cause : undefined;
  }

  return undefined;
}

export interface RegistrationRequest {
  /** As typed. Normalised here, once, so the stored value and the sign-in lookup agree. */
  readonly username: string;
  readonly password: string;
  readonly userAgent?: string | undefined;
  readonly address: string;
}

@Injectable()
export class RegistrationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(SESSION_STARTER) private readonly sessions: SessionStarter,
  ) {}

  async register(request: RegistrationRequest): Promise<IssuedSession> {
    const username = normaliseUsername(request.username);

    if (username.kind !== 'phone') {
      /*
       * ⚠️ Named `phone-only` rather than "invalid", because the two cases behind it are
       * different and a person can act on one of them: an address is refused *for now*, and a
       * fragment is refused because it is not a number. The sentence says both.
       *
       * Unlike sign-in, saying so is safe here. Registration cannot avoid telling somebody
       * whether it accepted their input — a form that refuses silently is a form nobody can
       * complete — and what is disclosed is a rule, not whether an account exists.
       */
      throw AppError.validationFailed(message('error.auth.register_phone_only'), {
        reason: 'phone-only',
      });
    }

    /* Before any row is written, so a weak password costs nothing and leaves nothing. */
    assertPasswordAcceptable(request.password);
    const passwordHash = await hashPassword(request.password);

    const userId = await this.db
      .transaction(async (tx) => {
        const [user] = await tx.insert(users).values({}).returning({ id: users.id });
        if (!user) throw new Error('registration: the user row was not returned');

        /*
         * ⚠️ `verified_at` null and `is_primary` false. Registering is a claim, not a proof —
         * and `user_phones_primary_is_verified` would refuse the row anyway, which is the
         * schema keeping this method honest rather than this method remembering.
         */
        await tx.insert(userPhones).values({ userId: user.id, number: username.key });
        await tx.insert(passwordCredentials).values({ userId: user.id, passwordHash });

        return user.id;
      })
      .catch((error: unknown) => {
        /*
         * ⭐ The collision, caught from the constraint rather than checked for first.
         *
         * A `SELECT … WHERE number = ?` before the INSERT is a window: two registrations for
         * one number can both find nothing and both proceed, and the loser gets a 500. The
         * unique index is the only thing that decides this correctly, so it is what is asked.
         */
        if (sqlStateOf(error) === UNIQUE_VIOLATION) {
          throw AppError.conflict(message('error.auth.number_already_registered'), {
            reason: 'number-already-registered',
          });
        }
        throw error;
      });

    return this.sessions.start({
      userId,
      userAgent: request.userAgent ?? null,
      ip: request.address,
    });
  }
}
