import { describe, expect, it } from "vitest";

import {
  selectNextRoomNoProgressRecoveryAction,
  validateRoomProtocolNoProgressRecoveryPolicy,
  type RoomProtocolDefinitionV1,
  type RoomProtocolNoProgressRecoveryPolicyV1,
  type RoomProtocolRecoveryActionV1,
} from "../room-contracts/protocol.js";
import {
  getRoomProtocolNoProgressRecoveryPolicy,
  ROOM_PROTOCOL_DEFINITIONS,
  ROOM_PROTOCOL_NO_PROGRESS_RECOVERY_POLICIES,
} from "../room-protocol-definitions.js";

function protocol(
  recoveryActions: readonly RoomProtocolRecoveryActionV1[],
): Pick<RoomProtocolDefinitionV1, "id" | "version" | "recoveryActions"> {
  return {
    id: "test-recovery-policy",
    version: 1,
    recoveryActions,
  };
}

function recoveryPolicy(
  actions: readonly RoomProtocolNoProgressRecoveryPolicyV1["actions"][number][],
): RoomProtocolNoProgressRecoveryPolicyV1 {
  return {
    protocolId: "test-recovery-policy",
    protocolVersion: 1,
    actions,
  };
}

function noProgressRecovery(
  overrides: Partial<RoomProtocolRecoveryActionV1> = {},
): RoomProtocolRecoveryActionV1 {
  return {
    id: "retry_stalled_work",
    trigger: "no_progress",
    action: "retry",
    maxAttempts: 2,
    phaseIds: ["plan"],
    exhaustedGateId: "work_blocked",
    ...overrides,
  };
}

describe("Room no-progress recovery policy", () => {
  it("requires unique, contiguous positive ladder orders and positive thresholds", () => {
    const declaredProtocol = protocol([
      noProgressRecovery(),
      noProgressRecovery({
        id: "redecompose_stalled_work",
        action: "redecompose",
      }),
    ]);
    const duplicate = validateRoomProtocolNoProgressRecoveryPolicy({
      protocol: declaredProtocol,
      policy: recoveryPolicy([
        {
          recoveryActionId: "retry_stalled_work",
          ladderOrder: 1,
          minimumConsecutiveUnchangedRounds: 2,
        },
        {
          recoveryActionId: "redecompose_stalled_work",
          ladderOrder: 1,
          minimumConsecutiveUnchangedRounds: 3,
        },
      ]),
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.issues.map((issue) => issue.code)).toContain(
        "duplicate_no_progress_recovery_ladder_order",
      );
    }

    const nonPositive = validateRoomProtocolNoProgressRecoveryPolicy({
      protocol: protocol([noProgressRecovery()]),
      policy: recoveryPolicy([
        {
          recoveryActionId: "retry_stalled_work",
          ladderOrder: 0,
          minimumConsecutiveUnchangedRounds: 0,
        },
      ]),
    });
    expect(nonPositive.ok).toBe(false);
    if (!nonPositive.ok) {
      expect(nonPositive.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          "invalid_no_progress_recovery_ladder_order",
          "invalid_no_progress_recovery_threshold",
        ]),
      );
    }

    const gap = validateRoomProtocolNoProgressRecoveryPolicy({
      protocol: protocol([noProgressRecovery()]),
      policy: recoveryPolicy([
        {
          recoveryActionId: "retry_stalled_work",
          ladderOrder: 2,
          minimumConsecutiveUnchangedRounds: 2,
        },
      ]),
    });
    expect(gap.ok).toBe(false);
    if (!gap.ok) {
      expect(gap.issues.map((issue) => issue.code)).toContain(
        "non_contiguous_no_progress_recovery_ladder_order",
      );
    }
  });

  it("selects the earliest eligible rung and advances only after its attempts are exhausted", () => {
    const declaredProtocol = protocol([
      noProgressRecovery(),
      noProgressRecovery({
        id: "redecompose_stalled_work",
        action: "redecompose",
        maxAttempts: 1,
      }),
    ]);
    const policyOverlay = recoveryPolicy([
      {
        recoveryActionId: "retry_stalled_work",
        ladderOrder: 1,
        minimumConsecutiveUnchangedRounds: 2,
      },
      {
        recoveryActionId: "redecompose_stalled_work",
        ladderOrder: 2,
        minimumConsecutiveUnchangedRounds: 3,
      },
    ]);

    expect(
      selectNextRoomNoProgressRecoveryAction({
        protocol: declaredProtocol,
        policy: policyOverlay,
        phaseId: "plan",
        consecutiveUnchangedRounds: 1,
        priorActionAttempts: [],
      }),
    ).toBeUndefined();
    expect(
      selectNextRoomNoProgressRecoveryAction({
        protocol: declaredProtocol,
        policy: policyOverlay,
        phaseId: "plan",
        consecutiveUnchangedRounds: 2,
        priorActionAttempts: [{ actionId: "retry_stalled_work", attempts: 1, exhausted: false }],
      }),
    ).toMatchObject({ recoveryAction: { id: "retry_stalled_work" }, ladderOrder: 1 });
    expect(
      selectNextRoomNoProgressRecoveryAction({
        protocol: declaredProtocol,
        policy: policyOverlay,
        phaseId: "plan",
        consecutiveUnchangedRounds: 2,
        priorActionAttempts: [{ actionId: "retry_stalled_work", attempts: 2, exhausted: false }],
      }),
    ).toBeUndefined();
    expect(
      selectNextRoomNoProgressRecoveryAction({
        protocol: declaredProtocol,
        policy: policyOverlay,
        phaseId: "plan",
        consecutiveUnchangedRounds: 3,
        priorActionAttempts: [{ actionId: "retry_stalled_work", attempts: 2, exhausted: false }],
      }),
    ).toMatchObject({ recoveryAction: { id: "redecompose_stalled_work" }, ladderOrder: 2 });
  });

  it("returns no action when the current phase is outside every no-progress policy scope", () => {
    expect(
      selectNextRoomNoProgressRecoveryAction({
        protocol: protocol([noProgressRecovery()]),
        policy: recoveryPolicy([
          {
            recoveryActionId: "retry_stalled_work",
            ladderOrder: 1,
            minimumConsecutiveUnchangedRounds: 2,
          },
        ]),
        phaseId: "verify",
        consecutiveUnchangedRounds: 9,
        priorActionAttempts: [],
      }),
    ).toBeUndefined();
  });

  it("declares one explicit two-round no-progress policy for every built-in protocol", () => {
    expect(ROOM_PROTOCOL_NO_PROGRESS_RECOVERY_POLICIES).toHaveLength(
      ROOM_PROTOCOL_DEFINITIONS.length,
    );
    for (const definition of ROOM_PROTOCOL_DEFINITIONS) {
      const policyOverlay = getRoomProtocolNoProgressRecoveryPolicy(
        definition.id,
        definition.version,
      );
      expect(policyOverlay, definition.id).toBeDefined();
      const validation = validateRoomProtocolNoProgressRecoveryPolicy({
        protocol: definition,
        policy: policyOverlay!,
      });
      expect(validation.ok, definition.id).toBe(true);
      if (!validation.ok) continue;
      expect(validation.value).toHaveLength(1);
      expect(validation.value[0]).toMatchObject({
        ladderOrder: 1,
        minimumConsecutiveUnchangedRounds: 2,
      });
    }
  });
});
