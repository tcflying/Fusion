import type { AsyncDataLayer } from "@fusion/core";
import type {
  RoomHostCompositionOperatorAdapterRegistryV1,
  RoomHostCompositionOperatorAdapterResolutionContextV1,
  RoomHostCompositionOperatorAdapterResolutionV1,
} from "./room-host-composition-operator-policy-provider.js";
import {
  createWindowsNativeRoomHostCompositionDependencies,
} from "./room-windows-host-composition-runtime.js";

/*
FNXC:WindowsNativeRoomHostComposition 2026-07-21-02:16:
The Windows daemon recognizes only this finite adapter bundle. These are
identifiers for host-owned implementations, never provider/account/model or
quota facts carried by a persisted operator policy.
*/
export const WINDOWS_NATIVE_ROOM_HOST_COMPOSITION_ADAPTER_BINDINGS_V1 = Object.freeze({
  capabilityObservationAdapterId: "windows-happier-capability-v1",
  providerAdmissionSnapshotAdapterId: "windows-happier-provider-admission-v1",
  capacityTelemetryAdapterId: "windows-happier-capacity-telemetry-v1",
  roomWorkerAuthorityAdapterId: "windows-room-worker-authority-v1",
});

export interface CreateWindowsNativeRoomHostCompositionAdapterRegistryInputV1 {
  /*
  FNXC:WindowsNativeRoomHostComposition 2026-07-21-02:16:
  The unscoped sibling layer returned by canonical backend bootstrap proves
  durable host state only; it does not prove provider telemetry.
  */
  readonly hostAsyncLayer?: AsyncDataLayer;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAdapterBindings(context: unknown): UnknownRecord | null {
  if (!isRecord(context) || !isRecord(context.authorityRecord)) return null;
  const policy = context.authorityRecord.policy;
  if (!isRecord(policy) || !isRecord(policy.adapterBindings)) return null;
  return policy.adapterBindings;
}

function hasExactWindowsNativeAdapterBindings(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const expected = WINDOWS_NATIVE_ROOM_HOST_COMPOSITION_ADAPTER_BINDINGS_V1;
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index])
    && value.capabilityObservationAdapterId === expected.capabilityObservationAdapterId
    && value.providerAdmissionSnapshotAdapterId === expected.providerAdmissionSnapshotAdapterId
    && value.capacityTelemetryAdapterId === expected.capacityTelemetryAdapterId
    && value.roomWorkerAuthorityAdapterId === expected.roomWorkerAuthorityAdapterId;
}

function resolveWithheld(reason: string): RoomHostCompositionOperatorAdapterResolutionV1 {
  return Object.freeze({ state: "withheld" as const, reason });
}

function isCanonicalIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function hasWindowsRuntimeContext(
  context: RoomHostCompositionOperatorAdapterResolutionContextV1,
): boolean {
  const authority = context.authorityRecord;
  const room = context.roomContext;
  /*
   * FNXC:WindowsRoomWorkerAuthority 2026-07-27-07:01:
   * Readiness requires Core's atomic durable worker-authority assertion; a
   * Room store that can only read leases must remain withheld.
   */
  if (
    !isRecord(authority)
    || !isRecord(authority.policy)
    || !isRecord(authority.policy.controllerAdmission)
    || !isRecord(room)
    || !isRecord(room.asyncLayer)
    || !isRecord(room.roomStore)
    || !isRecord(room.connectorRegistry)
    || !isCanonicalIdentifier(authority.projectId)
    || !isCanonicalIdentifier(authority.hostId)
    || room.projectId !== authority.projectId
    || room.hostId !== authority.hostId
    || room.asyncLayer.projectId !== authority.projectId
    || !Number.isSafeInteger(authority.policy.controllerAdmission.slots)
    || (authority.policy.controllerAdmission.slots as number) <= 0
    || typeof room.roomStore.getRoom !== "function"
    || typeof room.roomStore.getRoomCapabilityRegistry !== "function"
    || typeof room.roomStore.getTaskGraph !== "function"
    || typeof room.roomStore.assertWorkerAuthority !== "function"
    || typeof room.connectorRegistry.ids !== "function"
  ) {
    return false;
  }
  const connectorIds = room.connectorIds;
  return Array.isArray(connectorIds)
    && connectorIds.length === 1
    && connectorIds[0] === "happier";
}

/*
FNXC:WindowsNativeRoomHostComposition 2026-07-27-06:30:
The fixed Windows adapter bundle may become ready only with the canonical
unscoped backend plus the exact project-bound Room store/connector inventory
already verified by the operator-policy provider. The runtime dependency
builder reads provider/account/model lineage only from the durable capability
registry and worker authority only from Core leases; the signed slot ceiling
remains host-local and is never relabeled as provider-global quota.
*/
export function createWindowsNativeRoomHostCompositionAdapterRegistry(
  input: CreateWindowsNativeRoomHostCompositionAdapterRegistryInputV1 = {},
): RoomHostCompositionOperatorAdapterRegistryV1 {
  const hostAsyncLayer = input.hostAsyncLayer;
  return Object.freeze({
    resolve(
      context: RoomHostCompositionOperatorAdapterResolutionContextV1,
    ): RoomHostCompositionOperatorAdapterResolutionV1 {
      if (!hasExactWindowsNativeAdapterBindings(readAdapterBindings(context))) {
        return resolveWithheld("windows_host_adapter_binding_unrecognized");
      }
      if (hostAsyncLayer === undefined) {
        return resolveWithheld("windows_host_async_layer_unavailable");
      }
      if (hostAsyncLayer.projectId !== undefined) {
        return resolveWithheld("windows_host_async_layer_not_unscoped");
      }
      if (!hasWindowsRuntimeContext(context)) {
        return resolveWithheld("windows_host_runtime_context_invalid");
      }
      return Object.freeze({
        state: "ready" as const,
        dependencies: createWindowsNativeRoomHostCompositionDependencies({
          authorityRecord: context.authorityRecord,
          roomContext: context.roomContext,
        }),
      });
    },
  });
}
