import { describe, expect, it } from "vitest";

import type {
  AppendRoomPromotionInputV1,
  RoomCandidateRecordV1,
  RoomDissentRecordV1,
  RoomEvidenceLedgerAppendResult,
  RoomEvidenceLedgerCandidateEvaluation,
  RoomEvidenceLedgerScope,
  RoomEvidenceRecordV1,
  RoomGateResultV1,
  RoomPromotionRecordV1,
  RoomReviewRecordV1,
} from "@fusion/core";
import {
  AsyncRoomEvidenceLedger,
  type RoomEvidenceLedgerPersistence,
  type RoomEvidenceLedgerReferenceQuery,
} from "@fusion/core";

import {
  RoomIndependentArbitrationLedgerAdapter,
  type RoomIndependentArbitrationLedgerAdapterDependenciesV1,
  type RoomIndependentArbitrationPromotionEvidenceSnapshotV1,
} from "../room-independent-arbitration-ledger-adapter.js";
import type {
  AppendRoomIndependentArbitrationDecisionInputV1,
  RoomIndependentArbitrationDecisionV1,
} from "../room-independent-arbitration-coordinator.js";

const SCOPE = {
  projectId: "project-arbitration-adapter",
  roomId: "room-arbitration-adapter",
} as const satisfies RoomEvidenceLedgerScope;
const NODE_ID = "node-arbitration-adapter";
const CANDIDATE_ID = "candidate-arbitration-adapter";
const DECISION_ID = "decision-arbitration-adapter";
const DECIDED_AT = "2026-07-19T13:30:00.000Z";
const HASH = (character: string) => `sha256:${character.repeat(64)}`;

function candidate(): RoomCandidateRecordV1 {
  return {
    contractVersion: 1,
    id: CANDIDATE_ID,
    roomId: SCOPE.roomId,
    nodeId: NODE_ID,
    producingBindingId: "binding-producer",
    nativeSessionId: "native-producer",
    happierSessionId: "happier-producer",
    providerId: "codex",
    modelRef: "gpt-5.6",
    protocolId: "implementation",
    protocolVersion: 1,
    contextVersion: "context-arbitration",
    inputVersion: "input-arbitration",
    configVersion: "config-arbitration",
    contentHash: HASH("a"),
    artifactIds: [],
    parentCandidateIds: [],
    gateResultIds: ["gate-arbitration"],
    reviewIds: ["review-arbitration"],
    promotionState: "pending",
    createdAt: DECIDED_AT,
  };
}

function evidence(id: string): RoomEvidenceRecordV1 {
  return {
    contractVersion: 1,
    id,
    roomId: SCOPE.roomId,
    nodeId: NODE_ID,
    candidateId: CANDIDATE_ID,
    kind: "test",
    authoritativeSourceUri: `evidence://${id}`,
    sourceVersionOrHash: HASH("b"),
    capturedAt: DECIDED_AT,
    collectionMethod: "deterministic-fixture",
    collectorBindingId: "binding-verifier",
    contentHash: HASH("c"),
    artifactIds: [],
    authoritativeSourceRetained: true,
    expiresAt: null,
  };
}

function gate(): RoomGateResultV1 {
  return {
    contractVersion: 1,
    id: "gate-arbitration",
    roomId: SCOPE.roomId,
    nodeId: NODE_ID,
    candidateId: CANDIDATE_ID,
    profileId: "profile-arbitration",
    kind: "test",
    hard: true,
    status: "passed",
    evidenceIds: ["evidence-gate"],
    evaluatorBindingId: "binding-verifier",
    command: "pnpm test",
    exitCode: 0,
    recordedAt: DECIDED_AT,
  };
}

function review(id = "review-arbitration"): RoomReviewRecordV1 {
  return {
    contractVersion: 1,
    id,
    roomId: SCOPE.roomId,
    nodeId: NODE_ID,
    candidateId: CANDIDATE_ID,
    blindCandidateRef: `blind-${id}`,
    reviewerBindingId: "binding-independent-reviewer",
    reviewerNativeSessionId: "native-independent-reviewer",
    reviewerHappierSessionId: "happier-independent-reviewer",
    blind: true,
    producerIdentityHidden: true,
    independentFromProducer: true,
    verdict: "accept",
    rubricVersion: "rubric-arbitration",
    evidenceIds: ["evidence-review"],
    dissentIds: [],
    reviewContentHash: HASH("d"),
    committedAt: DECIDED_AT,
  };
}

function snapshot(
  overrides: Partial<RoomIndependentArbitrationPromotionEvidenceSnapshotV1> = {},
): RoomIndependentArbitrationPromotionEvidenceSnapshotV1 {
  const storedCandidate = candidate();
  const candidateEvaluation: RoomEvidenceLedgerCandidateEvaluation = {
    scope: SCOPE,
    candidate: storedCandidate,
    gateResults: [gate()],
    reviews: [review()],
    dissents: [] as readonly RoomDissentRecordV1[],
    promotions: [],
  };
  return {
    contractVersion: 1,
    scope: SCOPE,
    nodeId: NODE_ID,
    candidateId: CANDIDATE_ID,
    evaluation: candidateEvaluation,
    evidence: [evidence("evidence-gate"), evidence("evidence-review")],
    ...overrides,
  };
}

function decision(
  overrides: Partial<RoomIndependentArbitrationDecisionV1> = {},
): RoomIndependentArbitrationDecisionV1 {
  return {
    contractVersion: 1,
    id: DECISION_ID,
    scope: SCOPE,
    nodeId: NODE_ID,
    decision: "promoted",
    selectedCandidateId: CANDIDATE_ID,
    decisionActorType: "independent_arbiter",
    decisionActorId: "binding-independent-arbiter",
    candidateIds: [CANDIDATE_ID],
    reviewIds: ["review-arbitration"],
    hardGateResultIds: ["gate-arbitration"],
    unresolvedDissentIds: [],
    requiredActions: [],
    rationale: "Independent arbitration selected the only candidate with passing deterministic gates.",
    decidedAt: DECIDED_AT,
    ...overrides,
  };
}

function appendInput(
  decisionOverrides: Partial<RoomIndependentArbitrationDecisionV1> = {},
): AppendRoomIndependentArbitrationDecisionInputV1 {
  return {
    command: {
      commandId: "command-arbitration-adapter",
      idempotencyKey: "idempotency-arbitration-adapter",
      correlationId: "correlation-arbitration-adapter",
      causationId: null,
    },
    decision: decision(decisionOverrides),
  };
}

function fixture(options: {
  readonly evidenceSnapshot?: RoomIndependentArbitrationPromotionEvidenceSnapshotV1;
  readonly appendError?: Error & { readonly code?: string };
} = {}): {
  readonly adapter: RoomIndependentArbitrationLedgerAdapter;
  readonly reads: readonly unknown[];
  readonly appends: readonly AppendRoomPromotionInputV1[];
} {
  const reads: unknown[] = [];
  const appends: AppendRoomPromotionInputV1[] = [];
  const dependencies: RoomIndependentArbitrationLedgerAdapterDependenciesV1 = {
    evidenceReader: {
      async readPromotionEvidence(input) {
        reads.push(input);
        return options.evidenceSnapshot ?? snapshot();
      },
    },
    ledger: {
      async appendPromotion(input) {
        appends.push(input);
        if (options.appendError) throw options.appendError;
        return {
          table: "room_promotions",
          record: {
            id: input.id,
            roomId: input.scope.roomId,
            nodeId: input.nodeId,
            candidateId: input.candidateId,
            decision: input.decision,
            decisionActorId: input.decisionActorId,
          } as RoomPromotionRecordV1,
        } as RoomEvidenceLedgerAppendResult<"room_promotions", RoomPromotionRecordV1>;
      },
    },
  };
  return {
    adapter: new RoomIndependentArbitrationLedgerAdapter(dependencies),
    reads,
    appends,
  };
}

function coreBackedLedger(appended: unknown[]): AsyncRoomEvidenceLedger {
  const storedCandidate = candidate();
  const storedGate = gate();
  const storedReview = review();
  const storedEvidence = [evidence("evidence-gate"), evidence("evidence-review")];
  const evidenceById = new Map(storedEvidence.map((record) => [record.id, record]));
  const persistence: RoomEvidenceLedgerPersistence = {
    transaction: async (operation) => operation({
      resolveReferences: async (query: RoomEvidenceLedgerReferenceQuery) => ({
        scope: query.scope,
        artifacts: [],
        evidence: query.evidenceIds
          .map((id) => evidenceById.get(id))
          .filter((record): record is RoomEvidenceRecordV1 => Boolean(record)),
        candidates: query.candidateIds
          .map((id) => id === storedCandidate.id ? storedCandidate : null)
          .filter((record): record is RoomCandidateRecordV1 => Boolean(record)),
        reviews: query.reviewIds
          .map((id) => id === storedReview.id ? storedReview : null)
          .filter((record): record is RoomReviewRecordV1 => Boolean(record)),
        dissents: [],
        gateResults: query.gateResultIds
          .map((id) => id === storedGate.id ? storedGate : null)
          .filter((record): record is RoomGateResultV1 => Boolean(record)),
      }),
      loadCandidateEvaluation: async () => ({
        scope: SCOPE,
        candidate: storedCandidate,
        gateResults: [storedGate],
        reviews: [storedReview],
        dissents: [],
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

describe("RoomIndependentArbitrationLedgerAdapter", () => {
  it("maps one selected arbitration decision into one immutable Core promotion append", async () => {
    const testFixture = fixture();
    const input = appendInput();

    const record = await testFixture.adapter.appendDecision(input);

    expect(record).toEqual({ recordId: DECISION_ID, replayed: false });
    expect(testFixture.reads).toEqual([expect.objectContaining({
      command: input.command,
      decision: input.decision,
      candidateId: CANDIDATE_ID,
    })]);
    expect(testFixture.appends).toEqual([expect.objectContaining({
      scope: SCOPE,
      id: DECISION_ID,
      nodeId: NODE_ID,
      candidateId: CANDIDATE_ID,
      decision: "promoted",
      decisionActorType: "independent_arbiter",
      decisionActorId: "binding-independent-arbiter",
      hardGateResultIds: ["gate-arbitration"],
      reviewIds: ["review-arbitration"],
      unresolvedDissentIds: [],
      evidenceIds: ["evidence-gate", "evidence-review"],
    })]);
  });

  it("runs the synthesized promotion through the real Core appendPromotion hard-gate and independence checks", async () => {
    const appended: unknown[] = [];
    const adapter = new RoomIndependentArbitrationLedgerAdapter({
      evidenceReader: {
        async readPromotionEvidence() {
          return snapshot();
        },
      },
      ledger: coreBackedLedger(appended),
    });

    await expect(adapter.appendDecision(appendInput())).resolves.toEqual({
      recordId: DECISION_ID,
      replayed: false,
    });
    expect(appended).toEqual([expect.objectContaining({
      table: "room_promotions",
      record: expect.objectContaining({
        id: DECISION_ID,
        candidateId: CANDIDATE_ID,
        decisionActorId: "binding-independent-arbiter",
      }),
    })]);
  });

  it("rejects source snapshots that inject references not authorized by the arbitration decision", async () => {
    const injectedReview = review("review-injected");
    const injectedSnapshot = snapshot({
      evaluation: {
        ...snapshot().evaluation,
        reviews: [injectedReview],
      },
    });
    const testFixture = fixture({ evidenceSnapshot: injectedSnapshot });

    await expect(testFixture.adapter.appendDecision(appendInput())).rejects.toMatchObject({
      code: "evidence_snapshot_invalid",
    });
    expect(testFixture.appends).toHaveLength(0);
  });

  it("rejects an otherwise authorized hard-gate record from another Room task node before Core append", async () => {
    const crossNodeSnapshot = snapshot({
      evaluation: {
        ...snapshot().evaluation,
        gateResults: [{ ...gate(), nodeId: "node-arbitration-other" }],
      },
    });
    const testFixture = fixture({ evidenceSnapshot: crossNodeSnapshot });

    await expect(testFixture.adapter.appendDecision(appendInput())).rejects.toMatchObject({
      code: "evidence_snapshot_invalid",
    });
    expect(testFixture.appends).toHaveLength(0);
  });

  it("returns a typed failure instead of a runtime crash for a malformed DI evidence snapshot", async () => {
    const malformedSnapshot = snapshot({ evaluation: null as never });
    const testFixture = fixture({ evidenceSnapshot: malformedSnapshot });

    await expect(testFixture.adapter.appendDecision(appendInput())).rejects.toMatchObject({
      code: "evidence_snapshot_invalid",
    });
    expect(testFixture.appends).toHaveLength(0);
  });

  it("does not report success when Core rejects the typed immutable promotion append", async () => {
    const coreError = Object.assign(
      new Error("A hard gate failed after the adapter read its snapshot."),
      { code: "hard_gate_failed" },
    );
    const testFixture = fixture({ appendError: coreError });
    const input = appendInput();

    await expect(testFixture.adapter.appendDecision(input)).rejects.toBe(coreError);
    expect(testFixture.appends).toEqual([expect.objectContaining({
      decisionActorId: "binding-independent-arbiter",
    })]);
  });

  it("prevents a candidate producer from reaching the Core promotion append as an arbiter", async () => {
    const testFixture = fixture();

    await expect(testFixture.adapter.appendDecision(appendInput({
      decisionActorId: "binding-producer",
    }))).rejects.toMatchObject({ code: "evidence_snapshot_invalid" });
    expect(testFixture.appends).toHaveLength(0);
  });

  it("fails closed for multi-candidate escalations because the current immutable promotion contract is candidate-scoped", async () => {
    const testFixture = fixture();
    const input = appendInput({
      decision: "escalated",
      selectedCandidateId: null,
      candidateIds: [CANDIDATE_ID, "candidate-second"],
    });

    await expect(testFixture.adapter.appendDecision(input)).rejects.toMatchObject({
      code: "candidate_target_ambiguous",
    });
    expect(testFixture.reads).toHaveLength(0);
    expect(testFixture.appends).toHaveLength(0);
  });
});
