import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { createDatabase, createPool } from '@wewin/db/client';
import { eq, sql } from '@wewin/db/sql';
import {
  groupPermissions,
  groups,
  passwordCredentials,
  permissions,
  userEmails,
  userGroups,
  users,
} from '@wewin/db/schema';

import { hashPassword } from '../auth/password/password-hash';
import { loadEnvFileIfPresent } from '../config/env';
import { assertPasswordAcceptable } from '../auth/password/password.contract';
import { PERMISSION_CODES, PERMISSIONS, type PermissionCode } from '../rbac/permissions';

/**
 * Create a staff account that can sign in with a password.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────
 *
 * Chicken and egg. `users.read` and `users.write` have no routes — `account-status.ts` says
 * so and treats it as a known gap — so there is no screen that creates the first account,
 * and until there is, a fresh checkout has no way into the dashboard at all. Before password
 * sign-in that meant registering a real OAuth application with Google just to look at the
 * admin UI on a laptop.
 *
 * It is deliberately a **script and not an endpoint**. An endpoint that mints an
 * all-permissions account is a permanent hole that has to be defended for ever; a script is
 * something a person runs on a machine they already control, with a shell they already have.
 * When the user-administration surface exists, this stays as the bootstrap and stops being
 * the only way.
 *
 * ── ⚠️ Refuses to run against production ─────────────────────────────────────────
 *
 * `NODE_ENV=production` is refused outright unless `I_MEAN_IT=yes` is also set. The account
 * this writes can approve discounts, publish prices and moderate reviews; "I ran the wrong
 * terminal" must not be enough to create one on a live database.
 *
 *     pnpm --filter @wewin/api create-user -- somchai@wewin.co.th
 *     pnpm --filter @wewin/api create-user -- somchai@wewin.co.th --permissions catalog.read,orders.read
 *
 * The password is **prompted for, never an argument** — a password on a command line is in
 * the shell history, in `ps` output for every user on the box, and often in a shipped log.
 */

interface Options {
  readonly email: string;
  readonly permissions: readonly PermissionCode[];
  readonly groupCode: string;
  readonly groupNameTh: string;
}

function usage(problem: string): never {
  process.stderr.write(
    `${problem}\n\n` +
      'Usage: create-user <email> [--permissions a.b,c.d] [--group code] [--name "ชื่อกลุ่ม"]\n' +
      `Permissions: ${PERMISSION_CODES.join(', ')}\n`,
  );
  process.exit(2);
}

function parse(argv: readonly string[]): Options {
  const positional = argv.filter((argument) => !argument.startsWith('--'));
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? undefined : argv[at + 1];
  };

  const email = positional[0]?.trim().toLowerCase();
  if (email === undefined || !email.includes('@')) usage('An email address is required.');

  const requested = flag('permissions');
  const codes =
    requested === undefined
      ? PERMISSION_CODES
      : requested.split(',').map((code) => code.trim()).filter((code) => code.length > 0);

  const unknown = codes.filter((code) => !PERMISSION_CODES.includes(code as PermissionCode));
  if (unknown.length > 0) usage(`Unknown permission(s): ${unknown.join(', ')}`);

  /*
   * `groups_code_shape` is `^[a-z][a-z0-9_]*$` — underscores, no hyphens. Checked here so a
   * typo is a usage message rather than a CHECK violation printed as a failed INSERT after
   * the password has already been typed twice. (The first default was `bootstrap-staff`,
   * which is exactly the mistake this now catches.)
   */
  const groupCode = flag('group') ?? 'bootstrap_staff';
  if (!/^[a-z][a-z0-9_]*$/.test(groupCode)) {
    usage(`A group code must match ^[a-z][a-z0-9_]*$ — "${groupCode}" does not.`);
  }

  /*
   * `groups.name_th` is NOT NULL and is what every screen shows — the permissions table, the
   * authority-ceiling role picker, the user's own group list. It used to be hard-coded to
   * "ผู้ดูแลระบบตั้งต้น" for whatever `--group` was passed, which was harmless while this script only
   * ever made the one bootstrap group and actively misleading the moment it made a second: a
   * `finance_manager` row reading "ผู้ดูแลระบบตั้งต้น" in the ceiling picker is a ceiling granted to a
   * role nobody can identify.
   */
  const groupNameTh = flag('name')?.trim() ?? 'ผู้ดูแลระบบตั้งต้น';
  if (groupNameTh.length === 0) usage('--name cannot be empty.');

  return { email, permissions: codes as readonly PermissionCode[], groupCode, groupNameTh };
}

/**
 * The password, from the environment if it is there and from a prompt otherwise.
 *
 * ⚠️ **`WEWIN_BOOTSTRAP_PASSWORD` is for a container start-up or a CI fixture, and it is the
 * lesser of the automatable evils.** An environment variable is visible to the process and
 * to anybody who can read `/proc`, which is bad; a command-line argument is all of that
 * *plus* the shell history and `ps` output for every user on the box, which is worse. There
 * is deliberately no `--password` flag.
 *
 * Interactively it prompts twice and the input is **echoed**. Hiding it portably means
 * muting the output stream and restoring it on every exit path including a signal, and a
 * bootstrap script that leaves a terminal with echo off is a worse outcome than a password
 * visible to somebody already sitting at the machine.
 */
async function readPassword(): Promise<string> {
  const fromEnvironment = process.env['WEWIN_BOOTSTRAP_PASSWORD'];
  if (fromEnvironment !== undefined && fromEnvironment.length > 0) return fromEnvironment;

  /*
   * `terminal: stdin.isTTY` — not `true`. With a pipe on stdin, a readline in terminal mode
   * consumes the whole buffer on the first question and the second one then waits for input
   * that has already been read, which hangs the script with no output. Found by piping two
   * lines into it and watching it stop after "Again:".
   */
  const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY === true });
  try {
    const password = await rl.question('Password (visible): ');
    const again = await rl.question('Again: ');
    if (password !== again) usage('The two passwords did not match.');
    return password;
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production' && process.env['I_MEAN_IT'] !== 'yes') {
    usage('Refusing to create a staff account on a production database. Set I_MEAN_IT=yes.');
  }

  /*
   * The same walk-up-to-the-workspace-root search `src/config/env.ts` does for the server.
   * Turbo does not pass `.env` through to a task — the README records that trap costing a
   * phase — so a script that trusted `process.env` alone would exit 2 on every fresh
   * checkout with a `.env` sitting right there.
   */
  loadEnvFileIfPresent(__dirname);
  const url = process.env['DATABASE_URL'];
  if (url === undefined) usage('DATABASE_URL is not set, and no .env was found above this file.');

  const options = parse(process.argv.slice(2));
  const password = await readPassword();
  // The same rule the future change-password screen will apply — checked here rather than
  // discovered later, so a bootstrap account cannot be weaker than the policy allows.
  assertPasswordAcceptable(password);
  const passwordHash = await hashPassword(password);

  const pool = createPool(url);
  const db = createDatabase(pool);

  try {
    await db.transaction(async (tx) => {
      /*
       * `PermissionSyncService` writes these at boot, but this script may well be the first
       * thing that ever runs against a fresh database — before the API has started once —
       * and a group row pointing at a permission that does not exist yet is a foreign-key
       * failure with a confusing message. Same list, same source.
       */
      await tx
        .insert(permissions)
        .values(PERMISSION_CODES.map((code) => ({ code, description: PERMISSIONS[code] })))
        .onConflictDoNothing();

      const existing = await tx
        .select({ userId: userEmails.userId })
        .from(userEmails)
        .where(eq(userEmails.address, options.email))
        .limit(1);

      let userId = existing[0]?.userId;

      if (userId === undefined) {
        const [created] = await tx
          .insert(users)
          .values({ displayName: options.email.split('@')[0] ?? options.email })
          .returning({ id: users.id });
        if (created === undefined) throw new Error('could not create the user row');
        userId = created.id;

        /*
         * `verifiedAt` is set here, and it is the one line in this file that deserves a
         * second thought. The sign-in path requires a *verified* address on purpose —
         * `user_emails_one_verified_owner` is what stops somebody claiming an address they
         * do not control — and this script asserts that verification on the operator's
         * behalf. That is legitimate for an account being created by whoever administers
         * the database, and it is exactly what must never be reachable from a public
         * endpoint. `user_emails_primary_is_verified` is why the two flags move together.
         */
        await tx
          .insert(userEmails)
          .values({ userId, address: options.email, isPrimary: true, verifiedAt: new Date() });
      }

      // Idempotent on the credential too: running this again is how a forgotten bootstrap
      // password is changed, which is the operation an operator will actually want.
      await tx
        .insert(passwordCredentials)
        .values({ userId, passwordHash })
        .onConflictDoUpdate({
          target: passwordCredentials.userId,
          set: { passwordHash, updatedAt: new Date() },
        });

      /*
       * ⚠️ The conflict branch keeps the name the group already has — `sql\`groups.name_th\`` is
       * the *existing* row in an ON CONFLICT DO UPDATE, where `excluded.name_th` would be the one
       * being proposed. It reads like a pointless self-assignment and is not: DO NOTHING returns
       * no row, so `returning` would hand back `undefined` for every group that already exists and
       * the script would fail on its second run. This shape is the one way to get the id back
       * without writing anything.
       *
       * It also closes a real hazard. This is a bootstrap script an operator points at an existing
       * database to reset a forgotten password; before this, doing so silently renamed whatever
       * group was passed to "ผู้ดูแลระบบตั้งต้น". A rename is invisible in an audit trail that
       * records permission grants, and `groups.code` — the thing every guard reads — never moved,
       * so nothing would have failed. Only a human reading the ceiling picker would notice.
       */
      const [group] = await tx
        .insert(groups)
        .values({ code: options.groupCode, nameTh: options.groupNameTh })
        .onConflictDoUpdate({ target: groups.code, set: { nameTh: sql`groups.name_th` } })
        .returning({ id: groups.id });
      if (group === undefined) throw new Error('could not create the group row');

      await tx
        .insert(groupPermissions)
        .values(options.permissions.map((code) => ({ groupId: group.id, permissionCode: code })))
        .onConflictDoNothing();

      await tx.insert(userGroups).values({ userId, groupId: group.id }).onConflictDoNothing();

      // Reinstate an account this script is being pointed at deliberately. Without it,
      // "I locked myself out" has no answer at all, since nothing else can move a status.
      await tx.execute(
        sql`update users set status = 'active', suspended_at = null
             where id = ${userId}::uuid and status = 'suspended'`,
      );

      process.stdout.write(
        `\n${existing.length > 0 ? 'Updated' : 'Created'} ${options.email}\n` +
          `  user id     ${userId}\n` +
          `  group       ${options.groupCode}\n` +
          `  group name  ${options.groupNameTh}  (kept as-is if the group already existed)\n` +
          `  permissions ${options.permissions.join(', ')}\n\n` +
          'Sign in at the dashboard, or:\n' +
          `  curl -s localhost:3000/auth/password -H 'content-type: application/json' \\\n` +
          `    -d '{"email":"${options.email}","password":"…"}'\n`,
      );
    });
  } finally {
    await pool.end();
  }
}

/*
 * `void main()` and not top-level await: `apps/api` compiles to CommonJS (see
 * `tests/esm-interop.test.ts`, which pins that), so a top-level await here is a compile
 * error rather than a runtime surprise. The rejection handler is what turns a thrown error
 * into a non-zero exit — without it Node prints the stack and still exits 0, which in a
 * bootstrap script reads as "the account was created".
 */
void main().catch((error: unknown) => {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
