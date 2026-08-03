# @wewin/api

NestJS service. Phase 3a: it boots, it reports health, and it serves the published
catalogue out of Postgres.

## Running it

```bash
cp ../../.env.example ../../.env   # DATABASE_URL — one file at the workspace root
pnpm dev                      # docker compose up, tsc --watch, node --watch
curl localhost:3000/health
```

`pnpm dev` starts Postgres for you. If Docker is not running it says so and keeps going —
the API boots regardless and reports `degraded` until the database answers.

The `.env` search walks up from this directory to the workspace root and stops there, so the
root file is enough; `apps/api/.env` still wins if this app needs a database the rest of the
workspace should not have. Anything already exported wins over both — `process.loadEnvFile`
fills gaps, it does not overwrite.

| script | what it does |
| --- | --- |
| `pnpm dev` | Postgres + compile-on-change + restart-on-change |
| `pnpm build` / `pnpm start` | `tsc` to `dist/`, then plain `node dist/main.js` |
| `pnpm test` | compiles, then Vitest. Set `DATABASE_URL` to include the Postgres suite |
| `pnpm typecheck` / `pnpm lint` | `tsc --noEmit`, `oxlint` |
| `pnpm db:up` / `db:down` / `db:reset` / `db:logs` / `db:psql` | the **root** `docker-compose.yml`, host port 5433 |

There is one compose file and it is at the repository root. Phase 3a briefly had two — one
here on 5432 and one in `packages/db` on 5433 — which is how an API answers `/health` against
a database that has no tables. `DATABASE_URL` must name the server the migrations were
applied to, and with one file it does.

## Endpoints

| route | answers |
| --- | --- |
| `GET /health/live` | is the process alive? Touches nothing external — a liveness probe that fails during a database outage gets the process killed for someone else's problem |
| `GET /health/ready` | should traffic come here? `200` or `503`, and the body names the failing check |
| `GET /health` | the same report, for humans |
| `GET /meta` | what is running, and the wire conventions: lengths are micrometres, amounts are minor units. `catalog.counts` is queried from Postgres, and is `null` — never `0` — when the database does not answer |
| `GET /catalog/products` | every published product, each with the `productVersionId` + `documentHash` it must be priced against |
| `GET /catalog/products/:slug` | one of them, `404` when it has no published version |
| `GET /catalog/categories` | the ten categories |

Catalogue responses are built by `@wewin/contract`'s encoders, never by hand, so every exact
quantity carries its own unit: `{"unit":"um","digits":"3200000"}`, `{"unit":"THB.satang/m2",
"digits":"150000"}`. A bare number on this wire would be a number somebody divides by a
million. `x-wewin-contract-version` says which reading is in force.

`tests/catalog-fidelity.pg.test.ts` is the proof that the move to Postgres lost nothing: it
seeds, reads all 81 products back over HTTP, and compares each to `@wewin/core/fixtures` with
`toStrictEqual`. Its last block mutates a row and asserts that the comparison goes red, so
the suite is known to be capable of failing.

Errors are one shape everywhere:

```json
{ "error": { "code": "NOT_FOUND", "message": "…", "requestId": "…", "path": "/x", "timestamp": "…" } }
```

`code` is the part clients branch on; `message` is prose that will be translated in phase 6.
Every response carries `x-request-id`, echoed from the caller when it looks safe to log and
generated otherwise.

## CommonJS here, ESM in `@wewin/core`

The interesting problem in this app, and the one that does not solve itself.

`@wewin/core` is `"type": "module"` with a subpath-only export map. This app cannot be ESM:
Nest resolves constructor dependencies from `design:paramtypes`, which only
`emitDecoratorMetadata` produces, which only the TypeScript compiler emits — decorators are
not erasable syntax, so Node's built-in type stripping cannot run this code at all.

What works, and what was actually verified:

- **`module: nodenext` + no `"type"` field.** tsc emits `require("@wewin/core/money")` and
  permits it, because Node ≥ 22.12 can `require()` a synchronous ESM graph. The alternatives
  do not compile: `module: commonjs` rejects the import outright, and `moduleResolution:
  node10` cannot see subpath exports at all (and is an error in TypeScript 6).
- **The debt:** core must never gain a top-level `await`. One would turn every
  `require('@wewin/core/*')` here into `ERR_REQUIRE_ASYNC_MODULE` at boot. There is none
  today — `grep -rn 'await' packages/core/dist` finds nothing at module scope.
- **The guard:** `tests/esm-bridge.test.ts` reads the emitted JavaScript, asserts the
  `require()` calls are there, and then executes it in a real CommonJS process. Vitest alone
  proves nothing here — it resolves everything as ESM, so a passing `import` inside the test
  runner says nothing about `node dist/main.js`.
- `src/meta/catalog-source.ts` and `src/catalog/catalog.repository.ts` are the production
  users of that bridge — both `require()` ESM-only packages (`@wewin/core/money`,
  `@wewin/db/*`, `@wewin/contract/*`) at module load, so a break in the arrangement stops
  this app at boot rather than in a rarely-hit branch.
- `catalog-source.ts` used to import `@wewin/core/fixtures` and report
  `{"source":"fixtures","productCount":81}`. That was honest until `src/catalog/` started
  reading Postgres, at which point /meta would have gone on reporting 81 products from the
  TS table with an empty database underneath it. It counts the database now, and nothing in
  the request path imports the fixtures — `tests/esm-bridge.test.ts` asserts the compiled
  output does not mention them, because if it did, the fidelity suite would be comparing
  the fixture table to itself.

## Two decisions worth knowing about

**No `@nestjs/cli`.** It carries its own `typescript` dependency, so `nest build` would
compile with a different compiler than `pnpm typecheck` runs — and the rule in this repo is
that what CI type-checks is what production runs. `scripts/dev.mjs` covers what
`nest start --watch` did, in forty lines and with the workspace's compiler.

**Vitest transforms with SWC, not esbuild.** esbuild understands `experimentalDecorators`
but cannot emit `emitDecoratorMetadata` — it does no type resolution. Under esbuild every
provider injected by class type fails to resolve, and the workaround (an explicit
`@Inject()` on every constructor parameter) lets the test runner dictate production style.

## `bigint`, not a string that looks like one

node-postgres hands back `int8` as a **string** by default. `src/database/pg-types.ts`
replaces that parser on this pool, so money (minor units) and lengths (micrometres) arrive
as `bigint`. Accepted consequence: `count(*)` is a `bigint` too. A caller that wants a
number writes `Number(...)` and says so; nobody rounds a satang total at 2^53 by accident.

`tests/database.pg.test.ts` proves it against a real server, including the negative — a pool
built without that parser returns `'9223372036854775807'` as a string — so a future
simplification that drops it fails a test.

## Shutdown

`SIGTERM` → `HealthService` flips readiness to `draining` **while the socket is still
open**, waits `SHUTDOWN_GRACE_MS`, then Nest closes the server and `DatabaseService` ends
the pool. The order is the point: a load balancer needs to see a failing probe before the
port disappears.
