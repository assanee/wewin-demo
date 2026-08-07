import { Module, type DynamicModule, type ModuleMetadata } from '@nestjs/common';

import { SessionService } from '../session/session.service';
import { SESSION_STARTER } from '../password/session-starter';
import { PASSWORD_CREDENTIAL_STORE, PasswordRepository } from '../password/password.repository';
import { SECOND_FACTOR, type SecondFactor } from '../password/second-factor';
import { MfaChallengeService } from './challenge';
import { MfaAccountController } from './mfa-account.controller';
import { MfaAdminController } from './mfa-admin.controller';
import { MfaController } from './mfa.controller';
import { MfaRepository } from './mfa.repository';
import { AuditRepository } from '../../users/audit.repository';
import { MfaEnrolmentService } from './mfa-enrolment.service';
import { MfaSignInService } from './mfa-sign-in.service';
import { MFA_THROTTLE, makeMfaThrottle } from './mfa-throttle';
import { MFA_SECRET_BOX } from './mfa.tokens';
import { SecretBox, parseMfaKey } from './secret-box';

/**
 * The second factor.
 *
 * ── ⚠️ Why this takes `SessionModule` and not `PasswordModule` ───────────────
 *
 * `PasswordModule` needs `SECOND_FACTOR` — step one has to ask whether step two applies —
 * and this module needs `SESSION_STARTER`, which is `SessionService`. Importing
 * `PasswordModule` here to get it would close a cycle and Nest would refuse to boot.
 *
 * So both reach past each other to the same place: `AuthModule` builds one
 * `SessionModule.forRoot(config)` and hands the *same instance* to both. The reason that
 * matters is the one `AuthModule` already records — two `forRoot` calls compile, boot, and
 * sign access tokens with two different keys.
 *
 * ── The key ──────────────────────────────────────────────────────────────────
 *
 * `AUTH_MFA_SECRET_KEY` is parsed at boot, not at first use. A wrong-length key otherwise
 * throws inside `createCipheriv` at the moment somebody enrols — days after the deploy, as a
 * 500 with a stack trace naming a crypto call rather than a setting.
 */
export interface MfaModuleOptions {
  /** The one `SessionModule.forRoot(...)` the application shares. */
  readonly imports?: ModuleMetadata['imports'];
  /** base64url, 32 bytes. See `parseMfaKey`. */
  readonly secretKey: string;
}

/**
 * The adapter `PasswordModule` sees.
 *
 * A class rather than an object literal so Nest can inject into it, and deliberately thin:
 * everything it knows is "is the gate up" and "make me a token", which is the whole width of
 * the seam. Any more and `PasswordModule` would start to depend on how MFA works.
 */
class MfaSecondFactor implements SecondFactor {
  constructor(
    private readonly repository: MfaRepository,
    private readonly challenges: MfaChallengeService,
  ) {}

  async isRequired(userId: string): Promise<boolean> {
    const credential = await this.repository.findCredential(userId);

    /* `confirmed_at`, not the row's existence — an abandoned enrolment is not a gate. */
    return credential?.confirmedAt != null;
  }

  challenge(userId: string): { readonly token: string; readonly expiresAt: Date } {
    return this.challenges.issue(userId);
  }
}

@Module({})
export class MfaModule {
  static forRoot(options: MfaModuleOptions): DynamicModule {
    return {
      module: MfaModule,
      imports: options.imports ?? [],
      controllers: [MfaController, MfaAccountController, MfaAdminController],
      providers: [
        MfaRepository,
        AuditRepository,
        MfaChallengeService,
        MfaSignInService,
        MfaEnrolmentService,
        PasswordRepository,
        { provide: PASSWORD_CREDENTIAL_STORE, useExisting: PasswordRepository },
        { provide: SESSION_STARTER, useExisting: SessionService },
        {
          provide: MFA_SECRET_BOX,
          useFactory: () => new SecretBox(parseMfaKey(options.secretKey)),
        },
        {
          /* One instance per process — which is what makes the counters mean anything. */
          provide: MFA_THROTTLE,
          useFactory: makeMfaThrottle,
        },
        {
          provide: SECOND_FACTOR,
          useFactory: (repository: MfaRepository, challenges: MfaChallengeService) =>
            new MfaSecondFactor(repository, challenges),
          inject: [MfaRepository, MfaChallengeService],
        },
      ],
      /* `SECOND_FACTOR` is what `PasswordModule` imports this module for. */
      exports: [SECOND_FACTOR, MfaRepository],
    };
  }
}
