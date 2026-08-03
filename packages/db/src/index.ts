/**
 * Types only, like `@wewin/core`'s root.
 *
 * A runtime import here would let `import { products } from '@wewin/db'` pull the pg
 * driver into anything that only wanted a type. Values come from the subpaths:
 * `@wewin/db/schema`, `/client`, `/compile`, `/document`, `/publish`, `/seed`.
 * The export map has no runtime condition for `.`, so this is enforced by Node and not
 * only by review — `import '@wewin/db'` throws ERR_PACKAGE_PATH_NOT_EXPORTED.
 */

export type {
  CatalogDocumentV1,
  DocCustomGroup,
  DocNumExpr,
  DocOptionGroup,
  DocOptionValue,
  DocPriceDelta,
  DocRule,
  DocRuleExpr,
  DocSkuGroup,
  ExactString,
} from './document.js';

export type { AvailabilityLookup } from './compile.js';
export type { Database, Pool } from './client.js';
export type { PublishResult } from './publish.js';
export type { SeedResult } from './seed.js';
