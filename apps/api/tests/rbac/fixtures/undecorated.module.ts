import { Controller, Get, Module } from '@nestjs/common';

/**
 * A controller that carries no rbac decorator and is answered for by the declaration
 * table instead — the arrangement `src/rbac/route-declarations.ts` uses for the phase 3a
 * controllers this round does not own.
 *
 * It is a fixture and not a real controller so that the audit's two failure modes around
 * declarations — stale, and duplicated by a decorator — can be provoked without editing
 * the application's own table.
 */
@Controller('legacy')
export class UndecoratedController {
  @Get('report')
  report(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [UndecoratedController] })
export class UndecoratedModule {}
