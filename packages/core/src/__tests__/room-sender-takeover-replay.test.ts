import { describe, expect, it } from "vitest";

import { createRoomAggregate } from "../room-domain.js";
import { applyRoomProjectionEvents } from "../room-projection-replay.js";
import type { RoomEventRecordV1 } from "../room-contracts/storage.js";

const CREATED_AT = "2026-07-18T07:00:00.000Z";
const BLOCKED_AT = "2026-07-18T07:00:01.000Z";

function blockedTakeoverEvent(
  payload: Readonly<Record<string, unknown>>,
): RoomEventRecordV1 {
  return {
    contractVersion: 1,
    id: "event-sender-takeover-blocked-1",
    roomId: "room-sender-takeover-replay",
    projectId: "project-sender-takeover-replay",
    aggregateVersion: 1,
    eventType: "sender_takeover_blocked_delivery_uncertain",
    actorType: "system",
    actorId: "room-connector-ingestion",
    correlationId: "native-writer:status-1",
    causationId: null,
    payload,
    occurredAt: BLOCKED_AT,
    cursor: "2",
  };
}

describe("native IDE sender takeover projection replay", () => {
  it("advances only Room event metadata for a valid blocked takeover event", () => {
    const base = createRoomAggregate({
      id: "room-sender-takeover-replay",
      projectId: "project-sender-takeover-replay",
      objective: "Replay sender takeover evidence",
      protocolId: "implementation",
      protocolVersion: 1,
      now: CREATED_AT,
    });
    const replayed = applyRoomProjectionEvents(base, [blockedTakeoverEvent({
      projectionVersion: 1,
      bindingId: "binding-sender-replay",
      takeoverId: "native-writer:status-1",
      takeoverEpoch: 1,
      outboxIds: ["outbox-uncertain-1"],
      updatedAt: BLOCKED_AT,
    })]);

    expect(replayed).toEqual({
      ...base,
      room: { ...base.room, aggregateVersion: 1, updatedAt: BLOCKED_AT },
    });
  });

  it("fails closed for malformed or duplicate blocked outbox evidence", () => {
    const base = createRoomAggregate({
      id: "room-sender-takeover-replay",
      projectId: "project-sender-takeover-replay",
      objective: "Replay sender takeover evidence",
      protocolId: "implementation",
      protocolVersion: 1,
      now: CREATED_AT,
    });
    expect(() => applyRoomProjectionEvents(base, [blockedTakeoverEvent({
      projectionVersion: 1,
      bindingId: "binding-sender-replay",
      takeoverId: "native-writer:status-1",
      takeoverEpoch: 1,
      outboxIds: ["outbox-uncertain-1", "outbox-uncertain-1"],
      updatedAt: BLOCKED_AT,
    })])).toThrow(/unique non-empty outbox IDs/i);

    expect(() => applyRoomProjectionEvents(base, [{
      ...blockedTakeoverEvent({
        projectionVersion: 1,
        bindingId: "binding-sender-replay",
        takeoverId: "native-writer:status-1",
        takeoverEpoch: 1,
        outboxIds: ["outbox-uncertain-1"],
        updatedAt: BLOCKED_AT,
      }),
      occurredAt: "not-a-timestamp",
    }])).toThrow(/occurredAt.*valid timestamp/i);
  });
});
