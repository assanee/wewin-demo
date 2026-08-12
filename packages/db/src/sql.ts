/**
 * The query-builder vocabulary, re-exported so there is exactly one of it.
 *
 * Not a convenience. `apps/api` is CommonJS under `module: nodenext`, so its own
 * `import { eq } from 'drizzle-orm'` resolves drizzle's **require** declarations, while
 * the tables it is comparing come from this package, which is ESM and resolves drizzle's
 * **import** declarations. TypeScript treats the two as different nominal types — the
 * error names a private field, `SQL<unknown> is not assignable to SQL<unknown> … separate
 * declarations of a private property 'shouldInlineParams'` — and no amount of casting
 * makes them one type, because they genuinely are not.
 *
 * Routing the operators through this file means the schema and the operators used
 * against it arrive from a single resolution of drizzle, which is also the honest
 * statement of the dependency: apps/api talks to Postgres through @wewin/db's drizzle,
 * not through a second copy it picked itself.
 *
 * Only what a caller actually needs is listed. `export *` would re-export the whole ORM
 * from a package whose export map exists to keep the surface small.
 */

export { and, asc, count, desc, eq, gt, inArray, max, or, sql } from 'drizzle-orm';
export type { SQL } from 'drizzle-orm';
