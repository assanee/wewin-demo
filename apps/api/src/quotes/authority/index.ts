/**
 * What the rest of the application may use from the authority module.
 *
 * ── The one thing the submit path needs, and the order it must be called in ──────
 *
 *     await orders.transaction(async (tx) => {
 *       const order = await lockOrder(tx, orderId);          // 1. the lock, before anything
 *       const document = await pinDocument(tx, order);       // 2. the revision exists
 *       await authority.gate(tx, { orderId, scope });        // 3. throws 409 if it is not allowed
 *       await advance(tx, order, 'awaiting_payment');        // 4. only now
 *     });
 *
 * Step 3 has to come after step 2 because `approvals.order_document_id` is a foreign key —
 * a decision cannot be recorded about a revision that does not exist — and it has to come
 * before step 4 because a quote that is already with the customer cannot be un-sent.
 *
 * `gate` measures the concession **from the rows, itself**, inside the transaction it is
 * handed. It takes no amount from its caller and there is no parameter that changes the
 * figure: a gate that trusted a number passed to it would be a gate with a way past it.
 *
 * ── What is deliberately not exported ────────────────────────────────────────────
 *
 * `AuthorityRepository`, for the reason `payments/schedule/index.ts` gives about its own: a
 * second thing writing `approvals` would be a second opinion about who decided what. The pure
 * measurement is exported because a caller may legitimately want to *show* a concession
 * without deciding anything, and because a second implementation of "how much was conceded" is
 * the failure this whole module exists to prevent.
 */

export { AuthorityModule } from './authority.module';
export {
  AuthorityService,
  AUTHORITY_DIMENSIONS,
  CASHFLOW_FLOOR_BP_DEFAULT,
  type AuthorityAssessment,
  type DimensionAssessment,
  type DimensionOutcome,
} from './authority.service';

export {
  ConcessionIntegrityError,
  CONCESSION_SOURCE_KINDS,
  measureCashflow,
  measureMargin,
  type ConcessionSource,
  type ConcessionSourceKind,
  type DimensionMeasurement,
  type DocumentConcessions,
  type MarginInput,
  type OverrideFacts,
  type QuoteLineFacts,
} from './concession';

export type {
  ApprovalRow,
  AuthorityLimitChangeRow,
  AuthorityLimitRow,
  AuthorityLimitSnapshot,
  AuthorityTx,
} from './authority.repository';

export {
  approvalQuerySchema,
  decideApprovalSchema,
  requestApprovalSchema,
  setAuthorityLimitSchema,
  type ApprovalDetailWire,
  type ApprovalListWire,
  type ApprovalWire,
  type AuthorityAssessmentWire,
  type AuthorityLimitChangeListWire,
  type AuthorityLimitChangeWire,
  type AuthorityLimitListWire,
  type AuthorityLimitSnapshotWire,
  type AuthorityLimitWire,
  type DimensionAssessmentWire,
} from './authority.contract';
