import {
  compareRoomText,
  hashRoomValue,
  RoomDeterministicGatePolicy,
  type RoomEvidenceLedgerAppendResult,
  type RoomEvidenceLedgerScope,
  type RoomPromotionRecordV1,
} from "@fusion/core";
import { describe, expect, it } from "vitest";

import {
  RoomDeterministicGatePromotionCoordinator,
  type AppendRoomDeterministicGatePromotionInputV1,
  type RequestRoomDeterministicGatePromotionV1,
  type RoomDeterministicGatePromotionCoordinatorDependenciesV1,
  type RoomDeterministicGatePromotionPolicySnapshotV1,
} from "../room-deterministic-gate-promotion-coordinator.js";

type GatePolicyInputV1 = RoomDeterministicGatePolicy.EvaluateRoomDeterministicGatePolicyInputV1;

const SCOPE = {
  projectId: "project-deterministic-gates",
  roomId: "room-deterministic-gates",
} as RoomEvidenceLedgerScope;
const HASH = (character: string) => `sha256:${character.repeat(64)}`;
const DECIDED_AT = "2026-07-18T13:40:00.000Z";

function policyInput(
  overrides: Partial<GatePolicyInputV1> = {},
): GatePolicyInputV1 {
  const gates = [
    { id: "gate-rule", kind: "rule", hard: true as const, requiredEvidenceKinds: ["rule"] as const },
    { id: "gate-test", kind: "test", hard: true as const, requiredEvidenceKinds: ["test"] as const },
    { id: "gate-source", kind: "source", hard: true as const, requiredEvidenceKinds: ["source"] as const },
    { id: "gate-runtime", kind: "runtime", hard: true as const, requiredEvidenceKinds: ["runtime"] as const },
  ];
  const inputHash = hashRoomValue({
    contractVersion: 1,
    subjectId: "candidate-deterministic",
    subjectHash: HASH("a"),
    contextHash: HASH("b"),
    gates: gates
      .map((gate) => ({ ...gate, requiredEvidenceKinds: [...gate.requiredEvidenceKinds] }))
      .sort((left, right) => compareRoomText(left.id, right.id)),
  });
  return {
    contractVersion: 1,
    subjectId: "candidate-deterministic",
    subjectHash: HASH("a"),
    contextHash: HASH("b"),
    evaluatedAt: DECIDED_AT,
    gates,
    evidence: gates.map((gate, index) => ({
      id: `policy-evidence-${gate.kind}`,
      kind: gate.kind,
      reference: `evidence-reference-${gate.kind}`,
      contentHash: HASH(String.fromCharCode(99 + index)),
      recordedAt: DECIDED_AT,
    })),
    results: gates.map((gate) => ({
      gateId: gate.id,
      verdict: "passed" as const,
      inputHash,
      evidenceIds: [`policy-evidence-${gate.kind}`],
      responsibility: `executor-${gate.kind}`,
      failureReason: null,
    })),
    modelVotes: [{ voterBindingId: "binding-model-a", decision: "accept" }],
    arbiter: { bindingId: "binding-arbiter", decision: "accept", rationale: "audit-only preference" },
    ...overrides,
  };
}

function policyHash(input: GatePolicyInputV1): string {
  const decision = RoomDeterministicGatePolicy.evaluateRoomDeterministicGatePolicy(input);
  if (decision.inputHash === null) throw new Error("fixture must be a valid policy input");
  return decision.inputHash;
}

function snapshot(
  input: GatePolicyInputV1 = policyInput(),
  overrides: Partial<RoomDeterministicGatePromotionPolicySnapshotV1> = {},
): RoomDeterministicGatePromotionPolicySnapshotV1 {
  return {
    contractVersion: 1,
    scope: SCOPE,
    candidateId: "candidate-deterministic",
    nodeId: "node-deterministic",
    policyInputHash: policyHash(input),
    policyInput: input,
    evidenceRefs: input.evidence.map((evidence) => ({
      policyEvidenceId: evidence.id,
      evidenceId: `ledger-${evidence.id}`,
    })),
    hardGateRefs: input.gates.map((gate) => ({
      policyGateId: gate.id,
      gateResultId: `ledger-${gate.id}`,
    })),
    ...overrides,
  };
}

function request(
  overrides: Partial<RequestRoomDeterministicGatePromotionV1> = {},
): RequestRoomDeterministicGatePromotionV1 {
  const input = policyInput();
  return {
    contractVersion: 1,
    scope: SCOPE,
    candidateId: "candidate-deterministic",
    nodeId: "node-deterministic",
    expectedPolicyInputHash: policyHash(input),
    promotion: {
      id: "promotion-deterministic",
      decisionActorType: "controller",
      decisionActorId: "binding-controller",
      reviewIds: ["review-independent"],
      unresolvedDissentIds: [],
      rationale: "All deterministic gates passed; votes remain audit-only.",
      decidedAt: DECIDED_AT,
    },
    command: {
      commandId: "command-deterministic",
      idempotencyKey: "idempotency-deterministic",
      correlationId: "correlation-deterministic",
      causationId: "cause-deterministic",
    },
    ...overrides,
  };
}

function fixture(policySnapshot: RoomDeterministicGatePromotionPolicySnapshotV1): {
  readonly coordinator: RoomDeterministicGatePromotionCoordinator;
  readonly reads: readonly unknown[];
  readonly appends: readonly AppendRoomDeterministicGatePromotionInputV1[];
} {
  const reads: unknown[] = [];
  const appends: AppendRoomDeterministicGatePromotionInputV1[] = [];
  const dependencies: RoomDeterministicGatePromotionCoordinatorDependenciesV1 = {
    policyReader: {
      async readDeterministicGatePromotionPolicy(input) {
        reads.push(input);
        return policySnapshot;
      },
    },
    promotionPort: {
      async appendPromotion(input) {
        appends.push(input);
        return {
          table: "room_promotions",
          record: {
            id: input.promotion.id,
            roomId: input.promotion.scope.roomId,
            nodeId: input.promotion.nodeId,
            candidateId: input.promotion.candidateId,
            decision: input.promotion.decision,
          } as RoomPromotionRecordV1,
        } as RoomEvidenceLedgerAppendResult<"room_promotions", RoomPromotionRecordV1>;
      },
    },
  };
  return {
    coordinator: new RoomDeterministicGatePromotionCoordinator(dependencies),
    reads,
    appends,
  };
}

describe("RoomDeterministicGatePromotionCoordinator", () => {
  it("withholds a failed hard gate despite a majority of accepting model votes", async () => {
    const input = policyInput();
    const failed = {
      ...input,
      results: input.results.map((result) => result.gateId === "gate-runtime"
        ? { ...result, verdict: "failed" as const, failureReason: "runtime health probe failed" }
        : result),
      modelVotes: [
        { voterBindingId: "binding-model-a", decision: "accept" as const },
        { voterBindingId: "binding-model-b", decision: "accept" as const },
        { voterBindingId: "binding-model-c", decision: "accept" as const },
      ],
      arbiter: { bindingId: "binding-arbiter", decision: "accept" as const, rationale: "audit-only preference" },
    };
    const testFixture = fixture(snapshot(failed));

    const result = await testFixture.coordinator.promote(request({ expectedPolicyInputHash: policyHash(failed) }));

    expect(result.status).toBe("withheld");
    expect(testFixture.appends).toHaveLength(0);
    if (result.status === "withheld") {
      expect(result.reason.code).toBe("hard_gate_withheld");
      expect(result.decision?.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "failed_hard_gate", gateId: "gate-runtime" }),
      ]));
      expect(result.audit.advisoryModelVotes).toHaveLength(3);
      expect(result.audit.advisoryArbiter?.decision).toBe("accept");
    }
  });

  it.each(["error", "not_run", "missing_evidence"] as const)(
    "withholds an arbiter acceptance when a hard gate is %s",
    async (condition) => {
      const input = policyInput();
      const red = {
        ...input,
        results: input.results.map((result) => {
          if (result.gateId !== "gate-test") return result;
          if (condition === "missing_evidence") {
            return { ...result, evidenceIds: ["missing-policy-evidence"], failureReason: null };
          }
          return {
            ...result,
            verdict: condition,
            failureReason: `test gate ${condition}`,
          };
        }),
        arbiter: { bindingId: "binding-arbiter", decision: "accept" as const, rationale: "cannot override a hard gate" },
      };
      const testFixture = fixture(snapshot(red));

      const result = await testFixture.coordinator.promote(request({ expectedPolicyInputHash: policyHash(red) }));

      expect(result.status).toBe("withheld");
      expect(testFixture.appends).toHaveLength(0);
      if (result.status === "withheld") {
        expect(result.reason.code).toBe("hard_gate_withheld");
        expect(result.audit.advisoryArbiter?.decision).toBe("accept");
      }
    },
  );

  it("appends one all-green immutable promotion and preserves command identity", async () => {
    const input = policyInput();
    const testFixture = fixture(snapshot(input));
    const promotionRequest = request({ expectedPolicyInputHash: policyHash(input) });

    const result = await testFixture.coordinator.promote(promotionRequest);

    expect(result.status).toBe("promoted");
    expect(testFixture.reads).toHaveLength(1);
    expect(testFixture.appends).toHaveLength(1);
    expect(testFixture.appends[0]).toEqual(expect.objectContaining({
      command: promotionRequest.command,
      promotion: expect.objectContaining({
        scope: SCOPE,
        id: promotionRequest.promotion.id,
        nodeId: promotionRequest.nodeId,
        candidateId: promotionRequest.candidateId,
        decision: "promoted",
        hardGateResultIds: input.gates
          .map((gate) => `ledger-${gate.id}`)
          .sort(compareRoomText),
        evidenceIds: input.evidence
          .map((evidence) => `ledger-${evidence.id}`)
          .sort(compareRoomText),
      }),
    }));
  });

  it("fails closed before append for malformed requests and input-hash drift", async () => {
    const input = policyInput();
    const testFixture = fixture(snapshot(input));
    const malformed = request({ expectedPolicyInputHash: "not-a-canonical-hash" });

    const malformedResult = await testFixture.coordinator.promote(malformed as unknown as RequestRoomDeterministicGatePromotionV1);
    expect(malformedResult).toMatchObject({ status: "withheld", reason: { code: "invalid_request" } });
    expect(testFixture.reads).toHaveLength(0);
    expect(testFixture.appends).toHaveLength(0);

    const driftedSnapshot = snapshot(input, { policyInputHash: HASH("f") });
    const driftFixture = fixture(driftedSnapshot);
    const driftResult = await driftFixture.coordinator.promote(request({ expectedPolicyInputHash: policyHash(input) }));

    expect(driftResult).toMatchObject({ status: "withheld", reason: { code: "input_hash_drift" } });
    expect(driftFixture.appends).toHaveLength(0);

    const resultHashDrift = {
      ...input,
      results: input.results.map((result) => result.gateId === "gate-source"
        ? { ...result, inputHash: HASH("e") }
        : result),
    };
    const resultDriftFixture = fixture(snapshot(resultHashDrift));
    const resultDrift = await resultDriftFixture.coordinator.promote(request({
      expectedPolicyInputHash: policyHash(resultHashDrift),
    }));

    expect(resultDrift).toMatchObject({ status: "withheld", reason: { code: "input_hash_drift" } });
    expect(resultDriftFixture.appends).toHaveLength(0);
  });
});
