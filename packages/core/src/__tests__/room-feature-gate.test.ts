import { describe, expect, it } from "vitest";

import {
  isSessionRoomControlPlaneEnabled,
  SESSION_ROOM_CONTROL_PLANE_FLAG,
} from "../room-feature-gate.js";

describe("Session Room control-plane feature gate", () => {
  it("fails closed unless the project setting is explicitly true", () => {
    expect(SESSION_ROOM_CONTROL_PLANE_FLAG).toBe("sessionRoomControlPlane");
    expect(isSessionRoomControlPlaneEnabled(undefined)).toBe(false);
    expect(isSessionRoomControlPlaneEnabled({ experimentalFeatures: {} })).toBe(false);
    expect(
      isSessionRoomControlPlaneEnabled({
        experimentalFeatures: { [SESSION_ROOM_CONTROL_PLANE_FLAG]: false },
      }),
    ).toBe(false);
    expect(
      isSessionRoomControlPlaneEnabled({
        experimentalFeatures: { [SESSION_ROOM_CONTROL_PLANE_FLAG]: true },
      }),
    ).toBe(true);
  });
});
