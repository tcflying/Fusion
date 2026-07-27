import { describe, expect, it } from "vitest";

import { evaluateRoomSessionConnectorBootstrap } from "../room-session-connector-bootstrap.js";

describe("room session connector bootstrap", () => {
  it("normalizes duplicate and blank selected connector IDs before determining readiness", () => {
    expect(evaluateRoomSessionConnectorBootstrap({
      requiredConnectorIds: ["happier", "", "happier", "claude"],
      loadedConnectorRegistrations: [
        { pluginId: "fusion-plugin-happier-runtime", connectorId: "happier" },
        { pluginId: "fusion-plugin-claude-runtime", connectorId: "claude" },
      ],
    })).toMatchObject({
      state: "ready",
      requiredConnectorIds: ["claude", "happier"],
      missingConnectorIds: [],
    });
  });
});
