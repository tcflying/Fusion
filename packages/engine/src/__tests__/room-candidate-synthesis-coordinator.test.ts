import { describe, expect, it } from "vitest";
import type { RoomCandidateRecordV1, RoomEvidenceLedgerScope } from "@fusion/core";

import {
  RoomCandidateSynthesisCoordinator,
  type RequestRoomCandidateSynthesisV1,
  type RoomCandidateSynthesisAppendPortV1,
  type RoomCandidateSynthesisCoordinatorDependenciesV1,
  type RoomCandidateSynthesisPersistedComparisonV1,
  type RoomCandidateSynthesisPersistedParentV1,
} from "../room-candidate-synthesis-coordinator.js";

const SCOPE = {
  projectId: "project-candidate-synthesis",
  roomId: "room-candidate-synthesis",
} as const satisfies RoomEvidenceLedgerScope;
const NODE_ID = "node-candidate-synthesis";
const CREATED_AT = "2026-07-19T14:00:00.000Z";
const HASH = `sha256:${"a".repeat(64)}`;

function candidate(
  id: string,
  overrides: Partial<RoomCandidateRecordV1> = {},
): RoomCandidateRecordV1 {
  return {
    contractVersion: 1,
    id,
    roomId: SCOPE.roomId,
    nodeId: NODE_ID,
    producingBindingId: `binding-${id}`,
    nativeSessionId: `native-${id}`,
    happierSessionId: `happier-${id}`,
    providerId: "happier",
    modelRef: "provider-owned-model",
    protocolId: "implementation",
    protocolVersion: 1,
    contextVersion: "context-v1",
    inputVersion: "input-v1",
    configVersion: "config-v1",
    contentHash: HASH,
    artifactIds: [`artifact-${id}`],
    parentCandidateIds: [],
    gateResultIds: [],
    reviewIds: [],
    promotionState: "pending",
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function parent(
  id: string,
  scope: RoomEvidenceLedgerScope = SCOPE,
  overrides: Partial<RoomCandidateRecordV1> = {},
): RoomCandidateSynthesisPersistedParentV1 {
  return {
    persistence: "committed",
    scope,
    candidate: candidate(id, {
      roomId: scope.roomId,
      nodeId: NODE_ID,
      ...overrides,
    }),
  };
}

function comparison(
  overrides: Partial<RoomCandidateSynthesisPersistedComparisonV1> = {},
): RoomCandidateSynthesisPersistedComparisonV1 {
  return {
    persistence: "committed",
    id: "comparison-candidate-synthesis",
    scope: SCOPE,
    nodeId: NODE_ID,
    parentCandidateIds: ["candidate-parent-a", "candidate-parent-b"],
    conclusion: "The recorded comparison identifies complementary strengths that require a new child candidate.",
    concludedAt: CREATED_AT,
    ...overrides,
  };
}

function request(
  overrides: Partial<RequestRoomCandidateSynthesisV1> = {},
): RequestRoomCandidateSynthesisV1 {
  return {
    contractVersion: 1,
    scope: SCOPE,
    nodeId: NODE_ID,
    comparisonId: "comparison-candidate-synthesis",
    parentCandidateIds: ["candidate-parent-a", "candidate-parent-b"],
    command: {
      commandId: "command-candidate-synthesis",
      idempotencyKey: "idempotency-candidate-synthesis",
      correlationId: "correlation-candidate-synthesis",
      causationId: "cause-candidate-synthesis",
    },
    child: {
      contractVersion: 1,
      id: "candidate-synthesized-child",
      producingBindingId: "binding-synthesizer",
      nativeSessionId: "native-synthesizer",
      happierSessionId: "happier-synthesizer",
      providerId: "happier",
      modelRef: "provider-owned-model",
      protocolId: "implementation",
      protocolVersion: 1,
      contextVersion: "context-v2",
      inputVersion: "input-v2",
      configVersion: "config-v2",
      contentHash: HASH,
      artifactIds: ["artifact-synthesized-child"],
      gateResultIds: [],
      reviewIds: [],
      promotionState: "pending",
      createdAt: CREATED_AT,
    },
    ...overrides,
  };
}

function fixture(options: {
  readonly parents?: readonly RoomCandidateSynthesisPersistedParentV1[];
  readonly existing?: RoomCandidateSynthesisPersistedParentV1 | null;
  readonly comparison?: RoomCandidateSynthesisPersistedComparisonV1 | null;
  readonly failAppend?: boolean;
} = {}) {
  const parents = options.parents ?? [parent("candidate-parent-a"), parent("candidate-parent-b")];
  const appended: unknown[] = [];
  const append: RoomCandidateSynthesisAppendPortV1 = {
    appendSynthesis: async (input) => {
      appended.push(input);
      if (options.failAppend) throw new Error("durable candidate ledger unavailable");
      return {
        recordId: `record:${input.child.id}`,
        candidateId: input.child.id,
        revalidationRecorded: true,
        replayed: false,
      };
    },
  };
  const dependencies: RoomCandidateSynthesisCoordinatorDependenciesV1 = {
    source: {
      loadPersistedComparison: async () => options.comparison === undefined ? comparison() : options.comparison,
      loadPersistedParents: async () => parents,
      findPersistedCandidateById: async () => options.existing ?? null,
    },
    append,
  };
  return {
    appended,
    coordinator: new RoomCandidateSynthesisCoordinator(dependencies),
  };
}

describe("RoomCandidateSynthesisCoordinator", () => {
  it("creates a fresh pending child with explicit revalidation after durable append", async () => {
    const { coordinator, appended } = fixture();
    const result = await coordinator.synthesize(request());

    expect(result).toMatchObject({
      status: "created",
      child: {
        id: "candidate-synthesized-child",
        roomId: SCOPE.roomId,
        nodeId: NODE_ID,
        parentCandidateIds: ["candidate-parent-a", "candidate-parent-b"],
        gateResultIds: [],
        reviewIds: [],
        promotionState: "pending",
      },
      revalidation: {
        required: true,
        hardGates: true,
        independentReview: true,
        promotion: true,
        inheritedVerdictsIgnored: true,
      },
      record: {
        recordId: "record:candidate-synthesized-child",
        revalidationRecorded: true,
      },
    });
    expect(appended).toHaveLength(1);
    expect(Object.isFrozen((appended[0] as { child: object }).child)).toBe(true);
    expect(Object.isFrozen((appended[0] as { revalidation: object }).revalidation)).toBe(true);
  });

  it("withholds both a child ID reused from a parent and duplicate parent references", async () => {
    const { coordinator, appended } = fixture();

    await expect(coordinator.synthesize(request({
      child: { ...request().child, id: "candidate-parent-a" },
    }))).resolves.toMatchObject({
      status: "withheld",
      reason: { code: "child_id_conflicts_parent" },
    });
    await expect(coordinator.synthesize(request({
      parentCandidateIds: ["candidate-parent-a", "candidate-parent-a"],
    }))).resolves.toMatchObject({
      status: "withheld",
      reason: { code: "duplicate_parent_reference" },
    });

    expect(appended).toHaveLength(0);
  });

  it("withholds a child ID that is already committed outside the parent set", async () => {
    const { coordinator, appended } = fixture({
      existing: parent("candidate-synthesized-child"),
    });

    const result = await coordinator.synthesize(request());

    expect(result).toMatchObject({
      status: "withheld",
      reason: { code: "child_id_already_exists" },
    });
    expect(appended).toHaveLength(0);
  });

  it("withholds a parent returned from another project, Room, or node scope", async () => {
    const foreignScope = {
      projectId: SCOPE.projectId,
      roomId: "room-foreign",
    } as const satisfies RoomEvidenceLedgerScope;
    const { coordinator, appended } = fixture({
      parents: [parent("candidate-parent-a"), parent("candidate-parent-b", foreignScope)],
    });

    const result = await coordinator.synthesize(request());

    expect(result).toMatchObject({
      status: "withheld",
      reason: { code: "parent_scope_mismatch" },
    });
    expect(appended).toHaveLength(0);
  });

  it("withholds when any referenced persisted parent is missing", async () => {
    const { coordinator, appended } = fixture({
      parents: [parent("candidate-parent-a")],
    });

    const result = await coordinator.synthesize(request());

    expect(result).toMatchObject({
      status: "withheld",
      reason: { code: "parent_not_found" },
    });
    expect(appended).toHaveLength(0);
  });

  it.each([
    ["gate result", { gateResultIds: ["gate-parent-passed"] }, "child_inherits_gate_results"],
    ["review", { reviewIds: ["review-parent-accepted"] }, "child_inherits_reviews"],
    ["promotion", { promotionState: "eligible" as const }, "child_inherits_promotion"],
  ])("withholds inherited parent %s as a child result", async (_label, childOverrides, expectedCode) => {
    const { coordinator, appended } = fixture();
    const result = await coordinator.synthesize(request({
      child: { ...request().child, ...childOverrides },
    }));

    expect(result).toMatchObject({
      status: "withheld",
      reason: { code: expectedCode },
    });
    expect(appended).toHaveLength(0);
  });

  it("does not report a child as created when the typed append port fails", async () => {
    const { coordinator, appended } = fixture({ failAppend: true });
    const result = await coordinator.synthesize(request());

    expect(result).toMatchObject({
      status: "append_failed",
      reason: { code: "append_failed" },
      child: { id: "candidate-synthesized-child", promotionState: "pending" },
      revalidation: { required: true },
    });
    expect(result.status).not.toBe("created");
    expect(appended).toHaveLength(1);
  });
});
