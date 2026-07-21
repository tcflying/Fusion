import { describe, expect, it } from "vitest";

import { createRoomAggregate } from "../room-domain.js";
import { hashRoomValue } from "../room-integrity.js";
import { applyRoomProjectionEvents } from "../room-projection-replay.js";
import type { RoomEventRecordV1 } from "../room-contracts/storage.js";

const CREATED_AT = "2026-07-18T12:00:00.000Z";
const CLAIMED_AT = "2026-07-18T12:05:00.000Z";

function dispatchClaimEvent(): RoomEventRecordV1 {
  return {
    contractVersion: 1,
    id: "event-task-dispatch-claim-1",
    roomId: "room-task-dispatch-replay",
    projectId: "project-task-dispatch-replay",
    aggregateVersion: 1,
    eventType: "room_task_dispatch_claimed",
    actorType: "controller",
    actorId: "controller-task-dispatch",
    correlationId: "correlation-task-dispatch",
    causationId: "command-task-dispatch",
    payload: {
      projectionVersion: 1,
      nodeId: "node-ready",
      ownerSeatId: "seat-owner",
      ownerBindingId: "binding-owner",
      runningNodeVersion: 1,
      dagVersion: 2,
      messageId: "message-task-dispatch",
      targetId: "target-task-dispatch",
      outboxId: "outbox-task-dispatch",
      idempotencyKey: "claim-task-dispatch-1",
      updatedAt: CLAIMED_AT,
    },
    occurredAt: CLAIMED_AT,
    cursor: "2",
  };
}

function dispatchClaimEventV2(): RoomEventRecordV1 {
  const legacy = dispatchClaimEvent();
  const projection = {
    roomId: legacy.roomId,
    aggregateVersion: legacy.aggregateVersion,
    dagVersion: 2,
    nodes: [],
    edges: [],
    readyNodeIds: [],
    criticalPathNodeIds: [],
  };
  return {
    ...legacy,
    id: "event-task-dispatch-claim-v2",
    payload: {
      ...legacy.payload,
      projectionVersion: 2,
      projection,
      projectionHash: hashRoomValue(projection),
    },
  };
}

function graphMutationEvent(): RoomEventRecordV1 {
  const projection = {
    roomId: "room-task-dispatch-replay",
    aggregateVersion: 1,
    dagVersion: 1,
    nodes: [],
    edges: [],
    readyNodeIds: [],
    criticalPathNodeIds: [],
  };
  return {
    contractVersion: 1,
    id: "event-task-graph-mutation-1",
    roomId: "room-task-dispatch-replay",
    projectId: "project-task-dispatch-replay",
    aggregateVersion: 1,
    eventType: "room_task_graph_mutated",
    actorType: "controller",
    actorId: "controller-task-dispatch",
    correlationId: "correlation-task-graph",
    causationId: "command-task-graph",
    payload: {
      projectionVersion: 1,
      dagVersion: 1,
      idempotencyKey: "mutate-task-graph-1",
      mutationActions: ["add_node"],
      commandAudit: { version: 1, mutations: [] },
      projection,
      projectionHash: hashRoomValue(projection),
      mutatedAt: CLAIMED_AT,
    },
    occurredAt: CLAIMED_AT,
    cursor: "2",
  };
}

describe("ready-task dispatch projection replay", () => {
  it("advances only Room event metadata for a valid atomic dispatch claim", () => {
    const base = createRoomAggregate({
      id: "room-task-dispatch-replay",
      projectId: "project-task-dispatch-replay",
      objective: "Replay a durable task dispatch claim",
      protocolId: "implementation",
      protocolVersion: 1,
      now: CREATED_AT,
    });

    expect(applyRoomProjectionEvents(base, [dispatchClaimEvent()])).toEqual({
      ...base,
      room: { ...base.room, aggregateVersion: 1, updatedAt: CLAIMED_AT },
    });
  });

  it("accepts a hashed v2 task-dispatch graph snapshot while retaining aggregate replay compatibility", () => {
    const base = createRoomAggregate({
      id: "room-task-dispatch-replay",
      projectId: "project-task-dispatch-replay",
      objective: "Replay a durable task dispatch claim",
      protocolId: "implementation",
      protocolVersion: 1,
      now: CREATED_AT,
    });

    expect(applyRoomProjectionEvents(base, [dispatchClaimEventV2()])).toEqual({
      ...base,
      room: { ...base.room, aggregateVersion: 1, updatedAt: CLAIMED_AT },
    });
  });

  it("fails closed when a v2 task-dispatch snapshot hash is tampered", () => {
    const base = createRoomAggregate({
      id: "room-task-dispatch-replay",
      projectId: "project-task-dispatch-replay",
      objective: "Reject tampered durable task dispatch evidence",
      protocolId: "implementation",
      protocolVersion: 1,
      now: CREATED_AT,
    });
    const tampered = dispatchClaimEventV2();
    (tampered.payload as Record<string, unknown>).projectionHash = "sha256:tampered";

    expect(() => applyRoomProjectionEvents(base, [tampered])).toThrow(/hash/i);
  });

  it("replays a hashed task-graph mutation before a later dispatch checkpoint", () => {
    const base = createRoomAggregate({
      id: "room-task-dispatch-replay",
      projectId: "project-task-dispatch-replay",
      objective: "Replay a durable task-graph mutation",
      protocolId: "implementation",
      protocolVersion: 1,
      now: CREATED_AT,
    });

    expect(applyRoomProjectionEvents(base, [graphMutationEvent()])).toEqual({
      ...base,
      room: { ...base.room, aggregateVersion: 1, updatedAt: CLAIMED_AT },
    });
  });

  it("fails closed when task-graph replay evidence no longer matches its hash", () => {
    const base = createRoomAggregate({
      id: "room-task-dispatch-replay",
      projectId: "project-task-dispatch-replay",
      objective: "Reject tampered task-graph replay evidence",
      protocolId: "implementation",
      protocolVersion: 1,
      now: CREATED_AT,
    });
    const tampered = graphMutationEvent();
    const payload = tampered.payload as Record<string, unknown>;
    payload.projectionHash = "sha256:tampered";

    expect(() => applyRoomProjectionEvents(base, [tampered])).toThrow(/hash/i);
  });
});
