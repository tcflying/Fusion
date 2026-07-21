import { describe, expect, it } from "vitest";

import { createRoomAggregate } from "../room-domain.js";
import { getRoomProtocolDefinition } from "../room-protocol-definitions.js";
import {
  assignRoomRoles,
  createRoomCapabilitySnapshot,
  normalizeRoomRoleAssignmentConstraints,
} from "../room-role-assignment.js";
import { hashRoomValue } from "../room-integrity.js";
import { applyRoomProjectionEvents } from "../room-projection-replay.js";
import type { RoomEventRecordV1 } from "../room-contracts/storage.js";

const CREATED_AT = "2026-07-19T02:30:00.000Z";
const ACTIVATED_AT = "2026-07-19T02:35:00.000Z";

function roleAssignmentActivationEvent(): RoomEventRecordV1 {
  const protocol = getRoomProtocolDefinition("implementation", 1);
  if (!protocol) throw new Error("implementation protocol must exist for replay test");
  const snapshotResult = createRoomCapabilitySnapshot({
    contractVersion: 1,
    snapshotId: "snapshot-role-replay-1",
    revision: 1,
    capturedAt: ACTIVATED_AT,
    bindings: [{
      bindingId: "binding-implementer",
      availability: "eligible",
      capabilityRevision: "capability-r1",
      capabilities: [
        { name: "source_read", state: "verified" },
        { name: "workspace_write", state: "verified" },
      ],
    }],
  });
  if (!snapshotResult.ok) throw new Error("test capability snapshot must be valid");
  const constraintsResult = normalizeRoomRoleAssignmentConstraints({ locks: [], forbids: [] });
  if (!constraintsResult.ok) throw new Error("test constraints must be valid");
  const assignmentResult = assignRoomRoles({
    protocol,
    phaseId: "plan",
    capabilitySnapshot: snapshotResult.value,
    constraints: constraintsResult.value,
    producerBindingIds: [],
  });
  if (!assignmentResult.ok) throw new Error("test role assignment must be valid");
  const payload = {
    projectionVersion: 1,
    assignmentId: "assignment-role-replay-1",
    revision: 1,
    protocolId: protocol.id,
    protocolVersion: protocol.version,
    phaseId: "plan",
    capabilitySnapshot: snapshotResult.value,
    capabilitySnapshotHash: hashRoomValue(snapshotResult.value),
    constraints: constraintsResult.value,
    constraintsHash: hashRoomValue(constraintsResult.value),
    assignment: assignmentResult.value,
    assignmentHash: hashRoomValue(assignmentResult.value),
    authoritativeProducerBindingIds: assignmentResult.value.producerBindingIds,
    updatedAt: ACTIVATED_AT,
  };
  return {
    contractVersion: 1,
    id: "event-role-assignment-activation-1",
    roomId: "room-role-assignment-replay",
    projectId: "project-role-assignment-replay",
    aggregateVersion: 1,
    eventType: "room_role_assignment_activated",
    actorType: "controller",
    actorId: "controller-role-assignment",
    correlationId: "correlation-role-assignment",
    causationId: "command-role-assignment",
    payload,
    occurredAt: ACTIVATED_AT,
    cursor: "2",
  };
}

describe("Room role-assignment projection replay", () => {
  it("replays a canonical entry-phase assignment without consulting mutable assignment rows", () => {
    const base = createRoomAggregate({
      id: "room-role-assignment-replay",
      projectId: "project-role-assignment-replay",
      objective: "Replay capability-aware role activation",
      protocolId: "implementation",
      protocolVersion: 1,
      now: CREATED_AT,
    });

    expect(applyRoomProjectionEvents(base, [roleAssignmentActivationEvent()])).toEqual({
      ...base,
      room: { ...base.room, aggregateVersion: 1, updatedAt: ACTIVATED_AT },
    });
  });

  it("fails closed when assignment capability evidence is tampered", () => {
    const base = createRoomAggregate({
      id: "room-role-assignment-replay",
      projectId: "project-role-assignment-replay",
      objective: "Reject tampered capability-aware assignment evidence",
      protocolId: "implementation",
      protocolVersion: 1,
      now: CREATED_AT,
    });
    const tampered = roleAssignmentActivationEvent();
    (tampered.payload as Record<string, unknown>).capabilitySnapshotHash = "sha256:tampered";

    expect(() => applyRoomProjectionEvents(base, [tampered])).toThrow(/capability|hash/i);
  });
});
