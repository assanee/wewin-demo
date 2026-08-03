/** Injection token for the shared `pg.Pool`. */
export const PG_POOL = Symbol('wewin.pgPool');

/**
 * Injection token for the Drizzle handle built on that pool.
 *
 * Both exist because they answer different questions. The pool owns connection lifetime
 * and is what a liveness probe's raw `select 1` uses; the Drizzle handle is what every
 * catalogue query goes through, and it carries the schema — including
 * `bigint({ mode: 'bigint' })`, which is a separate mechanism from the pool's int8 type
 * parser and the one that governs a typed query's result. One pool underneath either
 * way, so both are subject to the same pool size and the same statement timeout.
 */
export const DRIZZLE = Symbol('wewin.drizzle');
