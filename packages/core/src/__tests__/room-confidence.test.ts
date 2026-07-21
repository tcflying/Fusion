import { describe, expect, it } from "vitest";

import type {
  RoomDissentRecordV1,
  RoomEvidenceRecordV1,
  RoomGateResultV1,
  RoomReviewRecordV1,
} from "../room-contracts/evidence.js";
import {
  evaluateRoomConfidenceSnapshot,
  type RoomConfidenceEvaluationInputV1,
} from "../room-confidence.js";

const ROOM_ID = "room-confidence";
const NODE_ID = "node-confidence";
const CANDIDATE_ID = "candidate-confidence";
const COMPUTED_AT = "2026-07-18T12:30:00.000Z";

function evidence(
  id: string,
  kind: RoomEvidenceRecordV1["kind"],
  expiresAt: string | null = "2026-07-18T12:35:00.000Z",
): RoomEvidenceRecordV1 {
  return {
    contractVersion: 1,
    id,
    roomId: ROOM_ID,
    nodeId: NODE_ID,
    candidateId: CANDIDATE_ID,
    kind,
    authoritativeSourceUri: `evidence://${id}`,
    sourceVersionOrHash: `sha256:source-${id}`,
    capturedAt: "2026-07-18T12:20:00.000Z",
    collectionMethod: "deterministic_fixture",
    collectorBindingId: null,
    contentHash: `sha256:content-${id}`,
    artifactIds: [],
    authoritativeSourceRetained: true,
    expiresAt,
  };
}

function passedGate(id = "gate-confidence"): RoomGateResultV1 {
  return {
    contractVersion: 1,
    id,
    roomId: ROOM_ID,
    nodeId: NODE_ID,
    candidateId: CANDIDATE_ID,
    profileId: "profile-confidence",
    kind: "test",
    hard: true,
    status: "passed",
    evidenceIds: ["evidence-test"],
    evaluatorBindingId: "binding-independent-verifier",
    command: "pnpm test",
    exitCode: 0,
    recordedAt: "2026-07-18T12:21:00.000Z",
  };
}

function independentReview(id: string): RoomReviewRecordV1 {
  return {
    contractVersion: 1,
    id,
    roomId: ROOM_ID,
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
    rubricVersion: "confidence-rubric/v1",
    evidenceIds: ["evidence-source"],
    dissentIds: [],
    reviewContentHash: `sha256:review-${id}`,
    committedAt: "2026-07-18T12:22:00.000Z",
  };
}

function dissent(overrides: Partial<RoomDissentRecordV1> = {}): RoomDissentRecordV1 {
  return {
    contractVersion: 1,
    id: "dissent-confidence",
    roomId: ROOM_ID,
    nodeId: NODE_ID,
    candidateId: CANDIDATE_ID,
    reviewId: "review-a",
    severity: "critical",
    state: "open",
    ownerId: "binding-owner",
    evidenceIds: ["evidence-source"],
    contentHash: "sha256:dissent-confidence",
    resolution: null,
    createdAt: "2026-07-18T12:23:00.000Z",
    updatedAt: "2026-07-18T12:23:00.000Z",
    ...overrides,
  };
}

function input(
  overrides: Partial<RoomConfidenceEvaluationInputV1> = {},
): RoomConfidenceEvaluationInputV1 {
  return {
    contractVersion: 1,
    id: "confidence-snapshot-1",
    roomId: ROOM_ID,
    nodeId: NODE_ID,
    candidateId: CANDIDATE_ID,
    methodologyVersion: "room-confidence/v1",
    computedAt: COMPUTED_AT,
    requiredEvidenceKinds: ["test", "source"],
    evidence: [
      evidence("evidence-test", "test"),
      evidence("evidence-source", "source"),
    ],
    gateResults: [passedGate()],
    reviews: [independentReview("review-a"), independentReview("review-b")],
    dissents: [],
    calibration: {
      source: "authorized_outcome_calibration",
      domain: "code",
      outcomeCount: 24,
      meanAbsoluteError: 0.05,
      observedAt: "2026-07-18T12:25:00.000Z",
      evidenceIds: ["evidence-source"],
    },
    ...overrides,
  };
}

function dimension(result: ReturnType<typeof evaluateRoomConfidenceSnapshot>, name: string) {
  return result.dimensions.find((entry) => entry.name === name);
}

describe("evaluateRoomConfidenceSnapshot", () => {
  it("derives high only from fresh authoritative evidence, hard validation, independent agreement, and calibration", () => {
    const result = evaluateRoomConfidenceSnapshot(input());

    expect(result.band).toBe("high");
    expect(result.modelSelfReportExcluded).toBe(true);
    expect(result.staleEvidenceIds).toEqual([]);
    expect(result.unresolvedDissentIds).toEqual([]);
    expect(result.inputEvidenceHash).toMatch(/^sha256:/u);
    expect(result.dimensions).toHaveLength(7);
    expect(result.dimensions.every((entry) => entry.band === "high")).toBe(true);
  });

  it("makes expired decisive evidence visible and refuses a high confidence band", () => {
    const result = evaluateRoomConfidenceSnapshot(input({
      evidence: [
        evidence("evidence-test", "test", "2026-07-18T12:29:59.999Z"),
        evidence("evidence-source", "source"),
      ],
    }));

    expect(result.band).toBe("low");
    expect(result.staleEvidenceIds).toEqual(["evidence-test"]);
    expect(dimension(result, "freshness")).toMatchObject({ band: "low" });
  });

  it("makes an open critical dissent dominate consensus and validation", () => {
    const result = evaluateRoomConfidenceSnapshot(input({
      dissents: [dissent()],
    }));

    expect(result.band).toBe("low");
    expect(result.unresolvedDissentIds).toEqual(["dissent-confidence"]);
    expect(dimension(result, "unresolved_dissent")).toMatchObject({ band: "low" });
  });

  it("reports unknown when authorized historical calibration is absent", () => {
    const result = evaluateRoomConfidenceSnapshot(input({ calibration: null }));

    expect(result.band).toBe("unknown");
    expect(dimension(result, "historical_calibration")).toMatchObject({ band: "unknown" });
  });
});
