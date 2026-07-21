import { describe, expect, it } from "vitest";

import {
  RoomStrategyVersionRuntimeCoordinator,
  type RoomStrategyVersionRuntimeCoordinatorDependenciesV1,
  type RoomStrategyVersionRuntimeStartContextV1,
  type RoomStrategyVersionRuntimeStartInputV1,
  type RoomStrategyVersionRuntimeUpgradeContextV1,
  type RoomStrategyVersionRuntimeUpgradeInputV1,
} from "../room-strategy-version-runtime-coordinator.js";

const AS_OF = "2026-07-19T16:00:00.000Z";
const EARLIER = "2026-07-19T15:45:00.000Z";
const LATER = "2026-07-19T16:30:00.000Z";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const HASH_D = `sha256:${"d".repeat(64)}`;

function strategy(
  strategyVersionId: string,
  immutableContentHash: string,
  promotionState: "candidate" | "promoted" | "rejected" | "rolled_back",
  producerActorId: string,
  projectId = "project-1",
): RoomStrategyVersionRuntimeStartContextV1["strategy"] {
  return {
    strategyVersionId,
    projectId,
    immutableContentHash,
    promotionState,
    promotionDecisionId: promotionState === "promoted" ? `promotion-${strategyVersionId}` : null,
    producerActorId,
    promotedAt: promotionState === "promoted" ? EARLIER : null,
  };
}

function startContext(
  overrides: Partial<RoomStrategyVersionRuntimeStartContextV1> = {},
): RoomStrategyVersionRuntimeStartContextV1 {
  return {
    contractVersion: 1,
    room: {
      projectId: "project-1",
      roomId: "room-1",
      aggregateVersion: 17,
      activeTurnId: null,
    },
    currentPin: null,
    strategy: strategy("strategy-v1", HASH_A, "promoted", "producer-v1"),
    ...overrides,
  };
}

function upgradeContext(
  overrides: Partial<RoomStrategyVersionRuntimeUpgradeContextV1> = {},
): RoomStrategyVersionRuntimeUpgradeContextV1 {
  const source = strategy("strategy-v1", HASH_A, "promoted", "producer-v1");
  const target = strategy("strategy-v2", HASH_B, "promoted", "producer-v2");
  return {
    contractVersion: 1,
    room: {
      projectId: "project-1",
      roomId: "room-1",
      aggregateVersion: 17,
      activeTurnId: null,
    },
    currentPin: {
      projectId: "project-1",
      roomId: "room-1",
      pinVersion: 3,
      aggregateVersion: 17,
      strategy: source,
      pinnedAt: EARLIER,
    },
    targetStrategy: target,
    turnBoundary: {
      projectId: "project-1",
      roomId: "room-1",
      aggregateVersion: 17,
      activeTurnId: null,
      settledTurnId: "turn-7",
      state: "completed",
      settledAt: EARLIER,
    },
    compatibility: {
      compatibilityId: "compatibility-1",
      projectId: "project-1",
      roomId: "room-1",
      sourceStrategyVersionId: source.strategyVersionId,
      sourceImmutableContentHash: source.immutableContentHash,
      targetStrategyVersionId: target.strategyVersionId,
      targetImmutableContentHash: target.immutableContentHash,
      state: "compatible",
      evaluatorKind: "deterministic_migration_gate",
      evaluatorId: "migration-gate-1",
      compatibilityHash: HASH_C,
      evidenceHash: HASH_D,
      evaluatedAt: AS_OF,
    },
    authorization: {
      authorizationId: "authorization-1",
      projectId: "project-1",
      roomId: "room-1",
      sourceStrategyVersionId: source.strategyVersionId,
      sourceImmutableContentHash: source.immutableContentHash,
      targetStrategyVersionId: target.strategyVersionId,
      targetImmutableContentHash: target.immutableContentHash,
      granted: true,
      authorityKind: "human_operator",
      authorityId: "operator-1",
      issuedAt: EARLIER,
      expiresAt: LATER,
      evidenceHash: HASH_C,
    },
    independentEvidence: [
      {
        evidenceId: "evidence-promotion",
        projectId: "project-1",
        roomId: "room-1",
        strategyVersionId: target.strategyVersionId,
        kind: "promotion",
        sourceKind: "durable_evolution_ledger",
        sourceId: "promotion-ledger-1",
        observedAt: EARLIER,
        evidenceHash: HASH_A,
      },
      {
        evidenceId: "evidence-compatibility",
        projectId: "project-1",
        roomId: "room-1",
        strategyVersionId: target.strategyVersionId,
        kind: "compatibility",
        sourceKind: "deterministic_gate",
        sourceId: "migration-gate-1",
        observedAt: EARLIER,
        evidenceHash: HASH_B,
      },
      {
        evidenceId: "evidence-rollback",
        projectId: "project-1",
        roomId: "room-1",
        strategyVersionId: source.strategyVersionId,
        kind: "rollback",
        sourceKind: "human_operator",
        sourceId: "operator-1",
        observedAt: EARLIER,
        evidenceHash: HASH_C,
      },
    ],
    ...overrides,
  };
}

function startInput(
  overrides: Partial<RoomStrategyVersionRuntimeStartInputV1> = {},
): RoomStrategyVersionRuntimeStartInputV1 {
  return {
    contractVersion: 1,
    startId: "start-1",
    projectId: "project-1",
    roomId: "room-1",
    strategyVersionId: "strategy-v1",
    expectedAggregateVersion: 17,
    requestedAt: AS_OF,
    ...overrides,
  };
}

function upgradeInput(
  overrides: Partial<RoomStrategyVersionRuntimeUpgradeInputV1> = {},
): RoomStrategyVersionRuntimeUpgradeInputV1 {
  return {
    contractVersion: 1,
    upgradeId: "upgrade-1",
    projectId: "project-1",
    roomId: "room-1",
    targetStrategyVersionId: "strategy-v2",
    expectedPinVersion: 3,
    expectedAggregateVersion: 17,
    requestedAt: AS_OF,
    ...overrides,
  };
}

function dependencies(
  context: {
    readonly start?: RoomStrategyVersionRuntimeStartContextV1 | null;
    readonly upgrade?: RoomStrategyVersionRuntimeUpgradeContextV1 | null;
  } = {},
): RoomStrategyVersionRuntimeCoordinatorDependenciesV1 {
  return {
    reader: {
      readStartContext: async () => context.start ?? startContext(),
      readRecordedUpgradeContext: async () => context.upgrade ?? upgradeContext(),
    },
    appendPort: {
      appendInitialPin: async (record) => ({
        status: "recorded",
        recordId: record.recordId,
        recordHash: record.recordHash,
      }),
      appendUpgrade: async (record) => ({
        status: "recorded",
        recordId: record.recordId,
        recordHash: record.recordHash,
      }),
    },
  };
}

describe("RoomStrategyVersionRuntimeCoordinator", () => {
  it("starts a Room only after recording the exact pin of a promoted immutable strategy", async () => {
    const initialRecords: unknown[] = [];
    const coordinator = new RoomStrategyVersionRuntimeCoordinator({
      ...dependencies(),
      appendPort: {
        appendInitialPin: async (record) => {
          initialRecords.push(record);
          return { status: "recorded", recordId: record.recordId, recordHash: record.recordHash };
        },
        appendUpgrade: async (record) => ({ status: "recorded", recordId: record.recordId, recordHash: record.recordHash }),
      },
    });

    const result = await coordinator.startPinnedRoom(startInput());

    expect(result).toMatchObject({
      status: "accepted",
      pin: {
        projectId: "project-1",
        roomId: "room-1",
        pinVersion: 1,
        aggregateVersion: 17,
        strategy: { strategyVersionId: "strategy-v1", promotionState: "promoted" },
      },
    });
    expect(initialRecords).toHaveLength(1);
    expect(initialRecords[0]).toMatchObject({
      recordId: "start-1",
      promotionDecisionId: "promotion-strategy-v1",
    });
  });

  it("withholds a start when the read-side strategy was not already promoted", async () => {
    let initialWrites = 0;
    const coordinator = new RoomStrategyVersionRuntimeCoordinator({
      ...dependencies({ start: startContext({ strategy: strategy("strategy-v1", HASH_A, "candidate", "producer-v1") }) }),
      appendPort: {
        appendInitialPin: async (record) => {
          initialWrites += 1;
          return { status: "recorded", recordId: record.recordId, recordHash: record.recordHash };
        },
        appendUpgrade: async (record) => ({ status: "recorded", recordId: record.recordId, recordHash: record.recordHash }),
      },
    });

    await expect(coordinator.startPinnedRoom(startInput())).resolves.toMatchObject({
      status: "withheld",
      reason: { code: "strategy_not_promoted" },
    });
    expect(initialWrites).toBe(0);
  });

  it("withholds a recorded upgrade while the Room still has an active turn", async () => {
    let upgradeWrites = 0;
    const base = upgradeContext();
    const coordinator = new RoomStrategyVersionRuntimeCoordinator({
      ...dependencies({ upgrade: { ...base, room: { ...base.room, activeTurnId: "turn-active" } } }),
      appendPort: {
        appendInitialPin: async (record) => ({ status: "recorded", recordId: record.recordId, recordHash: record.recordHash }),
        appendUpgrade: async (record) => {
          upgradeWrites += 1;
          return { status: "recorded", recordId: record.recordId, recordHash: record.recordHash };
        },
      },
    });

    await expect(coordinator.requestRecordedUpgrade(upgradeInput())).resolves.toMatchObject({
      status: "withheld",
      reason: { code: "turn_not_settled" },
    });
    expect(upgradeWrites).toBe(0);
  });

  it("withholds a cross-Room read context before it can append an upgrade", async () => {
    let upgradeWrites = 0;
    const base = upgradeContext();
    const coordinator = new RoomStrategyVersionRuntimeCoordinator({
      ...dependencies({ upgrade: { ...base, currentPin: { ...base.currentPin, roomId: "room-other" } } }),
      appendPort: {
        appendInitialPin: async (record) => ({ status: "recorded", recordId: record.recordId, recordHash: record.recordHash }),
        appendUpgrade: async (record) => {
          upgradeWrites += 1;
          return { status: "recorded", recordId: record.recordId, recordHash: record.recordHash };
        },
      },
    });

    await expect(coordinator.requestRecordedUpgrade(upgradeInput())).resolves.toMatchObject({
      status: "withheld",
      reason: { code: "scope_mismatch" },
    });
    expect(upgradeWrites).toBe(0);
  });

  it("withholds an incompatible recorded target before it can replace the current pin", async () => {
    let upgradeWrites = 0;
    const base = upgradeContext();
    const coordinator = new RoomStrategyVersionRuntimeCoordinator({
      ...dependencies({ upgrade: { ...base, compatibility: { ...base.compatibility, state: "incompatible" } } }),
      appendPort: {
        appendInitialPin: async (record) => ({ status: "recorded", recordId: record.recordId, recordHash: record.recordHash }),
        appendUpgrade: async (record) => {
          upgradeWrites += 1;
          return { status: "recorded", recordId: record.recordId, recordHash: record.recordHash };
        },
      },
    });

    const result = await coordinator.requestRecordedUpgrade(upgradeInput());

    expect(result).toMatchObject({
      status: "withheld",
      reason: { code: "core_rejected" },
      issues: [expect.objectContaining({ code: "incompatible_target" })],
    });
    expect(upgradeWrites).toBe(0);
  });

  it("never accepts an upgrade when the append port acknowledges a different immutable record", async () => {
    const coordinator = new RoomStrategyVersionRuntimeCoordinator({
      ...dependencies(),
      appendPort: {
        appendInitialPin: async (record) => ({ status: "recorded", recordId: record.recordId, recordHash: record.recordHash }),
        appendUpgrade: async (record) => ({
          status: "recorded",
          recordId: record.recordId,
          recordHash: HASH_D,
        }),
      },
    });

    await expect(coordinator.requestRecordedUpgrade(upgradeInput())).resolves.toMatchObject({
      status: "withheld",
      reason: { code: "append_ack_mismatch" },
    });
  });

  it("accepts a compatible recorded upgrade and retains the exact current pin as rollback lineage", async () => {
    const upgradeRecords: unknown[] = [];
    const coordinator = new RoomStrategyVersionRuntimeCoordinator({
      ...dependencies(),
      appendPort: {
        appendInitialPin: async (record) => ({ status: "recorded", recordId: record.recordId, recordHash: record.recordHash }),
        appendUpgrade: async (record) => {
          upgradeRecords.push(record);
          return { status: "recorded", recordId: record.recordId, recordHash: record.recordHash };
        },
      },
    });

    const result = await coordinator.requestRecordedUpgrade(upgradeInput());

    expect(result).toMatchObject({
      status: "accepted",
      record: {
        upgradeId: "upgrade-1",
        targetStrategyVersionId: "strategy-v2",
        rollbackTarget: {
          strategyVersionId: "strategy-v1",
          immutableContentHash: HASH_A,
          promotionDecisionId: "promotion-strategy-v1",
        },
      },
    });
    expect(upgradeRecords).toHaveLength(1);
  });
});
