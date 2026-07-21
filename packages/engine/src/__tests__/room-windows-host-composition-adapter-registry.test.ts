import type { AsyncDataLayer } from "@fusion/core";
import type { RoomHostCompositionOperatorAdapterResolutionContextV1 } from "../index.js";
import { describe, expect, it } from "vitest";

import {
  WINDOWS_NATIVE_ROOM_HOST_COMPOSITION_ADAPTER_BINDINGS_V1,
  createWindowsNativeRoomHostCompositionAdapterRegistry,
} from "../index.js";

function createResolutionContext(): RoomHostCompositionOperatorAdapterResolutionContextV1 {
  return {
    authorityRecord: {
      policy: { adapterBindings: WINDOWS_NATIVE_ROOM_HOST_COMPOSITION_ADAPTER_BINDINGS_V1 },
    },
    roomContext: { connectorIds: ["happier"] },
  } as unknown as RoomHostCompositionOperatorAdapterResolutionContextV1;
}

describe("Windows native Room host composition adapter registry", () => {
  it("withholds when the host layer is present but trusted provider telemetry is unavailable", () => {
    const registry = createWindowsNativeRoomHostCompositionAdapterRegistry({
      hostAsyncLayer: {} as AsyncDataLayer,
    });

    expect(registry.resolve(createResolutionContext())).toEqual({
      state: "withheld",
      reason: "windows_provider_admission_telemetry_unavailable",
    });
  });

  it("withholds when adapter bindings differ from the fixed Windows host bundle", () => {
    const registry = createWindowsNativeRoomHostCompositionAdapterRegistry({
      hostAsyncLayer: {} as AsyncDataLayer,
    });

    expect(registry.resolve({
      ...createResolutionContext(),
      authorityRecord: {
        policy: {
          adapterBindings: {
            ...WINDOWS_NATIVE_ROOM_HOST_COMPOSITION_ADAPTER_BINDINGS_V1,
            providerAdmissionSnapshotAdapterId: "untrusted-provider-admission-v1",
          },
        },
      },
    } as RoomHostCompositionOperatorAdapterResolutionContextV1)).toEqual({
      state: "withheld",
      reason: "windows_host_adapter_binding_unrecognized",
    });
  });

  it("withholds a project-bound layer instead of accepting it as the unscoped host layer", () => {
    const registry = createWindowsNativeRoomHostCompositionAdapterRegistry({
      hostAsyncLayer: { projectId: "project-1" } as AsyncDataLayer,
    });

    expect(registry.resolve(createResolutionContext())).toEqual({
      state: "withheld",
      reason: "windows_host_async_layer_not_unscoped",
    });
  });
});
