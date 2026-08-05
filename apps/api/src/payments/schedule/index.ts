/**
 * What the rest of the application may use from the instalment schedule.
 *
 * The service is the wiring. The pure functions are exported because other rounds have to
 * *read* the decisions in them rather than re-derive them: `scheduledDepositMinor` is the
 * ceiling every forfeit is bounded by (plan 7.13), and a second implementation of it is the
 * ฿12,902 difference that seam exists to close.
 *
 * `ScheduleRepository` is deliberately not here. A second thing writing `order_instalments`
 * would be a second opinion about what is locked.
 */

export { ScheduleModule } from './schedule.module';
export { ScheduleService, type RecomputeResult, type ScheduleContext } from './schedule.service';

export {
  BP_DENOMINATOR,
  FREEZE_GATE_STATUS,
  GATE_COVERAGE_BP_DEFAULT,
  MAX_INSTALMENTS,
  SCHEDULE_EDITABLE_STATUSES,
} from './defaults';

export {
  cashflowConcessionMinor,
  gatedPrefixMinor,
  isLocked,
  percentOf,
  planSchedule,
  recomputeSchedule,
  scheduledDepositMinor,
  type PlannedInstalment,
  type SchedulePlan,
  type SchedulePlanFailure,
  type ScheduleRow,
} from './plan';

export {
  basisOf,
  depositFixedTerms,
  depositPercentTerms,
  payInFullTerms,
  termFromWire,
  type ScheduleTerm,
} from './terms';

export {
  notEditableError,
  scheduleExistsError,
  scheduleFailureError,
  scheduleHasMoneyError,
} from './errors';
