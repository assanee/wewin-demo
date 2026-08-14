/**
 * What the rest of the app imports from payment slips: the module, and the pure functions.
 *
 * `SlipsService` and `SlipsRepository` are wiring, and they are not here for the reason
 * `src/orders/index.ts` gives about its own two: a feature module that reached for either
 * would be a second thing deciding when money has arrived, and the invariants this round
 * rests on — the order is locked before the slip, the allocations foot before they are
 * written, the gate is evaluated on both sides of the write, the transition goes through
 * the one door — hold only while there is one path through it.
 *
 * The pure functions *are* exported, because the neighbouring 5b modules need to read those
 * decisions rather than re-derive them: a refund's ceiling starts from what `planAllocations`
 * was willing to accept, and anything that wants to know what an instalment still owes must
 * use `remainingOf` rather than subtracting two columns and getting a negative.
 */

export { SlipsModule, type SlipsModuleOptions } from './slips.module';

/** The per-order ceiling on slips — a default this module chose; see the service. */
export { MAX_SLIPS_PER_ORDER_DEFAULT } from './slips.service';

export {
  planAllocations,
  remainingOf,
  suggestAllocations,
  thbMinor,
  type AllocationPlan,
  type CheckAllocationsInput,
  type InstalmentForAllocation,
  type Suggestion,
} from './allocations';

export {
  IMAGE_GRANT_TTL_SECONDS,
  UPLOAD_HANDLE_TTL_SECONDS,
  mintGrantKey,
  mintImageGrant,
  mintUploadHandle,
  verifyImageGrant,
  verifyUploadHandle,
  type GrantClaims,
  type GrantFailure,
  type GrantResult,
  type ImageGrantClaims,
  type UploadClaims,
} from './slip-grant';

export { parseSlipStorageConfig, type SlipStorageConfig } from './slip-storage.config';

export { translateSlipError, withTranslatedSlipErrors } from './slip-errors';

export type {
  AcceptSlipRequestWire,
  AcceptSlipResultWire,
  AllocationRequestWire,
  CreateSlipRequestWire,
  InstalmentSummaryWire,
  OrderTransitionWire,
  /* ⭐ The evidence-free payment and the audit list that makes it answerable — 0047. */
  RecordSlipRequestWire,
  RecordedSlipActorWire,
  RecordedSlipEntryWire,
  RecordedSlipListWire,
  RejectSlipRequestWire,
  RejectSlipResultWire,
  SlipAllocationWire,
  SlipImageGrantWire,
  SlipImageUploadWire,
  SlipListWire,
  SlipOrderMoneyWire,
  SlipQueueWire,
  SlipReviewWire,
  SlipWire,
} from './slips.contract';
