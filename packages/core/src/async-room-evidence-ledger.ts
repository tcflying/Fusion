import {
  type RoomArtifactRecordV1,
  type RoomCandidateRecordV1,
  type RoomConfidenceSnapshotV1,
  type RoomDissentRecordV1,
  type RoomEvidenceRecordV1,
  type RoomGateResultV1,
  type RoomPromotionRecordV1,
  type RoomReviewRecordV1,
} from "./room-contracts/evidence.js";
import { ROOM_CONTRACT_VERSIONS } from "./room-contracts/versions.js";
import type {
  ContentHash,
  IsoTimestamp,
  ProjectId,
  RoomArtifactId,
  RoomBindingId,
  RoomCandidateId,
  RoomConfidenceSnapshotId,
  RoomDissentId,
  RoomEvidenceId,
  RoomGateResultId,
  RoomId,
  RoomPromotionId,
  RoomReviewId,
  RoomTaskNodeId,
} from "./room-contracts/ids.js";
import {
  evaluateRoomConfidenceSnapshot,
  type AuthorizedRoomConfidenceCalibrationV1,
} from "./room-confidence.js";
import { compareRoomText } from "./room-integrity.js";

const CANONICAL_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const CANONICAL_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

const ROOM_ARTIFACT_KINDS = ["code", "document", "dataset", "log", "report", "media", "other"] as const;
const ROOM_EVIDENCE_KINDS = [
  "test",
  "schema",
  "policy",
  "source",
  "runtime",
  "user_constraint",
  "review",
  "operator_decision",
  "artifact",
] as const;
const ROOM_GATE_KINDS = ["test", "schema", "policy", "source", "runtime", "user_constraint"] as const;
const ROOM_GATE_STATUSES = ["passed", "failed", "error", "not_run"] as const;
const ROOM_REVIEW_VERDICTS = ["accept", "repair_required", "reject", "abstain"] as const;
const ROOM_PROMOTION_DECISIONS = ["promoted", "rejected", "escalated"] as const;
const ROOM_PROMOTION_ACTOR_TYPES = ["controller", "independent_arbiter", "human_operator"] as const;
const ROOM_DISSENT_SEVERITIES = ["info", "minor", "major", "critical"] as const;
const ROOM_DISSENT_STATES = ["open", "investigating", "resolved", "accepted_residual"] as const;

export interface RoomEvidenceLedgerScope {
  readonly projectId: ProjectId;
  readonly roomId: RoomId;
}

export type RoomEvidenceLedgerTable =
  | "room_artifacts"
  | "room_evidence"
  | "room_candidates"
  | "room_reviews"
  | "room_dissents"
  | "room_gate_results"
  | "room_promotions"
  | "room_confidence_snapshots";

export type RoomEvidenceLedgerEntry =
  | { readonly table: "room_artifacts"; readonly record: RoomArtifactRecordV1 }
  | { readonly table: "room_evidence"; readonly record: RoomEvidenceRecordV1 }
  | { readonly table: "room_candidates"; readonly record: RoomCandidateRecordV1 }
  | { readonly table: "room_reviews"; readonly record: RoomReviewRecordV1 }
  | { readonly table: "room_dissents"; readonly record: RoomDissentRecordV1 }
  | { readonly table: "room_gate_results"; readonly record: RoomGateResultV1 }
  | { readonly table: "room_promotions"; readonly record: RoomPromotionRecordV1 }
  | { readonly table: "room_confidence_snapshots"; readonly record: RoomConfidenceSnapshotV1 };

export interface RoomEvidenceLedgerReferenceQuery {
  readonly scope: RoomEvidenceLedgerScope;
  readonly artifactIds: readonly RoomArtifactId[];
  readonly evidenceIds: readonly RoomEvidenceId[];
  readonly candidateIds: readonly RoomCandidateId[];
  readonly reviewIds: readonly RoomReviewId[];
  readonly dissentIds: readonly RoomDissentId[];
  readonly gateResultIds: readonly RoomGateResultId[];
}

/**
 * A production persistence adapter resolves all requested IDs inside the same
 * transaction as the later append. It must return exactly the requested rows,
 * scoped to the supplied project and Room, in canonical ID order.
 */
export interface RoomEvidenceLedgerReferenceSnapshot {
  readonly scope: RoomEvidenceLedgerScope;
  readonly artifacts: readonly RoomArtifactRecordV1[];
  readonly evidence: readonly RoomEvidenceRecordV1[];
  readonly candidates: readonly RoomCandidateRecordV1[];
  readonly reviews: readonly RoomReviewRecordV1[];
  readonly dissents: readonly RoomDissentRecordV1[];
  readonly gateResults: readonly RoomGateResultV1[];
}

/**
 * The persistence implementation must use INSERT-only semantics. A conflict
 * means the primary key already exists; it must never be converted into an
 * update or upsert by the adapter.
 */
export type RoomEvidenceLedgerAppendOutcome =
  | { readonly status: "inserted"; readonly recordId: string }
  | { readonly status: "conflict"; readonly recordId: string };

export interface RoomEvidenceLedgerCandidateEvaluation {
  readonly scope: RoomEvidenceLedgerScope;
  readonly candidate: RoomCandidateRecordV1;
  readonly gateResults: readonly RoomGateResultV1[];
  readonly reviews: readonly RoomReviewRecordV1[];
  readonly dissents: readonly RoomDissentRecordV1[];
  readonly promotions: readonly RoomPromotionRecordV1[];
}

export interface RoomEvidenceLedgerTransaction {
  resolveReferences(input: RoomEvidenceLedgerReferenceQuery): Promise<RoomEvidenceLedgerReferenceSnapshot>;
  loadCandidateEvaluation(input: {
    readonly scope: RoomEvidenceLedgerScope;
    readonly candidateId: RoomCandidateId;
  }): Promise<RoomEvidenceLedgerCandidateEvaluation | null>;
  append(input: {
    readonly scope: RoomEvidenceLedgerScope;
    readonly entry: RoomEvidenceLedgerEntry;
  }): Promise<RoomEvidenceLedgerAppendOutcome>;
}

/**
 * This is deliberately a transactional persistence seam, rather than an
 * in-memory collection. A Drizzle/PostgreSQL adapter can bind it directly to
 * the existing Room tables without exposing table mutation to callers.
 */
export interface RoomEvidenceLedgerPersistence {
  transaction<TResult>(
    operation: (transaction: RoomEvidenceLedgerTransaction) => Promise<TResult>,
  ): Promise<TResult>;
}

export type RoomEvidenceLedgerImmutable<T> = T extends readonly (infer TEntry)[]
  ? readonly RoomEvidenceLedgerImmutable<TEntry>[]
  : T extends object
    ? { readonly [TKey in keyof T]: RoomEvidenceLedgerImmutable<T[TKey]> }
    : T;

export interface RoomEvidenceLedgerAppendResult<
  TTable extends RoomEvidenceLedgerTable,
  TRecord,
> {
  readonly table: TTable;
  readonly record: RoomEvidenceLedgerImmutable<TRecord>;
}

export interface AppendRoomArtifactInputV1 {
  readonly scope: RoomEvidenceLedgerScope;
  readonly id: RoomArtifactId;
  readonly nodeId: RoomTaskNodeId;
  readonly candidateId: RoomCandidateId | null;
  readonly kind: RoomArtifactRecordV1["kind"];
  readonly mediaType: string;
  readonly uri: string;
  readonly contentHash: ContentHash;
  readonly producingBindingId: RoomBindingId | null;
  readonly sourceRevision: string | null;
  readonly sizeBytes: number | null;
  readonly createdAt: IsoTimestamp;
}

export interface AppendRoomEvidenceInputV1 {
  readonly scope: RoomEvidenceLedgerScope;
  readonly id: RoomEvidenceId;
  readonly nodeId: RoomTaskNodeId;
  readonly candidateId: RoomCandidateId | null;
  readonly kind: RoomEvidenceRecordV1["kind"];
  readonly authoritativeSourceUri: string;
  readonly sourceVersionOrHash: string;
  readonly capturedAt: IsoTimestamp;
  readonly collectionMethod: string;
  readonly collectorBindingId: RoomBindingId | null;
  readonly contentHash: ContentHash;
  readonly artifactIds: readonly RoomArtifactId[];
  readonly expiresAt: IsoTimestamp | null;
}

export interface AppendRoomCandidateInputV1 {
  readonly scope: RoomEvidenceLedgerScope;
  readonly id: RoomCandidateId;
  readonly nodeId: RoomTaskNodeId;
  readonly producingBindingId: RoomBindingId;
  readonly nativeSessionId: string;
  readonly happierSessionId: string;
  readonly providerId: string;
  readonly modelRef: string;
  readonly protocolId: string;
  readonly protocolVersion: number;
  readonly contextVersion: string;
  readonly inputVersion: string;
  readonly configVersion: string;
  readonly contentHash: ContentHash;
  readonly artifactIds: readonly RoomArtifactId[];
  readonly parentCandidateIds: readonly RoomCandidateId[];
  readonly gateResultIds: readonly RoomGateResultId[];
  readonly reviewIds: readonly RoomReviewId[];
  readonly createdAt: IsoTimestamp;
}

export interface AppendRoomReviewInputV1 {
  readonly scope: RoomEvidenceLedgerScope;
  readonly id: RoomReviewId;
  readonly nodeId: RoomTaskNodeId;
  readonly candidateId: RoomCandidateId;
  readonly blindCandidateRef: string;
  readonly reviewerBindingId: RoomBindingId;
  readonly reviewerNativeSessionId: string;
  readonly reviewerHappierSessionId: string;
  readonly blind: boolean;
  readonly producerIdentityHidden: boolean;
  readonly independentFromProducer: true;
  readonly verdict: RoomReviewRecordV1["verdict"];
  readonly rubricVersion: string;
  readonly evidenceIds: readonly RoomEvidenceId[];
  readonly dissentIds: readonly RoomDissentId[];
  readonly reviewContentHash: ContentHash;
  readonly committedAt: IsoTimestamp;
}

export interface AppendRoomDissentInputV1 {
  readonly scope: RoomEvidenceLedgerScope;
  readonly id: RoomDissentId;
  readonly nodeId: RoomTaskNodeId;
  readonly candidateId: RoomCandidateId;
  readonly reviewId: RoomReviewId | null;
  readonly severity: RoomDissentRecordV1["severity"];
  readonly ownerId: string;
  readonly evidenceIds: readonly RoomEvidenceId[];
  readonly contentHash: ContentHash;
  readonly createdAt: IsoTimestamp;
}

export interface AppendRoomGateResultInputV1 {
  readonly scope: RoomEvidenceLedgerScope;
  readonly id: RoomGateResultId;
  readonly nodeId: RoomTaskNodeId;
  readonly candidateId: RoomCandidateId;
  readonly profileId: string;
  readonly kind: RoomGateResultV1["kind"];
  readonly hard: boolean;
  readonly status: RoomGateResultV1["status"];
  readonly evidenceIds: readonly RoomEvidenceId[];
  readonly evaluatorBindingId: RoomBindingId | null;
  readonly command: string | null;
  readonly exitCode: number | null;
  readonly recordedAt: IsoTimestamp;
}

export interface AppendRoomPromotionInputV1 {
  readonly scope: RoomEvidenceLedgerScope;
  readonly id: RoomPromotionId;
  readonly nodeId: RoomTaskNodeId;
  readonly candidateId: RoomCandidateId;
  readonly decision: RoomPromotionRecordV1["decision"];
  readonly decisionActorType: RoomPromotionRecordV1["decisionActorType"];
  readonly decisionActorId: string;
  readonly hardGateResultIds: readonly RoomGateResultId[];
  readonly reviewIds: readonly RoomReviewId[];
  readonly unresolvedDissentIds: readonly RoomDissentId[];
  readonly evidenceIds: readonly RoomEvidenceId[];
  readonly rationale: string;
  readonly decidedAt: IsoTimestamp;
}

export interface AppendRoomConfidenceSnapshotInputV1 {
  readonly scope: RoomEvidenceLedgerScope;
  readonly id: RoomConfidenceSnapshotId;
  readonly nodeId: RoomTaskNodeId;
  readonly candidateId: RoomCandidateId;
  readonly methodologyVersion: string;
  readonly computedAt: IsoTimestamp;
  readonly requiredEvidenceKinds: readonly RoomEvidenceRecordV1["kind"][];
  readonly evidenceIds: readonly RoomEvidenceId[];
  readonly calibration: AuthorizedRoomConfidenceCalibrationV1 | null;
}

export type RoomEvidenceLedgerErrorCode =
  | "invalid_input"
  | "invalid_hash"
  | "invalid_reference"
  | "reference_not_found"
  | "scope_mismatch"
  | "immutable_conflict"
  | "self_review_forbidden"
  | "self_promotion_forbidden"
  | "independent_review_required"
  | "hard_gate_failed"
  | "unresolved_critical_dissent";

export class RoomEvidenceLedgerError extends Error {
  constructor(
    readonly code: RoomEvidenceLedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RoomEvidenceLedgerError";
  }
}

/*
FNXC:SessionRoomEvidenceLedger 2026-07-19-08:03:
OpenSpec 7.1 requires Room artifacts, evidence, candidates, reviews, dissents,
gates, and promotions to be append-only evidence. This facade fixes caller
provided IDs and SHA-256 content hashes, preserves the producer's binding plus
native and Happier identities, and refuses self-review, self-promotion, failed
hard gates, and hidden critical dissent before persistence can write a record.
*/
export class AsyncRoomEvidenceLedger {
  constructor(private readonly persistence: RoomEvidenceLedgerPersistence) {}

  async appendArtifact(
    input: AppendRoomArtifactInputV1,
  ): Promise<RoomEvidenceLedgerAppendResult<"room_artifacts", RoomArtifactRecordV1>> {
    const { scope, record } = normalizeArtifactInput(input);
    return this.persistence.transaction(async (transaction) => {
      if (record.candidateId !== null) {
        const references = await this.resolveReferences(transaction, scope, {
          artifactIds: [],
          evidenceIds: [],
          candidateIds: [record.candidateId],
          reviewIds: [],
          dissentIds: [],
          gateResultIds: [],
        });
        const candidate = references.candidates[0];
        if (!candidate) throw referenceNotFound("candidate", record.candidateId);
        assertStoredCandidate(candidate, scope);
        if (!candidate.artifactIds.includes(record.id)) {
          throw new RoomEvidenceLedgerError(
            "invalid_reference",
            `Candidate ${candidate.id} did not declare artifact ${record.id} before append`,
          );
        }
      }
      return this.appendRecord(transaction, scope, { table: "room_artifacts", record });
    });
  }

  async appendEvidence(
    input: AppendRoomEvidenceInputV1,
  ): Promise<RoomEvidenceLedgerAppendResult<"room_evidence", RoomEvidenceRecordV1>> {
    const { scope, record } = normalizeEvidenceInput(input);
    return this.persistence.transaction(async (transaction) => {
      const references = await this.resolveReferences(transaction, scope, {
        artifactIds: record.artifactIds,
        evidenceIds: [],
        candidateIds: record.candidateId === null ? [] : [record.candidateId],
        reviewIds: [],
        dissentIds: [],
        gateResultIds: [],
      });
      for (const artifact of references.artifacts) assertStoredArtifact(artifact, scope);
      for (const candidate of references.candidates) assertStoredCandidate(candidate, scope);
      return this.appendRecord(transaction, scope, { table: "room_evidence", record });
    });
  }

  async appendCandidate(
    input: AppendRoomCandidateInputV1,
  ): Promise<RoomEvidenceLedgerAppendResult<"room_candidates", RoomCandidateRecordV1>> {
    const { scope, record } = normalizeCandidateInput(input);
    return this.persistence.transaction(async (transaction) => {
      const references = await this.resolveReferences(transaction, scope, {
        artifactIds: [],
        evidenceIds: [],
        candidateIds: record.parentCandidateIds,
        reviewIds: [],
        dissentIds: [],
        gateResultIds: [],
      });
      for (const parent of references.candidates) assertStoredCandidate(parent, scope);
      return this.appendRecord(transaction, scope, { table: "room_candidates", record });
    });
  }

  async appendReview(
    input: AppendRoomReviewInputV1,
  ): Promise<RoomEvidenceLedgerAppendResult<"room_reviews", RoomReviewRecordV1>> {
    const { scope, record } = normalizeReviewInput(input);
    return this.persistence.transaction(async (transaction) => {
      const references = await this.resolveReferences(transaction, scope, {
        artifactIds: [],
        evidenceIds: record.evidenceIds,
        candidateIds: [record.candidateId],
        reviewIds: [],
        dissentIds: record.dissentIds,
        gateResultIds: [],
      });
      const candidate = references.candidates[0];
      if (!candidate) throw referenceNotFound("candidate", record.candidateId);
      assertStoredCandidate(candidate, scope);
      assertIndependentReview(candidate, record);
      if (!candidate.reviewIds.includes(record.id)) {
        throw new RoomEvidenceLedgerError(
          "invalid_reference",
          `Candidate ${candidate.id} did not declare review ${record.id} before append`,
        );
      }
      for (const evidence of references.evidence) assertStoredEvidence(evidence, scope);
      for (const dissent of references.dissents) assertStoredDissent(dissent, scope, record.candidateId);
      return this.appendRecord(transaction, scope, { table: "room_reviews", record });
    });
  }

  async appendDissent(
    input: AppendRoomDissentInputV1,
  ): Promise<RoomEvidenceLedgerAppendResult<"room_dissents", RoomDissentRecordV1>> {
    const { scope, record } = normalizeDissentInput(input);
    return this.persistence.transaction(async (transaction) => {
      const references = await this.resolveReferences(transaction, scope, {
        artifactIds: [],
        evidenceIds: record.evidenceIds,
        candidateIds: [record.candidateId],
        reviewIds: record.reviewId === null ? [] : [record.reviewId],
        dissentIds: [],
        gateResultIds: [],
      });
      const candidate = references.candidates[0];
      if (!candidate) throw referenceNotFound("candidate", record.candidateId);
      assertStoredCandidate(candidate, scope);
      for (const evidence of references.evidence) assertStoredEvidence(evidence, scope);
      for (const review of references.reviews) assertStoredReview(review, scope, record.candidateId);
      return this.appendRecord(transaction, scope, { table: "room_dissents", record });
    });
  }

  async appendGateResult(
    input: AppendRoomGateResultInputV1,
  ): Promise<RoomEvidenceLedgerAppendResult<"room_gate_results", RoomGateResultV1>> {
    const { scope, record } = normalizeGateResultInput(input);
    return this.persistence.transaction(async (transaction) => {
      const references = await this.resolveReferences(transaction, scope, {
        artifactIds: [],
        evidenceIds: record.evidenceIds,
        candidateIds: [record.candidateId],
        reviewIds: [],
        dissentIds: [],
        gateResultIds: [],
      });
      const candidate = references.candidates[0];
      if (!candidate) throw referenceNotFound("candidate", record.candidateId);
      assertStoredCandidate(candidate, scope);
      if (!candidate.gateResultIds.includes(record.id)) {
        throw new RoomEvidenceLedgerError(
          "invalid_reference",
          `Candidate ${candidate.id} did not declare gate result ${record.id} before append`,
        );
      }
      for (const evidence of references.evidence) assertStoredEvidence(evidence, scope);
      return this.appendRecord(transaction, scope, { table: "room_gate_results", record });
    });
  }

  async appendPromotion(
    input: AppendRoomPromotionInputV1,
  ): Promise<RoomEvidenceLedgerAppendResult<"room_promotions", RoomPromotionRecordV1>> {
    const { scope, record } = normalizePromotionInput(input);
    return this.persistence.transaction(async (transaction) => {
      const references = await this.resolveReferences(transaction, scope, {
        artifactIds: [],
        evidenceIds: record.evidenceIds,
        candidateIds: [record.candidateId],
        reviewIds: record.reviewIds,
        dissentIds: record.unresolvedDissentIds,
        gateResultIds: record.hardGateResultIds,
      });
      const candidate = references.candidates[0];
      if (!candidate) throw referenceNotFound("candidate", record.candidateId);
      assertStoredCandidate(candidate, scope);
      assertNotCandidateProducer(candidate, record.decisionActorId, "self_promotion_forbidden");
      for (const evidence of references.evidence) assertStoredEvidence(evidence, scope);
      for (const review of references.reviews) assertStoredReview(review, scope, record.candidateId);
      for (const dissent of references.dissents) assertStoredDissent(dissent, scope, record.candidateId);
      for (const gateResult of references.gateResults) assertStoredGateResult(gateResult, scope, record.candidateId);

      if (record.decision === "promoted") {
        const evaluation = await transaction.loadCandidateEvaluation(
          immutableCopy({ scope, candidateId: record.candidateId }),
        );
        assertPromotionEligibility(evaluation, record, scope);
      }
      return this.appendRecord(transaction, scope, { table: "room_promotions", record });
    });
  }

  async appendConfidenceSnapshot(
    input: AppendRoomConfidenceSnapshotInputV1,
  ): Promise<RoomEvidenceLedgerAppendResult<"room_confidence_snapshots", RoomConfidenceSnapshotV1>> {
    const normalized = normalizeConfidenceSnapshotInput(input);
    return this.persistence.transaction(async (transaction) => {
      const references = await this.resolveReferences(transaction, normalized.scope, {
        artifactIds: [],
        evidenceIds: normalized.evidenceIds,
        candidateIds: [normalized.candidateId],
        reviewIds: [],
        dissentIds: [],
        gateResultIds: [],
      });
      const candidate = references.candidates[0];
      if (!candidate) throw referenceNotFound("candidate", normalized.candidateId);
      assertStoredCandidate(candidate, normalized.scope);
      assertConfidenceRecordNode(candidate, normalized.nodeId, "candidate");
      if (candidate.id !== normalized.candidateId) {
        throw new RoomEvidenceLedgerError(
          "invalid_reference",
          `Confidence snapshot candidate ${normalized.candidateId} did not resolve exactly`,
        );
      }
      for (const evidence of references.evidence) {
        assertStoredEvidence(evidence, normalized.scope);
        assertConfidenceRecordNode(evidence, normalized.nodeId, "evidence");
        if (evidence.candidateId !== null && evidence.candidateId !== normalized.candidateId) {
          throw new RoomEvidenceLedgerError(
            "invalid_reference",
            `Evidence ${evidence.id} belongs to another candidate`,
          );
        }
      }

      const evaluation = await transaction.loadCandidateEvaluation(
        immutableCopy({ scope: normalized.scope, candidateId: normalized.candidateId }),
      );
      assertConfidenceCandidateEvaluation(
        evaluation,
        normalized.scope,
        normalized.nodeId,
        normalized.candidateId,
      );

      const record = evaluateRoomConfidenceSnapshot({
        contractVersion: 1,
        id: normalized.id,
        roomId: normalized.scope.roomId,
        nodeId: normalized.nodeId,
        candidateId: normalized.candidateId,
        methodologyVersion: normalized.methodologyVersion,
        computedAt: normalized.computedAt,
        requiredEvidenceKinds: normalized.requiredEvidenceKinds,
        evidence: references.evidence,
        gateResults: evaluation.gateResults,
        reviews: evaluation.reviews,
        dissents: evaluation.dissents,
        calibration: normalized.calibration,
      });
      return this.appendRecord(transaction, normalized.scope, {
        table: "room_confidence_snapshots",
        record,
      });
    });
  }

  private async resolveReferences(
    transaction: RoomEvidenceLedgerTransaction,
    scope: RoomEvidenceLedgerScope,
    input: Omit<RoomEvidenceLedgerReferenceQuery, "scope">,
  ): Promise<RoomEvidenceLedgerReferenceSnapshot> {
    const query = immutableCopy({ scope, ...input });
    const snapshot = await transaction.resolveReferences(query);
    assertReferenceSnapshot(snapshot, query);
    return snapshot;
  }

  private async appendRecord<TEntry extends RoomEvidenceLedgerEntry>(
    transaction: RoomEvidenceLedgerTransaction,
    scope: RoomEvidenceLedgerScope,
    entry: TEntry,
  ): Promise<RoomEvidenceLedgerAppendResult<TEntry["table"], TEntry["record"]>> {
    const immutableEntry = immutableCopy(entry);
    const outcome = await transaction.append(immutableCopy({ scope, entry: immutableEntry }));
    if (outcome.status !== "inserted" || outcome.recordId !== immutableEntry.record.id) {
      throw new RoomEvidenceLedgerError(
        "immutable_conflict",
        `Room evidence ledger refuses to overwrite ${immutableEntry.table} record ${immutableEntry.record.id}`,
      );
    }
    return immutableCopy({ table: immutableEntry.table, record: immutableEntry.record }) as RoomEvidenceLedgerAppendResult<
      TEntry["table"],
      TEntry["record"]
    >;
  }
}

function normalizeArtifactInput(input: AppendRoomArtifactInputV1): {
  readonly scope: RoomEvidenceLedgerScope;
  readonly record: RoomArtifactRecordV1;
} {
  assertExactKeys(input, [
    "scope", "id", "nodeId", "candidateId", "kind", "mediaType", "uri", "contentHash",
    "producingBindingId", "sourceRevision", "sizeBytes", "createdAt",
  ], "artifact input");
  const scope = normalizeScope(input.scope);
  assertCanonicalReference(input.id, "artifact id");
  assertCanonicalReference(input.nodeId, "artifact node id");
  assertNullableReference(input.candidateId, "artifact candidate id");
  assertOneOf(input.kind, ROOM_ARTIFACT_KINDS, "artifact kind");
  assertNonBlankText(input.mediaType, "artifact media type");
  assertCanonicalUri(input.uri, "artifact URI");
  assertCanonicalHash(input.contentHash, "artifact content hash");
  assertNullableReference(input.producingBindingId, "artifact producing binding id");
  assertNullableText(input.sourceRevision, "artifact source revision");
  assertNullableNonNegativeInteger(input.sizeBytes, "artifact size bytes");
  assertCanonicalTimestamp(input.createdAt, "artifact creation time");
  return {
    scope,
    record: {
      contractVersion: ROOM_CONTRACT_VERSIONS.evidence,
      id: input.id,
      roomId: scope.roomId,
      nodeId: input.nodeId,
      candidateId: input.candidateId,
      kind: input.kind,
      mediaType: input.mediaType,
      uri: input.uri,
      contentHash: input.contentHash,
      producingBindingId: input.producingBindingId,
      sourceRevision: input.sourceRevision,
      sizeBytes: input.sizeBytes,
      immutable: true,
      createdAt: input.createdAt,
    },
  };
}

function normalizeEvidenceInput(input: AppendRoomEvidenceInputV1): {
  readonly scope: RoomEvidenceLedgerScope;
  readonly record: RoomEvidenceRecordV1;
} {
  assertExactKeys(input, [
    "scope", "id", "nodeId", "candidateId", "kind", "authoritativeSourceUri", "sourceVersionOrHash",
    "capturedAt", "collectionMethod", "collectorBindingId", "contentHash", "artifactIds", "expiresAt",
  ], "evidence input");
  const scope = normalizeScope(input.scope);
  assertCanonicalReference(input.id, "evidence id");
  assertCanonicalReference(input.nodeId, "evidence node id");
  assertNullableReference(input.candidateId, "evidence candidate id");
  assertOneOf(input.kind, ROOM_EVIDENCE_KINDS, "evidence kind");
  assertCanonicalUri(input.authoritativeSourceUri, "evidence authoritative source URI");
  assertCanonicalReference(input.sourceVersionOrHash, "evidence source version or hash");
  assertCanonicalTimestamp(input.capturedAt, "evidence capture time");
  assertNonBlankText(input.collectionMethod, "evidence collection method");
  assertNullableReference(input.collectorBindingId, "evidence collector binding id");
  assertCanonicalHash(input.contentHash, "evidence content hash");
  const artifactIds = canonicalReferenceList(input.artifactIds, "evidence artifact ids");
  assertNullableTimestamp(input.expiresAt, "evidence expiry time");
  return {
    scope,
    record: {
      contractVersion: ROOM_CONTRACT_VERSIONS.evidence,
      id: input.id,
      roomId: scope.roomId,
      nodeId: input.nodeId,
      candidateId: input.candidateId,
      kind: input.kind,
      authoritativeSourceUri: input.authoritativeSourceUri,
      sourceVersionOrHash: input.sourceVersionOrHash,
      capturedAt: input.capturedAt,
      collectionMethod: input.collectionMethod,
      collectorBindingId: input.collectorBindingId,
      contentHash: input.contentHash,
      artifactIds,
      authoritativeSourceRetained: true,
      expiresAt: input.expiresAt,
    },
  };
}

function normalizeCandidateInput(input: AppendRoomCandidateInputV1): {
  readonly scope: RoomEvidenceLedgerScope;
  readonly record: RoomCandidateRecordV1;
} {
  assertExactKeys(input, [
    "scope", "id", "nodeId", "producingBindingId", "nativeSessionId", "happierSessionId", "providerId",
    "modelRef", "protocolId", "protocolVersion", "contextVersion", "inputVersion", "configVersion",
    "contentHash", "artifactIds", "parentCandidateIds", "gateResultIds", "reviewIds", "createdAt",
  ], "candidate input");
  const scope = normalizeScope(input.scope);
  assertCanonicalReference(input.id, "candidate id");
  assertCanonicalReference(input.nodeId, "candidate node id");
  assertCanonicalReference(input.producingBindingId, "candidate producing binding id");
  assertIdentity(input.nativeSessionId, "candidate native Session id");
  assertIdentity(input.happierSessionId, "candidate Happier Session id");
  assertNonBlankText(input.providerId, "candidate provider id");
  assertNonBlankText(input.modelRef, "candidate model reference");
  assertCanonicalReference(input.protocolId, "candidate protocol id");
  assertPositiveInteger(input.protocolVersion, "candidate protocol version");
  assertCanonicalReference(input.contextVersion, "candidate context version");
  assertCanonicalReference(input.inputVersion, "candidate input version");
  assertCanonicalReference(input.configVersion, "candidate config version");
  assertCanonicalHash(input.contentHash, "candidate content hash");
  const artifactIds = canonicalReferenceList(input.artifactIds, "candidate artifact ids");
  const parentCandidateIds = canonicalReferenceList(input.parentCandidateIds, "candidate parent ids");
  const gateResultIds = canonicalReferenceList(input.gateResultIds, "candidate gate result ids");
  const reviewIds = canonicalReferenceList(input.reviewIds, "candidate review ids");
  if (parentCandidateIds.includes(input.id)) {
    throw new RoomEvidenceLedgerError("invalid_reference", "Candidate cannot name itself as a parent");
  }
  assertCanonicalTimestamp(input.createdAt, "candidate creation time");
  return {
    scope,
    record: {
      contractVersion: ROOM_CONTRACT_VERSIONS.evidence,
      id: input.id,
      roomId: scope.roomId,
      nodeId: input.nodeId,
      producingBindingId: input.producingBindingId,
      nativeSessionId: input.nativeSessionId,
      happierSessionId: input.happierSessionId,
      providerId: input.providerId,
      modelRef: input.modelRef,
      protocolId: input.protocolId,
      protocolVersion: input.protocolVersion,
      contextVersion: input.contextVersion,
      inputVersion: input.inputVersion,
      configVersion: input.configVersion,
      contentHash: input.contentHash,
      artifactIds,
      parentCandidateIds,
      gateResultIds,
      reviewIds,
      promotionState: "pending",
      createdAt: input.createdAt,
    },
  };
}

function normalizeReviewInput(input: AppendRoomReviewInputV1): {
  readonly scope: RoomEvidenceLedgerScope;
  readonly record: RoomReviewRecordV1;
} {
  assertExactKeys(input, [
    "scope", "id", "nodeId", "candidateId", "blindCandidateRef", "reviewerBindingId", "reviewerNativeSessionId",
    "reviewerHappierSessionId", "blind", "producerIdentityHidden", "independentFromProducer", "verdict",
    "rubricVersion", "evidenceIds", "dissentIds", "reviewContentHash", "committedAt",
  ], "review input");
  const scope = normalizeScope(input.scope);
  assertCanonicalReference(input.id, "review id");
  assertCanonicalReference(input.nodeId, "review node id");
  assertCanonicalReference(input.candidateId, "review candidate id");
  assertCanonicalReference(input.blindCandidateRef, "review blind candidate reference");
  assertCanonicalReference(input.reviewerBindingId, "reviewer binding id");
  assertIdentity(input.reviewerNativeSessionId, "reviewer native Session id");
  assertIdentity(input.reviewerHappierSessionId, "reviewer Happier Session id");
  assertBoolean(input.blind, "review blind flag");
  assertBoolean(input.producerIdentityHidden, "review producer identity hidden flag");
  if (input.blind && !input.producerIdentityHidden) {
    throw new RoomEvidenceLedgerError(
      "invalid_input",
      "A blind review must hide the producer identity",
    );
  }
  if (input.independentFromProducer !== true) {
    throw new RoomEvidenceLedgerError(
      "independent_review_required",
      "Room reviews must explicitly attest independentFromProducer: true",
    );
  }
  assertOneOf(input.verdict, ROOM_REVIEW_VERDICTS, "review verdict");
  assertCanonicalReference(input.rubricVersion, "review rubric version");
  const evidenceIds = canonicalReferenceList(input.evidenceIds, "review evidence ids");
  const dissentIds = canonicalReferenceList(input.dissentIds, "review dissent ids");
  assertCanonicalHash(input.reviewContentHash, "review content hash");
  assertCanonicalTimestamp(input.committedAt, "review commit time");
  return {
    scope,
    record: {
      contractVersion: ROOM_CONTRACT_VERSIONS.evidence,
      id: input.id,
      roomId: scope.roomId,
      nodeId: input.nodeId,
      candidateId: input.candidateId,
      blindCandidateRef: input.blindCandidateRef,
      reviewerBindingId: input.reviewerBindingId,
      reviewerNativeSessionId: input.reviewerNativeSessionId,
      reviewerHappierSessionId: input.reviewerHappierSessionId,
      blind: input.blind,
      producerIdentityHidden: input.producerIdentityHidden,
      independentFromProducer: true,
      verdict: input.verdict,
      rubricVersion: input.rubricVersion,
      evidenceIds,
      dissentIds,
      reviewContentHash: input.reviewContentHash,
      committedAt: input.committedAt,
    },
  };
}

function normalizeDissentInput(input: AppendRoomDissentInputV1): {
  readonly scope: RoomEvidenceLedgerScope;
  readonly record: RoomDissentRecordV1;
} {
  assertExactKeys(input, [
    "scope", "id", "nodeId", "candidateId", "reviewId", "severity", "ownerId", "evidenceIds", "contentHash", "createdAt",
  ], "dissent input");
  const scope = normalizeScope(input.scope);
  assertCanonicalReference(input.id, "dissent id");
  assertCanonicalReference(input.nodeId, "dissent node id");
  assertCanonicalReference(input.candidateId, "dissent candidate id");
  assertNullableReference(input.reviewId, "dissent review id");
  assertOneOf(input.severity, ROOM_DISSENT_SEVERITIES, "dissent severity");
  assertCanonicalReference(input.ownerId, "dissent owner id");
  const evidenceIds = canonicalReferenceList(input.evidenceIds, "dissent evidence ids");
  assertCanonicalHash(input.contentHash, "dissent content hash");
  assertCanonicalTimestamp(input.createdAt, "dissent creation time");
  return {
    scope,
    record: {
      contractVersion: ROOM_CONTRACT_VERSIONS.evidence,
      id: input.id,
      roomId: scope.roomId,
      nodeId: input.nodeId,
      candidateId: input.candidateId,
      reviewId: input.reviewId,
      severity: input.severity,
      state: "open",
      ownerId: input.ownerId,
      evidenceIds,
      contentHash: input.contentHash,
      resolution: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    },
  };
}

function normalizeGateResultInput(input: AppendRoomGateResultInputV1): {
  readonly scope: RoomEvidenceLedgerScope;
  readonly record: RoomGateResultV1;
} {
  assertExactKeys(input, [
    "scope", "id", "nodeId", "candidateId", "profileId", "kind", "hard", "status", "evidenceIds",
    "evaluatorBindingId", "command", "exitCode", "recordedAt",
  ], "gate result input");
  const scope = normalizeScope(input.scope);
  assertCanonicalReference(input.id, "gate result id");
  assertCanonicalReference(input.nodeId, "gate result node id");
  assertCanonicalReference(input.candidateId, "gate result candidate id");
  assertCanonicalReference(input.profileId, "gate result profile id");
  assertOneOf(input.kind, ROOM_GATE_KINDS, "gate result kind");
  assertBoolean(input.hard, "gate result hard flag");
  assertOneOf(input.status, ROOM_GATE_STATUSES, "gate result status");
  const evidenceIds = canonicalReferenceList(input.evidenceIds, "gate result evidence ids");
  assertNullableReference(input.evaluatorBindingId, "gate result evaluator binding id");
  assertNullableText(input.command, "gate result command");
  assertNullableInteger(input.exitCode, "gate result exit code");
  if ((input.command === null) !== (input.exitCode === null)) {
    throw new RoomEvidenceLedgerError(
      "invalid_input",
      "A gate result command and exit code must either both be present or both be null",
    );
  }
  assertCanonicalTimestamp(input.recordedAt, "gate result recorded time");
  return {
    scope,
    record: {
      contractVersion: ROOM_CONTRACT_VERSIONS.evidence,
      id: input.id,
      roomId: scope.roomId,
      nodeId: input.nodeId,
      candidateId: input.candidateId,
      profileId: input.profileId,
      kind: input.kind,
      hard: input.hard,
      status: input.status,
      evidenceIds,
      evaluatorBindingId: input.evaluatorBindingId,
      command: input.command,
      exitCode: input.exitCode,
      recordedAt: input.recordedAt,
    },
  };
}

function normalizePromotionInput(input: AppendRoomPromotionInputV1): {
  readonly scope: RoomEvidenceLedgerScope;
  readonly record: RoomPromotionRecordV1;
} {
  assertExactKeys(input, [
    "scope", "id", "nodeId", "candidateId", "decision", "decisionActorType", "decisionActorId",
    "hardGateResultIds", "reviewIds", "unresolvedDissentIds", "evidenceIds", "rationale", "decidedAt",
  ], "promotion input");
  const scope = normalizeScope(input.scope);
  assertCanonicalReference(input.id, "promotion id");
  assertCanonicalReference(input.nodeId, "promotion node id");
  assertCanonicalReference(input.candidateId, "promotion candidate id");
  assertOneOf(input.decision, ROOM_PROMOTION_DECISIONS, "promotion decision");
  assertOneOf(input.decisionActorType, ROOM_PROMOTION_ACTOR_TYPES, "promotion decision actor type");
  assertCanonicalReference(input.decisionActorId, "promotion decision actor id");
  const hardGateResultIds = canonicalReferenceList(input.hardGateResultIds, "promotion hard gate result ids");
  const reviewIds = canonicalReferenceList(input.reviewIds, "promotion review ids");
  const unresolvedDissentIds = canonicalReferenceList(input.unresolvedDissentIds, "promotion unresolved dissent ids");
  const evidenceIds = canonicalReferenceList(input.evidenceIds, "promotion evidence ids");
  assertNonBlankText(input.rationale, "promotion rationale");
  assertCanonicalTimestamp(input.decidedAt, "promotion decision time");
  return {
    scope,
    record: {
      contractVersion: ROOM_CONTRACT_VERSIONS.evidence,
      id: input.id,
      roomId: scope.roomId,
      nodeId: input.nodeId,
      candidateId: input.candidateId,
      decision: input.decision,
      decisionActorType: input.decisionActorType,
      decisionActorId: input.decisionActorId,
      hardGateResultIds,
      reviewIds,
      unresolvedDissentIds,
      evidenceIds,
      rationale: input.rationale,
      decidedAt: input.decidedAt,
    },
  };
}

function normalizeConfidenceSnapshotInput(input: AppendRoomConfidenceSnapshotInputV1): {
  readonly scope: RoomEvidenceLedgerScope;
  readonly id: RoomConfidenceSnapshotId;
  readonly nodeId: RoomTaskNodeId;
  readonly candidateId: RoomCandidateId;
  readonly methodologyVersion: string;
  readonly computedAt: IsoTimestamp;
  readonly requiredEvidenceKinds: readonly RoomEvidenceRecordV1["kind"][];
  readonly evidenceIds: readonly RoomEvidenceId[];
  readonly calibration: AuthorizedRoomConfidenceCalibrationV1 | null;
} {
  assertExactKeys(input, [
    "scope", "id", "nodeId", "candidateId", "methodologyVersion", "computedAt",
    "requiredEvidenceKinds", "evidenceIds", "calibration",
  ], "confidence snapshot input");
  const scope = normalizeScope(input.scope);
  assertCanonicalReference(input.id, "confidence snapshot id");
  assertCanonicalReference(input.nodeId, "confidence snapshot node id");
  assertCanonicalReference(input.candidateId, "confidence snapshot candidate id");
  assertNonBlankText(input.methodologyVersion, "confidence snapshot methodology version");
  assertCanonicalTimestamp(input.computedAt, "confidence snapshot computation time");
  const requiredEvidenceKinds = canonicalEvidenceKindList(
    input.requiredEvidenceKinds,
    "confidence snapshot required evidence kinds",
  );
  const evidenceIds = canonicalUniqueReferenceList(
    input.evidenceIds,
    "confidence snapshot evidence ids",
  ) as readonly RoomEvidenceId[];
  const calibration = normalizeConfidenceCalibration(input.calibration, input.computedAt);
  return {
    scope,
    id: input.id,
    nodeId: input.nodeId,
    candidateId: input.candidateId,
    methodologyVersion: input.methodologyVersion,
    computedAt: input.computedAt,
    requiredEvidenceKinds,
    evidenceIds,
    calibration,
  };
}

function normalizeScope(scope: RoomEvidenceLedgerScope): RoomEvidenceLedgerScope {
  assertExactKeys(scope, ["projectId", "roomId"], "ledger scope");
  assertCanonicalReference(scope.projectId, "ledger project id");
  assertCanonicalReference(scope.roomId, "ledger Room id");
  return { projectId: scope.projectId, roomId: scope.roomId };
}

function assertReferenceSnapshot(
  snapshot: RoomEvidenceLedgerReferenceSnapshot,
  query: RoomEvidenceLedgerReferenceQuery,
): void {
  if (!isRecord(snapshot)) {
    throw new RoomEvidenceLedgerError("invalid_input", "Ledger persistence returned an invalid reference snapshot");
  }
  const scope = normalizeScope(snapshot.scope);
  if (scope.projectId !== query.scope.projectId || scope.roomId !== query.scope.roomId) {
    throw new RoomEvidenceLedgerError("scope_mismatch", "Ledger persistence returned a reference snapshot for another scope");
  }
  assertResolvedReferenceSet(snapshot.artifacts, query.artifactIds, query.scope, "artifact");
  assertResolvedReferenceSet(snapshot.evidence, query.evidenceIds, query.scope, "evidence");
  assertResolvedReferenceSet(snapshot.candidates, query.candidateIds, query.scope, "candidate");
  assertResolvedReferenceSet(snapshot.reviews, query.reviewIds, query.scope, "review");
  assertResolvedReferenceSet(snapshot.dissents, query.dissentIds, query.scope, "dissent");
  assertResolvedReferenceSet(snapshot.gateResults, query.gateResultIds, query.scope, "gate result");
}

function assertResolvedReferenceSet<TRecord extends { readonly id: string; readonly roomId: string }>(
  records: readonly TRecord[],
  expectedIds: readonly string[],
  scope: RoomEvidenceLedgerScope,
  label: string,
): void {
  if (!Array.isArray(records)) {
    throw new RoomEvidenceLedgerError("invalid_input", `Ledger persistence returned invalid ${label} references`);
  }
  const resolvedIds: string[] = [];
  for (const record of records) {
    if (!isRecord(record)) {
      throw new RoomEvidenceLedgerError("invalid_input", `Ledger persistence returned an invalid ${label} record`);
    }
    assertCanonicalReference(record.id, `${label} record id`);
    if (record.roomId !== scope.roomId) {
      throw new RoomEvidenceLedgerError("scope_mismatch", `Resolved ${label} ${record.id} belongs to another Room`);
    }
    resolvedIds.push(record.id);
  }
  const canonicalResolvedIds = canonicalReferenceList(resolvedIds, `resolved ${label} ids`);
  assertSameReferences(canonicalResolvedIds, expectedIds, `resolved ${label} ids`);
}

function assertStoredArtifact(record: RoomArtifactRecordV1, scope: RoomEvidenceLedgerScope): void {
  assertRecordScope(record, scope, "artifact");
  assertCanonicalHash(record.contentHash, "stored artifact content hash");
  if (record.immutable !== true) {
    throw new RoomEvidenceLedgerError("invalid_input", `Stored artifact ${record.id} is not immutable`);
  }
}

function assertStoredEvidence(record: RoomEvidenceRecordV1, scope: RoomEvidenceLedgerScope): void {
  assertRecordScope(record, scope, "evidence");
  assertCanonicalHash(record.contentHash, "stored evidence content hash");
  if (record.authoritativeSourceRetained !== true) {
    throw new RoomEvidenceLedgerError("invalid_input", `Stored evidence ${record.id} did not retain its authority source`);
  }
}

function assertStoredCandidate(record: RoomCandidateRecordV1, scope: RoomEvidenceLedgerScope): void {
  assertRecordScope(record, scope, "candidate");
  if (record.contractVersion !== ROOM_CONTRACT_VERSIONS.evidence) {
    throw new RoomEvidenceLedgerError("invalid_input", `Candidate ${record.id} has an unsupported evidence contract version`);
  }
  assertCanonicalReference(record.producingBindingId, "stored candidate producing binding id");
  assertIdentity(record.nativeSessionId, "stored candidate native Session id");
  assertIdentity(record.happierSessionId, "stored candidate Happier Session id");
  assertCanonicalHash(record.contentHash, "stored candidate content hash");
  canonicalReferenceList(record.artifactIds, "stored candidate artifact ids");
  canonicalReferenceList(record.parentCandidateIds, "stored candidate parent ids");
  canonicalReferenceList(record.gateResultIds, "stored candidate gate result ids");
  canonicalReferenceList(record.reviewIds, "stored candidate review ids");
}

function assertStoredReview(
  record: RoomReviewRecordV1,
  scope: RoomEvidenceLedgerScope,
  candidateId: RoomCandidateId,
): void {
  assertRecordScope(record, scope, "review");
  if (record.candidateId !== candidateId) {
    throw new RoomEvidenceLedgerError("invalid_reference", `Review ${record.id} belongs to another candidate`);
  }
  assertCanonicalHash(record.reviewContentHash, "stored review content hash");
}

function assertStoredDissent(
  record: RoomDissentRecordV1,
  scope: RoomEvidenceLedgerScope,
  candidateId: RoomCandidateId,
): void {
  assertRecordScope(record, scope, "dissent");
  if (record.candidateId !== candidateId) {
    throw new RoomEvidenceLedgerError("invalid_reference", `Dissent ${record.id} belongs to another candidate`);
  }
  assertOneOf(record.severity, ROOM_DISSENT_SEVERITIES, "stored dissent severity");
  assertOneOf(record.state, ROOM_DISSENT_STATES, "stored dissent state");
  assertCanonicalHash(record.contentHash, "stored dissent content hash");
}

function assertStoredGateResult(
  record: RoomGateResultV1,
  scope: RoomEvidenceLedgerScope,
  candidateId: RoomCandidateId,
): void {
  assertRecordScope(record, scope, "gate result");
  if (record.candidateId !== candidateId) {
    throw new RoomEvidenceLedgerError("invalid_reference", `Gate result ${record.id} belongs to another candidate`);
  }
  assertOneOf(record.status, ROOM_GATE_STATUSES, "stored gate result status");
}

function assertConfidenceCandidateEvaluation(
  evaluation: RoomEvidenceLedgerCandidateEvaluation | null,
  scope: RoomEvidenceLedgerScope,
  nodeId: RoomTaskNodeId,
  candidateId: RoomCandidateId,
): asserts evaluation is RoomEvidenceLedgerCandidateEvaluation {
  if (evaluation === null) throw referenceNotFound("candidate evaluation", candidateId);
  const evaluationScope = normalizeScope(evaluation.scope);
  if (evaluationScope.projectId !== scope.projectId || evaluationScope.roomId !== scope.roomId) {
    throw new RoomEvidenceLedgerError("scope_mismatch", "Candidate evaluation belongs to another scope");
  }
  const candidate = evaluation.candidate;
  assertStoredCandidate(candidate, scope);
  assertConfidenceRecordNode(candidate, nodeId, "candidate");
  if (candidate.id !== candidateId) {
    throw new RoomEvidenceLedgerError("invalid_reference", "Candidate evaluation does not match the confidence candidate");
  }
  for (const gateResult of evaluation.gateResults) {
    assertStoredGateResult(gateResult, scope, candidateId);
    assertConfidenceRecordNode(gateResult, nodeId, "gate result");
  }
  for (const review of evaluation.reviews) {
    assertStoredReview(review, scope, candidateId);
    assertConfidenceRecordNode(review, nodeId, "review");
  }
  for (const dissent of evaluation.dissents) {
    assertStoredDissent(dissent, scope, candidateId);
    assertConfidenceRecordNode(dissent, nodeId, "dissent");
  }
  for (const promotion of evaluation.promotions) {
    assertRecordScope(promotion, scope, "promotion");
    if (promotion.candidateId !== candidateId) {
      throw new RoomEvidenceLedgerError("invalid_reference", `Promotion ${promotion.id} belongs to another candidate`);
    }
    assertConfidenceRecordNode(promotion, nodeId, "promotion");
  }
  assertSameReferences(
    canonicalReferenceList(evaluation.gateResults.map((gateResult) => gateResult.id), "confidence evaluation gate ids"),
    candidate.gateResultIds,
    "candidate gate declarations",
  );
  assertSameReferences(
    canonicalReferenceList(evaluation.reviews.map((review) => review.id), "confidence evaluation review ids"),
    candidate.reviewIds,
    "candidate review declarations",
  );
}

function assertConfidenceRecordNode(
  record: { readonly id: string; readonly nodeId: RoomTaskNodeId },
  nodeId: RoomTaskNodeId,
  label: string,
): void {
  if (record.nodeId !== nodeId) {
    throw new RoomEvidenceLedgerError(
      "invalid_reference",
      `${label} ${record.id} belongs to another Room task node`,
    );
  }
}

function assertRecordScope(
  record: { readonly id: string; readonly roomId: string },
  scope: RoomEvidenceLedgerScope,
  label: string,
): void {
  assertCanonicalReference(record.id, `${label} id`);
  if (record.roomId !== scope.roomId) {
    throw new RoomEvidenceLedgerError("scope_mismatch", `${label} ${record.id} belongs to another Room`);
  }
}

function assertIndependentReview(
  candidate: RoomCandidateRecordV1,
  review: Pick<
    RoomReviewRecordV1,
    "reviewerBindingId" | "reviewerNativeSessionId" | "reviewerHappierSessionId" | "independentFromProducer"
  >,
): void {
  if (review.independentFromProducer !== true) {
    throw new RoomEvidenceLedgerError(
      "independent_review_required",
      `Review must declare independence from candidate ${candidate.id}`,
    );
  }
  if (
    review.reviewerBindingId === candidate.producingBindingId
    || review.reviewerNativeSessionId === candidate.nativeSessionId
    || review.reviewerHappierSessionId === candidate.happierSessionId
  ) {
    throw new RoomEvidenceLedgerError(
      "self_review_forbidden",
      `Candidate ${candidate.id} cannot review itself through a binding, native Session, or Happier Session identity`,
    );
  }
}

function assertNotCandidateProducer(
  candidate: RoomCandidateRecordV1,
  decisionActorId: string,
  code: "self_promotion_forbidden",
): void {
  if (
    decisionActorId === candidate.producingBindingId
    || decisionActorId === candidate.nativeSessionId
    || decisionActorId === candidate.happierSessionId
  ) {
    throw new RoomEvidenceLedgerError(
      code,
      `Candidate ${candidate.id} cannot promote itself through a binding, native Session, or Happier Session identity`,
    );
  }
}

function assertPromotionEligibility(
  evaluation: RoomEvidenceLedgerCandidateEvaluation | null,
  promotion: RoomPromotionRecordV1,
  scope: RoomEvidenceLedgerScope,
): void {
  if (evaluation === null) throw referenceNotFound("candidate evaluation", promotion.candidateId);
  const evaluationScope = normalizeScope(evaluation.scope);
  if (evaluationScope.projectId !== scope.projectId || evaluationScope.roomId !== scope.roomId) {
    throw new RoomEvidenceLedgerError("scope_mismatch", "Candidate evaluation belongs to another scope");
  }
  const candidate = evaluation.candidate;
  assertStoredCandidate(candidate, scope);
  if (candidate.id !== promotion.candidateId || candidate.nodeId !== promotion.nodeId) {
    throw new RoomEvidenceLedgerError("invalid_reference", "Promotion does not match the candidate's Room task node");
  }
  assertNotCandidateProducer(candidate, promotion.decisionActorId, "self_promotion_forbidden");
  if (candidate.promotionState !== "pending" || evaluation.promotions.length > 0) {
    throw new RoomEvidenceLedgerError(
      "immutable_conflict",
      `Candidate ${candidate.id} already has an immutable promotion decision`,
    );
  }

  for (const gateResult of evaluation.gateResults) assertStoredGateResult(gateResult, scope, candidate.id);
  for (const review of evaluation.reviews) {
    assertStoredReview(review, scope, candidate.id);
    assertIndependentReview(candidate, review);
  }
  for (const dissent of evaluation.dissents) assertStoredDissent(dissent, scope, candidate.id);
  for (const previousPromotion of evaluation.promotions) assertRecordScope(previousPromotion, scope, "promotion");

  assertSameReferences(
    canonicalReferenceList(evaluation.gateResults.map((gateResult) => gateResult.id), "candidate evaluation gate ids"),
    candidate.gateResultIds,
    "candidate gate declarations",
  );
  assertSameReferences(
    canonicalReferenceList(evaluation.reviews.map((review) => review.id), "candidate evaluation review ids"),
    candidate.reviewIds,
    "candidate review declarations",
  );

  const hardGateIds = evaluation.gateResults
    .filter((gateResult) => gateResult.hard)
    .map((gateResult) => gateResult.id);
  const canonicalHardGateIds = canonicalReferenceList(hardGateIds, "candidate hard gate ids");
  if (canonicalHardGateIds.length === 0) {
    throw new RoomEvidenceLedgerError(
      "hard_gate_failed",
      `Candidate ${candidate.id} cannot promote without at least one recorded hard gate`,
    );
  }
  assertSameReferences(promotion.hardGateResultIds, canonicalHardGateIds, "promotion hard gate ids");
  if (evaluation.gateResults.some((gateResult) => gateResult.hard && gateResult.status !== "passed")) {
    throw new RoomEvidenceLedgerError(
      "hard_gate_failed",
      `Candidate ${candidate.id} has a failed, errored, or unrun hard gate`,
    );
  }
  if (!evaluation.reviews.some((review) => review.verdict === "accept")) {
    throw new RoomEvidenceLedgerError(
      "independent_review_required",
      `Candidate ${candidate.id} cannot promote without an independent accepting review`,
    );
  }

  const unresolvedDissentIds = canonicalReferenceList(
    evaluation.dissents
      .filter((dissent) => dissent.state === "open" || dissent.state === "investigating")
      .map((dissent) => dissent.id),
    "candidate unresolved dissent ids",
  );
  assertSameReferences(
    promotion.unresolvedDissentIds,
    unresolvedDissentIds,
    "promotion unresolved dissent ids",
  );
  if (evaluation.dissents.some((dissent) => (
    dissent.severity === "critical"
    && (dissent.state === "open" || dissent.state === "investigating")
  ))) {
    throw new RoomEvidenceLedgerError(
      "unresolved_critical_dissent",
      `Candidate ${candidate.id} has unresolved critical dissent`,
    );
  }
}

function assertExactKeys(value: unknown, expectedKeys: readonly string[], label: string): void {
  if (!isRecord(value)) {
    throw new RoomEvidenceLedgerError("invalid_input", `${label} must be a plain record`);
  }
  const actualKeys = Object.keys(value).sort(compareRoomText);
  const canonicalExpectedKeys = [...expectedKeys].sort(compareRoomText);
  if (
    actualKeys.length !== canonicalExpectedKeys.length
    || actualKeys.some((key, index) => key !== canonicalExpectedKeys[index])
  ) {
    throw new RoomEvidenceLedgerError("invalid_input", `${label} has unknown, missing, or mutable-only fields`);
  }
}

function assertCanonicalReference(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !CANONICAL_REFERENCE_PATTERN.test(value)) {
    throw new RoomEvidenceLedgerError("invalid_reference", `${label} must be a canonical non-blank reference`);
  }
}

function assertNullableReference(value: unknown, label: string): void {
  if (value !== null) assertCanonicalReference(value, label);
}

function canonicalReferenceList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new RoomEvidenceLedgerError("invalid_reference", `${label} must be an array of canonical references`);
  }
  const references = [...value];
  for (const reference of references) assertCanonicalReference(reference, label);
  if (references.some((reference, index) => (
    index > 0 && compareRoomText(references[index - 1]!, reference) >= 0
  ))) {
    throw new RoomEvidenceLedgerError(
      "invalid_reference",
      `${label} must be unique and sorted in canonical lexical order`,
    );
  }
  return references;
}

function canonicalUniqueReferenceList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new RoomEvidenceLedgerError("invalid_reference", `${label} must be an array of canonical references`);
  }
  const references = [...value];
  for (const reference of references) assertCanonicalReference(reference, label);
  const canonical = [...references].sort(compareRoomText);
  if (new Set(canonical).size !== canonical.length) {
    throw new RoomEvidenceLedgerError("invalid_reference", `${label} must not contain duplicates`);
  }
  return canonical;
}

function canonicalEvidenceKindList(
  value: unknown,
  label: string,
): readonly RoomEvidenceRecordV1["kind"][] {
  if (!Array.isArray(value)) {
    throw new RoomEvidenceLedgerError("invalid_input", `${label} must be an array of evidence kinds`);
  }
  const kinds = [...value];
  for (const kind of kinds) assertOneOf(kind, ROOM_EVIDENCE_KINDS, label);
  const canonical = [...kinds].sort(compareRoomText) as RoomEvidenceRecordV1["kind"][];
  if (new Set(canonical).size !== canonical.length) {
    throw new RoomEvidenceLedgerError("invalid_input", `${label} must not contain duplicates`);
  }
  return canonical;
}

function normalizeConfidenceCalibration(
  value: AuthorizedRoomConfidenceCalibrationV1 | null,
  computedAt: IsoTimestamp,
): AuthorizedRoomConfidenceCalibrationV1 | null {
  if (value === null) return null;
  assertExactKeys(value, [
    "source", "domain", "outcomeCount", "meanAbsoluteError", "observedAt", "evidenceIds",
  ], "confidence calibration");
  if (value.source !== "authorized_outcome_calibration") {
    throw new RoomEvidenceLedgerError("invalid_input", "Confidence calibration source is not authorized");
  }
  assertNonBlankText(value.domain, "confidence calibration domain");
  assertNonNegativeSafeInteger(value.outcomeCount, "confidence calibration outcome count");
  if (
    typeof value.meanAbsoluteError !== "number"
    || !Number.isFinite(value.meanAbsoluteError)
    || value.meanAbsoluteError < 0
    || value.meanAbsoluteError > 1
  ) {
    throw new RoomEvidenceLedgerError(
      "invalid_input",
      "Confidence calibration mean absolute error must be between zero and one",
    );
  }
  assertCanonicalTimestamp(value.observedAt, "confidence calibration observation time");
  if (Date.parse(value.observedAt) > Date.parse(computedAt)) {
    throw new RoomEvidenceLedgerError(
      "invalid_input",
      "Confidence calibration cannot be observed after confidence computation",
    );
  }
  return {
    source: value.source,
    domain: value.domain,
    outcomeCount: value.outcomeCount,
    meanAbsoluteError: value.meanAbsoluteError,
    observedAt: value.observedAt,
    evidenceIds: canonicalUniqueReferenceList(
      value.evidenceIds,
      "confidence calibration evidence ids",
    ) as readonly RoomEvidenceId[],
  };
}

function assertSameReferences(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  if (
    actual.length !== expected.length
    || actual.some((reference, index) => reference !== expected[index])
  ) {
    throw new RoomEvidenceLedgerError("invalid_reference", `${label} did not resolve exactly`);
  }
}

function assertCanonicalHash(value: unknown, label: string): asserts value is ContentHash {
  if (typeof value !== "string" || !CANONICAL_HASH_PATTERN.test(value)) {
    throw new RoomEvidenceLedgerError("invalid_hash", `${label} must be a lowercase sha256:<64-hex> digest`);
  }
}

function assertCanonicalTimestamp(value: unknown, label: string): asserts value is IsoTimestamp {
  if (typeof value !== "string") {
    throw new RoomEvidenceLedgerError("invalid_input", `${label} must be a canonical UTC ISO timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new RoomEvidenceLedgerError("invalid_input", `${label} must be a canonical UTC ISO timestamp`);
  }
}

function assertNullableTimestamp(value: unknown, label: string): void {
  if (value !== null) assertCanonicalTimestamp(value, label);
}

function assertCanonicalUri(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() !== value) {
    throw new RoomEvidenceLedgerError("invalid_reference", `${label} must be a canonical absolute URI`);
  }
  try {
    if (new URL(value).toString() !== value) {
      throw new RoomEvidenceLedgerError("invalid_reference", `${label} must be a canonical absolute URI`);
    }
  } catch (error) {
    if (error instanceof RoomEvidenceLedgerError) throw error;
    throw new RoomEvidenceLedgerError("invalid_reference", `${label} must be a canonical absolute URI`);
  }
}

function assertIdentity(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new RoomEvidenceLedgerError("invalid_reference", `${label} must preserve one non-blank exact identity`);
  }
}

function assertNonBlankText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim() !== value) {
    throw new RoomEvidenceLedgerError("invalid_input", `${label} must be non-blank without leading or trailing whitespace`);
  }
}

function assertNullableText(value: unknown, label: string): void {
  if (value !== null) assertNonBlankText(value, label);
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new RoomEvidenceLedgerError("invalid_input", `${label} must be boolean`);
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RoomEvidenceLedgerError("invalid_input", `${label} must be a positive safe integer`);
  }
}

function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RoomEvidenceLedgerError("invalid_input", `${label} must be a non-negative safe integer`);
  }
}

function assertNullableInteger(value: unknown, label: string): void {
  if (value !== null && !Number.isSafeInteger(value)) {
    throw new RoomEvidenceLedgerError("invalid_input", `${label} must be a safe integer or null`);
  }
}

function assertNullableNonNegativeInteger(value: unknown, label: string): void {
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) {
    throw new RoomEvidenceLedgerError("invalid_input", `${label} must be a non-negative safe integer or null`);
  }
}

function assertOneOf<TValue extends string>(
  value: unknown,
  allowedValues: readonly TValue[],
  label: string,
): asserts value is TValue {
  if (typeof value !== "string" || !allowedValues.includes(value as TValue)) {
    throw new RoomEvidenceLedgerError("invalid_input", `${label} has an unsupported value`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function referenceNotFound(label: string, id: string): RoomEvidenceLedgerError {
  return new RoomEvidenceLedgerError("reference_not_found", `Room evidence ledger could not resolve ${label} ${id}`);
}

function immutableCopy<TValue>(value: TValue): RoomEvidenceLedgerImmutable<TValue> {
  return deepFreeze(structuredClone(value)) as RoomEvidenceLedgerImmutable<TValue>;
}

function deepFreeze<TValue>(value: TValue, seen = new WeakSet<object>()): TValue {
  if (typeof value !== "object" || value === null) return value;
  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const nestedValue of Object.values(value)) deepFreeze(nestedValue, seen);
  return Object.freeze(value);
}
