import { describe, expect, it } from "vitest";

import {
  AsyncRoomCheckpointStore,
  AsyncRoomLeaseStore,
  AsyncRoomStore,
  ROOM_CONTRACT_VERSIONS,
  ROOM_UI_TASK_STATES,
  SESSION_CONNECTOR_CAPABILITIES,
  createRoomAggregate,
  hashRoomValue,
  rebuildRoomProjectionFromEvents,
} from "../index.js";

describe("Session Room package exports", () => {
  it("publishes the versioned contracts through the @fusion/core entry point", () => {
    expect(ROOM_CONTRACT_VERSIONS.api).toBe("room.v1");
    expect(ROOM_UI_TASK_STATES).toContain("blocked");
    expect(SESSION_CONNECTOR_CAPABILITIES).toContain("send");
  });

  it("publishes operational Room runtime stores and replay helpers through the same entry point", () => {
    expect(AsyncRoomStore).toBeTypeOf("function");
    expect(AsyncRoomLeaseStore).toBeTypeOf("function");
    expect(AsyncRoomCheckpointStore).toBeTypeOf("function");
    expect(createRoomAggregate).toBeTypeOf("function");
    expect(hashRoomValue).toBeTypeOf("function");
    expect(rebuildRoomProjectionFromEvents).toBeTypeOf("function");
  });
});
