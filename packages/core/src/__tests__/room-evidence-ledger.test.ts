import { describe, expect, it } from "vitest";

import {
  AsyncRoomEvidenceLedger,
  type AppendRoomArtifactInputV1,
  type AppendRoomEvidenceInputV1,
  type AppendRoomPromotionInputV1,
  type AppendRoomReviewInputV1,
  type RoomEvidenceLedgerAppendOutcome,
  type RoomEvidenceLedgerCandidateEvaluation,
  type RoomEvidenceLedgerEntry,
  type RoomEvidenceLedgerPersistence,
  type RoomEvidenceLedgerReferenceQuery,
  type RoomEvidenceLedgerReferenceSnapshot,
  type RoomEvidenceLedgerScope,
  type RoomEvidenceLedgerTransaction,
} from "../async-room-evidence-ledger.js";
import {
  type RoomArtifactRecordV1,
  type RoomCandidateRecordV1,
  type RoomDissentRecordV1,
  type RoomEvidenceRecordV1,
  type RoomGateResultV1,
  type RoomPromotionRecordV1,
  type RoomReviewRecordV1,
} from "../room-contracts/evidence.js";
import { ROOM_CONTRACT_VERSIONS } from "../room-contracts/versions.js";
import { hashRoomValue } from "../room-integrity.js";

const SCOPE = {
  projectId: "project-1",
  roomId: "room-1",
} as const satisfies RoomEvidenceLedgerScope;
const CREATED_AT = "2026-07-19T08:03:00.000Z";
const hash = (value: string): string => hashRoomValue(value);

class RecordingLedgerPersistence implements RoomEvidenceLedgerPersistence, RoomEvidenceLedgerTransaction {
  readonly artifacts: RoomArtifactRecordV1[] = [];
  readonly evidence: RoomEvidenceRecordV1[] = [];
  readonly candidates: RoomCandidateRecordV1[] = [];
  readonly reviews: RoomReviewRecordV1[] = [];
  readonly dissents: RoomDissentRecordV1[] = [];
  readonly gateResults: RoomGateResultV1[] = [];
  readonly appends: RoomEvidenceLedgerEntry[] = [];
  candidateEvaluation: RoomEvidenceLedgerCandidateEvaluation | null = null;
  nextAppendOutcome: RoomEvidenceLedgerAppendOutcome | null = null;

  async transaction<TResult>(
    operation: (transaction: RoomEvidenceLedgerTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    return operation(this);
  }

  async resolveReferences(input: RoomEvidenceLedgerReferenceQuery): Promise<RoomEvidenceLedgerReferenceSnapshot> {
    return {
      scope: input.scope,
      artifacts: this.select(this.artifacts, input.artifactIds),
      evidence: this.select(this.evidence, input.evidenceIds),
      candidates: this.select(this.candidates, input.candidateIds),
      reviews: this.select(this.reviews, input.reviewIds),
      dissents: this.select(this.dissents, input.dissentIds),
      gateResults: this.select(this.gateResults, input.gateResultIds),
    };
  }

  async loadCandidateEvaluation(): Promise<RoomEvidenceLedgerCandidateEvaluation | null> {
    return this.candidateEvaluation;
  }

  async append(input: {
    readonly scope: RoomEvidenceLedgerScope;
    readonly entry: RoomEvidenceLedgerEntry;
  }): Promise<RoomEvidenceLedgerAppendOutcome> {
    this.appends.push(input.entry);
    return this.nextAppendOutcome ?? { status: "inserted", recordId: input.entry.record.id };
  }

  private select<TRecord extends { readonly id: string }>(
    records: readonly TRecord[],
    ids: readonly string[],
  ): readonly TRecord[] {
    return ids.flatMap((id) => records.filter((record) => record.id === id));
  }
}

function artifactInput(overrides: Partial<AppendRoomArtifactInputV1> = {}): AppendRoomArtifactInputV1 {
  return {
    scope: SCOPE,
    id: "artifact-1",
    nodeId: "node-1",
    candidateId: null,
    kind: "code",
    mediaType: "text/plain",
    uri: "https://evidence.example/artifacts/artifact-1",
    contentHash: hash("artifact-1"),
    producingBindingId: "binding-producer",
    sourceRevision: "revision-1",
    sizeBytes: 42,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function evidenceInput(overrides: Partial<AppendRoomEvidenceInputV1> = {}): AppendRoomEvidenceInputV1 {
  return {
    scope: SCOPE,
    id: "evidence-1",
    nodeId: "node-1",
    candidateId: null,
    kind: "test",
    authoritativeSourceUri: "https://evidence.example/results/test-1",
    sourceVersionOrHash: "revision-1",
    capturedAt: CREATED_AT,
    collectionMethod: "vitest",
    collectorBindingId: "binding-verifier",
    contentHash: hash("evidence-1"),
    artifactIds: [],
    expiresAt: null,
    ...overrides,
  };
}

function candidateRecord(overrides: Partial<RoomCandidateRecordV1> = {}): RoomCandidateRecordV1 {
  return {
    contractVersion: ROOM_CONTRACT_VERSIONS.evidence,
    id: "candidate-1",
    roomId: SCOPE.roomId,
    nodeId: "node-1",
    producingBindingId: "binding-producer",
    nativeSessionId: "native-producer",
    happierSessionId: "happier-producer",
    providerId: "codex",
    modelRef: "provider-owned-model",
    protocolId: "implementation",
    protocolVersion: 1,
    contextVersion: "context-1",
    inputVersion: "input-1",
    configVersion: "config-1",
    contentHash: hash("candidate-1"),
    artifactIds: ["artifact-1"],
    parentCandidateIds: [],
    gateResultIds: ["gate-hard"],
    reviewIds: ["review-independent"],
    promotionState: "pending",
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function reviewInput(overrides: Partial<AppendRoomReviewInputV1> = {}): AppendRoomReviewInputV1 {
  return {
    scope: SCOPE,
    id: "review-independent",
    nodeId: "node-1",
    candidateId: "candidate-1",
    blindCandidateRef: "blind-candidate-a",
    reviewerBindingId: "binding-reviewer",
    reviewerNativeSessionId: "native-reviewer",
    reviewerHappierSessionId: "happier-reviewer",
    blind: true,
    producerIdentityHidden: true,
    independentFromProducer: true,
    verdict: "accept",
    rubricVersion: "rubric-1",
    evidenceIds: [],
    dissentIds: [],
    reviewContentHash: hash("review-independent"),
    committedAt: CREATED_AT,
    ...overrides,
  };
}

function reviewRecord(overrides: Partial<RoomReviewRecordV1> = {}): RoomReviewRecordV1 {
  return {
    contractVersion: ROOM_CONTRACT_VERSIONS.evidence,
    id: "review-independent",
    roomId: SCOPE.roomId,
    nodeId: "node-1",
    candidateId: "candidate-1",
    blindCandidateRef: "blind-candidate-a",
    reviewerBindingId: "binding-reviewer",
    reviewerNativeSessionId: "native-reviewer",
    reviewerHappierSessionId: "happier-reviewer",
    blind: true,
    producerIdentityHidden: true,
    independentFromProducer: true,
    verdict: "accept",
    rubricVersion: "rubric-1",
    evidenceIds: [],
    dissentIds: [],
    reviewContentHash: hash("review-independent"),
    committedAt: CREATED_AT,
    ...overrides,
  };
}

function gateResult(status: RoomGateResultV1["status"]): RoomGateResultV1 {
  return {
    contractVersion: ROOM_CONTRACT_VERSIONS.evidence,
    id: "gate-hard",
    roomId: SCOPE.roomId,
    nodeId: "node-1",
    candidateId: "candidate-1",
    profileId: "locked-constraints",
    kind: "policy",
    hard: true,
    status,
    evidenceIds: [],
    evaluatorBindingId: null,
    command: null,
    exitCode: null,
    recordedAt: CREATED_AT,
  };
}

function promotionInput(overrides: Partial<AppendRoomPromotionInputV1> = {}): AppendRoomPromotionInputV1 {
  return {
    scope: SCOPE,
    id: "promotion-1",
    nodeId: "node-1",
    candidateId: "candidate-1",
    decision: "promoted",
    decisionActorType: "independent_arbiter",
    decisionActorId: "binding-arbiter",
    hardGateResultIds: ["gate-hard"],
    reviewIds: ["review-independent"],
    unresolvedDissentIds: [],
    evidenceIds: [],
    rationale: "Independent review and the hard gate passed.",
    decidedAt: CREATED_AT,
    ...overrides,
  };
}

function candidateEvaluation(
  candidate: RoomCandidateRecordV1,
  gate: RoomGateResultV1,
  review: RoomReviewRecordV1,
  dissents: readonly RoomDissentRecordV1[] = [],
  promotions: readonly RoomPromotionRecordV1[] = [],
): RoomEvidenceLedgerCandidateEvaluation {
  return {
    scope: SCOPE,
    candidate,
    gateResults: [gate],
    reviews: [review],
    dissents,
    promotions,
  };
}

describe("AsyncRoomEvidenceLedger", () => {
  it("rejects non-canonical hashes and unordered references before persistence", async () => {
    const persistence = new RecordingLedgerPersistence();
    const ledger = new AsyncRoomEvidenceLedger(persistence);

    await expect(ledger.appendArtifact(artifactInput({ contentHash: "sha256:ABC" }))).rejects.toMatchObject({
      code: "invalid_hash",
    });
    await expect(ledger.appendEvidence(evidenceInput({ artifactIds: ["artifact-z", "artifact-a"] }))).rejects.toMatchObject({
      code: "invalid_reference",
    });

    expect(persistence.appends).toHaveLength(0);
  });

  it("keeps caller IDs and hashes immutable and records an INSERT-only artifact", async () => {
    const persistence = new RecordingLedgerPersistence();
    const ledger = new AsyncRoomEvidenceLedger(persistence);
    const input = artifactInput();

    const result = await ledger.appendArtifact(input);
    (input as { contentHash: string }).contentHash = hash("mutated-after-append");

    expect(result).toMatchObject({
      table: "room_artifacts",
      record: {
        id: "artifact-1",
        contentHash: hash("artifact-1"),
        immutable: true,
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.record)).toBe(true);
    expect(persistence.appends).toHaveLength(1);
    expect(Object.isFrozen(persistence.appends[0]!.record)).toBe(true);
  });

  it("fails closed when a reviewer shares any producer identity or omits the independence attestation", async () => {
    const persistence = new RecordingLedgerPersistence();
    const candidate = candidateRecord();
    persistence.candidates.push(candidate);
    const ledger = new AsyncRoomEvidenceLedger(persistence);

    await expect(ledger.appendReview(reviewInput({
      reviewerBindingId: candidate.producingBindingId,
      reviewerNativeSessionId: candidate.nativeSessionId,
      reviewerHappierSessionId: candidate.happierSessionId,
    }))).rejects.toMatchObject({ code: "self_review_forbidden" });
    await expect(ledger.appendReview(reviewInput({
      independentFromProducer: false as never,
    }))).rejects.toMatchObject({ code: "independent_review_required" });

    expect(persistence.appends).toHaveLength(0);
  });

  it("does not let an accepting review override a failed hard gate", async () => {
    const persistence = new RecordingLedgerPersistence();
    const candidate = candidateRecord();
    const review = reviewRecord();
    const failedGate = gateResult("failed");
    persistence.candidates.push(candidate);
    persistence.reviews.push(review);
    persistence.gateResults.push(failedGate);
    persistence.candidateEvaluation = candidateEvaluation(candidate, failedGate, review);
    const ledger = new AsyncRoomEvidenceLedger(persistence);

    await expect(ledger.appendPromotion(promotionInput())).rejects.toMatchObject({
      code: "hard_gate_failed",
    });
    expect(persistence.appends).toHaveLength(0);
  });

  it("rejects self-promotion even when independent review and hard gates pass", async () => {
    const persistence = new RecordingLedgerPersistence();
    const candidate = candidateRecord();
    const review = reviewRecord();
    const passedGate = gateResult("passed");
    persistence.candidates.push(candidate);
    persistence.reviews.push(review);
    persistence.gateResults.push(passedGate);
    persistence.candidateEvaluation = candidateEvaluation(candidate, passedGate, review);
    const ledger = new AsyncRoomEvidenceLedger(persistence);

    await expect(ledger.appendPromotion(promotionInput({
      decisionActorId: candidate.producingBindingId,
    }))).rejects.toMatchObject({ code: "self_promotion_forbidden" });
    expect(persistence.appends).toHaveLength(0);
  });

  it("rejects persistence conflicts instead of overwriting an immutable ledger record", async () => {
    const persistence = new RecordingLedgerPersistence();
    persistence.nextAppendOutcome = { status: "conflict", recordId: "artifact-1" };
    const ledger = new AsyncRoomEvidenceLedger(persistence);

    await expect(ledger.appendArtifact(artifactInput())).rejects.toMatchObject({
      code: "immutable_conflict",
    });
    expect(persistence.appends).toHaveLength(1);
    expect(persistence.appends[0]).toMatchObject({ table: "room_artifacts", record: { id: "artifact-1" } });
  });
});
