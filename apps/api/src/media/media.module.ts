import { Module, type DynamicModule } from '@nestjs/common';

import { MediaAdminController } from './media-admin.controller';
import { MediaController } from './media.controller';
import { MediaRepository } from './media.repository';
import { MediaService } from './media.service';
import { MEDIA_CONFIG } from './media.tokens';
import { parseMediaConfig, type MediaConfig } from './media.config';
import { ObjectStorage } from './storage/object-storage';

export interface MediaModuleOptions {
  /**
   * Omitted means this module parses `process.env` itself, exactly as `OAuthModule` does.
   *
   * Tests that care about the bucket pass their own; the rest get the local compose
   * defaults, which is what makes `bootApp()` work on a machine with no storage running —
   * nothing here connects at construction time.
   */
  readonly config?: MediaConfig;
}

/**
 * Images: upload, storage, serving.
 *
 * It imports nothing, on the same terms as `AdminModule`: `DatabaseModule` is `@Global` so
 * `DRIZZLE` is in scope, and `RbacModule` binds its guard over the whole graph — so both
 * controllers here are enforced and audited whether or not this module knows either exists.
 * The public serving route says `@AllowAnonymous` with a reason, which the boot audit prints;
 * that is the review surface for the one route in this feature that anybody can reach.
 *
 * Nothing is exported. The catalogue does not call into here — it stores a path string, and
 * the coupling between the two layers is that string and the trigger that protects it
 * (packages/db/src/schema/media.ts). A `CatalogAdminService` that imported `MediaService` to
 * "validate the hero image exists" would look like an improvement and would be the beginning
 * of the media table becoming a second, disagreeing answer to what a product shows.
 */
@Module({})
export class MediaModule {
  static forRoot(options: MediaModuleOptions = {}): DynamicModule {
    return {
      module: MediaModule,
      controllers: [MediaAdminController, MediaController],
      providers: [
        {
          provide: MEDIA_CONFIG,
          useValue: options.config ?? parseMediaConfig(process.env),
        },
        MediaService,
        MediaRepository,
        ObjectStorage,
      ],
    };
  }
}
