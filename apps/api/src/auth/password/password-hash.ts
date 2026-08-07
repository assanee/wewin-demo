import { Algorithm, hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

/**
 * argon2id, and nothing above it.
 *
 * The whole of this file is "turn a password into a PHC string and back into a yes or no".
 * It knows nothing about users, sessions or HTTP, which is what lets the sign-in path be
 * tested against a fake and this be tested against real work.
 *
 * ── Why argon2id and not the alternatives ────────────────────────────────────────
 *
 * `password_credentials_argon2id` in `packages/db/src/schema/auth.ts` is a CHECK, so the
 * database refuses anything else — this file is the code side of a decision already taken
 * there. Its reasoning, restated because it is the reason and not a preference: argon2id is
 * the memory-hard variant with side-channel resistance, and the thing being protected is a
 * human's choice out of a very small space. bcrypt is not memory-hard and truncates at 72
 * bytes, which for Thai text is about 24 characters — a passphrase would lose its tail
 * silently, and two different passphrases sharing a prefix would become one credential.
 *
 * `@node-rs/argon2` rather than `argon2`: the latter is a node-gyp build, which makes a
 * fresh `pnpm install` depend on a working C++ toolchain. This one ships prebuilt binaries.
 */

export interface Argon2Parameters {
  /** KiB. The parameter that costs a GPU farm the most, and the one to raise first. */
  readonly memoryCost: number;
  /** Passes over memory. */
  readonly timeCost: number;
  readonly parallelism: number;
}

/**
 * Today's cost, and the only place it is written.
 *
 * ⚠️ **Not a plan 13 number** — the business has not been asked how long a sign-in may take,
 * and these are the library's own defaults (19 MiB, 2 passes), which follow OWASP's current
 * minimum for argon2id. They are exported so `needsRehash` and the tests read the same
 * values as `hashPassword`, which is what makes raising them a one-line change that
 * upgrades every existing credential on its owner's next sign-in.
 *
 * The cost is paid on **every** sign-in attempt, including wrong ones, which is what makes
 * `sign-in-throttle.ts` a matter of availability and not only of guessing: 19 MiB per
 * in-flight attempt is the number to think about when choosing that limit.
 */
export const ARGON2ID_PARAMETERS: Argon2Parameters = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

const options = (parameters: Argon2Parameters) => ({
  algorithm: Algorithm.Argon2id,
  memoryCost: parameters.memoryCost,
  timeCost: parameters.timeCost,
  parallelism: parameters.parallelism,
});

/** A PHC string: `$argon2id$v=19$m=…,t=…,p=…$salt$hash`. Salt is generated per call. */
export async function hashPassword(
  password: string,
  parameters: Argon2Parameters = ARGON2ID_PARAMETERS,
): Promise<string> {
  return argonHash(password, options(parameters));
}

/**
 * Whether this password produced this hash.
 *
 * **Every failure is `false`, including a hash that does not parse.** Throwing would let a
 * caller distinguish "wrong password" from "this row is corrupt", and the second answer
 * confirms the account exists — see the test that walks five shapes of rubbish. It also
 * means one malformed row cannot 500 the sign-in endpoint for everybody.
 *
 * There is deliberately **no fast path**. Checking the length, or that the hash begins
 * `$argon2id$`, before doing the work would make a wrong password cheaper than a right one
 * by a measurable margin, and a measurable margin is an oracle. The cost of a wrong answer
 * is the full derivation, on purpose.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(hash, password);
  } catch {
    return false;
  }
}

/** `m=19456,t=2,p=1` out of a PHC string, or `undefined` if it is not one this can read. */
function parametersOf(hash: string): Argon2Parameters | undefined {
  const found = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hash);
  if (found === null) return undefined;

  const [, memory, time, parallel] = found as unknown as [string, string, string, string];
  return { memoryCost: Number(memory), timeCost: Number(time), parallelism: Number(parallel) };
}

/**
 * Whether this stored hash is weaker than what we would write today.
 *
 * Called after a *successful* verification, so the plaintext is in hand exactly once and
 * can be re-hashed at the current cost. That is the entire upgrade mechanism: no migration,
 * no batch job, and no window in which the database holds a plaintext to convert.
 *
 * **Weaker, not different.** A hash written by a newer deployment during a rolling release
 * is stronger, and an older instance must leave it alone rather than downgrade it — hence
 * `<` on each parameter and not `!==`. Parallelism is compared the same way, though it is
 * the one where "more" is not obviously "stronger"; treating a higher value as acceptable
 * keeps the rule "never rewrite what a newer build wrote" true without exception.
 *
 * Anything unparseable answers `true`: unknown parameters are assumed weak. The row still
 * works — `verifyPassword` decides that separately — this only says replace it.
 */
export function needsRehash(hash: string, current: Argon2Parameters = ARGON2ID_PARAMETERS): boolean {
  const stored = parametersOf(hash);
  if (stored === undefined) return true;

  return (
    stored.memoryCost < current.memoryCost ||
    stored.timeCost < current.timeCost ||
    stored.parallelism < current.parallelism
  );
}
