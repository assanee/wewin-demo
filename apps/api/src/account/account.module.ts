import { Module } from '@nestjs/common';

import { AccountController } from './account.controller';
import { AccountRepository } from './account.repository';
import { AccountService } from './account.service';

/**
 * A person's own account settings.
 *
 * A plain `@Module` and not a `forRoot`: it reaches only the database, through `DRIZZLE`
 * from the global `DatabaseModule`. Nothing here needs the session module — changing a
 * password revokes rows directly rather than through `SessionService`, because the
 * revocation is one UPDATE and routing it through a service that mints tokens would be
 * borrowing an object for the one method that does not mint anything.
 */
@Module({
  controllers: [AccountController],
  providers: [AccountService, AccountRepository],
})
export class AccountModule {}
