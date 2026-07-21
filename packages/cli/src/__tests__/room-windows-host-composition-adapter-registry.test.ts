import type { AsyncDataLayer } from "@fusion/core";
import type { RoomHostCompositionOperatorAdapterResolutionContextV1 } from "@fusion/engine";
import { describe, expect, it } from "vitest";

import {
  WINDOWS_NATIVE_ROOM_HOST_COMPOSITION_ADAPTER_BINDINGS_V1,
  createWindowsNativeRoomHostCompositionAdapterRegistry,
} from "../room-windows-host-composition-adapter-registry.js";

function createResolutionContext(
  adapterBindings = WINDOWS_NATIVE_ROOM_HOST_COMPOSITION_ADAPTER_BINDINGS_V1,
): RoomHostCompositionOperatorAdapterResolutionContextV1 {
  return {
    authorityRecord: {
      policy: { adapterBindings },
    },
    roomContext: {
      connectorIds: ["happier"],
    },
  } as unknown as RoomHostCompositionOperatorAdapterResolutionContextV1;
}

describe("Windows native Room host composition adapter registry", () => {
  it("withholds rather than fabricating provider admission from a host layer or connector label", async () => {
    const registry = createWindowsNativeRoomHostCompositionAdapterRegistry({
      hostAsyncLayer: {} as AsyncDataLayer,
    });

    expect(registry.resolve(createResolutionContext())).toEqual({
      state: "withheld",
      reason: "windows_provider_admission_telemetry_unavailable",
    });
  });

  it("rejects operator bindings that do not name this Windows host's fixed adapter set", async () => {
    const registry = createWindowsNativeRoomHostCompositionAdapterRegistry({
      hostAsyncLayer: {} as AsyncDataLayer,
    });

    expect(registry.resolve(createResolutionContext({
      ...WINDOWS_NATIVE_ROOM_HOST_COMPOSITION_ADAPTER_BINDINGS_V1,
      providerAdmissionSnapshotAdapterId: "untrusted-provider-admission-v1",
    }))).toEqual({
      state: "withheld",
      reason: "windows_host_adapter_binding_unrecognized",
    });
  });

  it("withholds when daemon bootstrap has no canonical host async layer", async () => {
    const registry = createWindowsNativeRoomHostCompositionAdapterRegistry({});

    expect(registry.resolve(createResolutionContext())).toEqual({
      state: "withheld",
      reason: "windows_host_async_layer_unavailable",
    });
  });

  it("rejects a project-bound layer in place of the canonical unscoped host layer", async () => {
    const registry = createWindowsNativeRoomHostCompositionAdapterRegistry({
      hostAsyncLayer: { projectId: "project-1" } as AsyncDataLayer,
    });

    expect(registry.resolve(createResolutionContext())).toEqual({
      state: "withheld",
      reason: "windows_host_async_layer_not_unscoped",
    });
  });
});
