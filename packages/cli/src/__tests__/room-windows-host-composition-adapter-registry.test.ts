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
        adapterBindings,
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
  it("resolves the fixed Windows bundle to host-owned durable admission dependencies", async () => {
    const registry = createWindowsNativeRoomHostCompositionAdapterRegistry({
      hostAsyncLayer: {} as AsyncDataLayer,
    });

    expect(registry.resolve(createResolutionContext())).toMatchObject({
      state: "ready",
      dependencies: {
        providerBackpressureVerifiedFactory: expect.any(Function),
        capabilityRegistryRefreshVerifiedFactory: expect.any(Function),
        taskDispatchCapacityAdmissionVerifiedFactory: expect.any(Function),
      },
    });
  });

  it("withholds without a project-bound durable Room store", async () => {
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
