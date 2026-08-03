import pg from 'pg';

/**
 * Postgres `bigint` must arrive as a JavaScript `bigint`.
 *
 * node-postgres hands back int8 as a *string* by default, on the reasoning that a caller
 * who wants a number can call Number(). That default is exactly wrong for this codebase:
 * money is bigint minor units and lengths are bigint micrometres (plan 4.1, 4.3), so the
 * two obvious things to do with that string — `Number(x)` or leaving it as a string that
 * compares and adds like a string — are both silent corruption. `'900' + 100n` throws,
 * but `'900' + '100'` is `'900100'` and nothing complains.
 *
 * Known consequence: `count(*)` is int8, so counts come back as bigint too. That is the
 * correct end of the trade. A caller that wants a number writes `Number(count)` and says
 * so; nobody accidentally rounds a satang total at 2^53.
 */

type TypeParser = (value: string) => unknown;

const parseInt8 = (value: string): bigint => BigInt(value);

/*
 * Scoped to the pool we create rather than pg's global registry: a global
 * `setTypeParser` would also reach any other pg client in the process — a migration
 * runner, a test helper — and change its behaviour from a distance.
 */
export const bigintAwareTypes: pg.CustomTypesConfig = {
  getTypeParser(oid, format) {
    if (oid === pg.types.builtins.INT8 && format !== 'binary') {
      return parseInt8;
    }
    // pg-types declares this `any`; naming the shape here is the only place the cast
    // belongs, rather than letting `any` spread into every column we read.
    return pg.types.getTypeParser(oid, format) as TypeParser;
  },
};
