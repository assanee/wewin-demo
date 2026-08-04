/**
 * What the rest of the app imports from the admin surface: the module, and nothing else.
 *
 * The services and the repository are wiring. A feature module that reached for
 * `DraftRepository` would be a second writer to the normalised layer, and the invariant
 * this module rests on — that a draft's stored document is always the compile of its own
 * rows — holds only while there is one.
 *
 * The types are exported for tests, which is the honest reason and worth saying: nothing in
 * `src/` outside this directory uses them.
 */

export { AdminModule } from './admin.module';
export { CatalogAdminService, unpublishedFieldsOf } from './catalog-admin.service';
export { OptionCatalogService } from './option-catalog.service';
export { DraftRepository, type Tx, type VersionRow } from './draft.repository';
export {
  availabilityOf,
  compileDraft,
  compileDraftDocument,
  type CompiledDraft,
  type DraftOptionRow,
  type DraftOptionValueRow,
  type DraftProductRow,
  type DraftRows,
  type DraftRuleRow,
} from './draft-document';
export { translatePostgresError } from './pg-errors';
export { ZodBodyPipe } from './zod-body.pipe';
