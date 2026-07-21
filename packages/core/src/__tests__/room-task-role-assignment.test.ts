import { describe, expect, it } from "vitest";

import { resolveRoomTaskRoleAssignment } from "../room-task-role-assignment.js";
import type {
  RoomCapabilitySnapshotV1,
  RoomRoleAssignmentV1,
} from "../room-contracts/assignment.js";

const snapshot: RoomCapabilitySnapshotV1 = {
  contractVersion: 1,
  snapshotId: "snapshot-task-role-resolution",
  revision: 1,
  capturedAt: "2026-07-19T02:50:00.000Z",
  bindings: [
    {
      bindingId: "binding-a",
      availability: "eligible",
      capabilityRevision: "capability-a",
      capabilities: [
        { name: "source_read", state: "verified" },
        { name: "workspace_write", state: "verified" },
      ],
    },
    {
      bindingId: "binding-b",
      availability: "eligible",
      capabilityRevision: "capability-b",
      capabilities: [
        { name: "source_read", state: "verified" },
        { name: "workspace_write", state: "verified" },
      ],
    },
  ],
};

function assignment(bindingIds: readonly string[] = ["binding-a"]): RoomRoleAssignmentV1 {
  return {
    contractVersion: 1,
    protocolId: "implementation",
    protocolVersion: 1,
    phaseId: "plan",
    capabilitySnapshotId: snapshot.snapshotId,
    capabilitySnapshotRevision: snapshot.revision,
    capabilitySnapshotFingerprint: "sha256:test",
    assignments: [{
      roleId: "implementer",
      bindingIds,
      requiredCapabilities: ["source_read", "workspace_write"],
    }],
    producerBindingIds: [...bindingIds],
  };
}

describe("Room task role assignment resolution", () => {
  it("resolves a task through the durable role and certified capabilities", () => {
    expect(resolveRoomTaskRoleAssignment({
      roleRequirements: ["implementer"],
      capabilityRequirements: ["workspace_write"],
    }, assignment(), snapshot)).toEqual({ ok: true, bindingIds: ["binding-a"] });
  });

  it("returns all matching bindings so dispatch can reject ambiguity instead of choosing one", () => {
    expect(resolveRoomTaskRoleAssignment({
      roleRequirements: ["implementer"],
      capabilityRequirements: ["source_read"],
    }, assignment(["binding-b", "binding-a"]), snapshot)).toEqual({
      ok: true,
      bindingIds: ["binding-a", "binding-b"],
    });
  });

  it("fails closed for missing role annotation, stale roles, and unavailable required capability", () => {
    expect(resolveRoomTaskRoleAssignment({
      roleRequirements: [],
      capabilityRequirements: [],
    }, assignment(), snapshot)).toEqual({ ok: false, code: "task_role_requirements_missing" });
    expect(resolveRoomTaskRoleAssignment({
      roleRequirements: ["implementation_verifier"],
      capabilityRequirements: [],
    }, assignment(), snapshot)).toEqual({ ok: false, code: "task_role_not_assigned" });
    expect(resolveRoomTaskRoleAssignment({
      roleRequirements: ["implementer"],
      capabilityRequirements: ["test"],
    }, assignment(), snapshot)).toEqual({ ok: false, code: "task_binding_not_eligible" });
  });
});
