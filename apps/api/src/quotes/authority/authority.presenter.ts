import type {
  ApprovalRow,
  AuthorityLimitChangeRow,
  AuthorityLimitRow,
  GroupFacts,
} from './authority.repository';
import type { ApprovalRights } from './approval-rights';
import type { ApprovalQueue, AuthorityAssessment, DimensionAssessment } from './authority.service';
import type { DimensionMeasurement } from './concession';
import type {
  ApprovalQueueWire,
  ApprovalRightsWire,
  ApprovalWire,
  AuthorityAssessmentWire,
  AuthorityGroupWire,
  AuthorityLimitChangeWire,
  AuthorityLimitWire,
  CeilingWire,
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

/**
 * ⭐ Say which of the two `null`s this is, here, once — rather than letting every client
 * reconstruct it from an unrelated field.
 *
 * `DimensionOutcome` already knows: `within_authority` carries the ceiling that covered the
 * concession, `needs_approval` carries `bigint | null` where `null` genuinely means the actor's
 * roles hold no live row, and the other two carry nothing because the answer they give is not
 * about the caller's ceiling at all — `judge` returns before reading the table when nothing has
 * been conceded, and a covered concession is a fact about the *approver's* authority.
 *
 * Flattening all of that into one `string | null` is what produced the bug the browser caught:
 * the dashboard read "the API did not say" as "you have none" and told salespeople they had no
 * authority on every quote with no discount on it. Fixing that on the client left the wire as
 * ambiguous as it was. `known: false` is this function refusing to pretend it looked.
 *
 * ⚠️ `covered_by_approval` is `known: false` on purpose even though `judge` *did* read the
 * ceiling on the way past. It read it, found it did not cover the concession, and then answered
 * a different question. Reporting a ceiling beside "somebody else approved this" would invite
 * exactly the arithmetic — comparing the two — that the approval exists to have already
 * settled. If a screen ever needs the caller's headroom here, it belongs on the outcome first.
 */
function ceilingWire(outcome: DimensionAssessment['outcome'] | undefined): CeilingWire {
  if (outcome === undefined) return { known: false };

  switch (outcome.kind) {
    case 'within_authority':
      return { known: true, thbMinor: outcome.ceilingThbMinor.toString() };
    case 'needs_approval':
      return { known: true, thbMinor: outcome.ceilingThbMinor?.toString() ?? null };
    case 'nothing_conceded':
    case 'covered_by_approval':
      return { known: false };
  }
}

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
    ceiling: ceilingWire(outcome),
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
    /*
     * ⭐ On every response that carries an approval, and not only on the write-off screens.
     *
     * The inbox lists both mechanisms in one table — that is the point of one table — and
     * `concessionThbMinor` means two different things across them: money the customer will not be
     * charged, and money the company will not be paid. A row that did not say which is a figure an
     * approver reads under the wrong heading.
     */
    kind: row.kind,
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

/**
 * ⭐ A ceiling this response **did** consult — so `known` is always true, and `null` means the
 * caller's roles hold no live row at all.
 *
 * Deliberately not `ceilingWire` above. That one answers *"did this outcome look at your
 * ceiling?"* and returns `{ known: false }` on the outcomes that did not. Here the ceiling is
 * read unconditionally, for one dimension, in order to decide whether a button appears — so
 * `{ known: false }` would be a lie about what the server did, and a client that dimmed the
 * approve button on it would be dimming it for the wrong reason. See `CeilingWire`'s own note:
 * `thbMinor: '0'` is a real grant and `null` is the absence of one.
 */
function callerCeilingWire(ceilingThbMinor: bigint | undefined): CeilingWire {
  return { known: true, thbMinor: ceilingThbMinor?.toString() ?? null };
}

export function approvalRightsWire(
  rights: ApprovalRights,
  ceilingThbMinor: bigint | undefined,
): ApprovalRightsWire {
  return {
    mayApprove: rights.mayApprove,
    mayRefuse: rights.mayRefuse,
    because: rights.because,
    ceiling: callerCeilingWire(ceilingThbMinor),
  };
}

export function approvalQueueWire(queue: ApprovalQueue): ApprovalQueueWire {
  return {
    approvals: queue.approvals.map(approvalWire),
    ceilings: {
      margin: callerCeilingWire(queue.ceilings.margin),
      cashflow: callerCeilingWire(queue.ceilings.cashflow),
    },
    withheld: {
      beyondYourAuthority: queue.beyondYourAuthority,
      yourOwnRequests: queue.yourOwnRequests,
    },
    isTruncated: queue.isTruncated,
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
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedByUserId: row.revokedByUserId,
  };
}

export function limitChangeWire(row: AuthorityLimitChangeRow): AuthorityLimitChangeWire {
  return {
    id: row.id,
    groupId: row.groupId,
    groupCode: row.groupCode,
    dimension: row.dimension,
    changedByUserId: row.changedByUserId,
    changedAt: row.changedAt.toISOString(),
    before: row.before,
    after: row.after,
  };
}

/** A role the picker can offer. `GroupFacts` is already exactly this shape — see why there. */
export function groupWire(row: GroupFacts): AuthorityGroupWire {
  return { id: row.id, code: row.code, nameTh: row.nameTh };
}
