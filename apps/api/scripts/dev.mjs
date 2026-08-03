import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * `pnpm dev` for this app has to do three things, and none of them is interesting enough
 * to justify a dependency:
 *
 *   1. bring Postgres up, because an API with no database is a health endpoint that says
 *      "degraded" and nothing else,
 *   2. compile, because Node cannot run TypeScript with decorators — type stripping only
 *      handles erasable syntax and `emitDecoratorMetadata` is the opposite of erasable,
 *   3. restart on rebuild.
 *
 * @nestjs/cli would cover 2 and 3, at the cost of compiling with the `typescript` version
 * bundled inside the CLI rather than the workspace's. See package.json.
 */

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const tsc = require.resolve('typescript/bin/tsc');

/** Docker not being up is a nuisance, not a reason to refuse to start the compiler. */
const dockerExit = await run('docker', ['compose', 'up', '-d', '--wait'], { allowFailure: true });
if (dockerExit !== 0) {
  process.stderr.write('\n[dev] Postgres did not start. Run `pnpm db:up` once Docker is available.\n\n');
}

// One blocking compile first: `node --watch` on a dist/ that does not exist yet spends its
// first seconds printing MODULE_NOT_FOUND at whoever just ran the command.
await run(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { allowFailure: true });

const children = [
  spawn(process.execPath, [tsc, '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'], {
    cwd: appDir,
    stdio: 'inherit',
  }),
  spawn(process.execPath, ['--watch', '--enable-source-maps', 'dist/main.js'], {
    cwd: appDir,
    stdio: 'inherit',
  }),
];

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    for (const child of children) {
      child.kill(signal);
    }
  });
}

// If either half dies on its own, take the other with it — a compiler watching nothing or
// a server nobody is rebuilding is worse than a clean exit.
for (const child of children) {
  child.on('exit', (code) => {
    if (stopping) {
      return;
    }
    stopping = true;
    for (const sibling of children) {
      if (sibling !== child) {
        sibling.kill('SIGTERM');
      }
    }
    process.exitCode = code ?? 1;
  });
}

function run(command, args, { allowFailure = false } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: appDir, stdio: 'inherit' });
    child.on('error', (error) => {
      if (allowFailure) {
        // `docker` not being installed reads the same as `docker` failing, from here.
        resolvePromise(1);
        return;
      }
      rejectPromise(error);
    });
    child.on('exit', (code) => {
      if (code === 0 || allowFailure) {
        resolvePromise(code ?? 0);
      } else {
        rejectPromise(new Error(`${command} exited with ${String(code)}`));
      }
    });
  });
}
