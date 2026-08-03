import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';

import { HealthService } from './health.service';
import type { HealthReport, LivenessReport } from './health.types';

/*
 * Three endpoints because they answer three different questions:
 *   /health/live   is the process alive?          restart me if not
 *   /health/ready  should traffic come here?      route around me if not
 *   /health        what is wrong?                 for humans and dashboards
 *
 * The 503 bodies are health reports rather than the standard error envelope: a probe is
 * not a failed API call, and a load balancer reading `checks.database.error` should not
 * have to dig through an error wrapper to find it.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  async overall(@Res({ passthrough: true }) response: Response): Promise<HealthReport> {
    const report = await this.health.report();
    response.status(this.health.isReady(report) ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }

  @Get('live')
  live(): LivenessReport {
    return this.health.liveness();
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response): Promise<HealthReport> {
    const report = await this.health.report();
    response.status(this.health.isReady(report) ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
