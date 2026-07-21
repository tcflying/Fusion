import type {
  ContentHash,
  IsoTimestamp,
  RoomArtifactId,
  RoomBindingId,
  RoomCandidateId,
  RoomConfidenceSnapshotId,
  RoomDissentId,
  RoomEvidenceId,
  RoomGateResultId,
  RoomId,
  RoomPromotionId,
  RoomProtocolId,
  RoomReviewId,
  RoomTaskNodeId,
} from "./ids.js";
import type { RoomEvidenceContractVersion } from "./versions.js";

export const ROOM_CONFIDENCE_BANDS = ["high", "medium", "low", "unknown"] as const;

export const ROOM_CONFIDENCE_DIMENSIONS = [
  "evidence_coverage",
  "evidence_quality",
  "validation_strength",
  "independent_agreement",
  "unresolved_dissent",
  "historical_calibration",
  "freshness",
] as const;

export type RoomConfidenceBand = (typeof ROOM_CONFIDENCE_BANDS)[number];
export type RoomConfidenceDimensionName = (typeof ROOM_CONFIDENCE_DIMENSIONS)[number];
export type RoomEvidenceKind =
  | "test"
  | "schema"
  | "policy"
  | "source"
  | "runtime"
  | "user_constraint"
  | "review"
  | "operator_decision"
  | "artifact";
export type RoomGateKind = "test" | "schema" | "policy" | "source" | "runtime" | "user_constraint";
export type RoomGateStatus = "passed" | "failed" | "error" | "not_run";
export type RoomCandidatePromotionState = "pending" | "eligible" | "promoted" | "rejected" | "superseded";

export interface RoomArtifactRecordV1 {
  readonly contractVersion: RoomEvidenceContractVersion;
  readonly id: RoomArtifactId;
  readonly roomId: RoomId;
  readonly nodeId: RoomTaskNodeId;
  readonly candidateId: RoomCandidateId | null;
  readonly kind: "code" | "document" | "dataset" | "log" | "report" | "media" | "other";
  readonly mediaType: string;
  readonly uri: string;
  readonly contentHash: ContentHash;
  readonly producingBindingId: RoomBindingId | null;
  readonly sourceRevision: string | null;
  readonly sizeBytes: number | null;
  readonly immutable: true;
  readonly createdAt: IsoTimestamp;
}

export interface RoomEvidenceRecordV1 {
  readonly contractVersion: RoomEvidenceContractVersion;
  readonly id: RoomEvidenceId;
  readonly roomId: RoomId;
  readonly nodeId: RoomTaskNodeId;
  readonly candidateId: RoomCandidateId | null;
  readonly kind: RoomEvidenceKind;
  readonly authoritativeSourceUri: string;
  readonly sourceVersionOrHash: string;
  readonly capturedAt: IsoTimestamp;
  readonly collectionMethod: string;
  readonly collectorBindingId: RoomBindingId | null;
  readonly contentHash: ContentHash;
  readonly artifactIds: readonly RoomArtifactId[];
  readonly authoritativeSourceRetained: true;
  readonly expiresAt: IsoTimestamp | null;
}

/*
FNXC:SessionRoomEvidence 2026-07-17-03:02:
Candidate provenance keeps provider-native and Happier identities separate so
blind review can hide producers without destroying the authorized audit trail.
*/
export interface RoomCandidateRecordV1 {
  readonly contractVersion: RoomEvidenceContractVersion;
  readonly id: RoomCandidateId;
  readonly roomId: RoomId;
  readonly nodeId: RoomTaskNodeId;
  readonly producingBindingId: RoomBindingId;
  readonly nativeSessionId: string;
  readonly happierSessionId: string;
  readonly providerId: string;
  readonly modelRef: string;
  readonly protocolId: RoomProtocolId;
  readonly protocolVersion: number;
  readonly contextVersion: string;
  readonly inputVersion: string;
  readonly configVersion: string;
  readonly contentHash: ContentHash;
  readonly artifactIds: readonly RoomArtifactId[];
  readonly parentCandidateIds: readonly RoomCandidateId[];
  readonly gateResultIds: readonly RoomGateResultId[];
  readonly reviewIds: readonly RoomReviewId[];
  readonly promotionState: RoomCandidatePromotionState;
  readonly createdAt: IsoTimestamp;
}

export interface RoomReviewRecordV1 {
  readonly contractVersion: RoomEvidenceContractVersion;
  readonly id: RoomReviewId;
  readonly roomId: RoomId;
  readonly nodeId: RoomTaskNodeId;
  readonly candidateId: RoomCandidateId;
  readonly blindCandidateRef: string;
  readonly reviewerBindingId: RoomBindingId;
  readonly reviewerNativeSessionId: string;
  readonly reviewerHappierSessionId: string;
  readonly blind: boolean;
  readonly producerIdentityHidden: boolean;
  readonly independentFromProducer: boolean;
  readonly verdict: "accept" | "repair_required" | "reject" | "abstain";
  readonly rubricVersion: string;
  readonly evidenceIds: readonly RoomEvidenceId[];
  readonly dissentIds: readonly RoomDissentId[];
  readonly reviewContentHash: ContentHash;
  readonly committedAt: IsoTimestamp;
}

export interface RoomDissentResolutionV1 {
  readonly kind: "resolved" | "disproved" | "operator_accepted_residual";
  readonly actorId: string;
  readonly evidenceIds: readonly RoomEvidenceId[];
  readonly rationale: string;
  readonly resolvedAt: IsoTimestamp;
}

export interface RoomDissentRecordV1 {
  readonly contractVersion: RoomEvidenceContractVersion;
  readonly id: RoomDissentId;
  readonly roomId: RoomId;
  readonly nodeId: RoomTaskNodeId;
  readonly candidateId: RoomCandidateId;
  readonly reviewId: RoomReviewId | null;
  readonly severity: "info" | "minor" | "major" | "critical";
  readonly state: "open" | "investigating" | "resolved" | "accepted_residual";
  readonly ownerId: string;
  readonly evidenceIds: readonly RoomEvidenceId[];
  readonly contentHash: ContentHash;
  readonly resolution: RoomDissentResolutionV1 | null;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface RoomGateResultV1 {
  readonly contractVersion: RoomEvidenceContractVersion;
  readonly id: RoomGateResultId;
  readonly roomId: RoomId;
  readonly nodeId: RoomTaskNodeId;
  readonly candidateId: RoomCandidateId;
  readonly profileId: string;
  readonly kind: RoomGateKind;
  readonly hard: boolean;
  readonly status: RoomGateStatus;
  readonly evidenceIds: readonly RoomEvidenceId[];
  readonly evaluatorBindingId: RoomBindingId | null;
  readonly command: string | null;
  readonly exitCode: number | null;
  readonly recordedAt: IsoTimestamp;
}

export interface RoomPromotionRecordV1 {
  readonly contractVersion: RoomEvidenceContractVersion;
  readonly id: RoomPromotionId;
  readonly roomId: RoomId;
  readonly nodeId: RoomTaskNodeId;
  readonly candidateId: RoomCandidateId;
  readonly decision: "promoted" | "rejected" | "escalated";
  readonly decisionActorType: "controller" | "independent_arbiter" | "human_operator";
  readonly decisionActorId: string;
  readonly hardGateResultIds: readonly RoomGateResultId[];
  readonly reviewIds: readonly RoomReviewId[];
  readonly unresolvedDissentIds: readonly RoomDissentId[];
  readonly evidenceIds: readonly RoomEvidenceId[];
  readonly rationale: string;
  readonly decidedAt: IsoTimestamp;
}

export interface RoomConfidenceDimensionV1 {
  readonly name: RoomConfidenceDimensionName;
  readonly band: RoomConfidenceBand;
  readonly evidenceIds: readonly RoomEvidenceId[];
  readonly rationale: string;
}

export interface RoomConfidenceSnapshotV1 {
  readonly contractVersion: RoomEvidenceContractVersion;
  readonly id: RoomConfidenceSnapshotId;
  readonly roomId: RoomId;
  readonly nodeId: RoomTaskNodeId;
  readonly candidateId: RoomCandidateId | null;
  readonly band: RoomConfidenceBand;
  readonly methodologyVersion: string;
  readonly inputEvidenceHash: ContentHash;
  readonly dimensions: readonly RoomConfidenceDimensionV1[];
  readonly staleEvidenceIds: readonly RoomEvidenceId[];
  readonly unresolvedDissentIds: readonly RoomDissentId[];
  readonly modelSelfReportExcluded: true;
  readonly computedAt: IsoTimestamp;
}

export function canCandidatePassHardGates(gateResults: readonly RoomGateResultV1[]): boolean {
  const hardGateResults = gateResults.filter((result) => result.hard);
  return hardGateResults.length > 0 && hardGateResults.every((result) => result.status === "passed");
}
