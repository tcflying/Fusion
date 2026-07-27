import type { StoredRoomLeaseV1 } from "@fusion/core";

import type { RoomTaskDispatchCapacityAdmissionV1 } from "./room-dependency-dispatch-coordinator.js";

export interface RoomTaskCapacityAdmissionAuditHandle {
  readonly roomId: string;
  readonly lease: StoredRoomLeaseV1;
  readonly projectionVersion: number;
  readonly source: string;
  readonly lifecycleGeneration: number;
}

export type RoomTaskCapacityAdmissionAuditRecorder = (
  mutationType: "room:task-capacity-admission",
  roomId: string,
  metadata: Record<string, unknown>,
  lifecycleGeneration: number,
) => Promise<void>;

/*
FNXC:CapacityTelemetryDiagnostics 2026-07-27-19:48:
Task-capacity decisions need the same bounded audit projection regardless of
which RoomController dispatch path observes them. Keep persistence ordering and
message-free metadata here so controller lifecycle orchestration cannot drift
from Cockpit and metric telemetry semantics.
*/
export async function persistTaskDispatchCapacityAdmissions(
  handle: RoomTaskCapacityAdmissionAuditHandle,
  admissions: readonly RoomTaskDispatchCapacityAdmissionV1[],
  record: RoomTaskCapacityAdmissionAuditRecorder,
): Promise<void> {
  for (const admission of admissions) {
    await record("room:task-capacity-admission", handle.roomId, {
      leaseId: handle.lease.id,
      leaseEpoch: handle.lease.epoch,
      expectedAggregateVersion: handle.projectionVersion,
      source: handle.source,
      admissionState: admission.state,
      requestedCount: admission.requestedNodeIds.length,
      admittedCount: admission.admittedNodeIds.length,
      reasonCodes: [...admission.reasonCodes],
      ...(admission.diagnostic ? {
        diagnostic: {
          state: admission.diagnostic.state,
          reasonCode: admission.diagnostic.reasonCode,
          stage: admission.diagnostic.stage,
        },
      } : {}),
    }, handle.lifecycleGeneration);
  }
}
