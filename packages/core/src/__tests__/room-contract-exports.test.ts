import { describe, expect, it } from "vitest";

import {
  ROOM_CONTRACT_VERSIONS,
  ROOM_UI_TASK_STATES,
  SESSION_CONNECTOR_CAPABILITIES,
} from "../index.js";

describe("Session Room package exports", () => {
  it("publishes the versioned contracts through the @fusion/core entry point", () => {
    expect(ROOM_CONTRACT_VERSIONS.api).toBe("room.v1");
    expect(ROOM_UI_TASK_STATES).toContain("blocked");
    expect(SESSION_CONNECTOR_CAPABILITIES).toContain("send");
  });
});
