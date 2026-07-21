import { describe, expect, it } from "vitest";

import {
  AsyncRoomEvidenceLedger,
  type RoomEvidenceLedgerPersistence,
  type RoomEvidenceLedgerReferenceQuery,
} from "../async-room-evidence-ledger.js";
import type {
  RoomCandidateRecordV1,
  RoomDissentRecordV1,
  RoomEvidenceRecordV1,
  RoomGateResultV1,
  RoomReviewRecordV1,
} from "../room-contracts/evidence.js";

const SCOPE = { projectId: "project-confidence-ledger", roomId: "room-confidence-ledger" } as const;
const NODE_ID = "node-confidence-ledger";
const CANDIDATE_ID = "candidate-confidence-ledger";
const COMPUTED_AT = "2026-07-18T13:00:00.000Z";

const evidence: readonly RoomEvidenceRecordV1[] = [
  {
    contractVersion: 1,
    id: "evidence-test",
    roomId: SCOPE.roomId,
    nodeId: NODE_ID,
    candidateId: CANDIDATE_ID,
    kind: "test",
    authoritativeSourceUri: "evidence://test",
    sourceVersionOrHash: "sha256:source-test",
    capturedAt: "2026-07-18T12:50:00.000Z",
    collectionMethod: "deterministic_fixture",
    collectorBindingId: null,
    contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    artifactIds: [],
    authoritativeSourceRetained: true,
    expiresAt: "2026-07-18T13:05:00.000Z",
  },
  {
    contractVersion: 1,
    id: "evidence-source",
    roomId: SCOPE.roomId,
    nodeId: NODE_ID,
    candidateId: CANDIDATE_ID,
    kind: "source",
    authoritativeSourceUri: "evidence://source",
    sourceVersionOrHash: "sha256:source-source",
    capturedAt: "2026-07-18T12:51:00.000Z",
    collectionMethod: "deterministic_fixture",
    collectorBindingId: null,
    contentHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    artifactIds: [],
    authoritativeSourceRetained: true,
    expiresAt: "2026-07-18T13:05:00.000Z",
  },
];

const candidate: RoomCandidateRecordV1 = {
  contractVersion: 1,
  id: CANDIDATE_ID,
  roomId: SCOPE.roomId,
  nodeId: NODE_ID,
  producingBindingId: "binding-producer",
  nativeSessionId: "native-producer",
  happierSessionId: "happier-producer",
  providerId: "codex",
  modelRef: "gpt-5.6",
  protocolId: "implementation-review",
  protocolVersion: 1,
  contextVersion: "context-v1",
  inputVersion: "input-v1",
  configVersion: "config-v1",
  contentHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  artifactIds: [],
  parentCandidateIds: [],
  gateResultIds: ["gate-confidence"],
  reviewIds: ["review-a", "review-b"],
  promotionState: "eligible",
  createdAt: "2026-07-18T12:49:00.000Z",
};

const gates: readonly RoomGateResultV1[] = [{
  contractVersion: 1,
  id: "gate-confidence",
  roomId: SCOPE.roomId,
  nodeId: NODE_ID,
  candidateId: CANDIDATE_ID,
  profileId: "code-profile",
  kind: "test",
  hard: true,
  status: "passed",
  evidenceIds: ["evidence-test"],
  evaluatorBindingId: "binding-verifier",
  command: "pnpm test",
  exitCode: 0,
  recordedAt: "2026-07-18T12:52:00.000Z",
}];

function review(id: string): RoomReviewRecordV1 {
  return {
    contractVersion: 1,
    id,
    roomId: SCOPE.roomId,
    nodeId: NODE_ID,
    candidateId: CANDIDATE_ID,
    blindCandidateRef: `blind-${id}`,
    reviewerBindingId: `binding-${id}`,
    reviewerNativeSessionId: `native-${id}`,
    reviewerHappierSessionId: `happier-${id}`,
    blind: true,
    producerIdentityHidden: true,
    independentFromProducer: true,
    verdict: "accept",
    rubricVersion: "rubric-v1",
    evidenceIds: ["evidence-source"],
    dissentIds: [],
    reviewContentHash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    committedAt: "2026-07-18T12:53:00.000Z",
  };
}

const reviews = [review("review-a"), review("review-b")];
const dissents: readonly RoomDissentRecordV1[] = [];

function createLedger(appended: unknown[]): AsyncRoomEvidenceLedger {
  const evidenceById = new Map(evidence.map((record) => [record.id, record]));
  const reviewById = new Map(reviews.map((record) => [record.id, record]));
  const gateById = new Map(gates.map((record) => [record.id, record]));
  const persistence: RoomEvidenceLedgerPersistence = {
    transaction: async (operation) => operation({
      resolveReferences: async (query: RoomEvidenceLedgerReferenceQuery) => ({
        scope: query.scope,
        artifacts: [],
        evidence: query.evidenceIds.map((id) => evidenceById.get(id)).filter((record): record is RoomEvidenceRecordV1 => Boolean(record)),
        candidates: query.candidateIds.map((id) => id === candidate.id ? candidate : null).filter((record): record is RoomCandidateRecordV1 => Boolean(record)),
        reviews: query.reviewIds.map((id) => reviewById.get(id)).filter((record): record is RoomReviewRecordV1 => Boolean(record)),
        dissents: [],
        gateResults: query.gateResultIds.map((id) => gateById.get(id)).filter((record): record is RoomGateResultV1 => Boolean(record)),
      }),
      loadCandidateEvaluation: async () => ({
        scope: SCOPE,
        candidate,
        gateResults: gates,
        reviews,
        dissents,
        promotions: [],
      }),
      append: async (input) => {
        appended.push(input.entry);
        return { status: "inserted", recordId: input.entry.record.id };
      },
    }),
  };
  return new AsyncRoomEvidenceLedger(persistence);
}

describe("AsyncRoomEvidenceLedger confidence snapshots", () => {
  it("derives and appends one immutable confidence snapshot from persisted candidate evidence", async () => {
    const appended: unknown[] = [];
    const ledger = createLedger(appended);

    const result = await ledger.appendConfidenceSnapshot({
      scope: SCOPE,
      id: "confidence-snapshot-ledger",
      nodeId: NODE_ID,
      candidateId: CANDIDATE_ID,
      methodologyVersion: "room-confidence/v1",
      computedAt: COMPUTED_AT,
      requiredEvidenceKinds: ["test", "source"],
      evidenceIds: ["evidence-test", "evidence-source"],
      calibration: {
        source: "authorized_outcome_calibration",
        domain: "code",
        outcomeCount: 24,
        meanAbsoluteError: 0.05,
        observedAt: "2026-07-18T12:54:00.000Z",
        evidenceIds: ["evidence-source"],
      },
    });

    expect(result).toMatchObject({
      table: "room_confidence_snapshots",
      record: {
        id: "confidence-snapshot-ledger",
        band: "high",
        modelSelfReportExcluded: true,
      },
    });
    expect(appended).toHaveLength(1);
  });
});
