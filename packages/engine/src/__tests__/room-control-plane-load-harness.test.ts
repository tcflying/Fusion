import { describe, expect, it } from "vitest";

import {
  ROOM_CONTROL_PLANE_LOAD_HARNESS_CONTRACT_VERSION,
  runRoomControlPlaneLoadHarness,
  type RoomControlPlaneLoadHarnessInputV1,
} from "../room-control-plane-load-harness.js";

const AS_OF = "2026-07-19T12:00:00.000Z";

function fixture(overrides: Partial<RoomControlPlaneLoadHarnessInputV1> = {}): RoomControlPlaneLoadHarnessInputV1 {
  return {
    contractVersion: ROOM_CONTROL_PLANE_LOAD_HARNESS_CONTRACT_VERSION,
    asOf: AS_OF,
    projectId: "project-load-harness",
    roomId: "room-load-harness",
    seed: "load-harness-seed-v1",
    ...overrides,
  };
}

describe("runRoomControlPlaneLoadHarness", () => {
  it("proves deterministic simulated 64-seat attachment and 32-active-task saturation without claiming provider E2E", () => {
    const first = runRoomControlPlaneLoadHarness(fixture());
    const second = runRoomControlPlaneLoadHarness(fixture());

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      status: "passed",
      proofBoundary: {
        tier: "simulated_control_plane",
        realProviderE2E: false,
        realSessionE2E: false,
      },
      counts: {
        attachedSeats: 64,
        activeControllerTasks: 32,
        queuedControllerTasks: 32,
      },
    });
    expect(first.seats).toHaveLength(64);
    expect(new Set(first.seats.map((seat) => seat.seatId))).toHaveLength(64);
    expect(first.activeControllerTasks).toHaveLength(32);
    expect(first.capacityDecision.admission).toMatchObject({
      concurrencyLimit: 32,
      currentActiveSlots: 32,
      newlyAdmittedSlots: 0,
    });
    expect(first.scenarios).toEqual([
      { id: "attached-64-seats", status: "passed" },
      { id: "active-32-controller-tasks", status: "passed" },
    ]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.seats)).toBe(true);
    expect(Object.isFrozen(first.seats[0])).toBe(true);
  });

  it("fails closed for malformed identities and retains the simulated-proof boundary", () => {
    const result = runRoomControlPlaneLoadHarness(
      fixture({ projectId: "", seed: "" }) as unknown as RoomControlPlaneLoadHarnessInputV1,
    );

    expect(result).toMatchObject({
      status: "failed",
      proofBoundary: {
        tier: "simulated_control_plane",
        realProviderE2E: false,
        realSessionE2E: false,
      },
      issues: [
        { code: "invalid_input" },
      ],
    });
  });
});
