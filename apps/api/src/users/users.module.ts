import { Module, type DynamicModule, type ModuleMetadata } from '@nestjs/common';

import { UsersController } from './users.controller';
import { AuditRepository } from './audit.repository';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

/**
 * User administration.
 *
 * ⚠️ `forRoot({ imports: [auth] })`, and the argument is the *same* `AuthModule` instance
 * `AppModule` built — the third module in this codebase to need that shape, for the reason
 * `PasswordModule` records: a second `AuthModule.forRoot(...)` would build a second session
 * key, and here it would also build a second `PasswordResetService` with its own throttle
 * counters. `AuthModule` re-exports the password module so `PasswordResetService` resolves
 * through this graph.
 *
 * `UsersService` needs it for one thing: sending a colleague the same set-password link the
 * login page sends. A second implementation of that would be a second one-shot token scheme
 * to keep correct.
 */
export interface UsersModuleOptions {
  /** The one `AuthModule.forRoot(...)` the application shares. */
  readonly imports?: ModuleMetadata['imports'];
}

@Module({})
export class UsersModule {
  static forRoot(options: UsersModuleOptions = {}): DynamicModule {
    return {
      module: UsersModule,
      imports: options.imports ?? [],
      controllers: [UsersController],
      providers: [UsersService, UsersRepository, AuditRepository],
    };
  }
}
