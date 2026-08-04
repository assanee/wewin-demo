/**
 * Boot failed because a route's access is not stated anywhere.
 *
 * Shaped like `EnvValidationError` on purpose — same idea, same failure mode, same
 * treatment in main.ts: a list of problems a person can act on, written to stderr,
 * process exits 1. A stack trace through NestFactory would say where the audit runs,
 * which nobody needs to know; the message says which endpoint is unguarded, which is the
 * only fact that matters.
 *
 * This error is *not* the same kind of thing as a permission mismatch against the
 * database. Refusing to boot on a code/database difference breaks rollback (plan 6(d)),
 * so that case warns. Refusing to boot here cannot break a rollback: both halves of the
 * comparison — the routes and their declarations — are compiled into the same artefact,
 * so an artefact that boots once boots forever.
 */
export class RouteAuditError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      [
        'Route audit failed — refusing to start:',
        ...problems.map((problem) => `  - ${problem}`),
        '',
        'Every endpoint must state what it requires. On the handler:',
        "  @RequirePermissions('orders.read')   a signed-in user holding those permissions",
        '  @RequireAuthenticated()              a signed-in user, any permissions',
        "  @AllowAnonymous('why')               deliberately reachable with no principal",
        '',
        'Hiding the menu item is not authorisation. See src/rbac/route-declarations.ts for',
        'the one table that answers for controllers which carry no decorator.',
      ].join('\n'),
    );
    this.name = 'RouteAuditError';
    this.problems = problems;
  }
}
