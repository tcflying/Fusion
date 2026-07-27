import { describe, expect, it, vi } from "vitest";

import type { RoomTaskDispatchCapacityAdmissionV1 } from "../room-dependency-dispatch-coordinator.js";
import {
  persistTaskDispatchCapacityAdmissions,
  type RoomTaskCapacityAdmissionAuditHandle,
} from "../room-task-capacity-admission-audit.js";

describe("persistTaskDispatchCapacityAdmissions", () => {
  it("persists bounded capacity telemetry in dispatch order", async () => {
    const persist = vi.fn(async () => undefined);
    const admissions = [{
      state: "withheld" as const,
      requestedNodeIds: ["task-a"],
      admittedNodeIds: [],
      reasonCodes: ["capacity_telemetry_observer_failed" as const],
      decision: null,
      diagnostic: {
        state: "withheld" as const,
        reasonCode: "capacity_telemetry_observer_failed" as const,
        stage: "telemetry_observation" as const,
      },
    }] satisfies readonly RoomTaskDispatchCapacityAdmissionV1[];

    await persistTaskDispatchCapacityAdmissions({
      roomId: "room-1",
      lease: { id: "lease-1", epoch: 7 } as RoomTaskCapacityAdmissionAuditHandle["lease"],
      projectionVersion: 12,
      source: "controller",
      lifecycleGeneration: 3,
    }, admissions, persist);

    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("room:task-capacity-admission", "room-1", {
      leaseId: "lease-1",
      leaseEpoch: 7,
      expectedAggregateVersion: 12,
      source: "controller",
      admissionState: "withheld",
      requestedCount: 1,
      admittedCount: 0,
      reasonCodes: ["capacity_telemetry_observer_failed"],
      diagnostic: {
        state: "withheld",
        reasonCode: "capacity_telemetry_observer_failed",
        stage: "telemetry_observation",
      },
    }, 3);
    expect(JSON.stringify(persist.mock.calls)).not.toContain("task-a");
  });
});
