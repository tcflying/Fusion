import {
  type RoomConfidenceBand,
  type RoomConfidenceDimensionName,
  type RoomConfidenceDimensionV1,
  type RoomConfidenceSnapshotV1,
  type RoomDissentRecordV1,
  type RoomEvidenceKind,
  type RoomEvidenceRecordV1,
  type RoomGateResultV1,
  type RoomReviewRecordV1,
} from "./room-contracts/evidence.js";
import type { RoomEvidenceId } from "./room-contracts/ids.js";
import { hashRoomValue } from "./room-integrity.js";

export const ROOM_CONFIDENCE_EVALUATOR_CONTRACT_VERSION = 1 as const;

export interface AuthorizedRoomConfidenceCalibrationV1 {
  readonly source: "authorized_outcome_calibration";
  readonly domain: string;
  readonly outcomeCount: number;
  readonly meanAbsoluteError: number;
  readonly observedAt: string;
  readonly evidenceIds: readonly RoomEvidenceId[];
}

export interface RoomConfidenceEvaluationInputV1 {
  readonly contractVersion: typeof ROOM_CONFIDENCE_EVALUATOR_CONTRACT_VERSION;
  readonly id: RoomConfidenceSnapshotV1["id"];
  readonly roomId: RoomConfidenceSnapshotV1["roomId"];
  readonly nodeId: RoomConfidenceSnapshotV1["nodeId"];
  readonly candidateId: RoomConfidenceSnapshotV1["candidateId"];
  readonly methodologyVersion: string;
  readonly computedAt: string;
  readonly requiredEvidenceKinds: readonly RoomEvidenceKind[];
  readonly evidence: readonly RoomEvidenceRecordV1[];
  readonly gateResults: readonly RoomGateResultV1[];
  readonly reviews: readonly RoomReviewRecordV1[];
  readonly dissents: readonly RoomDissentRecordV1[];
  readonly calibration: AuthorizedRoomConfidenceCalibrationV1 | null;
}

/*
FNXC:RoomConfidence 2026-07-19-13:20:
OpenSpec 7.6 requires a versioned, evidence-derived confidence band rather than
a self-reported model score. The evaluator admits only persisted evidence,
hard-gate outcomes, independent reviews, dissents, calibration, and freshness
so every displayed dimension has deterministic, inspectable provenance.
*/
export function evaluateRoomConfidenceSnapshot(
  input: RoomConfidenceEvaluationInputV1,
): RoomConfidenceSnapshotV1 {
  validateInput(input);

  const staleEvidenceIds = sortUnique(
    input.evidence
      .filter((record) => record.expiresAt !== null && Date.parse(record.expiresAt) <= Date.parse(input.computedAt))
      .map((record) => record.id),
  );
  const unresolvedDissents = input.dissents.filter((record) => record.state !== "resolved");
  const unresolvedDissentIds = sortUnique(unresolvedDissents.map((record) => record.id));

  const dimensions: readonly RoomConfidenceDimensionV1[] = Object.freeze([
    dimension(
      "evidence_coverage",
      evidenceCoverageBand(input.requiredEvidenceKinds, input.evidence),
      sortUnique(input.evidence.map((record) => record.id)),
      "Required evidence kinds are checked against the immutable Room evidence ledger.",
    ),
    dimension(
      "evidence_quality",
      evidenceQualityBand(input.evidence),
      sortUnique(input.evidence.map((record) => record.id)),
      "Only retained authoritative evidence with a source hash and collection method contributes.",
    ),
    dimension(
      "validation_strength",
      validationStrengthBand(input.gateResults),
      sortUnique(input.gateResults.flatMap((record) => record.evidenceIds)),
      "Hard deterministic gate outcomes outrank review votes and model claims.",
    ),
    dimension(
      "independent_agreement",
      independentAgreementBand(input.reviews),
      sortUnique(input.reviews.flatMap((record) => record.evidenceIds)),
      "Only reviews explicitly recorded as independent from the producer are counted.",
    ),
    dimension(
      "unresolved_dissent",
      unresolvedDissentBand(unresolvedDissents),
      sortUnique(unresolvedDissents.flatMap((record) => record.evidenceIds)),
      "Open, investigating, and accepted-residual dissent remains visible in the confidence result.",
    ),
    dimension(
      "historical_calibration",
      historicalCalibrationBand(input.calibration),
      input.calibration ? sortUnique(input.calibration.evidenceIds) : [],
      "Calibration requires authorized observed outcomes; model self-reported confidence is excluded.",
    ),
    dimension(
      "freshness",
      freshnessBand(input.evidence, staleEvidenceIds),
      staleEvidenceIds,
      "Evidence expires only through its recorded authoritative freshness boundary.",
    ),
  ]);

  return Object.freeze({
    contractVersion: ROOM_CONFIDENCE_EVALUATOR_CONTRACT_VERSION,
    id: input.id,
    roomId: input.roomId,
    nodeId: input.nodeId,
    candidateId: input.candidateId,
    band: aggregateBand(dimensions.map((entry) => entry.band)),
    methodologyVersion: input.methodologyVersion,
    inputEvidenceHash: hashRoomValue({
      contractVersion: input.contractVersion,
      roomId: input.roomId,
      nodeId: input.nodeId,
      candidateId: input.candidateId,
      methodologyVersion: input.methodologyVersion,
      computedAt: input.computedAt,
      requiredEvidenceKinds: sortUnique(input.requiredEvidenceKinds),
      evidence: [...input.evidence]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((record) => ({
          id: record.id,
          kind: record.kind,
          contentHash: record.contentHash,
          sourceVersionOrHash: record.sourceVersionOrHash,
          capturedAt: record.capturedAt,
          expiresAt: record.expiresAt,
        })),
      gateResults: [...input.gateResults]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((record) => ({ id: record.id, hard: record.hard, status: record.status, evidenceIds: sortUnique(record.evidenceIds) })),
      reviews: [...input.reviews]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((record) => ({
          id: record.id,
          independentFromProducer: record.independentFromProducer,
          verdict: record.verdict,
          evidenceIds: sortUnique(record.evidenceIds),
        })),
      dissents: [...input.dissents]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((record) => ({ id: record.id, severity: record.severity, state: record.state, evidenceIds: sortUnique(record.evidenceIds) })),
      calibration: input.calibration
        ? {
            domain: input.calibration.domain,
            outcomeCount: input.calibration.outcomeCount,
            meanAbsoluteError: input.calibration.meanAbsoluteError,
            observedAt: input.calibration.observedAt,
            evidenceIds: sortUnique(input.calibration.evidenceIds),
          }
        : null,
    }),
    dimensions,
    staleEvidenceIds: Object.freeze(staleEvidenceIds),
    unresolvedDissentIds: Object.freeze(unresolvedDissentIds),
    modelSelfReportExcluded: true,
    computedAt: input.computedAt,
  });
}

function dimension(
  name: RoomConfidenceDimensionName,
  band: RoomConfidenceBand,
  evidenceIds: readonly RoomEvidenceId[],
  rationale: string,
): RoomConfidenceDimensionV1 {
  return Object.freeze({ name, band, evidenceIds: Object.freeze([...evidenceIds]), rationale });
}

function evidenceCoverageBand(
  requiredKinds: readonly RoomEvidenceKind[],
  evidence: readonly RoomEvidenceRecordV1[],
): RoomConfidenceBand {
  if (evidence.length === 0) return "unknown";
  const available = new Set(evidence.map((record) => record.kind));
  return requiredKinds.every((kind) => available.has(kind)) ? "high" : "low";
}

function evidenceQualityBand(evidence: readonly RoomEvidenceRecordV1[]): RoomConfidenceBand {
  if (evidence.length === 0) return "unknown";
  return evidence.every((record) =>
    record.authoritativeSourceRetained
    && isNonEmptyText(record.authoritativeSourceUri)
    && isNonEmptyText(record.sourceVersionOrHash)
    && isNonEmptyText(record.collectionMethod)
    && isNonEmptyText(record.contentHash),
  ) ? "high" : "low";
}

function validationStrengthBand(gates: readonly RoomGateResultV1[]): RoomConfidenceBand {
  const hardGates = gates.filter((record) => record.hard);
  if (hardGates.length === 0) return "unknown";
  return hardGates.every((record) => record.status === "passed") ? "high" : "low";
}

function independentAgreementBand(reviews: readonly RoomReviewRecordV1[]): RoomConfidenceBand {
  const independent = reviews.filter((record) => record.independentFromProducer);
  if (independent.length === 0) return "unknown";
  if (independent.some((record) => record.verdict === "reject" || record.verdict === "repair_required")) {
    return "low";
  }
  if (independent.every((record) => record.verdict === "accept")) {
    return independent.length >= 2 ? "high" : "medium";
  }
  return "unknown";
}

function unresolvedDissentBand(dissents: readonly RoomDissentRecordV1[]): RoomConfidenceBand {
  if (dissents.length === 0) return "high";
  if (dissents.some((record) => record.severity === "critical" || record.severity === "major")) return "low";
  return "medium";
}

function historicalCalibrationBand(
  calibration: AuthorizedRoomConfidenceCalibrationV1 | null,
): RoomConfidenceBand {
  if (!calibration) return "unknown";
  if (calibration.outcomeCount >= 20 && calibration.meanAbsoluteError <= 0.1) return "high";
  if (calibration.outcomeCount >= 10 && calibration.meanAbsoluteError <= 0.2) return "medium";
  return "low";
}

function freshnessBand(
  evidence: readonly RoomEvidenceRecordV1[],
  staleEvidenceIds: readonly RoomEvidenceId[],
): RoomConfidenceBand {
  if (evidence.length === 0) return "unknown";
  return staleEvidenceIds.length === 0 ? "high" : "low";
}

function aggregateBand(bands: readonly RoomConfidenceBand[]): RoomConfidenceBand {
  if (bands.includes("low")) return "low";
  if (bands.includes("unknown")) return "unknown";
  if (bands.includes("medium")) return "medium";
  return "high";
}

function validateInput(input: RoomConfidenceEvaluationInputV1): void {
  if (input.contractVersion !== ROOM_CONFIDENCE_EVALUATOR_CONTRACT_VERSION) {
    throw new Error("Room confidence evaluator contract version is unsupported");
  }
  requireText(input.id, "confidence snapshot id");
  requireText(input.roomId, "room id");
  requireText(input.nodeId, "node id");
  requireText(input.methodologyVersion, "methodology version");
  const computedAtMs = parseCanonicalTimestamp(input.computedAt, "computedAt");
  if (new Set(input.requiredEvidenceKinds).size !== input.requiredEvidenceKinds.length) {
    throw new Error("Required evidence kinds must be unique");
  }
  const evidenceIds = new Set<string>();
  const evidenceById = new Map<string, RoomEvidenceRecordV1>();
  for (const record of input.evidence) {
    validateEvidenceScope(record, input);
    if (evidenceIds.has(record.id)) throw new Error(`Duplicate Room evidence id ${record.id}`);
    evidenceIds.add(record.id);
    evidenceById.set(record.id, record);
    parseCanonicalTimestamp(record.capturedAt, `evidence ${record.id} capturedAt`);
    if (Date.parse(record.capturedAt) > computedAtMs) {
      throw new Error(`Room evidence ${record.id} was captured after confidence computation`);
    }
    if (record.expiresAt !== null) parseCanonicalTimestamp(record.expiresAt, `evidence ${record.id} expiresAt`);
  }
  const gateIds = new Set<string>();
  for (const record of input.gateResults) {
    validateCandidateScope(record.roomId, record.nodeId, record.candidateId, input, `gate ${record.id}`);
    if (gateIds.has(record.id)) throw new Error(`Duplicate Room gate id ${record.id}`);
    gateIds.add(record.id);
    assertEvidenceReferences(record.evidenceIds, evidenceById, `gate ${record.id}`);
    parseCanonicalTimestamp(record.recordedAt, `gate ${record.id} recordedAt`);
  }
  const reviewIds = new Set<string>();
  for (const record of input.reviews) {
    validateCandidateScope(record.roomId, record.nodeId, record.candidateId, input, `review ${record.id}`);
    if (reviewIds.has(record.id)) throw new Error(`Duplicate Room review id ${record.id}`);
    reviewIds.add(record.id);
    assertEvidenceReferences(record.evidenceIds, evidenceById, `review ${record.id}`);
    parseCanonicalTimestamp(record.committedAt, `review ${record.id} committedAt`);
  }
  const dissentIds = new Set<string>();
  for (const record of input.dissents) {
    validateCandidateScope(record.roomId, record.nodeId, record.candidateId, input, `dissent ${record.id}`);
    if (dissentIds.has(record.id)) throw new Error(`Duplicate Room dissent id ${record.id}`);
    dissentIds.add(record.id);
    assertEvidenceReferences(record.evidenceIds, evidenceById, `dissent ${record.id}`);
    parseCanonicalTimestamp(record.updatedAt, `dissent ${record.id} updatedAt`);
  }
  if (input.calibration) validateCalibration(input.calibration, evidenceById, computedAtMs);
}

function validateEvidenceScope(record: RoomEvidenceRecordV1, input: RoomConfidenceEvaluationInputV1): void {
  if (record.roomId !== input.roomId || record.nodeId !== input.nodeId) {
    throw new Error(`Room evidence ${record.id} is outside the confidence scope`);
  }
  if (input.candidateId !== null && record.candidateId !== null && record.candidateId !== input.candidateId) {
    throw new Error(`Room evidence ${record.id} belongs to a different candidate`);
  }
}

function validateCandidateScope(
  roomId: string,
  nodeId: string,
  candidateId: string,
  input: RoomConfidenceEvaluationInputV1,
  label: string,
): void {
  if (input.candidateId === null) throw new Error(`${label} requires a candidate-scoped confidence snapshot`);
  if (roomId !== input.roomId || nodeId !== input.nodeId || candidateId !== input.candidateId) {
    throw new Error(`${label} is outside the confidence scope`);
  }
}

function validateCalibration(
  calibration: AuthorizedRoomConfidenceCalibrationV1,
  evidenceById: ReadonlyMap<string, RoomEvidenceRecordV1>,
  computedAtMs: number,
): void {
  if (calibration.source !== "authorized_outcome_calibration") {
    throw new Error("Room confidence calibration source is not authorized");
  }
  requireText(calibration.domain, "calibration domain");
  if (!Number.isSafeInteger(calibration.outcomeCount) || calibration.outcomeCount < 0) {
    throw new Error("Room confidence calibration outcome count must be a non-negative safe integer");
  }
  if (!Number.isFinite(calibration.meanAbsoluteError) || calibration.meanAbsoluteError < 0 || calibration.meanAbsoluteError > 1) {
    throw new Error("Room confidence calibration mean absolute error must be between zero and one");
  }
  if (parseCanonicalTimestamp(calibration.observedAt, "calibration observedAt") > computedAtMs) {
    throw new Error("Room confidence calibration was observed after confidence computation");
  }
  assertEvidenceReferences(calibration.evidenceIds, evidenceById, "calibration");
}

function assertEvidenceReferences(
  evidenceIds: readonly RoomEvidenceId[],
  evidenceById: ReadonlyMap<string, RoomEvidenceRecordV1>,
  label: string,
): void {
  for (const evidenceId of evidenceIds) {
    if (!evidenceById.has(evidenceId)) throw new Error(`${label} references unknown Room evidence ${evidenceId}`);
  }
}

function parseCanonicalTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return parsed;
}

function requireText(value: string, label: string): void {
  if (!isNonEmptyText(value)) throw new Error(`${label} must be a non-empty canonical string`);
}

function isNonEmptyText(value: string): boolean {
  return value.length > 0 && value.trim() === value;
}

function sortUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
