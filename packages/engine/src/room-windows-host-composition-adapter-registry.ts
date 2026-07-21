import type { AsyncDataLayer } from "@fusion/core";
import type {
  RoomHostCompositionOperatorAdapterRegistryV1,
  RoomHostCompositionOperatorAdapterResolutionContextV1,
  RoomHostCompositionOperatorAdapterResolutionV1,
} from "./room-host-composition-operator-policy-provider.js";

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

/*
FNXC:WindowsNativeRoomHostComposition 2026-07-21-02:16:
The Windows host owns the adapter-name allow-list and receives only canonical
unscoped backend state. That state does not prove provider/account/model/node
admission or dispatch telemetry, so execution remains withheld until a
host-owned telemetry adapter supplies those facts.
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
      return resolveWithheld("windows_provider_admission_telemetry_unavailable");
    },
  });
}
