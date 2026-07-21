import {
  hashRoomValue,
  type AppendRoomEvolutionExperimentInputV1,
  type AsyncRoomEvolutionLedger,
  type RoomEvolutionLedgerAppendResult,
  type RoomEvolutionExperimentRecordV1,
} from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

import {
  ROOM_EVOLUTION_AUTHORIZED_SHADOW_CONTRACT_VERSION,
  RoomEvolutionAuthorizedShadowRunner,
  type RecordRoomEvolutionAuthorizedShadowInputV1,
} from "../room-evolution-authorized-shadow.js";

const PROJECT_ID = "project-evolution-shadow";
const ROOM_ID = "room-evolution-shadow";
const CREATED_AT = "2026-07-19T10:15:00.000Z";

const DASHBOARD_OPERATOR = {
  kind: "dashboard_operator" as const,
  principalId: "operator-evolution-shadow",
};

function createInput(
  overrides: Partial<RecordRoomEvolutionAuthorizedShadowInputV1> = {},
): RecordRoomEvolutionAuthorizedShadowInputV1 {
  return {
    contractVersion: ROOM_EVOLUTION_AUTHORIZED_SHADOW_CONTRACT_VERSION,
    commandId: "shadow-command-1",
    roomId: ROOM_ID,
    hypothesisId: "hypothesis-1",
    candidateVersionId: "candidate-1",
    ...overrides,
  };
}

function createLedger(): Pick<AsyncRoomEvolutionLedger, "appendExperiment"> & {
  readonly appendExperiment: ReturnType<typeof vi.fn>;
} {
  const appendExperiment = vi.fn(async (
    input: AppendRoomEvolutionExperimentInputV1,
  ): Promise<RoomEvolutionLedgerAppendResult<"room_evolution_experiments", RoomEvolutionExperimentRecordV1>> => ({
    table: "room_evolution_experiments",
    record: {
      contractVersion: 1,
      id: input.id,
      projectId: input.scope.projectId,
      roomId: input.scope.roomId,
      scopeKind: input.scope.scopeKind,
      scopeKey: input.scope.scopeKey,
      hypothesisId: input.hypothesisId,
      candidateVersionId: input.candidateVersionId,
      state: input.state,
      inputSnapshotHash: input.inputSnapshotHash,
      authorizationEvidence: input.authorizationEvidence,
      authorizationHash: input.authorizationHash,
      capacityPool: input.capacityPool,
      createdByActorId: input.createdByActorId,
      createdAt: input.createdAt,
    },
  }));
  return { appendExperiment };
}

describe("RoomEvolutionAuthorizedShadowRunner", () => {
  it("records only a planned, evolution-paused durable receipt for an authenticated operator", async () => {
    const ledger = createLedger();
    const runner = new RoomEvolutionAuthorizedShadowRunner({
      projectId: PROJECT_ID,
      ledger,
      now: () => CREATED_AT,
    });

    const result = await runner.record(createInput(), DASHBOARD_OPERATOR);

    expect(result).toMatchObject({
      status: "shadow_recorded",
      receipt: {
        projectId: PROJECT_ID,
        roomId: ROOM_ID,
        hypothesisId: "hypothesis-1",
        candidateVersionId: "candidate-1",
        state: "planned",
        capacityPool: "evolution_paused",
        createdAt: CREATED_AT,
      },
    });
    expect(ledger.appendExperiment).toHaveBeenCalledTimes(1);
    const append = ledger.appendExperiment.mock.calls[0]![0] as AppendRoomEvolutionExperimentInputV1;
    expect(append).toMatchObject({
      scope: {
        projectId: PROJECT_ID,
        roomId: ROOM_ID,
        scopeKind: "room",
        scopeKey: `room:${ROOM_ID}`,
      },
      hypothesisId: "hypothesis-1",
      candidateVersionId: "candidate-1",
      state: "planned",
      capacityPool: "evolution_paused",
      createdByActorId: DASHBOARD_OPERATOR.principalId,
      createdAt: CREATED_AT,
    });
    expect(append.authorizationEvidence).toEqual({
      contractVersion: ROOM_EVOLUTION_AUTHORIZED_SHADOW_CONTRACT_VERSION,
      kind: "operator_authorized_evolution_shadow",
      actor: DASHBOARD_OPERATOR,
      commandId: "shadow-command-1",
      prohibitedOperations: [
        "source_worktree_creation",
        "provider_call",
        "evaluator",
        "canary",
        "promotion",
        "rollback",
      ],
    });
    expect(append.authorizationHash).toBe(hashRoomValue(append.authorizationEvidence));
    expect(append.inputSnapshotHash).toBe(hashRoomValue({
      contractVersion: ROOM_EVOLUTION_AUTHORIZED_SHADOW_CONTRACT_VERSION,
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      hypothesisId: "hypothesis-1",
      candidateVersionId: "candidate-1",
      commandId: "shadow-command-1",
    }));
  });

  it("withholds instead of inventing a Core read when a durable candidate reference is absent", async () => {
    const ledger = createLedger();
    const runner = new RoomEvolutionAuthorizedShadowRunner({
      projectId: PROJECT_ID,
      ledger,
      now: () => CREATED_AT,
    });

    const result = await runner.record(createInput({ candidateVersionId: "" }), DASHBOARD_OPERATOR);

    expect(result).toEqual({
      status: "withheld",
      reason: "existing_durable_references_required_no_safe_read_api",
    });
    expect(ledger.appendExperiment).not.toHaveBeenCalled();
  });

  it("withholds a ledger rejection without trying a raw persistence fallback", async () => {
    const ledger = createLedger();
    ledger.appendExperiment.mockRejectedValueOnce(new Error("candidate reference missing"));
    const runner = new RoomEvolutionAuthorizedShadowRunner({
      projectId: PROJECT_ID,
      ledger,
      now: () => CREATED_AT,
    });

    const result = await runner.record(createInput(), DASHBOARD_OPERATOR);

    expect(result).toEqual({
      status: "withheld",
      reason: "durable_receipt_rejected",
    });
    expect(ledger.appendExperiment).toHaveBeenCalledTimes(1);
  });

  it("withholds non-operator identities before the evolution ledger is touched", async () => {
    const ledger = createLedger();
    const runner = new RoomEvolutionAuthorizedShadowRunner({
      projectId: PROJECT_ID,
      ledger,
      now: () => CREATED_AT,
    });

    const result = await runner.record(createInput(), {
      kind: "controller",
      principalId: "controller-1",
    });

    expect(result).toEqual({ status: "withheld", reason: "dashboard_operator_required" });
    expect(ledger.appendExperiment).not.toHaveBeenCalled();
  });
});
