import { describe, expect, it } from "vitest";

import {
  commitRoomStrategyVersionUpgrade,
  evaluateRoomStrategyVersionPinning,
  type EvaluateRoomStrategyVersionPinningInputV1,
  type RoomStrategyVersionUpgradeAppendPortV1,
} from "../room-strategy-version-pinning.js";

const AS_OF = "2026-07-19T15:20:00.000Z";
const LATER = "2026-07-19T15:30:00.000Z";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const HASH_D = `sha256:${"d".repeat(64)}`;

function strategy(
  strategyVersionId: string,
  immutableContentHash: string,
  promotionState: "candidate" | "promoted" | "rejected" | "rolled_back",
  producerActorId: string,
) {
  return {
    strategyVersionId,
    projectId: "project-1",
    immutableContentHash,
    promotionState,
    promotionDecisionId: promotionState === "promoted" ? `promotion-${strategyVersionId}` : null,
    producerActorId,
    promotedAt: promotionState === "promoted" ? AS_OF : null,
  } as const;
}

function inputFixture(): EvaluateRoomStrategyVersionPinningInputV1 {
  const currentStrategy = strategy("strategy-v1", HASH_A, "promoted", "author-v1");
  const targetStrategy = strategy("strategy-v2", HASH_B, "promoted", "author-v2");
  return {
    contractVersion: 1,
    asOf: AS_OF,
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
      strategy: currentStrategy,
      pinnedAt: "2026-07-19T15:00:00.000Z",
    },
    request: {
      upgradeId: "upgrade-1",
      projectId: "project-1",
      roomId: "room-1",
      expectedPinVersion: 3,
      expectedAggregateVersion: 17,
      requestedAt: AS_OF,
      targetStrategy,
      rollbackTarget: currentStrategy,
    },
    turnBoundary: {
      projectId: "project-1",
      roomId: "room-1",
      aggregateVersion: 17,
      activeTurnId: null,
      settledTurnId: "turn-7",
      state: "completed",
      settledAt: AS_OF,
    },
    compatibility: {
      compatibilityId: "compatibility-1",
      projectId: "project-1",
      roomId: "room-1",
      sourceStrategyVersionId: "strategy-v1",
      sourceImmutableContentHash: HASH_A,
      targetStrategyVersionId: "strategy-v2",
      targetImmutableContentHash: HASH_B,
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
      sourceStrategyVersionId: "strategy-v1",
      sourceImmutableContentHash: HASH_A,
      targetStrategyVersionId: "strategy-v2",
      targetImmutableContentHash: HASH_B,
      granted: true,
      authorityKind: "human_operator",
      authorityId: "operator-1",
      issuedAt: "2026-07-19T15:19:00.000Z",
      expiresAt: LATER,
      evidenceHash: HASH_C,
    },
    independentEvidence: [
      {
        evidenceId: "evidence-promotion",
        projectId: "project-1",
        roomId: "room-1",
        strategyVersionId: "strategy-v2",
        kind: "promotion",
        sourceKind: "durable_evolution_ledger",
        sourceId: "ledger-promotion-1",
        observedAt: AS_OF,
        evidenceHash: HASH_A,
      },
      {
        evidenceId: "evidence-compatibility",
        projectId: "project-1",
        roomId: "room-1",
        strategyVersionId: "strategy-v2",
        kind: "compatibility",
        sourceKind: "deterministic_gate",
        sourceId: "migration-gate-1",
        observedAt: AS_OF,
        evidenceHash: HASH_B,
      },
      {
        evidenceId: "evidence-rollback",
        projectId: "project-1",
        roomId: "room-1",
        strategyVersionId: "strategy-v1",
        kind: "rollback",
        sourceKind: "independent_evaluator",
        sourceId: "reviewer-1",
        observedAt: AS_OF,
        evidenceHash: HASH_C,
      },
    ],
  };
}

function expectIssue(input: EvaluateRoomStrategyVersionPinningInputV1, code: string): void {
  expect(evaluateRoomStrategyVersionPinning(input)).toMatchObject({
    ok: false,
    issues: expect.arrayContaining([expect.objectContaining({ code })]),
  });
}

describe("Room strategy version pinning", () => {
  it("pins a running Room to an immutable promoted strategy and records only a compatible settled-turn upgrade", async () => {
    const input = inputFixture();
    let appendedId: string | null = null;
    const appendPort: RoomStrategyVersionUpgradeAppendPortV1 = {
      async append(record) {
        appendedId = record.recordId;
        return { status: "recorded", recordId: record.recordId, recordHash: record.recordHash };
      },
    };

    const result = await commitRoomStrategyVersionUpgrade({ input, appendPort });

    expect(result).toMatchObject({
      ok: true,
      record: {
        projectId: "project-1",
        roomId: "room-1",
        sourceStrategyVersionId: "strategy-v1",
        targetStrategyVersionId: "strategy-v2",
        activation: { kind: "after_settled_turn", settledTurnId: "turn-7" },
        rollbackTarget: { strategyVersionId: "strategy-v1", immutableContentHash: HASH_A },
      },
    });
    if (!result.ok) throw new Error("Expected strategy upgrade to be recorded");
    expect(appendedId).toBe(result.record.recordId);
    expect(result.record.recordHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(result.record)).toBe(true);
    expect(Object.isFrozen(result.record.evidence)).toBe(true);
  });

  it("fails closed when a running Room is pinned to an unpromoted strategy", () => {
    const base = inputFixture();
    expectIssue({
      ...base,
      currentPin: {
        ...base.currentPin,
        strategy: strategy("strategy-v1", HASH_A, "candidate", "author-v1"),
      },
    }, "current_pin_not_promoted");
  });

  it("rejects an unpromoted target strategy before it can replace a running pin", () => {
    const base = inputFixture();
    expectIssue({
      ...base,
      request: {
        ...base.request,
        targetStrategy: strategy("strategy-v2", HASH_B, "candidate", "author-v2"),
      },
    }, "target_not_promoted");
  });

  it("rejects cross-Room authorization, compatibility, and evidence", () => {
    const authorizationBase = inputFixture();
    expectIssue({
      ...authorizationBase,
      authorization: { ...authorizationBase.authorization, roomId: "room-other" },
    }, "scope_mismatch");

    const compatibilityBase = inputFixture();
    expectIssue({
      ...compatibilityBase,
      compatibility: { ...compatibilityBase.compatibility, projectId: "project-other" },
    }, "scope_mismatch");

    const evidenceBase = inputFixture();
    expectIssue({
      ...evidenceBase,
      independentEvidence: evidenceBase.independentEvidence.map((entry) => entry.evidenceId === "evidence-promotion"
        ? { ...entry, roomId: "room-other" }
        : entry),
    }, "scope_mismatch");
  });

  it("requires an inactive Room and a completed settled-turn boundary", () => {
    const activeBase = inputFixture();
    expectIssue({
      ...activeBase,
      room: { ...activeBase.room, activeTurnId: "turn-8" as never },
    }, "turn_boundary_required");

    const unsettledBase = inputFixture();
    expectIssue({
      ...unsettledBase,
      turnBoundary: { ...unsettledBase.turnBoundary, state: "running" as never },
    }, "turn_boundary_required");
  });

  it("fails closed on stale expected pin or aggregate versions", () => {
    const pinBase = inputFixture();
    expectIssue({
      ...pinBase,
      request: { ...pinBase.request, expectedPinVersion: 2 },
    }, "stale_version_conflict");

    const aggregateBase = inputFixture();
    expectIssue({
      ...aggregateBase,
      request: { ...aggregateBase.request, expectedAggregateVersion: 16 },
    }, "stale_version_conflict");
  });

  it("requires an explicit compatible migration contract bound to both immutable versions", () => {
    const incompatibleBase = inputFixture();
    expectIssue({
      ...incompatibleBase,
      compatibility: { ...incompatibleBase.compatibility, state: "incompatible" as never },
    }, "incompatible_target");

    const driftedHashBase = inputFixture();
    expectIssue({
      ...driftedHashBase,
      compatibility: { ...driftedHashBase.compatibility, targetImmutableContentHash: HASH_C },
    }, "compatibility_mismatch");
  });

  it("forbids model self-authorization and self-report evidence", () => {
    const selfAuthorizationBase = inputFixture();
    expectIssue({
      ...selfAuthorizationBase,
      authorization: {
        ...selfAuthorizationBase.authorization,
        authorityKind: "model_self_report" as never,
        authorityId: "author-v2",
      },
    }, "self_authorization_forbidden");

    const selfReportBase = inputFixture();
    expectIssue({
      ...selfReportBase,
      independentEvidence: selfReportBase.independentEvidence.map((entry) => entry.evidenceId === "evidence-promotion"
        ? { ...entry, sourceKind: "model_self_report" as never }
        : entry),
    }, "untrusted_evidence_source");
  });

  it("requires a rollback target that exactly names the current promoted immutable pin", () => {
    const base = inputFixture();
    expectIssue({
      ...base,
      request: {
        ...base.request,
        rollbackTarget: strategy("strategy-v0", HASH_D, "promoted", "author-v0"),
      },
    }, "rollback_target_required");
  });

  it("withholds an upgrade when any required promotion, compatibility, or rollback evidence is absent", () => {
    const base = inputFixture();
    expectIssue({
      ...base,
      independentEvidence: base.independentEvidence.filter((entry) => entry.kind !== "compatibility"),
    }, "missing_independent_evidence");
  });

  it("does not treat an inexact append acknowledgement as a committed upgrade", async () => {
    const appendPort: RoomStrategyVersionUpgradeAppendPortV1 = {
      async append(record) {
        return { status: "recorded", recordId: record.recordId, recordHash: HASH_D };
      },
    };

    await expect(commitRoomStrategyVersionUpgrade({ input: inputFixture(), appendPort })).resolves.toMatchObject({
      ok: false,
      reason: { code: "append_ack_mismatch" },
    });
  });
});
