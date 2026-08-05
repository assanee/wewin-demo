import type { ApprovalRow, AuthorityLimitRow } from './authority.repository';
import type { AuthorityAssessment, DimensionAssessment } from './authority.service';
import type { DimensionMeasurement } from './concession';
import type {
  ApprovalWire,
  AuthorityAssessmentWire,
  AuthorityLimitWire,
  DimensionAssessmentWire,
} from './authority.contract';

/**
 * Rows to wire, in one place.
 *
 * Its own file because both controllers need it and neither should own it: a serialiser that
 * lives in a controller is a serialiser that gets a second copy the day a second controller
 * needs it, and two of these would eventually disagree about whether a `bigint` is a string.
 *
 * Every amount leaves as a decimal string. `JSON.stringify` cannot serialise a `bigint` at
 * all — it throws — so this is not a style preference, it is the boundary where the choice has
 * to be made, and making it once means it is made the same way everywhere.
 */

function measurementWire(
  measurement: DimensionMeasurement,
  outcome: DimensionAssessment['outcome'] | undefined,
): DimensionAssessmentWire {
  return {
    dimension: measurement.dimension,
    concessionThbMinor: measurement.concessionThbMinor.toString(),
    sources: measurement.sources.map((source) => ({
      kind: source.kind,
      amountThbMinor: source.amountThbMinor.toString(),
      quoteLineId: source.quoteLineId,
      overrideId: source.overrideId,
      reasonCode: source.reasonCode,
    })),
    outcome: outcome?.kind ?? 'unassessed',
    ceilingThbMinor:
      outcome === undefined
        ? null
        : outcome.kind === 'within_authority'
          ? outcome.ceilingThbMinor.toString()
          : outcome.kind === 'needs_approval' && outcome.ceilingThbMinor !== null
            ? outcome.ceilingThbMinor.toString()
            : null,
    approvalId:
      outcome === undefined
        ? null
        : outcome.kind === 'covered_by_approval'
          ? outcome.approvalId
          : outcome.kind === 'needs_approval'
            ? outcome.pendingApprovalId
            : null,
  };
}

export function dimensionWire(assessment: DimensionAssessment): DimensionAssessmentWire {
  return measurementWire(assessment.measurement, assessment.outcome);
}

/** A measurement with nobody's authority applied to it — the approver's "what does it concede now". */
export function bareMeasurementWire(measurement: DimensionMeasurement): DimensionAssessmentWire {
  return measurementWire(measurement, undefined);
}

export function assessmentWire(assessment: AuthorityAssessment): AuthorityAssessmentWire {
  return {
    orderId: assessment.orderId,
    orderNo: assessment.orderNo,
    quoteRevision: assessment.quoteRevision,
    margin: dimensionWire(assessment.margin),
    cashflow: dimensionWire(assessment.cashflow),
    allowed: assessment.allowed,
  };
}

export function approvalWire(row: ApprovalRow): ApprovalWire {
  return {
    id: row.id,
    orderId: row.orderId,
    orderNo: row.orderNo,
    orderDocumentId: row.orderDocumentId,
    documentRevision: row.documentRevision,
    quoteRevision: row.quoteRevision,
    dimension: row.dimension,
    status: row.status,
    concessionThbMinor: row.concessionThbMinor.toString(),
    reasonTh: row.reasonTh,
    requestedByUserId: row.requestedByUserId,
    requestedByName: row.requestedByName,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNoteTh: row.decisionNoteTh,
    decidedCeilingThbMinor: row.decidedCeilingThbMinor?.toString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function limitWire(row: AuthorityLimitRow): AuthorityLimitWire {
  return {
    groupId: row.groupId,
    groupCode: row.groupCode,
    groupNameTh: row.groupNameTh,
    dimension: row.dimension,
    maxConcessionThbMinor: row.maxConcessionThbMinor.toString(),
    grantedByUserId: row.grantedByUserId,
    updatedAt: row.updatedAt.toISOString(),
    noteTh: row.noteTh,
  };
}
