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
      contractVersion: 1,
      projectId: "project-1",
      hostId: "windows-host-1",
      bundleId: "windows-room-bundle-1",
      issuer: "fusion-operator",
      policy: {
        connectorIds: ["happier"],
        controllerAdmission: {
          workClass: "normal",
          slots: 4,
        },
        adapterBindings: WINDOWS_NATIVE_ROOM_HOST_COMPOSITION_ADAPTER_BINDINGS_V1,
      },
      policyHash: "policy-hash-1",
      revision: 1,
      issuedAt: "2026-07-27T05:00:00.000Z",
      updatedAt: "2026-07-27T05:00:00.000Z",
      expiresAt: "2026-07-27T07:00:00.000Z",
      revokedAt: null,
      revokedReason: null,
    },
    roomContext: {
      projectId: "project-1",
      hostId: "windows-host-1",
      connectorIds: ["happier"],
      taskStore: {},
      asyncLayer: { projectId: "project-1" },
      roomStore: {
        getRoom: async () => undefined,
        getRoomCapabilityRegistry: async () => null,
        getTaskGraph: async () => null,
        assertWorkerAuthority: async () => undefined,
      },
      connectorRegistry: {
        ids: () => ["happier"],
      },
    },
  } as unknown as RoomHostCompositionOperatorAdapterResolutionContextV1;
}

describe("Windows native Room host composition adapter registry", () => {
  it("resolves the fixed Windows bundle to all host-owned production dependencies", async () => {
    const registry = createWindowsNativeRoomHostCompositionAdapterRegistry({
      hostAsyncLayer: {} as AsyncDataLayer,
    });

    const result = await registry.resolve(createResolutionContext());

    expect(result).toMatchObject({
      state: "ready",
      dependencies: {
        providerBackpressureVerifiedFactory: expect.any(Function),
        capabilityRegistryRefreshVerifiedFactory: expect.any(Function),
        taskDispatchCapacityAdmissionVerifiedFactory: expect.any(Function),
      },
    });
  });

  it("withholds when the host layer is present but trusted provider telemetry is unavailable", () => {
    const registry = createWindowsNativeRoomHostCompositionAdapterRegistry({
      hostAsyncLayer: {} as AsyncDataLayer,
    });

    const context = createResolutionContext();
    expect(registry.resolve({
      ...context,
      roomContext: {
        ...context.roomContext,
        roomStore: undefined,
      },
    } as unknown as RoomHostCompositionOperatorAdapterResolutionContextV1))
      .toEqual({
        state: "withheld",
        reason: "windows_host_runtime_context_invalid",
      });
  });

  it("withholds when Core cannot atomically prove Room worker authority", () => {
    const registry = createWindowsNativeRoomHostCompositionAdapterRegistry({
      hostAsyncLayer: {} as AsyncDataLayer,
    });
    const context = createResolutionContext();

    expect(registry.resolve({
      ...context,
      roomContext: {
        ...context.roomContext,
        roomStore: {
          ...context.roomContext.roomStore,
          assertWorkerAuthority: undefined,
        },
      },
    } as unknown as RoomHostCompositionOperatorAdapterResolutionContextV1))
      .toEqual({
        state: "withheld",
        reason: "windows_host_runtime_context_invalid",
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
